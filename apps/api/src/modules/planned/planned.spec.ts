import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeClinicianWith, makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
type Plan = { estimate: { total: string }; id: string; status: string; requestNumber: string; can: Record<string, boolean>; bed: { id: string; code: string } | null; admission: { id: string; admissionNumber: string } | null; nursingAssessment: { status: string } | null; deposit: { held: string; required: string | null; basis: string | null }; claim: { id: string; status: string } | null; close: { reason: string } | null; events: { action: string }[] };
const key = () => `k-${randomUUID().slice(0, 18)}`;
const ymd = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;

describe("planned admission: request, doctor, desk, billing, insurance, deposit, bed, admission, nursing", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: User; let desk: User; let cashier: User; let officer: User; let bedMgr: User; let manager: User; let nurse: User; let bDesk: User;
  let doc: TestDoctor; let doc2: TestDoctor;
  let wardId: string;
  let insurerId: string;

  const mkBed = async (): Promise<{ id: string; code: string; wardId: string }> => {
    const room = (await t.api("post", "/rooms", a.admin.token).send({ wardId, name: `Room ${uniqueWord(3)}`, code: code("R") })).body.data as { id: string };
    const r = await t.api("post", "/beds", a.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1500" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  const get = async (id: string, tok = desk.token): Promise<Plan> => (await t.api("get", `/planned-admissions/${id}`, tok)).body.data;
  const step = async (id: string, path: string, tok: string, body: Record<string, unknown> | undefined = undefined, method: "post" | "put" = "post") => {
    const req = t.api(method, `/planned-admissions/${id}/${path}`, tok);
    return body === undefined ? req : req.send(body);
  };
  const ok = async (id: string, path: string, tok: string, body?: Record<string, unknown>, method: "post" | "put" = "post"): Promise<Plan> => {
    const r = await step(id, path, tok, body ?? {}, method);
    assert.ok(r.status === 200 || r.status === 201, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  };
  const notes = async (tok: string) => (await t.api("get", "/notifications", tok)).body.data as { type: string; entityId: string }[];
  const details = (o: Record<string, unknown> = {}) => ({ diagnosis: "Cholelithiasis", plannedProcedure: "Laparoscopic cholecystectomy", proposedDate: ymd(3), expectedStayDays: 3, wardId, ...o });

  /** An outside request that has been accepted by the doctor and is with the desk. */
  const toDesk = async (patientId: string, over: Record<string, unknown> = {}): Promise<Plan> => {
    const r = await t.api("post", "/planned-admissions", rec.token).send({ patientId, source: "OUTSIDE_ARRANGED", consultantId: doc.practitionerId, details: "Dr. Sen of the city asked me to come for gallbladder surgery", ...over });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return ok(r.body.data.id, "doctor", doc.token, { action: "ACCEPT", ...details() });
  };
  /** Verified by the desk, estimated, self-pay, in the deposit step with 5000 asked. */
  const toDeposit = async (patientId: string): Promise<Plan> => {
    const p = await toDesk(patientId);
    await ok(p.id, "verify", desk.token, details());
    await ok(p.id, "estimate", cashier.token, { lines: [{ description: "Surgeon and theatre", quantity: "1", unitPrice: "20000" }, { description: "Bed (3 days)", quantity: "3", unitPrice: "1500" }] }, "put");
    await ok(p.id, "payer", cashier.token, { payer: "SELF_PAY" });
    await ok(p.id, "tariff-done", cashier.token);
    return ok(p.id, "deposit-required", cashier.token, { amount: "5000" }, "put");
  };
  const takeDeposit = (id: string, amount: string, tok = cashier.token, k = key(), ref = `UPI-${uniqueWord(6)}`) => t.api("post", `/planned-admissions/${id}/deposit`, tok).set("Idempotency-Key", k).send({ tenders: [{ method: "UPI", amount, reference: ref }] });
  const toBed = async (patientId: string): Promise<Plan> => { const p = await toDeposit(patientId); assert.equal((await takeDeposit(p.id, "5000")).status, 201); return get(p.id); };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("plan-a"); b = await t.makeTenant("plan-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]); desk = await t.makeUser(a, ["ADMISSION_DESK"]); cashier = await t.makeUser(a, ["CASHIER"]); officer = await t.makeUser(a, ["CLAIMS_OFFICER"]);
    bedMgr = await t.makeUser(a, ["BED_MANAGER"]); manager = await t.makeUser(a, ["MANAGER"]); nurse = await t.makeUser(a, ["NURSE"]); bDesk = await t.makeUser(b, ["ADMISSION_DESK"]);
    doc = await makeDoctor(t, a); doc2 = await makeDoctor(t, a);
    wardId = ((await t.api("post", "/wards", a.admin.token).send({ name: `Private ${uniqueWord(4)}`, code: code("PV") })).body.data as { id: string }).id;
    insurerId = ((await t.api("post", "/claims/insurers", officer.token).send({ name: `Star ${uniqueWord(6)}`, kind: "TPA" })).body.data as { id: string }).id;
  });
  after(async () => { await t.close(); });

  // ───────────────────────── route 1: the OPD doctor advises ─────────────────────────
  it("OPD route: the doctor ticks 'needs admission', reception asks the patient, and the request goes all the way to an admission with a nursing assessment waiting", async () => {
    const patient = await registerPatient(t, rec.token);
    const visit = await startVisit(t, rec.token, doc, patient.id);
    // Only the doctor of the visit may advise it.
    assert.equal((await t.api("post", `/encounters/${visit.encounterId}/planned-admission`, doc2.token).send({ details: "Needs surgery" })).status, 404, "another doctor does not even see the visit");
    assert.equal((await t.api("post", `/encounters/${visit.encounterId}/planned-admission`, rec.token).send({ details: "Needs surgery" })).status, 403, "reception cannot advise");
    const adv = await t.api("post", `/encounters/${visit.encounterId}/planned-admission`, doc.token).send({ details: "Gallstones with repeated colic; surgery advised", ...details() });
    assert.equal(adv.status, 201, JSON.stringify(adv.body));
    const plan = adv.body.data as Plan;
    assert.equal(plan.status, "ADVISED");
    assert.match(plan.requestNumber, /^PA-\d{4}-\d{6}$/);
    assert.ok((await notes(rec.token)).some((n) => n.type === "PLANNED_ADMISSION_ADVISED" && n.entityId === plan.id), "reception is told");
    assert.equal((await t.api("post", `/encounters/${visit.encounterId}/planned-admission`, doc.token).send({ details: "again" })).status, 409, "advised once");
    const mine = (await t.api("get", `/encounters/${visit.encounterId}/planned-admission`, doc.token)).body.data;
    assert.equal(mine.id, plan.id);
    // Nothing moves until the patient consents; the doctor cannot skip reception, the desk's steps wait.
    assert.equal((await step(plan.id, "verify", desk.token, details())).status, 409);
    assert.equal((await step(plan.id, "consent", doc.token, { consented: true })).status, 403, "the doctor does not record consent");
    const c = await ok(plan.id, "consent", rec.token, { consented: true, note: "Patient and son agree" });
    assert.equal(c.status, "DESK_REVIEW");
    // The desk verifies (it may correct the day), billing estimates, the patient pays himself, the deposit comes, bed management holds a bed.
    const v = await ok(plan.id, "verify", desk.token, details({ proposedDate: ymd(4) }));
    assert.equal(v.status, "TARIFF_PAYER");
    await ok(plan.id, "estimate", cashier.token, { lines: [{ description: "Surgeon and theatre", quantity: "1", unitPrice: "20000" }, { description: "Bed (3 days)", quantity: "3", unitPrice: "1500" }] }, "put");
    assert.equal((await get(plan.id)).estimate.total, "24500.00");
    await ok(plan.id, "payer", cashier.token, { payer: "SELF_PAY" });
    assert.equal((await ok(plan.id, "tariff-done", cashier.token)).status, "DEPOSIT");
    await ok(plan.id, "deposit-required", cashier.token, { amount: "5000" }, "put");
    assert.equal((await takeDeposit(plan.id, "2000")).status, 201);
    assert.equal((await get(plan.id)).status, "DEPOSIT", "part of the deposit does not clear it");
    const full = await takeDeposit(plan.id, "3000");
    assert.equal(full.status, 201, JSON.stringify(full.body));
    const afterDeposit = await get(plan.id);
    assert.equal(afterDeposit.status, "BED_ALLOCATION");
    assert.equal(afterDeposit.deposit.basis, "DEPOSIT_PAID");
    assert.equal(afterDeposit.deposit.held, "5000.00");
    const bed = await mkBed();
    const held = await ok(plan.id, "bed", bedMgr.token, { bedId: bed.id });
    assert.equal(held.status, "READY");
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed.id } })).status, "RESERVED");
    // The patient comes: the admission is made on the held bed, as any other admission.
    const done = await ok(plan.id, "admit", desk.token);
    assert.equal(done.status, "ADMITTED");
    assert.ok(done.admission?.admissionNumber.startsWith("ADM-"));
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed.id } })).status, "OCCUPIED");
    const assignment = await t.prisma.bedAssignment.findFirst({ where: { admissionId: done.admission!.id, releasedAt: null } });
    assert.equal(assignment?.bedId, bed.id);
    const adm = await t.api("get", `/admissions/${done.admission!.id}`, desk.token);
    assert.equal(adm.status, 200);
    assert.equal(adm.body.data.status, "ADMITTED");
    assert.equal(adm.body.data.bed.code, bed.code);
    // The nursing admission assessment is on the nurses' list and the nurse completes it.
    const task = await t.prisma.nursingTask.findFirst({ where: { admissionId: done.admission!.id, title: "Nursing admission assessment" } });
    assert.equal(task?.status, "PENDING");
    assert.equal((await t.api("post", `/tasks/${task!.id}/complete`, nurse.token).send({ note: "Assessed: stable, fasting since midnight" })).status, 200);
    assert.equal((await get(plan.id)).nursingAssessment?.status, "DONE");
    // It is final.
    assert.equal((await step(plan.id, "cancel", desk.token, { reason: "Changed our minds" })).status, 409);
    assert.equal((await step(plan.id, "admit", desk.token)).status, 409);
    const trail = (await get(plan.id)).events.map((e) => e.action);
    assert.deepEqual(trail, ["ADVISED", "CONSENT_GIVEN", "DESK_VERIFIED", "ESTIMATE_SAVED", "PAYER_SET", "TARIFF_DONE", "DEPOSIT_REQUIRED_SET", "DEPOSIT_TAKEN", "DEPOSIT_TAKEN", "FINANCIAL_CLEARED", "BED_ALLOCATED", "ADMITTED"]);
    const audits = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityType: "PlannedAdmission", entityId: plan.id }, select: { action: true } });
    for (const x of ["PLANNED_ADMISSION_ADVISED", "PLANNED_ADMISSION_CONSENT_GIVEN", "PLANNED_ADMISSION_FINANCIAL_CLEARED", "PLANNED_ADMISSION_ADMITTED"]) assert.ok(audits.some((e) => e.action === x), x);
    // The deposit is an ordinary advance payment of the patient, marked as taken for this request.
    const advances = await t.prisma.advanceDeposit.findMany({ where: { tenantId: a.tenantId, plannedAdmissionId: plan.id } });
    assert.equal(advances.length, 2);
    assert.equal((await t.api("get", `/patients/${patient.id}/advances`, cashier.token)).status, 200);
  });

  it("OPD route: a patient who does not want to be admitted closes the request with the reason; the doctor may withdraw the advice; a new tick is then allowed", async () => {
    const patient = await registerPatient(t, rec.token);
    const visit = await startVisit(t, rec.token, doc, patient.id);
    const adv = (await t.api("post", `/encounters/${visit.encounterId}/planned-admission`, doc.token).send({ details: "Hernia repair advised" })).body.data as Plan;
    assert.equal((await step(adv.id, "consent", rec.token, { consented: false })).status, 400, "a refusal needs the reason");
    const no = await ok(adv.id, "consent", rec.token, { consented: false, note: "Cannot afford it this month" });
    assert.equal(no.status, "CLOSED");
    assert.equal(no.close?.reason, "PATIENT_DECLINED");
    // Closed requests do not block a new one.
    const again = await t.api("post", `/encounters/${visit.encounterId}/planned-admission`, doc.token).send({ details: "Hernia repair advised again" });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    const w = await ok(again.body.data.id, "cancel", doc.token, { reason: "Doctor withdrew the admission advice" });
    assert.equal(w.close?.reason, "CANCELLED");
  });

  // ───────────────────────── route 2a: arranged with a consultant ─────────────────────────
  it("arranged with a consultant: the request goes to that doctor, who asks for the chamber visit, then confirms the day; the patient joins the admission queue", async () => {
    const patient = await registerPatient(t, rec.token);
    const r = await t.api("post", "/planned-admissions", rec.token).send({ patientId: patient.id, source: "OUTSIDE_ARRANGED", consultantId: doc.practitionerId, details: "I spoke to Dr. on the phone last week; knee replacement planned" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const plan = r.body.data as Plan;
    assert.equal(plan.status, "DOCTOR_REVIEW");
    assert.ok((await notes(doc.token)).some((n) => n.type === "PLANNED_ADMISSION_REQUEST" && n.entityId === plan.id), "the doctor is told");
    // Only that doctor sees and decides it.
    assert.equal((await t.api("get", `/planned-admissions/${plan.id}`, doc2.token)).status, 404);
    assert.equal((await step(plan.id, "doctor", doc2.token, { action: "ASK", mode: "CHAMBER", note: "Send the patient" })).status, 404);
    assert.equal((await step(plan.id, "doctor", rec.token, { action: "ASK", mode: "CHAMBER", note: "Send the patient" })).status, 403);
    assert.ok(((await t.api("get", "/planned-admissions", doc.token)).body.data as { id: string }[]).some((x) => x.id === plan.id));
    assert.ok(!((await t.api("get", "/planned-admissions", doc2.token)).body.data as { id: string }[]).some((x) => x.id === plan.id));
    // The doctor approves the request and asks reception to send the patient to the chamber.
    const asked = await ok(plan.id, "doctor", doc.token, { action: "ASK", mode: "CHAMBER", note: "Bring the X-rays and the old prescription" });
    assert.equal(asked.status, "AWAITING_PATIENT");
    assert.ok((await notes(rec.token)).some((n) => n.type === "PLANNED_ADMISSION_DECIDED" && n.entityId === plan.id), "reception is told what the doctor wants");
    assert.equal((await step(plan.id, "doctor", doc.token, { action: "ACCEPT", ...details() })).status, 409, "the doctor cannot accept before the patient has come");
    // Reception sends the patient into the doctor's queue.
    const ready = await ok(plan.id, "patient-ready", rec.token, { note: "Patient is here with the X-rays" });
    assert.equal(ready.status, "DOCTOR_REVIEW");
    const walk = await t.prisma.appointment.findFirst({ where: { tenantId: a.tenantId, patientId: patient.id, practitionerId: doc.practitionerId, source: "WALK_IN" } });
    assert.ok(walk, "the patient is in the doctor's OPD queue");
    // The doctor confirms the admission and its day: the patient is in the admission queue.
    const acc = await ok(plan.id, "doctor", doc.token, { action: "ACCEPT", ...details({ proposedDate: ymd(5) }) });
    assert.equal(acc.status, "DESK_REVIEW");
    assert.ok((await notes(desk.token)).some((n) => n.type === "PLANNED_ADMISSION_STEP" && n.entityId === plan.id), "the admission desk is told");
    const queue = (await t.api("get", "/planned-admissions?status=DESK_REVIEW", desk.token)).body.data as { id: string }[];
    assert.ok(queue.some((x) => x.id === plan.id));
  });

  // ───────────────────────── route 2b: no prior arrangement ─────────────────────────
  it("walk-in with outside papers: the consultant may ask for reports, investigations, recommend other treatment or decline; nothing is an admission order until accepted", async () => {
    const patient = await registerPatient(t, rec.token);
    const r = await t.api("post", "/planned-admissions", rec.token).send({ patientId: patient.id, source: "OUTSIDE_DIRECT", consultantId: doc.practitionerId, details: "Outside doctor wrote 'admit for angiography'; external prescription and reports with the patient" });
    const plan = r.body.data as Plan;
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(plan.status, "DOCTOR_REVIEW");
    // The outside doctor's note is not an admission order: nothing is with the desk.
    assert.equal((await step(plan.id, "verify", desk.token, details())).status, 409);
    // Reports only: the consultant reads the reports; no queue entry is made.
    assert.equal((await ok(plan.id, "doctor", doc.token, { action: "ASK", mode: "REPORTS", note: "Send the reports to me first" })).status, "AWAITING_PATIENT");
    const before = await t.prisma.appointment.count({ where: { tenantId: a.tenantId, patientId: patient.id } });
    assert.equal((await ok(plan.id, "patient-ready", rec.token, { note: "Reports handed over" })).status, "DOCTOR_REVIEW");
    assert.equal(await t.prisma.appointment.count({ where: { tenantId: a.tenantId, patientId: patient.id } }), before, "reports only: the patient is not queued");
    // More investigations.
    assert.equal((await ok(plan.id, "doctor", doc.token, { action: "ASK", mode: "INVESTIGATIONS", note: "Repeat ECG and troponin" })).status, "AWAITING_PATIENT");
    assert.equal((await ok(plan.id, "patient-ready", rec.token, { note: "New reports brought", sendToQueue: false })).status, "DOCTOR_REVIEW");
    // A different treatment is recommended: the request ends without an admission.
    const other = await ok(plan.id, "doctor", doc.token, { action: "OTHER_TREATMENT", note: "Medical management is enough for now" });
    assert.equal(other.status, "CLOSED");
    assert.equal(other.close?.reason, "OTHER_TREATMENT");
    assert.equal(await t.prisma.admission.count({ where: { tenantId: a.tenantId, patientId: patient.id } }), 0);
    // A second walk-in is declined by the consultant.
    const p2 = await registerPatient(t, rec.token);
    const r2 = (await t.api("post", "/planned-admissions", rec.token).send({ patientId: p2.id, source: "OUTSIDE_DIRECT", consultantId: doc.practitionerId, details: "Wants admission for rest" })).body.data as Plan;
    assert.equal((await step(r2.id, "doctor", doc.token, { action: "DECLINE" })).status, 400, "a decline needs the reason");
    const dec = await ok(r2.id, "doctor", doc.token, { action: "DECLINE", reason: "Not clinically indicated" });
    assert.equal(dec.close?.reason, "DOCTOR_DECLINED");
  });

  // ───────────────────────── tariff, insurance, deposit ─────────────────────────
  it("insured patient: the insurance team checks the policy and asks the insurer; an approval that covers the estimate clears the deposit; cancelling releases the bed and closes the claim", async () => {
    const patient = await registerPatient(t, rec.token);
    const pol = await t.api("post", `/patients/${patient.id}/policies`, officer.token).send({ insurerId, policyNumber: `POL-${uniqueWord(6)}`, validFrom: ymd(-30), validTo: ymd(300), sumInsured: "500000" });
    assert.equal(pol.status, 201, JSON.stringify(pol.body));
    const expired = await t.api("post", `/patients/${patient.id}/policies`, officer.token).send({ insurerId, policyNumber: `OLD-${uniqueWord(6)}`, validFrom: ymd(-400), validTo: ymd(-5) });
    const plan = await toDesk(patient.id);
    await ok(plan.id, "verify", desk.token, details());
    await ok(plan.id, "estimate", cashier.token, { lines: [{ description: "Procedure package", quantity: "1", unitPrice: "60000" }] }, "put");
    // Only the insurance team sets an insured payer; the policy must be the patient's, active, and valid on the day.
    assert.equal((await step(plan.id, "payer", cashier.token, { payer: "INSURED", policyId: pol.body.data.id, preauthRequired: true, eligibilityNote: "Network hospital" })).status, 403);
    assert.equal((await step(plan.id, "payer", officer.token, { payer: "INSURED", policyId: expired.body.data.id, preauthRequired: true, eligibilityNote: "Checked" })).status, 409, "an expired policy");
    assert.equal((await step(plan.id, "payer", officer.token, { payer: "INSURED", policyId: randomUUID(), preauthRequired: true, eligibilityNote: "Checked" })).status, 404);
    const insured = await ok(plan.id, "payer", officer.token, { payer: "INSURED", policyId: pol.body.data.id, preauthRequired: true, eligibilityNote: "Policy active, network hospital, room rent within limit" });
    assert.equal(insured.claim?.status, "DRAFT", "the cashless claim is started with the request");
    assert.equal((await ok(plan.id, "tariff-done", officer.token)).status, "PREAUTH");
    assert.equal((await step(plan.id, "preauth", cashier.token, { action: "REQUEST", requestedAmount: "60000" })).status, 403);
    await ok(plan.id, "preauth", officer.token, { action: "REQUEST", requestedAmount: "60000", note: "Pre-auth form sent" });
    assert.equal((await get(plan.id)).claim?.status, "PREAUTH_PENDING");
    assert.equal((await step(plan.id, "deposit-required", cashier.token, { amount: "1000" }, "put")).status, 409, "the deposit waits for the insurer");
    const approved = await ok(plan.id, "preauth", officer.token, { action: "APPROVE", amount: "60000", reason: "Approved in full" });
    assert.equal(approved.status, "DEPOSIT");
    assert.equal(approved.claim?.status, "PREAUTH_APPROVED");
    // A deposit of nothing is accepted only because the insurer covers the whole estimate.
    const cleared = await ok(plan.id, "deposit-required", cashier.token, { amount: "0" }, "put");
    assert.equal(cleared.status, "BED_ALLOCATION");
    assert.equal(cleared.deposit.basis, "INSURANCE_APPROVED");
    const bed = await mkBed();
    assert.equal((await ok(plan.id, "bed", bedMgr.token, { bedId: bed.id })).status, "READY");
    // The patient does not come: the desk records it; the bed is released and the claim that was only started is closed.
    const gone = await ok(plan.id, "cancel", desk.token, { reason: "Patient did not come on the day", kind: "NO_SHOW" });
    assert.equal(gone.status, "CLOSED");
    assert.equal(gone.close?.reason, "NO_SHOW");
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed.id } })).status, "AVAILABLE");
    assert.equal((await t.prisma.claim.findFirstOrThrow({ where: { id: insured.claim!.id } })).status, "CLOSED");
  });

  it("a rejected pre-authorisation can be turned into a self-pay admission; the estimate cannot be left empty and a manager alone can waive the deposit", async () => {
    const patient = await registerPatient(t, rec.token);
    const pol = await t.api("post", `/patients/${patient.id}/policies`, officer.token).send({ insurerId, policyNumber: `POL-${uniqueWord(6)}`, validFrom: ymd(-30), validTo: ymd(300) });
    const plan = await toDesk(patient.id);
    await ok(plan.id, "verify", desk.token, details());
    assert.equal((await step(plan.id, "tariff-done", cashier.token)).status, 409, "no estimate, no payer yet");
    await ok(plan.id, "estimate", cashier.token, { lines: [{ description: "Package", quantity: "1", unitPrice: "30000" }] }, "put");
    assert.equal((await step(plan.id, "tariff-done", cashier.token)).status, 409, "no payer yet");
    await ok(plan.id, "payer", officer.token, { payer: "INSURED", policyId: pol.body.data.id, preauthRequired: true, eligibilityNote: "Checked with the TPA desk" });
    await ok(plan.id, "tariff-done", officer.token);
    await ok(plan.id, "preauth", officer.token, { action: "REQUEST", requestedAmount: "30000" });
    assert.equal((await step(plan.id, "preauth", officer.token, { action: "REJECT" })).status, 400, "the insurer's reason is needed");
    const rej = await ok(plan.id, "preauth", officer.token, { action: "REJECT", reason: "Pre-existing condition not covered" });
    assert.equal(rej.status, "PREAUTH", "the request waits: the insurance team decides what next");
    assert.equal(rej.claim?.status, "REJECTED");
    const self = await ok(plan.id, "preauth", officer.token, { action: "SELF_PAY", reason: "Patient will pay himself" });
    assert.equal(self.status, "DEPOSIT");
    // Self-pay: a deposit is needed; zero is refused; nobody but a manager waives it.
    assert.equal((await step(plan.id, "deposit-required", cashier.token, { amount: "0" }, "put")).status, 400);
    await ok(plan.id, "deposit-required", cashier.token, { amount: "10000" }, "put");
    assert.equal((await step(plan.id, "waive", cashier.token, { reason: "Known patient, pays at discharge" })).status, 403);
    assert.equal((await step(plan.id, "waive", manager.token, { reason: "short" })).status, 400, "the waiver needs a real reason");
    const waived = await ok(plan.id, "waive", manager.token, { reason: "Hospital trustee's patient, pays at discharge" });
    assert.equal(waived.status, "BED_ALLOCATION");
    assert.equal(waived.deposit.basis, "WAIVED");
  });

  it("the deposit is taken once per Idempotency-Key, needs the right permissions, and cannot be taken before the deposit step", async () => {
    const patient = await registerPatient(t, rec.token);
    const early = await toDesk(patient.id);
    assert.equal((await takeDeposit(early.id, "1000")).status, 409, "not at the deposit step");
    await ok(early.id, "verify", desk.token, details());
    await ok(early.id, "estimate", cashier.token, { lines: [{ description: "Package", quantity: "1", unitPrice: "20000" }] }, "put");
    await ok(early.id, "payer", cashier.token, { payer: "SELF_PAY" });
    await ok(early.id, "tariff-done", cashier.token);
    await ok(early.id, "deposit-required", cashier.token, { amount: "8000" }, "put");
    assert.equal((await takeDeposit(early.id, "1000", desk.token)).status, 403, "the desk does not take money");
    assert.equal((await t.api("post", `/planned-admissions/${early.id}/deposit`, cashier.token).send({ tenders: [{ method: "UPI", amount: "1000", reference: "UPI-123456" }] })).status, 400, "a key is needed");
    const k = key();
    const first = await takeDeposit(early.id, "3000", cashier.token, k, "UPI-REPEAT1");
    const again = await takeDeposit(early.id, "3000", cashier.token, k, "UPI-REPEAT1");
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal((await get(early.id)).deposit.held, "3000.00", "a repeat with the same key takes no second deposit");
    // Raising the amount asked, then paying the rest, clears it; the estimate stays open for billing until the bed step.
    assert.equal((await takeDeposit(early.id, "5000")).status, 201);
    const cleared = await get(early.id);
    assert.equal(cleared.status, "BED_ALLOCATION");
    assert.equal((await step(early.id, "estimate", cashier.token, { lines: [{ description: "Changed", quantity: "1", unitPrice: "1" }] }, "put")).status, 409, "no more estimate changes once the money is cleared");
  });

  // ───────────────────────── bed and the day ─────────────────────────
  it("a held bed belongs to one request; it cannot be freed by hand; changing it frees the old one; the day can be moved; and the patient is admitted on the bed that was held", async () => {
    const p1 = await toBed(( await registerPatient(t, rec.token)).id);
    const p2 = await toBed((await registerPatient(t, rec.token)).id);
    assert.equal(p1.status, "BED_ALLOCATION");
    const bed1 = await mkBed(); const bed2 = await mkBed();
    assert.equal((await step(p1.id, "bed", rec.token, { bedId: bed1.id })).status, 403, "reception does not hold beds");
    assert.equal((await step(p1.id, "bed", bedMgr.token, { bedId: randomUUID() })).status, 404);
    const r1 = await ok(p1.id, "bed", bedMgr.token, { bedId: bed1.id });
    assert.equal(r1.status, "READY");
    assert.equal((await step(p2.id, "bed", bedMgr.token, { bedId: bed1.id })).status, 409, "the bed is already held");
    // Nobody frees a held bed by hand.
    const free = await t.api("post", `/beds/${bed1.id}/status`, a.admin.token).send({ status: "AVAILABLE", reason: "Trying" });
    assert.equal(free.status, 409, JSON.stringify(free.body));
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed1.id } })).status, "RESERVED");
    // The bed can be changed while the request is ready: the old bed is free again.
    const ch = await ok(p1.id, "bed", bedMgr.token, { bedId: bed2.id });
    assert.equal(ch.bed?.id, bed2.id);
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed1.id } })).status, "AVAILABLE");
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed2.id } })).status, "RESERVED");
    assert.equal((await ok(p2.id, "bed", bedMgr.token, { bedId: bed1.id })).status, "READY");
    // The day can be moved with a reason, but not into the past.
    assert.equal((await step(p1.id, "reschedule", desk.token, { proposedDate: ymd(-2), reason: "Wrong day" })).status, 400);
    assert.equal((await step(p1.id, "reschedule", desk.token, { proposedDate: ymd(6) })).status, 400, "the reason is needed");
    assert.equal((await ok(p1.id, "reschedule", desk.token, { proposedDate: ymd(6), reason: "Patient asked for the next week" })).status, "READY");
    // A bed that was taken by someone else in the meantime is not admitted into.
    await t.prisma.$executeRawUnsafe(`UPDATE "Bed" SET status = 'OCCUPIED' WHERE id = '${bed2.id}'`);
    const bad = await step(p1.id, "admit", desk.token);
    assert.equal(bad.status, 409, JSON.stringify(bad.body));
    assert.equal((await get(p1.id)).status, "READY");
    // Bed management holds another bed, and the patient is admitted on it.
    const bed3 = await mkBed();
    assert.equal((await ok(p1.id, "bed", bedMgr.token, { bedId: bed3.id })).bed?.id, bed3.id);
    assert.equal((await ok(p1.id, "admit", desk.token)).status, "ADMITTED");
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed3.id } })).status, "OCCUPIED");
    // The patient is now admitted: another request for the same patient is refused.
    const again = await t.api("post", "/planned-admissions", rec.token).send({ patientId: (await t.prisma.plannedAdmission.findFirstOrThrow({ where: { id: p1.id } })).patientId, source: "OUTSIDE_DIRECT", consultantId: doc.practitionerId, details: "Again" });
    assert.equal(again.status, 409);
  });

  it("steps cannot be skipped or repeated, and a patient has one open request", async () => {
    const patient = await registerPatient(t, rec.token);
    const r = await t.api("post", "/planned-admissions", rec.token).send({ patientId: patient.id, source: "OUTSIDE_ARRANGED", consultantId: doc.practitionerId, details: "Arranged by phone" });
    const plan = r.body.data as Plan;
    assert.equal((await t.api("post", "/planned-admissions", rec.token).send({ patientId: patient.id, source: "OUTSIDE_DIRECT", consultantId: doc.practitionerId, details: "Second request" })).status, 409, "one open request per patient");
    for (const [path, tok, body] of [["verify", desk.token, details()], ["tariff-done", cashier.token, {}], ["bed", bedMgr.token, { bedId: randomUUID() }], ["admit", desk.token, {}], ["waive", manager.token, { reason: "Trying to skip the doctor" }], ["consent", rec.token, { consented: true }]] as const) {
      const x = await step(plan.id, path, tok, body as Record<string, unknown>);
      assert.ok([409, 404].includes(x.status), `${path} while with the doctor: ${x.status}`);
    }
    assert.equal((await step(plan.id, "doctor", doc.token, { action: "ACCEPT", ...details({ proposedDate: ymd(-1) }) })).status, 400, "the day cannot be in the past");
    assert.equal((await step(plan.id, "doctor", doc.token, { action: "ACCEPT", ...details({ wardId: randomUUID() }) })).status, 400, "unknown ward");
    // Unexpected fields are refused.
    assert.equal((await step(plan.id, "doctor", doc.token, { action: "ASK", mode: "CHAMBER", note: "Come", status: "READY" })).status, 400);
    assert.equal((await t.api("post", "/planned-admissions", rec.token).send({ patientId: patient.id, source: "OPD_ADVISED", consultantId: doc.practitionerId, details: "Spoofed source" })).status, 400);
    // Cancelling is allowed to the people who run the queue, with a reason.
    assert.equal((await step(plan.id, "cancel", nurse.token, { reason: "Nurse cancelling" })).status, 403);
    assert.equal((await step(plan.id, "cancel", rec.token, { reason: "no" })).status, 400);
    assert.equal((await ok(plan.id, "cancel", rec.token, { reason: "Patient no longer wants the surgery" })).status, "CLOSED");
  });

  it("a request cannot go to a doctor who cannot review it, and the emergency ward is not for planned admissions", async () => {
    const erOnly = await makeClinicianWith(t, a, ["ER_READ", "ER_TREAT"]);
    const patient = await registerPatient(t, rec.token);
    const bad = await t.api("post", "/planned-admissions", rec.token).send({ patientId: patient.id, source: "OUTSIDE_ARRANGED", consultantId: erOnly.practitionerId, details: "Sent to the wrong doctor" });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    const er = await t.prisma.ward.findFirstOrThrow({ where: { tenantId: a.tenantId, facilityId: a.facilityId, code: "ER" } });
    const p = await toDesk(patient.id);
    assert.equal((await step(p.id, "verify", desk.token, details({ wardId: er.id }))).status, 400, "the emergency ward is not a room category");
    assert.equal((await step(p.id, "verify", desk.token, details({ consultantId: erOnly.practitionerId }))).status, 400, "the desk cannot hand it to a doctor who cannot review");
    const q = await toBed((await registerPatient(t, rec.token)).id);
    const erBed = await t.prisma.bed.findFirstOrThrow({ where: { tenantId: a.tenantId, wardId: er.id, status: "AVAILABLE" } });
    assert.equal((await step(q.id, "bed", bedMgr.token, { bedId: erBed.id })).status, 409, "emergency beds are for emergency patients");
  });

  // ───────────────────────── safety ─────────────────────────
  it("another hospital never sees or changes a request, and every role sees only what it should", async () => {
    const patient = await registerPatient(t, rec.token);
    const p = await toDesk(patient.id);
    assert.equal((await t.api("get", `/planned-admissions/${p.id}`, bDesk.token)).status, 404);
    for (const [path, body] of [["verify", details()], ["reschedule", { proposedDate: ymd(5), reason: "Other hospital" }], ["cancel", { reason: "Other hospital cancelling" }], ["admit", {}], ["bed", { bedId: randomUUID() }]] as const) {
      assert.equal((await step(p.id, path, bDesk.token, body as Record<string, unknown>)).status, 404, `${path} of another hospital's request`);
    }
    assert.equal(((await t.api("get", "/planned-admissions", bDesk.token)).body.data as unknown[]).length, 0);
    assert.equal((await t.api("get", "/planned-admissions/summary", bDesk.token)).body.data.open, 0);
    // The nurse and the manager can look, and cannot act.
    assert.equal((await t.api("get", `/planned-admissions/${p.id}`, nurse.token)).status, 200);
    assert.equal((await t.api("get", `/planned-admissions/${p.id}`, manager.token)).status, 200);
    for (const [who, tok] of [["nurse", nurse.token], ["manager", manager.token]] as const) {
      for (const path of ["verify", "bed", "admit", "cancel", "doctor", "consent"]) assert.equal((await step(p.id, path, tok, {})).status, 403, `${who} ${path}`);
    }
    // The detail page tells each person what they may do next.
    assert.equal((await get(p.id, desk.token)).can.verify, true);
    assert.equal((await get(p.id, nurse.token)).can.verify, false);
    assert.equal((await get(p.id, doc.token)).can.verify, false);
    // The doctor of another request cannot read this one; the queue list is the same.
    assert.equal((await t.api("get", `/planned-admissions/${p.id}`, doc2.token)).status, 404);
  });

  it("the database refuses to rewrite history: the timeline is append-only, a finished request is final, the estimate is locked, and a request cannot be deleted", async () => {
    const patient = await registerPatient(t, rec.token);
    const p = await toBed(patient.id);
    const ev = await t.prisma.plannedAdmissionEvent.findFirstOrThrow({ where: { plannedId: p.id } });
    await assert.rejects(() => t.prisma.plannedAdmissionEvent.update({ where: { id: ev.id }, data: { action: "REWRITTEN" } }));
    await assert.rejects(() => t.prisma.plannedAdmissionEvent.delete({ where: { id: ev.id } }));
    await assert.rejects(() => t.prisma.plannedEstimateLine.deleteMany({ where: { plannedId: p.id } }), "the estimate is locked once the money is cleared");
    await assert.rejects(() => t.prisma.plannedAdmission.delete({ where: { id: p.id } }));
    await assert.rejects(() => t.prisma.plannedAdmission.update({ where: { id: p.id }, data: { details: "Rewritten" } }), "what the patient said never changes");
    await assert.rejects(() => t.prisma.plannedAdmission.update({ where: { id: p.id }, data: { status: "READY" } }), "a request cannot be ready without a bed");
    await ok(p.id, "cancel", desk.token, { reason: "Test: the request ends" });
    await assert.rejects(() => t.prisma.plannedAdmission.update({ where: { id: p.id }, data: { closeNote: "Edited after closing" } }), "a closed request is final");
  });

  // ───────────────────────── concurrency ─────────────────────────
  it("two requests racing for the same bed: one holds it, the other is refused; the same request admitted twice makes one admission", async () => {
    const x = await toBed((await registerPatient(t, rec.token)).id);
    const y = await toBed((await registerPatient(t, rec.token)).id);
    const bed = await mkBed();
    const [r1, r2] = await Promise.all([step(x.id, "bed", bedMgr.token, { bedId: bed.id }), step(y.id, "bed", bedMgr.token, { bedId: bed.id })]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409], `${r1.status} ${r2.status}`);
    const winner = r1.status === 200 ? x : y;
    const [a1, a2] = await Promise.all([step(winner.id, "admit", desk.token), step(winner.id, "admit", desk.token)]);
    assert.deepEqual([a1.status, a2.status].sort(), [200, 409], `${a1.status} ${a2.status}`);
    const row = await t.prisma.plannedAdmission.findFirstOrThrow({ where: { id: winner.id } });
    assert.equal(await t.prisma.admission.count({ where: { tenantId: a.tenantId, patientId: row.patientId } }), 1);
  });

  // ───────────────────────── the rest of the IPD flow is untouched ─────────────────────────
  it("the ordinary admission still works, and a planned-admitted patient is discharged through the ordinary discharge flow", async () => {
    const bed = await mkBed();
    const patient = await registerPatient(t, rec.token);
    const direct = await t.api("post", "/admissions", rec.token).send({ patientId: patient.id, consultantId: doc.practitionerId, bedId: bed.id, reason: "Walk-in admission, nothing planned" });
    assert.equal(direct.status, 201, JSON.stringify(direct.body));
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed.id } })).status, "OCCUPIED");
    assert.equal((await t.api("get", "/planned-admissions/summary", desk.token)).status, 200);
    // A bed held for a planned admission is not offered as available by the bed list.
    const p = await toBed((await registerPatient(t, rec.token)).id);
    const held = await mkBed();
    await ok(p.id, "bed", bedMgr.token, { bedId: held.id });
    const avail = (await t.api("get", "/beds?status=AVAILABLE", desk.token)).body.data as { id: string }[];
    assert.ok(!avail.some((x) => x.id === held.id), "a held bed is not available");
    const adm = await ok(p.id, "admit", desk.token);
    const full = await t.api("get", `/admissions/${adm.admission!.id}`, desk.token);
    assert.equal(full.body.data.bedHistory.length, 1);
    assert.equal(full.body.data.bedHistory[0].reason, "Planned admission");
    // It appears in the ordinary admissions list.
    const listed = (await t.api("get", "/admissions?status=ADMITTED", desk.token)).body.data as { id: string }[];
    assert.ok(listed.some((x) => x.id === adm.admission!.id));
  });
});
