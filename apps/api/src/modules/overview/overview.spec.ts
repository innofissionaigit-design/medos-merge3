import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
const key = () => `k-${randomUUID().slice(0, 18)}`;

describe("manager overview: the status of the emergency ward, the ICU and billing, read only", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let desk: User; let erNurse: User; let icuNurse: User; let hospMgr: User; let bMgr: User; let nurse: User; let cashier: User; let doctor: User;
  let erDoc: TestDoctor; let icuDoc: TestDoctor;

  const makeDoc = async (tenant: TestTenant, role: string): Promise<TestDoctor> => {
    const user = await t.makeUser(tenant, [role]);
    const department = await t.prisma.department.create({ data: { tenantId: tenant.tenantId, facilityId: tenant.facilityId, name: `Dept ${uniqueWord(5)}`, code: `D${randomBytes(3).toString("hex").toUpperCase()}` } });
    const p = await t.prisma.practitioner.create({ data: { tenantId: tenant.tenantId, facilityId: tenant.facilityId, userId: user.id, departmentId: department.id, displayName: `Dr. ${uniqueWord(6)} ${uniqueWord(7)}`, specialty: "Critical Care" } });
    return { userId: user.id, token: user.token, practitionerId: p.id, departmentId: department.id };
  };
  const arrive = async () => {
    const patient = await registerPatient(t, desk.token);
    const r = await t.api("post", "/emergency/cases", desk.token).set("Idempotency-Key", key()).send({ patientId: patient.id, doctorId: erDoc.practitionerId, chiefComplaint: "Fall from height", arrivalMode: "AMBULANCE" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string; encounterId: string };
  };
  const view = async (tok = hospMgr.token) => (await t.api("get", "/overview", tok)).body.data;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("ov-a"); b = await t.makeTenant("ov-b");
    desk = await t.makeUser(a, ["EMERGENCY_RECEPTIONIST"]); erNurse = await t.makeUser(a, ["EMERGENCY_NURSE"]); icuNurse = await t.makeUser(a, ["ICU_NURSE"]); hospMgr = await t.makeUser(a, ["MANAGER"]);
    nurse = await t.makeUser(a, ["NURSE"]); cashier = await t.makeUser(a, ["CASHIER"]); doctor = await t.makeUser(a, ["DOCTOR"]);
    erDoc = await makeDoc(a, "EMERGENCY_DOCTOR"); icuDoc = await makeDoc(a, "ICU_DOCTOR");
    bMgr = await t.makeUser(b, ["MANAGER"]);
    await t.api("put", "/settings/EMERGENCY_FEE_AMOUNT", a.admin.token).send({ value: "500.00" });
  });
  after(async () => { await t.close(); });

  it("shows how many are in the emergency ward, by urgency, who waits for a doctor, the beds and what is owed", async () => {
    await t.prisma.emergencyCase.updateMany({ where: { tenantId: a.tenantId, status: { in: ["ARRIVED", "TRIAGED", "IN_TREATMENT"] } }, data: { status: "CANCELLED", cancelReason: "test cleanup" } });
    await t.prisma.$executeRawUnsafe(`UPDATE "EmergencyBedStay" SET "releasedAt" = now(), "releasedById" = "assignedById" WHERE "tenantId" = '${a.tenantId}'::uuid AND "releasedAt" IS NULL`);
    await t.prisma.bed.updateMany({ where: { tenantId: a.tenantId, ward: { code: "ER" } }, data: { status: "AVAILABLE" } });
    const c1 = await arrive(); const c2 = await arrive(); await arrive();
    assert.equal((await t.api("post", `/emergency/cases/${c1.id}/triage`, erNurse.token).send({ level: "RED", consciousness: "PAIN", airwayClear: true, breathingOk: false, circulationOk: true })).status, 201);
    assert.equal((await t.api("post", `/emergency/cases/${c2.id}/triage`, erNurse.token).send({ level: "YELLOW", consciousness: "ALERT", airwayClear: true, breathingOk: true, circulationOk: true })).status, 201);
    assert.equal((await t.api("post", `/emergency/cases/${c1.id}/accept`, erDoc.token)).status, 200);
    const v = (await view()).emergency;
    assert.equal(v.inWard, 3);
    assert.equal(v.notTriaged, 1);
    assert.equal(v.waitingForDoctor, 2);
    assert.equal(v.byLevel.RED, 1); assert.equal(v.byLevel.YELLOW, 1);
    assert.equal(v.arrivalsToday >= 3, true);
    assert.deepEqual(v.beds, { total: 6, free: 3, withoutBed: 0 });
    assert.equal(v.cases.length, 3);
    assert.deepEqual(v.cases.map((c: { triageLevel: string | null }) => c.triageLevel), [null, "RED", "YELLOW"], "the patient not yet triaged first, then by urgency, as on the nurses' board");
    assert.ok(v.cases.every((c: { patientName: string | null }) => typeof c.patientName === "string"));
  });

  it("shows the ICU: patients, free beds, late vitals, urgent instructions, equipment and what has been charged so far", async () => {
    await t.prisma.bedAssignment.updateMany({ where: { tenantId: a.tenantId, bed: { ward: { code: "ICU" } }, releasedAt: null }, data: { releasedAt: new Date() } });
    await t.prisma.bed.updateMany({ where: { tenantId: a.tenantId, ward: { code: "ICU" } }, data: { status: "AVAILABLE" } });
    await t.prisma.admission.updateMany({ where: { tenantId: a.tenantId, status: "ADMITTED" }, data: { status: "DISCHARGED", dischargedAt: new Date(), dischargeType: "ROUTINE" } }).catch(() => undefined);
    const e = await arrive();
    const beds = (await t.api("get", "/emergency/beds", erDoc.token)).body.data;
    const d = await t.api("post", `/emergency/cases/${e.id}/decision`, erDoc.token).set("Idempotency-Key", key()).send({ disposition: "ICU", bedId: beds.ICU.find((x: { free: boolean }) => x.free).id, consultantId: icuDoc.practitionerId, note: "Needs ventilation" });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const adm = d.body.data.admission.id as string;
    assert.equal((await t.api("post", `/icu/stays/${adm}/instructions`, icuDoc.token).send({ text: "Call me if saturation drops", urgent: true })).status, 201);
    const vent = (await t.api("post", "/services", a.admin.token).send({ code: `V${uniqueWord(5).toUpperCase()}`, name: "ICU ventilator (per day)", category: "ROOM_BED", price: "2500", taxPercent: 0 })).body.data;
    assert.equal((await t.api("post", `/icu/stays/${adm}/equipment`, icuNurse.token).send({ serviceId: vent.id })).status, 201);
    const v = (await view()).icu;
    assert.equal(v.patients, 1);
    assert.equal(v.beds.total, 3);
    assert.equal(v.beds.free, 2);
    assert.equal(v.urgentInstructionsOpen, 1);
    assert.equal(v.equipmentInUse, 1);
    assert.equal(v.chargesSoFar, "8500.00", "the ICU bed for the day and the ventilator");
    assert.equal(v.stays[0].chargesSoFar, "8500.00");
    assert.equal((await view()).emergency.decisionsToday.ICU >= 1, true);
  });

  it("shows billing: invoiced and collected today, what is outstanding by kind, and admitted patients' charges not yet billed", async () => {
    const v = (await view()).billing;
    assert.ok(Number(v.invoicedToday.total) >= 500, "the emergency bill issued at the handover");
    assert.ok(Number(v.outstanding.total) >= 500);
    assert.ok(v.outstanding.byKind.some((k: { kind: string }) => k.kind === "EMERGENCY"));
    assert.equal(v.admittedChargesNotBilled.patients, 1);
    assert.equal(v.admittedChargesNotBilled.total, "8500.00");
    const inv = (await t.api("get", "/invoices?kind=EMERGENCY", cashier.token)).body.data[0];
    const paid = await t.api("post", `/invoices/${inv.id}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "UPI", amount: String(inv.total), reference: "UPI-OV-1" }] });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    const after1 = (await view()).billing;
    assert.ok(Number(after1.collectedToday.total) >= Number(inv.total));
    assert.ok(after1.collectedToday.byMethod.some((m: { method: string }) => m.method === "UPI"));
  });

  it("is for the manager and the administrator only, changes nothing, and never shows another hospital", async () => {
    for (const [tok, who] of [[nurse.token, "nurse"], [cashier.token, "cashier"], [doctor.token, "doctor"], [erNurse.token, "emergency nurse"], [icuNurse.token, "ICU nurse"], [desk.token, "emergency desk"]] as const) {
      assert.equal((await t.api("get", "/overview", tok)).status, 403, `${who} has no overview`);
    }
    assert.equal((await t.api("get", "/overview", a.admin.token)).status, 200, "the administrator may follow it too");
    const e = await arrive();
    // The manager follows and does not micromanage: no acting on any of the three areas.
    for (const [method, path, body] of [
      ["post", `/emergency/cases/${e.id}/triage`, { level: "RED", consciousness: "ALERT", airwayClear: true, breathingOk: true, circulationOk: true }],
      ["post", `/emergency/cases/${e.id}/decision`, { disposition: "DISCHARGE", note: "Manager tries to decide" }],
      ["post", `/emergency/cases/${e.id}/bed`, { bedId: randomUUID() }],
      ["post", `/emergency/cases/${e.id}/bill/issue`, {}],
      ["post", `/order-requests`, { kind: "TEST", encounterId: e.encounterId, tests: [{ name: "CBC", category: "LABORATORY" }] }],
      ["post", `/icu/stays/${randomUUID()}/instructions`, { text: "Manager instruction" }],
      ["post", `/icu/stays/${randomUUID()}/equipment`, { serviceId: randomUUID() }],
      ["post", `/icu/stays/${randomUUID()}/vitals-schedule`, { intervalMinutes: 5 }],
    ] as const) {
      const r = await t.api(method, path, hospMgr.token).send(body);
      assert.equal(r.status, 403, `${method} ${path}: the manager cannot do this (got ${r.status})`);
    }
    const other = await view(bMgr.token);
    assert.equal(other.emergency.inWard, 0);
    assert.equal(other.icu.patients, 0);
    assert.equal(other.billing.invoicedToday.count, 0);
    assert.equal(other.billing.outstanding.count, 0);
  });
});
