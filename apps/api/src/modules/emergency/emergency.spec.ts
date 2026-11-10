import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
const key = () => `k-${randomUUID().slice(0, 18)}`;
const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;

describe("emergency ward: arrival, triage, treatment, billing and the decision", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let desk: User; let erNurse: User; let plainNurse: User; let pharm: User; let cashier: User; let reception: User; let pTech: User; let path: User; let mgr: User;
  let doc: TestDoctor; let doc2: TestDoctor;
  let bDesk: User; let bNurse: User; let bDoc: TestDoctor;
  let cbc: { id: string; name: string }; let hb: string;
  let medicine: { id: string; genericName: string; brandName: string };
  let batchId: string;

  const get = async (path_: string, tok: string) => (await t.api("get", path_, tok)).body.data;
  const notes = async (tok: string) => (await t.api("get", "/notifications", tok)).body.data as { type: string; entityId: string }[];
  const alerts = async (tok: string) => (await t.api("get", "/emergency/alerts", tok)).body.data as { id: string; action: string }[];
  const caseOf = async (id: string, tok = doc.token) => (await t.api("get", `/emergency/cases/${id}`, tok)).body.data;
  const register = (patientId: string, o: Record<string, unknown> = {}, tok = desk.token, doctor = doc, k = key()) =>
    t.api("post", "/emergency/cases", tok).set("Idempotency-Key", k).send({ patientId, doctorId: doctor.practitionerId, chiefComplaint: "Road accident, bleeding from the head", arrivalMode: "AMBULANCE", ...o });
  const arrive = async (o: Record<string, unknown> = {}) => {
    const patient = await registerPatient(t, desk.token);
    const r = await register(patient.id, o);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient, id: r.body.data.id as string, encounterId: r.body.data.encounterId as string, body: r.body.data };
  };
  const triage = (id: string, o: Record<string, unknown> = {}, tok = erNurse.token) =>
    t.api("post", `/emergency/cases/${id}/triage`, tok).send({ level: "RED", consciousness: "PAIN", airwayClear: true, breathingOk: false, circulationOk: true, painScore: 8, note: "Bleeding controlled with pressure", ...o });
  const decide = (id: string, o: Record<string, unknown>, tok = doc.token, k = key()) => t.api("post", `/emergency/cases/${id}/decision`, tok).set("Idempotency-Key", k).send({ note: "Needs immediate care", ...o });
  const beds = async (tok = doc.token) => (await t.api("get", "/emergency/beds", tok)).body.data as { OT: { id: string; free: boolean; code: string }[]; ICU: { id: string; free: boolean; code: string }[] };
  /** The theatre and the ICU hold only a few beds, so a test that needs one starts with every one of them free again. */
  const freeBeds = async () => {
    const ids = (await t.prisma.bed.findMany({ where: { tenantId: a.tenantId, ward: { code: { in: ["OT", "ICU"] } } }, select: { id: true } })).map((x) => x.id);
    await t.prisma.bedAssignment.updateMany({ where: { tenantId: a.tenantId, bedId: { in: ids }, releasedAt: null }, data: { releasedAt: new Date() } });
    await t.prisma.bed.updateMany({ where: { tenantId: a.tenantId, id: { in: ids } }, data: { status: "AVAILABLE" } });
  };
  const freeBed = async (ward: "OT" | "ICU") => { const b_ = (await beds())[ward].find((x) => x.free); assert.ok(b_, `a free ${ward} bed`); return b_.id; };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("er-a");
    b = await t.makeTenant("er-b");
    desk = await t.makeUser(a, ["EMERGENCY_RECEPTIONIST"]); erNurse = await t.makeUser(a, ["EMERGENCY_NURSE"]); plainNurse = await t.makeUser(a, ["NURSE"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]); cashier = await t.makeUser(a, ["CASHIER"]); reception = await t.makeUser(a, ["RECEPTIONIST"]);
    pTech = await t.makeUser(a, ["P_LAB_TECH"]); path = await t.makeUser(a, ["PATHOLOGIST"]); mgr = await t.makeUser(a, ["LIMS_MANAGER"]);
    doc = await makeDoctor(t, a); doc2 = await makeDoctor(t, a);
    bDesk = await t.makeUser(b, ["EMERGENCY_RECEPTIONIST"]); bNurse = await t.makeUser(b, ["EMERGENCY_NURSE"]); bDoc = await makeDoctor(t, b);
    assert.equal((await t.api("put", "/settings/EMERGENCY_FEE_AMOUNT", a.admin.token).send({ value: "500.00" })).status, 200);
    cbc = (await t.api("post", "/services", a.admin.token).send({ code: code("T"), name: "Complete blood count", category: "INVESTIGATION", price: "250", taxPercent: 0 })).body.data;
    const def = await t.api("put", `/lab/tests/${cbc.id}`, path.token).send({
      specimen: "Blood (EDTA)", turnaroundHours: 4, instructions: "No fasting is needed.",
      parameters: [{ name: "Haemoglobin", unit: "g/dL", type: "NUMERIC", decimals: 1, lowMale: 13.5, highMale: 17.5, lowFemale: 12, highFemale: 15.5, criticalLow: 7, criticalHigh: 20 }],
    });
    assert.equal(def.status, 200, JSON.stringify(def.body));
    hb = def.body.data.definition.parameters[0].id as string;
    const m = await t.api("post", "/medicines", pharm.token).send({ brandName: `Brand${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "500 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 5 });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    medicine = m.body.data;
    const batch = await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId: medicine.id, batchNo: code("B"), expiryDate: ymd(365), mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50", quantity: 500 });
    assert.equal(batch.status, 201, JSON.stringify(batch.body));
    batchId = batch.body.data.id;
  });
  after(async () => { await t.close(); });

  describe("the whole journey", () => {
    it("registers the patient, alerts the emergency nurses and the doctor, opens the bill, and the doctor sees the nurse's vitals", async () => {
      const { patient, id, encounterId, body } = await arrive();
      assert.equal(body.status, "ARRIVED");
      assert.equal(body.needsTriage, true);
      assert.match(body.caseNumber, /^ER-/);
      // The bill is open from the first moment, with the emergency fee on it.
      assert.equal(body.bill.hasOpenBill, true);
      assert.equal(body.bill.openTotal, "500.00");
      assert.equal((await t.prisma.encounter.findFirstOrThrow({ where: { id: encounterId } })).type, "EMERGENCY");

      // The red alert: the emergency nurse and the doctor who was called; nobody else.
      assert.ok((await notes(erNurse.token)).some((n) => n.type === "EMERGENCY_ARRIVAL" && n.entityId === id), "emergency nurse alerted");
      assert.ok((await notes(doc.token)).some((n) => n.type === "EMERGENCY_ARRIVAL" && n.entityId === id), "called doctor alerted");
      assert.ok(!(await notes(plainNurse.token)).some((n) => n.type === "EMERGENCY_ARRIVAL"), "an ordinary nurse is not alerted");
      assert.ok(!(await notes(doc2.token)).some((n) => n.type === "EMERGENCY_ARRIVAL"), "another doctor is not alerted");
      assert.ok(!(await notes(desk.token)).some((n) => n.type === "EMERGENCY_ARRIVAL"), "the desk is not alerted about its own registration");
      assert.deepEqual((await alerts(erNurse.token)).filter((x) => x.id === id).map((x) => x.action), ["TRIAGE"]);
      assert.deepEqual((await alerts(doc.token)).filter((x) => x.id === id).map((x) => x.action), ["ACCEPT"]);
      assert.equal((await alerts(doc2.token)).length, 0);

      // The nurse triages: the alert for the nurses ends, the doctor is told, and the level shows.
      const tr = await triage(id);
      assert.equal(tr.status, 201, JSON.stringify(tr.body));
      assert.equal(tr.body.data.status, "TRIAGED");
      assert.equal(tr.body.data.triageLevel, "RED");
      assert.equal(tr.body.data.triages.length, 1);
      assert.equal((await alerts(erNurse.token)).filter((x) => x.id === id).length, 0);
      assert.ok((await notes(doc.token)).some((n) => n.type === "EMERGENCY_TRIAGED" && n.entityId === id));

      // The nurse takes the vitals on the visit; the doctor's view of the case shows them.
      const v = await t.api("post", `/encounters/${encounterId}/observations`, erNurse.token).send({ observations: [{ type: "SYSTOLIC_BP", value: 90 }, { type: "DIASTOLIC_BP", value: 60 }, { type: "PULSE", value: 118 }, { type: "SPO2", value: 91 }] });
      assert.equal(v.status, 201, JSON.stringify(v.body));
      const seen = await caseOf(id);
      const byType = Object.fromEntries((seen.vitals as { type: string; value: string }[]).map((x) => [x.type, x.value]));
      assert.equal(byType["PULSE"], "118");
      assert.equal(byType["SPO2"], "91");
      assert.equal(seen.patient.id, patient.id);

      // The doctor accepts; the doctor's alert ends. A second accept changes nothing.
      const acc = await t.api("post", `/emergency/cases/${id}/accept`, doc.token);
      assert.equal(acc.status, 200, JSON.stringify(acc.body));
      assert.equal(acc.body.data.status, "IN_TREATMENT");
      assert.equal((await t.api("post", `/emergency/cases/${id}/accept`, doc.token)).status, 200);
      assert.equal((await alerts(doc.token)).filter((x) => x.id === id).length, 0);
    });

    it("medicines go to the pharmacy and onto the emergency bill, and a return before the bill is issued takes them off it", async () => {
      const { patient, id, encounterId } = await arrive();
      await t.api("post", `/emergency/cases/${id}/accept`, doc.token);
      const draft = await t.api("put", `/encounters/${encounterId}/prescription`, doc.token).send({ items: [{ medicineId: medicine.id, genericName: medicine.genericName, strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3, quantity: 9 }] });
      assert.equal(draft.status, 200, JSON.stringify(draft.body));
      const sign = await t.api("post", `/encounters/${encounterId}/prescription/sign`, doc.token).send({});
      assert.equal(sign.status, 200, JSON.stringify(sign.body));
      const orderId = sign.body.data.id as string;
      const itemId = sign.body.data.items[0].id as string;
      assert.ok((await notes(pharm.token)).some((n) => n.type === "PRESCRIPTION_AT_PHARMACY" && n.entityId === orderId), "the pharmacy is told");
      assert.equal((await caseOf(id)).medicines.pendingAtPharmacy, 1);

      const d = await t.api("post", "/pharmacy/dispenses", pharm.token).set("Idempotency-Key", key()).send({ patientId: patient.id, medicationOrderId: orderId, items: [{ medicationOrderItemId: itemId, medicineId: medicine.id, quantity: 9 }] });
      assert.equal(d.status, 201, JSON.stringify(d.body));
      const dispenseId = d.body.data.dispense.id as string;
      const c = await caseOf(id);
      assert.equal(c.bill.openTotal, "585.50", "500.00 fee + 9 x 9.50 of medicines");
      assert.equal(c.medicines.pendingAtPharmacy, 0);
      assert.equal((await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId } })).quantity, 491, "the stock ledger took the nine tablets out");
      // One open bill, not a separate counter bill, and the cashiers are not asked to collect a pharmacy bill.
      const invoices = await t.prisma.invoice.findMany({ where: { encounterId } });
      assert.equal(invoices.length, 1);
      assert.equal(invoices[0]?.kind, "EMERGENCY");
      assert.equal(invoices[0]?.status, "DRAFT");
      assert.ok(!(await notes(cashier.token)).some((n) => n.type === "PHARMACY_BILL_WAITING"));

      // Three tablets come back before the bill is issued: they leave the bill.
      const lineId = (await t.prisma.dispenseItem.findFirstOrThrow({ where: { dispenseId } })).id;
      const ret = await t.api("post", `/pharmacy/dispenses/${dispenseId}/returns`, pharm.token).set("Idempotency-Key", key()).send({ reason: "Not needed any more", items: [{ dispenseItemId: lineId, quantity: 3 }] });
      assert.equal(ret.status, 201, JSON.stringify(ret.body));
      assert.equal((await caseOf(id)).bill.openTotal, "557.00", "500.00 + 6 x 9.50");
      assert.equal((await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId } })).quantity, 494, "the three returned tablets are back in stock");
    });

    it("tests ordered by the doctor are emergency tests in the laboratory, taken by the emergency nurse, and go on the emergency bill when the report is issued", async () => {
      const { id, encounterId } = await arrive();
      await t.api("post", `/emergency/cases/${id}/accept`, doc.token);
      const o = await t.api("post", "/lims/orders", doc.token).send({ encounterId, tests: [{ name: cbc.name, category: "LABORATORY" }] });
      assert.equal(o.status, 201, JSON.stringify(o.body));
      assert.equal(o.body.data.routedToLab, true);
      assert.equal(o.body.data.priority, "EMERGENCY");
      assert.equal(o.body.data.nurseAssigned, erNurse.id, "an emergency nurse takes the sample");
      let req = (await get("/lims/requests?department=PATHOLOGY&pageSize=100", mgr.token)).items.find((r: { encounterId: string }) => r.encounterId === encounterId);
      assert.ok(req);
      assert.equal(req.origin, "EMERGENCY");
      assert.equal(req.priority, "EMERGENCY");
      assert.equal((await caseOf(id)).tests.pending, 1);
      // The cashier is not asked to bill it separately.
      assert.ok(!JSON.stringify(await get("/test-orders/queue", cashier.token)).includes(encounterId), "not on the cashier's list of tests to bill");

      // The laboratory does the work as for any patient.
      const step = async (s: string, tok: string, body: Record<string, unknown> = {}) => { const r = await t.api("post", `/lims/requests/${req.id}/${s}`, tok).send(body); assert.equal(r.status, 200, `${s}: ${JSON.stringify(r.body)}`); };
      const fresh = async () => (await get("/lims/requests?department=PATHOLOGY&pageSize=100", mgr.token)).items.find((r: { id: string }) => r.id === req.id);
      await step("collect", erNurse.token);
      await step("accept", pTech.token);
      req = await fresh();
      assert.equal((await t.api("put", `/lab/results/${req.resultId}/draft`, pTech.token).send({ version: req.resultVersion, values: [{ parameterId: hb, value: "13.2" }] })).status, 200);
      await step("submit", pTech.token);
      req = await fresh();
      assert.equal((await t.api("post", `/lab/results/${req.resultId}/verify`, path.token).send({ version: req.resultVersion })).status, 200);
      await step("issue", pTech.token);
      const c = await caseOf(id);
      assert.equal(c.tests.issued, 1);
      assert.equal(c.bill.openTotal, "750.00", "500.00 fee + 250.00 test");
      assert.ok(c.bill.invoices[0].lines.some((l: { description: string }) => l.description.startsWith("Complete blood count")));
    });

    it("the desk adds a charge to the bill, issues it, and takes the payment with the ordinary billing", async () => {
      const { id, encounterId } = await arrive();
      const service = (await t.api("post", "/services", a.admin.token).send({ code: code("S"), name: "Wound suturing", category: "PROCEDURE", price: "700", taxPercent: 0 })).body.data;
      assert.equal((await t.api("post", `/emergency/cases/${id}/bill/charges`, desk.token).send({ serviceId: service.id })).status, 201);
      const manual = await t.api("post", `/emergency/cases/${id}/bill/charges`, desk.token).send({ description: "Ambulance oxygen", unitPrice: "150", quantity: 2 });
      assert.equal(manual.status, 201, JSON.stringify(manual.body));
      assert.equal(manual.body.data.bill.openTotal, "1500.00", "500 + 700 + 2 x 150");
      // A doctor or nurse cannot add charges; only the desk can.
      assert.equal((await t.api("post", `/emergency/cases/${id}/bill/charges`, erNurse.token).send({ description: "Extra", unitPrice: "10" })).status, 403);
      const issued = await t.api("post", `/emergency/cases/${id}/bill/issue`, desk.token);
      assert.equal(issued.status, 200, JSON.stringify(issued.body));
      assert.equal(issued.body.data.bill.hasOpenBill, false);
      assert.equal(issued.body.data.bill.dueTotal, "1500.00");
      const inv = issued.body.data.bill.invoices[0];
      assert.match(inv.invoiceNumber, /^INV-/);
      // Split payment at the desk.
      const pay = await t.api("post", `/invoices/${inv.id}/payments`, desk.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: "1000.00" }, { method: "UPI", amount: "500.00", reference: "UPI-ER-0001" }] });
      assert.equal(pay.status, 201, JSON.stringify(pay.body));
      assert.equal((await caseOf(id, desk.token)).bill.dueTotal, "0.00");
      // The issued bill cannot be changed; a later charge opens a new open bill.
      assert.equal((await t.api("post", `/emergency/cases/${id}/bill/issue`, desk.token)).status, 409, "nothing left to issue");
      assert.equal((await t.api("post", `/emergency/cases/${id}/bill/charges`, desk.token).send({ description: "Dressing", unitPrice: "100" })).status, 201);
      assert.equal((await caseOf(id, desk.token)).bill.openTotal, "100.00");
      assert.equal((await t.prisma.invoice.findMany({ where: { encounterId, kind: "EMERGENCY" } })).length, 2);
    });
  });

  describe("the doctor's decision", () => {
    it("sends the patient to the ICU: admitted to that bed on the same record, the bill is issued, and the case is closed", async () => {
      await freeBeds();
      const { patient, id, encounterId } = await arrive();
      await t.api("post", `/emergency/cases/${id}/accept`, doc.token);
      const bedId = await freeBed("ICU");
      const r = await decide(id, { disposition: "ICU", bedId });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.status, "HANDED_OVER");
      assert.equal(r.body.data.disposition, "ICU");
      assert.ok(r.body.data.admission.id);
      assert.match(r.body.data.admission.bed, /ICU/);
      const enc = await t.prisma.encounter.findFirstOrThrow({ where: { id: encounterId } });
      assert.equal(enc.type, "IPD", "the emergency visit became the inpatient visit");
      const adm = await t.prisma.admission.findFirstOrThrow({ where: { id: r.body.data.admission.id } });
      assert.equal(adm.encounterId, encounterId);
      assert.equal(adm.patientId, patient.id);
      assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bedId } })).status, "OCCUPIED");
      // The emergency fee is frozen on an issued bill, to be paid at the desk.
      assert.equal(r.body.data.bill.hasOpenBill, false);
      assert.equal(r.body.data.bill.dueTotal, "500.00");
      // The doctor sees the admission; the desk and the nurses are told; the closed case takes nothing more.
      assert.equal((await t.api("get", `/admissions/${adm.id}`, doc.token)).status, 200);
      assert.ok((await notes(desk.token)).some((n) => n.type === "EMERGENCY_DECISION" && n.entityId === id));
      assert.ok((await notes(erNurse.token)).some((n) => n.type === "EMERGENCY_DECISION" && n.entityId === id));
      assert.equal((await t.api("post", `/emergency/cases/${id}/notes`, doc.token).send({ text: "More notes" })).status, 409);
      assert.equal((await decide(id, { disposition: "DISCHARGE" })).status, 409, "a closed case cannot be decided again");
      // The audit trail names the decision.
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "EMERGENCY_DECISION", entityId: id } }));
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ENCOUNTER_BECAME_INPATIENT", entityId: encounterId } }));
    });

    it("sends the patient to the OT, only to a bed of the operation theatre", async () => {
      await freeBeds();
      const { id } = await arrive();
      const icuBed = await freeBed("ICU");
      assert.equal((await decide(id, { disposition: "OT", bedId: icuBed })).status, 400, "an ICU bed is not an OT bed");
      assert.equal((await decide(id, { disposition: "OT" })).status, 400, "a bed is needed");
      assert.equal((await decide(id, { disposition: "DISCHARGE", bedId: icuBed })).status, 400, "going home needs no bed");
      const r = await decide(id, { disposition: "OT", bedId: await freeBed("OT") });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.match(r.body.data.admission.bed, /OT/);
    });

    it("sends the patient home: the visit ends, nothing is admitted, and what is owed stays on an issued bill", async () => {
      const { id, encounterId } = await arrive();
      const r = await decide(id, { disposition: "DISCHARGE", note: "Minor injury, dressed and advised" });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.status, "DISCHARGED");
      assert.equal(r.body.data.admission, null);
      assert.equal((await t.prisma.encounter.findFirstOrThrow({ where: { id: encounterId } })).status, "COMPLETED");
      assert.equal(r.body.data.bill.dueTotal, "500.00");
    });

    it("a replayed decision changes nothing twice; the same bed cannot go to two patients at once", async () => {
      await freeBeds();
      const x = await arrive(); const y = await arrive();
      const bedId = await freeBed("ICU");
      const k = key();
      const first = await decide(x.id, { disposition: "ICU", bedId }, doc.token, k);
      const again = await decide(x.id, { disposition: "ICU", bedId }, doc.token, k);
      assert.equal(first.status, 201); assert.equal(again.status, 200);
      assert.equal(again.body.data.admission.id, first.body.data.admission.id);
      assert.equal((await t.prisma.admission.count({ where: { encounterId: x.encounterId } })), 1);
      // The bed is now taken.
      const busy = await decide(y.id, { disposition: "ICU", bedId });
      assert.equal(busy.status, 409);
      assert.equal(busy.body.error.code, "BED_NOT_AVAILABLE");
      // Two cases racing for the same free bed: exactly one wins.
      const p = await arrive(); const q = await arrive();
      const results = await Promise.all([decide(p.id, { disposition: "ICU", bedId: await freeBed("ICU") }), decide(q.id, { disposition: "ICU", bedId: await freeBed("ICU") })]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    });
  });

  describe("who may do what, and what the database keeps", () => {
    it("each step belongs to one role", async () => {
      const patient = await registerPatient(t, desk.token);
      for (const [tok, who] of [[reception.token, "reception"], [erNurse.token, "emergency nurse"], [doc.token, "doctor"], [plainNurse.token, "ordinary nurse"], [cashier.token, "cashier"]] as const) {
        assert.equal((await register(patient.id, {}, tok)).status, 403, `${who} cannot register an emergency arrival`);
      }
      const { id } = await arrive();
      assert.equal((await triage(id, {}, desk.token)).status, 403, "the desk does not triage");
      assert.equal((await triage(id, {}, doc.token)).status, 403, "a doctor does not triage");
      assert.equal((await triage(id, {}, plainNurse.token)).status, 403, "an ordinary nurse does not triage");
      assert.equal((await t.api("post", `/emergency/cases/${id}/accept`, desk.token)).status, 403);
      assert.equal((await decide(id, { disposition: "DISCHARGE" }, desk.token)).status, 403, "the desk does not decide");
      assert.equal((await decide(id, { disposition: "DISCHARGE" }, erNurse.token)).status, 403, "the nurse does not decide");
      assert.equal((await t.api("get", "/emergency/cases", reception.token)).status, 403, "ordinary reception does not see the emergency board");
      assert.equal((await t.api("get", "/emergency/cases", plainNurse.token)).status, 403);
      assert.equal((await t.api("get", "/emergency/cases", desk.token)).status, 200);
      // The emergency desk handles emergencies only: no appointments, no OPD queue.
      assert.equal((await t.api("get", "/appointments", desk.token)).status, 403);
      assert.equal((await t.api("get", "/queue", desk.token)).status, 403);
    });

    it("only the doctor who was called can accept, write notes or decide; another doctor does not even see the case", async () => {
      const { id } = await arrive();
      assert.equal((await t.api("post", `/emergency/cases/${id}/accept`, doc2.token)).status, 404);
      assert.equal((await t.api("post", `/emergency/cases/${id}/notes`, doc2.token).send({ text: "I looked at the patient" })).status, 404);
      assert.equal((await decide(id, { disposition: "DISCHARGE" }, doc2.token)).status, 404);
      assert.equal((await t.api("get", `/emergency/cases/${id}`, doc2.token)).status, 404);
      const board = (await get("/emergency/cases", doc2.token)).length ?? 0;
      assert.equal(board, 0, "the other doctor's board has no cases");
      // The called doctor's note is recorded (and is also the acceptance); the nurse cannot write the doctor's notes.
      const n = await t.api("post", `/emergency/cases/${id}/notes`, doc.token).send({ text: "Head injury, GCS 13, no limb weakness", diagnosis: "Head injury" });
      assert.equal(n.status, 201, JSON.stringify(n.body));
      assert.equal(n.body.data.status, "IN_TREATMENT");
      assert.equal(n.body.data.notes[0].diagnosis, "Head injury");
      assert.equal((await t.api("post", `/emergency/cases/${id}/notes`, erNurse.token).send({ text: "Nurse trying" })).status, 403);
    });

    it("another hospital sees nothing: not the case, not the patient, not the doctor", async () => {
      const { id, patient } = await arrive();
      for (const tok of [bDesk.token, bNurse.token, bDoc.token]) {
        assert.equal((await t.api("get", `/emergency/cases/${id}`, tok)).status, 404);
      }
      assert.equal((await triage(id, {}, bNurse.token)).status, 404);
      assert.equal((await t.api("post", `/emergency/cases/${id}/accept`, bDoc.token)).status, 404);
      assert.equal((await decide(id, { disposition: "DISCHARGE" }, bDoc.token)).status, 404);
      assert.equal((await t.api("post", `/emergency/cases/${id}/bill/issue`, bDesk.token)).status, 404);
      assert.equal((await register(patient.id, {}, bDesk.token, bDoc)).status, 404, "another hospital's patient cannot be registered");
      const bPatient = await registerPatient(t, bDesk.token);
      assert.equal((await register(bPatient.id, {}, bDesk.token, doc)).status, 400, "another hospital's doctor cannot be called");
      assert.equal((await get("/emergency/cases", bDesk.token)).length, 0);
      assert.equal((await t.api("get", `/emergency/cases/not-a-uuid`, desk.token)).status, 404);
    });

    it("a patient is in the ward once; a repeated registration replays; two at once make one case", async () => {
      const patient = await registerPatient(t, desk.token);
      const k = key();
      const first = await register(patient.id, {}, desk.token, doc, k);
      const replay = await register(patient.id, {}, desk.token, doc, k);
      assert.equal(first.status, 201); assert.equal(replay.status, 200);
      assert.equal(replay.body.data.id, first.body.data.id);
      assert.equal((await register(patient.id)).status, 409, "already in the emergency ward");
      const other = await registerPatient(t, desk.token);
      const both = await Promise.all([register(other.id), register(other.id)]);
      assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
      assert.equal(await t.prisma.emergencyCase.count({ where: { patientId: other.id } }), 1);
      assert.equal((await register(other.id, { chiefComplaint: "x" })).status, 400, "the complaint needs a few words");
    });

    it("the triage record and the doctor's notes are never changed or deleted; a closed case takes no more", async () => {
      const { id } = await arrive();
      const tr = await triage(id);
      const triageId = tr.body.data.triages[0].id as string;
      await assert.rejects(() => t.prisma.$executeRaw`UPDATE "EmergencyTriage" SET level = 'GREEN'::"TriageLevel" WHERE id = ${triageId}::uuid`, /append-only/);
      await assert.rejects(() => t.prisma.$executeRaw`DELETE FROM "EmergencyTriage" WHERE id = ${triageId}::uuid`, /append-only/);
      const n = await t.api("post", `/emergency/cases/${id}/notes`, doc.token).send({ text: "Assessment done" });
      await assert.rejects(() => t.prisma.$executeRaw`UPDATE "EmergencyNote" SET text = 'changed' WHERE id = ${n.body.data.notes[0].id}::uuid`, /append-only/);
      // A second triage is a new record: the history keeps the first.
      const again = await triage(id, { level: "YELLOW", consciousness: "ALERT", breathingOk: true });
      assert.equal(again.status, 201);
      assert.equal(again.body.data.triages.length, 2);
      assert.equal(again.body.data.triageLevel, "YELLOW");
      // The case row itself cannot be moved to another patient or doctor, and cannot be deleted.
      await assert.rejects(() => t.prisma.$executeRaw`UPDATE "EmergencyCase" SET "doctorId" = ${doc2.practitionerId}::uuid WHERE id = ${id}::uuid`, /cannot be moved/);
      await assert.rejects(() => t.prisma.$executeRaw`DELETE FROM "EmergencyCase" WHERE id = ${id}::uuid`, /append-only/);
      // The status only moves forward: IN_TREATMENT cannot go back to ARRIVED.
      await t.api("post", `/emergency/cases/${id}/accept`, doc.token);
      await assert.rejects(() => t.prisma.$executeRaw`UPDATE "EmergencyCase" SET status = 'ARRIVED'::"EmergencyStatus" WHERE id = ${id}::uuid`, /cannot move/);
      assert.equal((await decide(id, { disposition: "DISCHARGE" })).status, 201);
      assert.equal((await triage(id)).status, 409, "a closed case takes no triage");
      await assert.rejects(() => t.prisma.$executeRaw`UPDATE "EmergencyCase" SET "dispositionNote" = 'changed' WHERE id = ${id}::uuid`, /closed/);
    });

    it("a patient registered by mistake can be cancelled only before anything is done for them", async () => {
      const x = await arrive();
      const c = await t.api("post", `/emergency/cases/${x.id}/cancel`, desk.token).send({ reason: "Registered twice by mistake" });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      assert.equal(c.body.data.status, "CANCELLED");
      assert.equal((await t.prisma.encounter.findFirstOrThrow({ where: { id: x.encounterId } })).status, "CANCELLED");
      assert.equal((await t.prisma.invoice.findMany({ where: { encounterId: x.encounterId } })).every((i) => i.status === "CANCELLED"), true);
      const y = await arrive();
      await triage(y.id);
      assert.equal((await t.api("post", `/emergency/cases/${y.id}/cancel`, desk.token).send({ reason: "Should not be possible now" })).status, 409);
      assert.equal((await t.api("post", `/emergency/cases/${y.id}/cancel`, doc.token).send({ reason: "A doctor cannot cancel" })).status, 403);
    });

    it("an emergency patient is never held up by the registration fee, and the patient history shows the emergency visit", async () => {
      await freeBeds();
      assert.equal((await t.api("put", "/settings/REGISTRATION_FEE_ENABLED", a.admin.token).send({ value: true })).status, 200);
      assert.equal((await t.api("put", "/settings/REGISTRATION_FEE_AMOUNT", a.admin.token).send({ value: "100.00" })).status, 200);
      try {
        const patient = (await t.api("post", "/patients", desk.token).set("Idempotency-Key", key()).send({
          firstName: `Unknown${uniqueWord(4)}`, gender: "UNKNOWN", estimatedAgeYears: 40, registration: { exemption: { reason: "Emergency" } },
        }));
        assert.equal(patient.status, 201, JSON.stringify(patient.body));
        const r = await register(patient.body.data.id);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        const visits = await t.api("get", `/patients/${patient.body.data.id}/encounters`, doc.token);
        assert.equal(visits.status, 200, JSON.stringify(visits.body));
        assert.ok((visits.body.data as { type: string }[]).some((v) => v.type === "EMERGENCY"));
        // Sent to the ICU, the patient is admitted even though the registration fee was exempted.
        assert.equal((await decide(r.body.data.id, { disposition: "ICU", bedId: await freeBed("ICU") })).status, 201);
      } finally {
        await t.api("put", "/settings/REGISTRATION_FEE_ENABLED", a.admin.token).send({ value: false });
      }
    });
  });
});
