import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
const key = () => `k-${randomUUID().slice(0, 18)}`;
const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;

describe("nurse requests: the nurse asks, the doctor in charge decides", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let desk: User; let erNurse: User; let icuNurse: User; let plainNurse: User; let cashier: User; let pharm: User; let hospMgr: User; let pTech: User; let path: User;
  let erDoc: TestDoctor; let icuDoc: TestDoctor; let otherDoc: TestDoctor;
  let bErNurse: User;
  let cbc: { id: string; name: string };

  const makeDoc = async (tenant: TestTenant, role: string): Promise<TestDoctor> => {
    const user = await t.makeUser(tenant, [role]);
    const department = await t.prisma.department.create({ data: { tenantId: tenant.tenantId, facilityId: tenant.facilityId, name: `Dept ${uniqueWord(5)}`, code: `D${randomBytes(3).toString("hex").toUpperCase()}` } });
    const p = await t.prisma.practitioner.create({ data: { tenantId: tenant.tenantId, facilityId: tenant.facilityId, userId: user.id, departmentId: department.id, displayName: `Dr. ${uniqueWord(6)} ${uniqueWord(7)}`, specialty: "Emergency Medicine" } });
    return { userId: user.id, token: user.token, practitionerId: p.id, departmentId: department.id };
  };
  const freeIcuBeds = async () => {
    const ids = (await t.prisma.bed.findMany({ where: { tenantId: a.tenantId, ward: { code: "ICU" } }, select: { id: true } })).map((x) => x.id);
    await t.prisma.bedAssignment.updateMany({ where: { tenantId: a.tenantId, bedId: { in: ids }, releasedAt: null }, data: { releasedAt: new Date() } });
    await t.prisma.bed.updateMany({ where: { tenantId: a.tenantId, id: { in: ids } }, data: { status: "AVAILABLE" } });
    await t.prisma.admission.updateMany({ where: { tenantId: a.tenantId, assignments: { some: { bedId: { in: ids } } }, status: "ADMITTED" }, data: { status: "DISCHARGED", dischargedAt: new Date(), dischargeType: "ROUTINE" } }).catch(() => undefined);
  };
  /** A patient in the emergency ward, called to the emergency doctor. */
  const emergency = async () => {
    const patient = await registerPatient(t, desk.token);
    const r = await t.api("post", "/emergency/cases", desk.token).set("Idempotency-Key", key()).send({ patientId: patient.id, doctorId: erDoc.practitionerId, chiefComplaint: "Breathlessness and chest pain", arrivalMode: "AMBULANCE" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { caseId: r.body.data.id as string, encounterId: r.body.data.encounterId as string };
  };
  /** The same patient after the emergency doctor handed them over to the ICU doctor. */
  const icuStay = async () => {
    await freeIcuBeds();
    const e = await emergency();
    const beds = (await t.api("get", "/emergency/beds", erDoc.token)).body.data;
    const d = await t.api("post", `/emergency/cases/${e.caseId}/decision`, erDoc.token).set("Idempotency-Key", key()).send({ disposition: "ICU", bedId: beds.ICU.find((x: { free: boolean }) => x.free).id, consultantId: icuDoc.practitionerId, note: "Needs ventilation" });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    return { ...e, admissionId: d.body.data.admission.id as string };
  };
  const ask = (tok: string, body: Record<string, unknown>) => t.api("post", "/order-requests", tok).send(body);
  const testReq = (encounterId: string, o: Record<string, unknown> = {}) => ({ kind: "TEST", encounterId, tests: [{ serviceId: cbc.id }], ...o });
  const medReq = (encounterId: string, name = "Paracetamol") => ({ kind: "MEDICINE", encounterId, item: { genericName: name, strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3 } });
  const decide = (tok: string, id: string, body: Record<string, unknown>) => t.api("post", `/order-requests/${id}/decision`, tok).send(body);
  const list = async (tok: string, encounterId: string) => (await t.api("get", `/order-requests?encounterId=${encounterId}`, tok)).body.data as { id: string; status: string; summary: string; kind: string }[];
  const notes = async (tok: string) => (await t.api("get", "/notifications", tok)).body.data as { type: string; entityId: string }[];

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("req-a"); b = await t.makeTenant("req-b");
    desk = await t.makeUser(a, ["EMERGENCY_RECEPTIONIST"]); erNurse = await t.makeUser(a, ["EMERGENCY_NURSE"]); icuNurse = await t.makeUser(a, ["ICU_NURSE"]); plainNurse = await t.makeUser(a, ["NURSE"]);
    cashier = await t.makeUser(a, ["CASHIER"]); pharm = await t.makeUser(a, ["PHARMACIST"]); hospMgr = await t.makeUser(a, ["MANAGER"]); pTech = await t.makeUser(a, ["P_LAB_TECH"]); path = await t.makeUser(a, ["PATHOLOGIST"]);
    erDoc = await makeDoc(a, "EMERGENCY_DOCTOR"); icuDoc = await makeDoc(a, "ICU_DOCTOR"); otherDoc = await makeDoc(a, "EMERGENCY_DOCTOR");
    bErNurse = await t.makeUser(b, ["EMERGENCY_NURSE"]);
    cbc = (await t.api("post", "/services", a.admin.token).send({ code: code("T"), name: "Complete blood count", category: "INVESTIGATION", price: "250", taxPercent: 0 })).body.data;
    const def = await t.api("put", `/lab/tests/${cbc.id}`, path.token).send({ specimen: "Blood (EDTA)", turnaroundHours: 4, instructions: "None", parameters: [{ name: "Haemoglobin", unit: "g/dL", type: "NUMERIC", decimals: 1, lowMale: 13.5, highMale: 17.5, lowFemale: 12, highFemale: 15.5, criticalLow: 7, criticalHigh: 20 }] });
    assert.equal(def.status, 200, JSON.stringify(def.body));
    void pTech; void pharm;
  });
  after(async () => { await t.close(); });

  it("the emergency nurse asks for a test: nothing reaches the laboratory until the doctor accepts, and then it is ordered as an emergency test in the doctor's name", async () => {
    const e = await emergency();
    const made = await ask(erNurse.token, testReq(e.encounterId, { note: "Suspected cardiac event" }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.data.status, "PENDING");
    assert.match(made.body.data.summary, /Complete blood count/);
    assert.equal(await t.prisma.limsRequest.count({ where: { tenantId: a.tenantId, encounterId: e.encounterId } }), 0, "the laboratory has not been asked yet");
    assert.ok((await notes(erDoc.token)).some((n) => n.type === "ORDER_REQUESTED" && n.entityId === e.caseId), "the doctor is told");
    assert.equal((await list(erDoc.token, e.encounterId)).length, 1);
    assert.equal((await list(erNurse.token, e.encounterId))[0]?.status, "PENDING");
    // The nurse cannot decide her own request; another doctor does not see it; the manager has no say.
    assert.equal((await decide(erNurse.token, made.body.data.id, { action: "ACCEPT" })).status, 403);
    assert.equal((await decide(otherDoc.token, made.body.data.id, { action: "ACCEPT" })).status, 404, "another doctor does not even see it");
    assert.equal((await decide(hospMgr.token, made.body.data.id, { action: "ACCEPT" })).status, 403);
    const ok = await decide(erDoc.token, made.body.data.id, { action: "ACCEPT" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, "ACCEPTED");
    const lab = await t.prisma.limsRequest.findMany({ where: { tenantId: a.tenantId, encounterId: e.encounterId } });
    assert.equal(lab.length, 1);
    assert.equal(lab[0]?.priority, "EMERGENCY");
    assert.ok((await notes(erNurse.token)).some((n) => n.type === "ORDER_REQUEST_DECIDED"), "the nurse is told");
    assert.equal((await decide(erDoc.token, made.body.data.id, { action: "ACCEPT" })).status, 409, "decided once");
    assert.equal(await t.prisma.limsRequest.count({ where: { tenantId: a.tenantId, encounterId: e.encounterId } }), 1, "a second accept orders nothing more");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ORDER_REQUEST_ACCEPTED", entityId: made.body.data.id } }));
  });

  it("a medicine request goes on the doctor's draft prescription, keeping what is already there, and is not signed or sent to the pharmacy until the doctor signs", async () => {
    const e = await emergency();
    assert.equal((await t.api("put", `/encounters/${e.encounterId}/prescription`, erDoc.token).send({ items: [{ genericName: "Ondansetron", dosage: "4 mg", route: "IV", frequency: "STAT" }] })).status, 200);
    const made = await ask(erNurse.token, medReq(e.encounterId));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const ok = await decide(erDoc.token, made.body.data.id, { action: "ACCEPT" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const rx = (await t.api("get", `/encounters/${e.encounterId}/prescription`, erDoc.token)).body.data.orders as { status: string; items: { genericName: string }[] }[];
    const draft = rx.find((o) => o.status === "DRAFT");
    assert.deepEqual(draft?.items.map((i) => i.genericName), ["Ondansetron", "Paracetamol"], "the doctor's own line stays, the request is added");
    assert.equal(rx.filter((o) => o.status === "SIGNED").length, 0, "nothing is signed by accepting");
    const sign = await t.api("post", `/encounters/${e.encounterId}/prescription/sign`, erDoc.token).send({});
    assert.equal(sign.status, 200, JSON.stringify(sign.body));
  });

  it("declining needs a reason and tells the nurse; the nurse can withdraw only her own waiting request", async () => {
    const e = await emergency();
    const one = (await ask(erNurse.token, medReq(e.encounterId, "Aspirin"))).body.data;
    assert.equal((await decide(erDoc.token, one.id, { action: "DECLINE" })).status, 400, "a reason is needed");
    const no = await decide(erDoc.token, one.id, { action: "DECLINE", note: "Patient is allergic to aspirin" });
    assert.equal(no.status, 200, JSON.stringify(no.body));
    assert.equal(no.body.data.status, "DECLINED");
    assert.equal(no.body.data.decisionNote, "Patient is allergic to aspirin");
    assert.equal(await t.prisma.medicationOrder.count({ where: { tenantId: a.tenantId, encounterId: e.encounterId } }), 0, "a declined request puts nothing on the prescription");
    const two = (await ask(erNurse.token, testReq(e.encounterId))).body.data;
    assert.equal((await t.api("post", `/order-requests/${two.id}/cancel`, icuNurse.token)).status, 403, "another nurse cannot withdraw it");
    const gone = await t.api("post", `/order-requests/${two.id}/cancel`, erNurse.token);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.data.status, "CANCELLED");
    assert.equal((await t.api("post", `/order-requests/${two.id}/cancel`, erNurse.token)).status, 409);
    assert.equal((await decide(erDoc.token, two.id, { action: "ACCEPT" })).status, 409, "a withdrawn request cannot be accepted");
  });

  it("the ICU nurse asks the ICU doctor, and only for a patient in the ICU; each nurse is kept to her own ward", async () => {
    const s = await icuStay();
    const made = await ask(icuNurse.token, medReq(s.encounterId, "Noradrenaline"));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.ok((await notes(icuDoc.token)).some((n) => n.type === "ORDER_REQUESTED" && n.entityId === s.admissionId), "the ICU doctor is told");
    assert.equal((await decide(erDoc.token, made.body.data.id, { action: "ACCEPT" })).status, 404, "the emergency doctor handed the patient over");
    assert.equal((await decide(icuDoc.token, made.body.data.id, { action: "ACCEPT" })).status, 200);
    // The emergency nurse cannot ask for the ICU patient, and the ICU nurse cannot ask for a patient in the emergency ward.
    assert.equal((await ask(erNurse.token, testReq(s.encounterId))).status, 404);
    const e = await emergency();
    assert.equal((await ask(icuNurse.token, testReq(e.encounterId))).status, 404);
    assert.equal(await t.prisma.orderRequest.count({ where: { tenantId: a.tenantId, encounterId: e.encounterId } }), 0);
  });

  it("an unsigned draft prescription goes with the patient: the ICU doctor gets the emergency doctor's draft to review and sign, and can accept new requests", async () => {
    await freeIcuBeds();
    const e = await emergency();
    const req = (await ask(erNurse.token, medReq(e.encounterId, "Aspirin"))).body.data;
    assert.equal((await decide(erDoc.token, req.id, { action: "ACCEPT" })).status, 200);
    const beds = (await t.api("get", "/emergency/beds", erDoc.token)).body.data;
    const d = await t.api("post", `/emergency/cases/${e.caseId}/decision`, erDoc.token).set("Idempotency-Key", key()).send({ disposition: "ICU", bedId: beds.ICU.find((x: { free: boolean }) => x.free).id, consultantId: icuDoc.practitionerId, note: "Needs monitoring" });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const orders = await t.prisma.medicationOrder.findMany({ where: { tenantId: a.tenantId, encounterId: e.encounterId }, include: { items: true } });
    assert.equal(orders.filter((o) => o.status === "CANCELLED").length, 1, "the emergency doctor's draft is closed");
    const mine = orders.find((o) => o.status === "DRAFT");
    assert.equal(mine?.orderedById, icuDoc.userId, "the ICU doctor now holds the draft");
    assert.deepEqual(mine?.items.map((i) => i.genericName), ["Aspirin"]);
    const more = (await ask(icuNurse.token, medReq(e.encounterId, "Noradrenaline"))).body.data;
    const ok = await decide(icuDoc.token, more.id, { action: "ACCEPT" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const rx = (await t.api("get", `/encounters/${e.encounterId}/prescription`, icuDoc.token)).body.data.orders as { status: string; items: { genericName: string }[] }[];
    assert.deepEqual(rx.find((o) => o.status === "DRAFT")?.items.map((i) => i.genericName), ["Aspirin", "Noradrenaline"]);
    assert.equal((await t.api("post", `/encounters/${e.encounterId}/prescription/sign`, icuDoc.token).send({})).status, 200);
  });

  it("who may do what, and what the database keeps", async () => {
    const e = await emergency();
    for (const [tok, who] of [[plainNurse.token, "ordinary nurse"], [cashier.token, "cashier"], [desk.token, "emergency desk"], [hospMgr.token, "manager"], [erDoc.token, "doctor"]] as const) {
      assert.equal((await ask(tok, testReq(e.encounterId))).status, 403, `${who} cannot make a request`);
    }
    assert.equal((await t.api("get", `/order-requests?encounterId=${e.encounterId}`, cashier.token)).status, 403);
    assert.equal((await ask(bErNurse.token, testReq(e.encounterId))).status, 404, "another hospital");
    assert.equal((await ask(erNurse.token, { ...testReq(e.encounterId), status: "ACCEPTED" })).status, 400, "no status injection");
    assert.equal((await ask(erNurse.token, { ...testReq(e.encounterId), tenantId: b.tenantId })).status, 400, "no tenant injection");
    assert.equal((await ask(erNurse.token, testReq(e.encounterId, { tests: [{ serviceId: randomUUID() }] }))).status, 400, "unknown test");
    assert.equal((await ask(erNurse.token, testReq(e.encounterId, { tests: [] }))).status, 400);
    assert.equal((await ask(erNurse.token, { kind: "MEDICINE", encounterId: e.encounterId, item: { genericName: "X" } })).status, 400);
    assert.equal((await ask(erNurse.token, testReq(randomUUID()))).status, 404);
    const mine = (await ask(erNurse.token, testReq(e.encounterId))).body.data;
    assert.equal((await t.api("get", `/order-requests?encounterId=${e.encounterId}`, bErNurse.token)).body.data.length, 0, "another hospital sees nothing");
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "OrderRequest" SET summary = 'changed' WHERE id = ${mine.id}::uuid`, /cannot be rewritten/);
    await assert.rejects(() => t.prisma.$executeRaw`DELETE FROM "OrderRequest" WHERE id = ${mine.id}::uuid`);
    assert.equal((await decide(erDoc.token, mine.id, { action: "ACCEPT", extra: 1 })).status, 400);
    assert.equal((await decide(erDoc.token, randomUUID(), { action: "ACCEPT" })).status, 404);
    // Once the case is closed (sent home), the nurse can no longer ask.
    const out = await t.api("post", `/emergency/cases/${e.caseId}/decision`, erDoc.token).set("Idempotency-Key", key()).send({ disposition: "DISCHARGE", note: "Fine to go home" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal((await ask(erNurse.token, testReq(e.encounterId))).status, 404);
  });
});
