import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
const key = () => `k-${randomUUID().slice(0, 18)}`;
const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;

describe("ICU: handover from the emergency ward, vitals schedule, instructions, day-by-day record", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let desk: User; let erNurse: User; let icuNurse: User; let icuNurse2: User; let plainNurse: User; let path: User; let mgr: User; let hospMgr: User; let cashier: User;
  let erDoc: TestDoctor; let icuDoc: TestDoctor; let icuDoc2: TestDoctor;
  let bIcuNurse: User; let bIcuDoc: TestDoctor;
  let cbc: { id: string; name: string };

  const get = async (p: string, tok: string) => (await t.api("get", p, tok)).body.data;
  const notes = async (tok: string) => (await t.api("get", "/notifications", tok)).body.data as { type: string; entityId: string }[];
  const makeIcuDoctor = async (tenant: TestTenant): Promise<TestDoctor> => {
    const user = await t.makeUser(tenant, ["ICU_DOCTOR"]);
    const department = await t.prisma.department.create({ data: { tenantId: tenant.tenantId, facilityId: tenant.facilityId, name: `Dept ${uniqueWord(5)}`, code: `D${randomBytes(3).toString("hex").toUpperCase()}` } });
    const p = await t.prisma.practitioner.create({ data: { tenantId: tenant.tenantId, facilityId: tenant.facilityId, userId: user.id, departmentId: department.id, displayName: `Dr. ${uniqueWord(6)} ${uniqueWord(7)}`, specialty: "Critical Care" } });
    return { userId: user.id, token: user.token, practitionerId: p.id, departmentId: department.id };
  };
  const freeIcuBeds = async () => {
    const ids = (await t.prisma.bed.findMany({ where: { tenantId: a.tenantId, ward: { code: "ICU" } }, select: { id: true } })).map((x) => x.id);
    await t.prisma.bedAssignment.updateMany({ where: { tenantId: a.tenantId, bedId: { in: ids }, releasedAt: null }, data: { releasedAt: new Date() } });
    await t.prisma.bed.updateMany({ where: { tenantId: a.tenantId, id: { in: ids } }, data: { status: "AVAILABLE" } });
    await t.prisma.admission.updateMany({ where: { tenantId: a.tenantId, assignments: { some: { bedId: { in: ids } } }, status: "ADMITTED" }, data: { status: "DISCHARGED", dischargedAt: new Date(), dischargeType: "ROUTINE" } }).catch(() => undefined);
  };
  /** A patient from the emergency ward, with the nurse's vitals taken there, handed over to the ICU doctor. */
  const handover = async (doctor: TestDoctor = icuDoc) => {
    await freeIcuBeds();
    const patient = await registerPatient(t, desk.token);
    const c = await t.api("post", "/emergency/cases", desk.token).set("Idempotency-Key", key()).send({ patientId: patient.id, doctorId: erDoc.practitionerId, chiefComplaint: "Road accident with head injury", arrivalMode: "AMBULANCE" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const caseId = c.body.data.id as string; const encounterId = c.body.data.encounterId as string;
    assert.equal((await t.api("post", `/emergency/cases/${caseId}/triage`, erNurse.token).send({ level: "RED", consciousness: "PAIN", airwayClear: true, breathingOk: false, circulationOk: true })).status, 201);
    assert.equal((await t.api("post", `/encounters/${encounterId}/observations`, erNurse.token).send({ observations: [{ type: "PULSE", value: 120 }, { type: "SPO2", value: 90 }] })).status, 201);
    assert.equal((await t.api("post", `/emergency/cases/${caseId}/notes`, erDoc.token).send({ text: "GCS 9, intubation planned", diagnosis: "Head injury" })).status, 201);
    const beds = (await t.api("get", "/emergency/beds", erDoc.token)).body.data;
    const d = await t.api("post", `/emergency/cases/${caseId}/decision`, erDoc.token).set("Idempotency-Key", key()).send({ disposition: "ICU", bedId: beds.ICU.find((x: { free: boolean }) => x.free).id, consultantId: doctor.practitionerId, note: "Needs ventilation and monitoring" });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    return { patient, caseId, encounterId, admissionId: d.body.data.admission.id as string };
  };
  const stay = async (id: string, tok: string) => (await t.api("get", `/icu/stays/${id}`, tok));

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("icu-a"); b = await t.makeTenant("icu-b");
    desk = await t.makeUser(a, ["EMERGENCY_RECEPTIONIST"]); erNurse = await t.makeUser(a, ["EMERGENCY_NURSE"]); icuNurse = await t.makeUser(a, ["ICU_NURSE"]); icuNurse2 = await t.makeUser(a, ["ICU_NURSE"]);
    plainNurse = await t.makeUser(a, ["NURSE"]); path = await t.makeUser(a, ["PATHOLOGIST"]); mgr = await t.makeUser(a, ["LIMS_MANAGER"]); hospMgr = await t.makeUser(a, ["MANAGER"]); cashier = await t.makeUser(a, ["CASHIER"]);
    erDoc = await makeDoctor(t, a); icuDoc = await makeIcuDoctor(a); icuDoc2 = await makeIcuDoctor(a);
    bIcuNurse = await t.makeUser(b, ["ICU_NURSE"]); bIcuDoc = await makeIcuDoctor(b);
    cbc = (await t.api("post", "/services", a.admin.token).send({ code: code("T"), name: "Complete blood count", category: "INVESTIGATION", price: "250", taxPercent: 0 })).body.data;
    const def = await t.api("put", `/lab/tests/${cbc.id}`, path.token).send({ specimen: "Blood (EDTA)", turnaroundHours: 4, instructions: "None", parameters: [{ name: "Haemoglobin", unit: "g/dL", type: "NUMERIC", decimals: 1, lowMale: 13.5, highMale: 17.5, lowFemale: 12, highFemale: 15.5, criticalLow: 7, criticalHigh: 20 }] });
    assert.equal(def.status, 200, JSON.stringify(def.body));
  });
  after(async () => { await t.close(); });

  it("the emergency doctor hands the patient over to an ICU doctor: both ICU people are told and find the whole emergency record", async () => {
    await freeIcuBeds();
    const docs = await get("/emergency/icu-doctors", erDoc.token);
    assert.ok(docs.some((d: { id: string }) => d.id === icuDoc.practitionerId));
    assert.ok(!docs.some((d: { id: string }) => d.id === erDoc.practitionerId), "an emergency doctor is not an ICU doctor");
    // A doctor who is not an ICU doctor cannot take the patient over.
    const bad = await registerPatient(t, desk.token);
    const c = await t.api("post", "/emergency/cases", desk.token).set("Idempotency-Key", key()).send({ patientId: bad.id, doctorId: erDoc.practitionerId, chiefComplaint: "Collapse at home" });
    const beds = (await t.api("get", "/emergency/beds", erDoc.token)).body.data;
    const refused = await t.api("post", `/emergency/cases/${c.body.data.id}/decision`, erDoc.token).set("Idempotency-Key", key()).send({ disposition: "ICU", bedId: beds.ICU[0].id, consultantId: erDoc.practitionerId, note: "Not an ICU doctor" });
    assert.equal(refused.status, 400);

    const h = await handover();
    assert.ok((await notes(icuNurse.token)).some((n) => n.type === "ICU_ADMITTED" && n.entityId === h.admissionId), "the ICU nurse is told");
    assert.ok((await notes(icuDoc.token)).some((n) => n.type === "ICU_ADMITTED" && n.entityId === h.admissionId), "the ICU doctor is told");
    assert.ok(!(await notes(plainNurse.token)).some((n) => n.type === "ICU_ADMITTED"), "an ordinary nurse is not");
    assert.ok(!(await notes(icuDoc2.token)).some((n) => n.type === "ICU_ADMITTED" && n.entityId === h.admissionId), "another ICU doctor is not");
    for (const tok of [icuNurse.token, icuDoc.token, a.admin.token, hospMgr.token]) {
      const r = await stay(h.admissionId, tok);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.doctorName, (await t.prisma.practitioner.findFirstOrThrow({ where: { id: icuDoc.practitionerId } })).displayName);
      const em = r.body.data.fromEmergency;
      assert.equal(em.complaint, "Road accident with head injury");
      assert.equal(em.triages[0].level, "RED");
      assert.equal(em.notes[0].diagnosis, "Head injury");
      assert.match(em.handoverNote, /ventilation/);
      const before = r.body.data.readings.filter((x: { phase: string }) => x.phase === "BEFORE");
      assert.equal(before[0].values.PULSE.value, "120", "the vitals taken in the emergency ward are there");
    }
    const board = (await get("/icu/stays", icuNurse.token)).find((s: { id: string }) => s.id === h.admissionId);
    assert.ok(board);
    assert.equal(board.fromEmergency.startsWith("ER-"), true);
    assert.equal(board.calledByMe, false);
    assert.equal((await get("/icu/stays", icuDoc.token)).find((s: { id: string }) => s.id === h.admissionId).calledByMe, true);
    assert.equal((await get("/icu/stays", icuDoc2.token)).length, 0, "another ICU doctor sees only their own patients");
  });

  it("the ICU doctor sets how often vitals are taken; the nurse records them and the doctor sees them; late vitals raise an alert", async () => {
    const h = await handover();
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/vitals-schedule`, icuDoc.token).send({ intervalMinutes: 10 })).status, 400, "only 5, 15, 60 or 120");
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/vitals-schedule`, icuNurse.token).send({ intervalMinutes: 15 })).status, 403, "the nurse does not set the interval");
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/vitals-schedule`, icuDoc2.token).send({ intervalMinutes: 15 })).status, 404, "another doctor's patient");
    for (const m of [5, 15, 60, 120]) assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/vitals-schedule`, icuDoc.token).send({ intervalMinutes: m })).status, 200);
    const set = await t.api("post", `/icu/stays/${h.admissionId}/vitals-schedule`, icuDoc.token).send({ intervalMinutes: 15, reason: "Unstable after intubation" });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.data.schedule.intervalMinutes, 15);
    assert.equal(set.body.data.schedule.history.length, 5, "every change is kept");
    assert.ok((await notes(icuNurse.token)).some((n) => n.type === "ICU_VITALS_SCHEDULE" && n.entityId === h.admissionId));
    // Nothing is late yet; thirty minutes after the interval was set, with nothing recorded, the nurse is alerted.
    assert.equal((await get("/icu/alerts", icuNurse.token)).filter((x: { admissionId: string }) => x.admissionId === h.admissionId).length, 0);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "IcuVitalsOrder" DISABLE TRIGGER icu_vitals_order_append_only`);
    await t.prisma.$executeRawUnsafe(`UPDATE "IcuVitalsOrder" SET "setAt" = now() - interval '30 minutes' WHERE "admissionId" = '${h.admissionId}'::uuid`);
    // The readings taken in the emergency ward were also before that.
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Observation" DISABLE TRIGGER USER`);
    await t.prisma.$executeRawUnsafe(`UPDATE "Observation" SET "recordedAt" = now() - interval '45 minutes' WHERE "encounterId" = '${h.encounterId}'::uuid`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Observation" ENABLE TRIGGER USER`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "IcuVitalsOrder" ENABLE TRIGGER icu_vitals_order_append_only`);
    const late = (await get("/icu/alerts", icuNurse.token)).filter((x: { admissionId: string }) => x.admissionId === h.admissionId);
    assert.equal(late[0].kind, "VITALS_OVERDUE");
    assert.equal((await get("/icu/stays", icuNurse.token)).find((s: { id: string }) => s.id === h.admissionId).schedule.overdue, true);
    assert.equal((await get("/icu/alerts", icuDoc.token)).length, 0, "the doctor is not the one who takes vitals");
    // The nurse records vitals through her own screen; the alert ends and the doctor sees the readings under her name.
    const v = await t.api("post", `/encounters/${h.encounterId}/observations`, icuNurse.token).send({ observations: [{ type: "PULSE", value: 104 }, { type: "SYSTOLIC_BP", value: 110 }, { type: "DIASTOLIC_BP", value: 70 }, { type: "SPO2", value: 95 }] });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    assert.equal((await get("/icu/alerts", icuNurse.token)).filter((x: { admissionId: string }) => x.admissionId === h.admissionId).length, 0);
    const seen = (await stay(h.admissionId, icuDoc.token)).body.data;
    assert.equal(seen.schedule.overdue, false);
    assert.equal(seen.latest.PULSE.value, "104");
    const mine = seen.readings.find((r: { phase: string }) => r.phase === "ICU");
    assert.equal(mine.values.SPO2.value, "95");
    assert.ok(mine.by);
    assert.equal(seen.days[0].vitals.count >= 1, true);
    assert.deepEqual(seen.days[0].vitals.pulse.length, 2);
  });

  it("the doctor's instructions reach the nurse, who marks each done once; the doctor sees who did it", async () => {
    const h = await handover();
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/instructions`, icuNurse.token).send({ text: "Turn the patient two hourly" })).status, 403);
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/instructions`, icuDoc.token).send({ text: "no" })).status, 400);
    const calm = await t.api("post", `/icu/stays/${h.admissionId}/instructions`, icuDoc.token).send({ text: "Turn the patient two hourly and keep the head of the bed raised" });
    assert.equal(calm.status, 201, JSON.stringify(calm.body));
    const urgent = await t.api("post", `/icu/stays/${h.admissionId}/instructions`, icuDoc.token).send({ text: "Call me if urine output falls below 30 ml an hour", urgent: true });
    assert.equal(urgent.status, 201);
    assert.ok((await notes(icuNurse.token)).some((n) => n.type === "ICU_INSTRUCTION" && n.entityId === h.admissionId));
    assert.ok(!(await notes(plainNurse.token)).some((n) => n.type === "ICU_INSTRUCTION"));
    assert.ok((await get("/icu/alerts", icuNurse.token)).some((x: { admissionId: string; kind: string }) => x.admissionId === h.admissionId && x.kind === "URGENT_INSTRUCTION"));
    const open = (await stay(h.admissionId, icuNurse.token)).body.data.instructions as { id: string; urgent: boolean; status: string }[];
    assert.equal(open.length, 2);
    const first = open.find((i) => !i.urgent)!;
    assert.equal((await t.api("post", `/icu/instructions/${first.id}/done`, icuDoc.token).send({})).status, 403, "the doctor does not tick the nurse's list");
    const done = await t.api("post", `/icu/instructions/${first.id}/done`, icuNurse.token).send({ note: "Turned at 14:00 and 16:00" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const row = done.body.data.instructions.find((i: { id: string }) => i.id === first.id);
    assert.equal(row.status, "DONE");
    assert.equal(row.doneNote, "Turned at 14:00 and 16:00");
    assert.ok(row.doneBy);
    assert.equal((await t.api("post", `/icu/instructions/${first.id}/done`, icuNurse.token).send({})).status, 409, "done once");
    // The words of an instruction, and the record that it was done, cannot be changed; two nurses pressing at once make one record.
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "IcuInstruction" SET text = 'changed text here' WHERE id = ${first.id}::uuid`, /cannot be rewritten|already/);
    await assert.rejects(() => t.prisma.$executeRaw`DELETE FROM "IcuInstruction" WHERE id = ${first.id}::uuid`, /append-only/);
    const second = open.find((i) => i.urgent)!;
    const race = await Promise.all([t.api("post", `/icu/instructions/${second.id}/done`, icuNurse.token).send({}), t.api("post", `/icu/instructions/${second.id}/done`, icuNurse2.token).send({})]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await get("/icu/alerts", icuNurse.token)).filter((x: { admissionId: string }) => x.admissionId === h.admissionId).length, 0);
  });

  it("the doctor keeps a day-by-day record that nothing rewrites", async () => {
    const h = await handover();
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/notes`, icuNurse.token).send({ text: "Nurse trying to write" })).status, 403);
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/notes`, icuDoc2.token).send({ text: "Another doctor's note" })).status, 404);
    const n = await t.api("post", `/icu/stays/${h.admissionId}/notes`, icuDoc.token).send({ text: "Day 1: ventilated, sedated, haemodynamically stable on low-dose support", plan: "Wean sedation tomorrow if stable" });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/notes`, icuDoc.token).send({ text: "Evening review: urine output adequate" })).status, 201);
    const days = (await stay(h.admissionId, icuNurse.token)).body.data.days;
    assert.equal(days[0].dayNumber, 1);
    assert.equal(days[0].notes.length, 2);
    assert.equal(days[0].notes[0].plan === null || typeof days[0].notes[0].plan === "string", true);
    const id = days[0].notes[0].id as string;
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "IcuDayNote" SET text = 'rewritten text' WHERE id = ${id}::uuid`, /append-only/);
    await assert.rejects(() => t.prisma.$executeRaw`DELETE FROM "IcuDayNote" WHERE id = ${id}::uuid`, /append-only/);
  });

  it("tests the ICU doctor orders go to the laboratory as the ICU nurse's to collect, and the nurse and the laboratory manager see them", async () => {
    const h = await handover();
    const o = await t.api("post", "/lims/orders", icuDoc.token).send({ encounterId: h.encounterId, priority: "URGENT", tests: [{ name: cbc.name, category: "LABORATORY" }] });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    assert.equal(o.body.data.routedToLab, true);
    assert.ok([icuNurse.id, icuNurse2.id].includes(o.body.data.nurseAssigned), "an ICU nurse takes the sample, not an ordinary nurse");
    const nurse = o.body.data.nurseAssigned === icuNurse.id ? icuNurse : icuNurse2;
    assert.ok((await notes(nurse.token)).some((n) => n.type === "LIMS_ASSIGNED"), "the ICU nurse is told");
    const req = ((await get("/lims/requests?department=PATHOLOGY&pageSize=100", mgr.token)).items as { encounterId: string; priority: string; origin: string }[]).find((r) => r.encounterId === h.encounterId);
    assert.ok(req, "the laboratory manager sees it");
    assert.equal(req.origin, "IPD");
    assert.equal((await get("/icu/stays", nurse.token)).find((s: { id: string }) => s.id === h.admissionId).pendingTests, 1);
    assert.equal((await stay(h.admissionId, hospMgr.token)).body.data.tests.pending, 1, "the manager can follow it too");
  });

  it("everything the ICU does is in the bill: the bed for every day, equipment for every day in use, a charge added by the nurse; the cashier sees it", async () => {
    const h = await handover();
    const vent = (await t.api("post", "/services", a.admin.token).send({ code: code("V"), name: "ICU ventilator (per day)", category: "ROOM_BED", price: "2500", taxPercent: 0 })).body.data;
    const proc = (await t.api("post", "/services", a.admin.token).send({ code: code("P"), name: "Central line insertion", category: "PROCEDURE", price: "1200", taxPercent: 0 })).body.data;
    // The first day of the ICU bed was charged when the patient was handed over, at the ICU bed's daily rate.
    const first = (await stay(h.admissionId, icuNurse.token)).body.data.billing;
    const beds = first.items.filter((c: { source: string }) => c.source === "BED");
    assert.equal(beds.length, 1);
    assert.equal(beds[0].lineTotal, "6000.00");
    assert.equal((await stay(h.admissionId, icuNurse.token)).body.data.billing.items.filter((c: { source: string }) => c.source === "BED").length, 1, "looking again charges nothing twice");
    // Equipment: from the price list, one at a time, by the nurse or the doctor in charge; not by anybody else.
    assert.equal((await t.api("get", "/icu/equipment", icuNurse.token)).body.data.some((e: { id: string }) => e.id === vent.id), true);
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/equipment`, plainNurse.token).send({ serviceId: vent.id })).status, 403);
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/equipment`, icuDoc2.token).send({ serviceId: vent.id })).status, 404, "another doctor's patient");
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/equipment`, bIcuNurse.token).send({ serviceId: vent.id })).status, 404, "another hospital");
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/equipment`, icuNurse.token).send({ serviceId: proc.id })).status, 400, "a procedure is not equipment");
    const on = await t.api("post", `/icu/stays/${h.admissionId}/equipment`, icuNurse.token).send({ serviceId: vent.id });
    assert.equal(on.status, 201, JSON.stringify(on.body));
    assert.equal(on.body.data.equipment[0].active, true);
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/equipment`, icuDoc.token).send({ serviceId: vent.id })).status, 409, "already in use");
    assert.equal(on.body.data.billing.items.filter((c: { source: string }) => c.source === "EQUIPMENT").length, 1, "the first day is charged at once");
    // It has been on for two more days: three days are charged, each once, at the price list's price.
    const useId = on.body.data.equipment[0].id as string;
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "IcuEquipmentUse" DISABLE TRIGGER icu_equipment_guard`);
    await t.prisma.$executeRawUnsafe(`UPDATE "IcuEquipmentUse" SET "startedAt" = now() - interval '2 days' WHERE id = '${useId}'::uuid`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "IcuEquipmentUse" ENABLE TRIGGER icu_equipment_guard`);
    const three = (await stay(h.admissionId, icuDoc.token)).body.data.billing.items.filter((c: { source: string }) => c.source === "EQUIPMENT");
    assert.equal(three.length >= 3, true);
    assert.ok(three.every((c: { lineTotal: string }) => c.lineTotal === "2500.00"));
    const off = await t.api("post", `/icu/equipment/${useId}/stop`, icuNurse.token);
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.data.equipment[0].active, false);
    assert.equal((await t.api("post", `/icu/equipment/${useId}/stop`, icuNurse.token)).status, 409, "stopped once");
    const after = (await stay(h.admissionId, icuNurse.token)).body.data.billing.items.filter((c: { source: string }) => c.source === "EQUIPMENT").length;
    assert.equal((await stay(h.admissionId, icuNurse.token)).body.data.billing.items.filter((c: { source: string }) => c.source === "EQUIPMENT").length, after, "a stopped item adds nothing");
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "IcuEquipmentUse" SET "serviceId" = ${proc.id}::uuid WHERE id = ${useId}::uuid`, /cannot be rewritten|already stopped/);
    // A procedure the nurse adds from the price list goes on the same bill; a free-price charge needs billing permission.
    assert.equal((await t.api("post", `/admissions/${h.admissionId}/charges`, icuNurse.token).send({ type: "PROCEDURE", serviceId: proc.id, quantity: 1 })).status, 201);
    assert.equal((await t.api("post", `/admissions/${h.admissionId}/charges`, icuNurse.token).send({ description: "Free price", unitPrice: "10", taxPercent: 0, quantity: 1 })).status, 403);
    const bill = (await stay(h.admissionId, hospMgr.token)).body.data.billing;
    assert.ok(bill.items.some((c: { description: string }) => c.description.startsWith("Central line")));
    // The cashier sees the stay's charges waiting to be billed.
    const unbilled = (await get("/charges/unbilled", cashier.token)).find((g: { admissionId: string }) => g.admissionId === h.admissionId);
    assert.ok(unbilled);
    assert.equal(unbilled.charges >= 5, true, "the bed day, three equipment days and the procedure");
  });

  it("equipment stops when the patient leaves the ICU ward, so a ward day is not charged for a ventilator; a move within the ICU keeps it", async () => {
    const h = await handover();
    const mon = (await t.api("post", "/services", a.admin.token).send({ code: code("M"), name: "ICU monitor (per day)", category: "ROOM_BED", price: "800", taxPercent: 0 })).body.data;
    const on = await t.api("post", `/icu/stays/${h.admissionId}/equipment`, icuNurse.token).send({ serviceId: mon.id });
    assert.equal(on.status, 201, JSON.stringify(on.body));
    const mkBedIn = async (wardCode: string | null) => {
      const ward = wardCode ? await t.prisma.ward.findFirstOrThrow({ where: { tenantId: a.tenantId, code: wardCode } }) : (await t.api("post", "/wards", a.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
      const room = (await t.api("post", "/rooms", a.admin.token).send({ wardId: ward.id, name: `Room ${uniqueWord(3)}`, code: code("R") })).body.data;
      const bed = await t.api("post", "/beds", a.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1500" });
      assert.equal(bed.status, 201, JSON.stringify(bed.body));
      return bed.body.data.id as string;
    };
    // To another bed of the same ward: the equipment stays on the patient.
    const icuBed = await mkBedIn("ICU");
    assert.equal((await t.api("post", `/admissions/${h.admissionId}/transfer`, icuNurse.token).send({ toBedId: icuBed, reason: "Moved to a bigger room" })).status, 200);
    assert.equal((await stay(h.admissionId, icuNurse.token)).body.data.equipment[0].active, true);
    // To a general ward: it is stopped at that moment, by the system, and said so in the audit.
    const wardBed = await mkBedIn(null);
    assert.equal((await t.api("post", `/admissions/${h.admissionId}/transfer`, icuNurse.token).send({ toBedId: wardBed, reason: "Improved, back to the ward" })).status, 200);
    const left = await t.prisma.icuEquipmentUse.findFirstOrThrow({ where: { tenantId: a.tenantId, admissionId: h.admissionId } });
    assert.ok(left.stoppedAt, "equipment is stopped when the patient leaves the ICU ward");
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, entityId: h.admissionId, action: "ICU_EQUIPMENT_STOPPED" } }), 1);
  });

  it("each profile sees only what it should; another hospital sees nothing; a patient who leaves the ICU leaves the board", async () => {
    const h = await handover();
    for (const [tok, who] of [[plainNurse.token, "ordinary nurse"], [erNurse.token, "emergency nurse"], [cashier.token, "cashier"], [desk.token, "emergency desk"], [erDoc.token, "emergency doctor"]] as const) {
      assert.equal((await t.api("get", "/icu/stays", tok)).status, 403, `${who} has no ICU board`);
    }
    for (const tok of [bIcuNurse.token, bIcuDoc.token]) {
      assert.equal((await stay(h.admissionId, tok)).status, 404);
      assert.equal((await get("/icu/stays", tok)).length, 0);
    }
    assert.equal((await t.api("post", `/icu/stays/${h.admissionId}/instructions`, bIcuDoc.token).send({ text: "Cross-hospital instruction" })).status, 404);
    assert.equal((await t.api("get", "/icu/stays/not-a-uuid", icuNurse.token)).status, 404);
    // A stay that has ended takes nothing more and is no longer on the board.
    await t.prisma.admission.update({ where: { id: h.admissionId }, data: { status: "DISCHARGED", dischargedAt: new Date(), dischargeType: "ROUTINE" } });
    assert.equal((await stay(h.admissionId, icuNurse.token)).status, 404);
    await assert.rejects(() => t.prisma.$executeRaw`INSERT INTO "IcuDayNote" ("tenantId", "facilityId", "admissionId", day, text, "authorId") VALUES (${a.tenantId}::uuid, ${a.facilityId}::uuid, ${h.admissionId}::uuid, CURRENT_DATE, 'late note here', ${icuDoc.userId}::uuid)`, /only while the patient is admitted/);
  });
});
