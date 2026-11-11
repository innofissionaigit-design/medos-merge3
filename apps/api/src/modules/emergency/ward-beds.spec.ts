import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
const key = () => `k-${randomUUID().slice(0, 18)}`;

describe("emergency ward beds: an emergency patient lies in a bed until the doctor decides", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let desk: User; let erNurse: User; let cashier: User; let hospMgr: User;
  let doc: TestDoctor; let bDesk: User; let bDoc: TestDoctor;

  const register = async (o: Record<string, unknown> = {}, tok = desk.token) => {
    const patient = await registerPatient(t, tok);
    return t.api("post", "/emergency/cases", tok).set("Idempotency-Key", key()).send({ patientId: patient.id, doctorId: doc.practitionerId, chiefComplaint: "Chest pain since morning", arrivalMode: "WALK_IN", ...o });
  };
  const erBeds = async () => (await t.api("get", "/emergency/beds", erNurse.token)).body.data.ER as { id: string; code: string; free: boolean; status: string; occupant: { caseId: string } | null }[];
  /** Every bed of the emergency ward free again, and no patient lying in one. */
  const clearWard = async () => {
    const ids = (await t.prisma.bed.findMany({ where: { tenantId: a.tenantId, ward: { code: "ER" } }, select: { id: true } })).map((x) => x.id);
    await t.prisma.$executeRawUnsafe(`UPDATE "EmergencyBedStay" SET "releasedAt" = now(), "releasedById" = "assignedById" WHERE "tenantId" = '${a.tenantId}'::uuid AND "releasedAt" IS NULL`);
    await t.prisma.bed.updateMany({ where: { tenantId: a.tenantId, id: { in: ids } }, data: { status: "AVAILABLE" } });
    await t.prisma.emergencyCase.updateMany({ where: { tenantId: a.tenantId, status: { in: ["ARRIVED", "TRIAGED", "IN_TREATMENT"] } }, data: { status: "CANCELLED", cancelReason: "test cleanup" } });
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("erbed-a"); b = await t.makeTenant("erbed-b");
    desk = await t.makeUser(a, ["EMERGENCY_RECEPTIONIST"]); erNurse = await t.makeUser(a, ["EMERGENCY_NURSE"]); cashier = await t.makeUser(a, ["CASHIER"]); hospMgr = await t.makeUser(a, ["MANAGER"]);
    doc = await makeDoctor(t, a);
    bDesk = await t.makeUser(b, ["EMERGENCY_RECEPTIONIST"]); bDoc = await makeDoctor(t, b);
  });
  after(async () => { await t.close(); });

  it("the hospital has an emergency ward with beds, and a new patient is given the first free one", async () => {
    await clearWard();
    const ward = await erBeds();
    assert.equal(ward.length, 6);
    assert.ok(ward.every((x) => x.free && x.occupant === null));
    const r = await register();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.bed.code, "ER1");
    const after1 = await erBeds();
    assert.equal(after1.find((x) => x.code === "ER1")?.status, "OCCUPIED");
    assert.equal(after1.find((x) => x.code === "ER1")?.occupant?.caseId, r.body.data.id);
    const r2 = await register();
    assert.equal(r2.body.data.bed.code, "ER2", "the next patient gets the next bed");
    assert.equal(await t.prisma.emergencyBedStay.count({ where: { tenantId: a.tenantId, caseId: r.body.data.id, releasedAt: null } }), 1);
  });

  it("the nurse or the desk moves a patient to another free bed; an occupied bed, another hospital's bed and other roles are refused; every stay is kept", async () => {
    await clearWard();
    const r = await register();
    const caseId = r.body.data.id as string;
    const other = await register();
    const free = (await erBeds()).find((x) => x.free)!;
    assert.equal((await t.api("post", `/emergency/cases/${caseId}/bed`, erNurse.token).send({ bedId: other.body.data.bed.id })).status, 409, "that bed has a patient");
    const moved = await t.api("post", `/emergency/cases/${caseId}/bed`, erNurse.token).send({ bedId: free.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.data.bed.id, free.id);
    assert.equal((await t.api("post", `/emergency/cases/${caseId}/bed`, erNurse.token).send({ bedId: r.body.data.bed.id })).status, 409, "the bed just left is being cleaned");
    const another = (await erBeds()).find((x) => x.free)!;
    assert.equal((await t.api("post", `/emergency/cases/${caseId}/bed`, desk.token).send({ bedId: another.id })).status, 200, "the desk can move the patient too");
    assert.equal(await t.prisma.emergencyBedStay.count({ where: { tenantId: a.tenantId, caseId } }), 3, "every stay in a bed is kept");
    assert.equal((await t.api("post", `/emergency/cases/${caseId}/bed`, erNurse.token).send({ bedId: another.id })).status, 400, "already in this bed");
    assert.equal((await t.api("post", `/emergency/cases/${caseId}/bed`, cashier.token).send({ bedId: free.id })).status, 403);
    assert.equal((await t.api("post", `/emergency/cases/${caseId}/bed`, hospMgr.token).send({ bedId: free.id })).status, 403, "the manager follows, and does not move patients");
    const bBed = (await t.api("get", "/emergency/beds", (await t.makeUser(b, ["EMERGENCY_NURSE"])).token)).body.data.ER[0];
    assert.equal((await t.api("post", `/emergency/cases/${caseId}/bed`, erNurse.token).send({ bedId: bBed.id })).status, 404, "another hospital's bed");
    const wardOther = await t.prisma.bed.findFirstOrThrow({ where: { tenantId: a.tenantId, ward: { code: "ICU" } } });
    assert.equal((await t.api("post", `/emergency/cases/${caseId}/bed`, erNurse.token).send({ bedId: wardOther.id })).status, 400, "an ICU bed is not an emergency bed");
    await assert.rejects(() => t.prisma.$executeRawUnsafe(`UPDATE "EmergencyBedStay" SET "bedId" = "bedId", "assignedAt" = now() - interval '1 day' WHERE "caseId" = '${caseId}'::uuid`), /cannot be rewritten|already ended/);
    await assert.rejects(() => t.prisma.$executeRawUnsafe(`DELETE FROM "EmergencyBedStay" WHERE "caseId" = '${caseId}'::uuid`));
  });

  it("when the ward is full the patient is still registered, without a bed, and the nurse gives one when it is free; two arrivals at once never share a bed", async () => {
    await clearWard();
    const made = await Promise.all(Array.from({ length: 6 }, () => register()));
    assert.ok(made.every((m) => m.status === 201), JSON.stringify(made.map((m) => m.body)));
    const codes = made.map((m) => m.body.data.bed?.code as string);
    assert.equal(new Set(codes).size, 6, `six arrivals at once took six different beds: ${codes.join(",")}`);
    const seventh = await register();
    assert.equal(seventh.status, 201, "an emergency is never turned away");
    assert.equal(seventh.body.data.bed, null);
    const sevenId = seventh.body.data.id as string;
    // A bed becomes free when its patient is sent home; then the nurse gives it.
    const first = made[0]!.body.data;
    const bed = await t.api("get", "/emergency/beds", doc.token);
    assert.ok(bed.body.data.ER.every((x: { free: boolean }) => !x.free));
    const sent = await t.api("post", `/emergency/cases/${first.id}/decision`, doc.token).set("Idempotency-Key", key()).send({ disposition: "DISCHARGE", note: "Minor, can go home" });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.data.bed, null, "the bed is released when the doctor decides");
    const freed = await t.prisma.bed.findFirstOrThrow({ where: { id: first.bed.id } });
    assert.ok(["CLEANING", "AVAILABLE"].includes(freed.status));
    await t.prisma.bed.update({ where: { id: first.bed.id }, data: { status: "AVAILABLE" } });
    const given = await t.api("post", `/emergency/cases/${sevenId}/bed`, erNurse.token).send({ bedId: first.bed.id });
    assert.equal(given.status, 200, JSON.stringify(given.body));
    assert.equal(given.body.data.bed.code, first.bed.code);
  });

  it("a bed is freed when the registration is cancelled; the desk may choose a free bed, but never an ICU bed or another hospital's bed", async () => {
    await clearWard();
    const r = await register();
    const bedId = r.body.data.bed.id as string;
    const cancelled = await t.api("post", `/emergency/cases/${r.body.data.id}/cancel`, desk.token).send({ reason: "Registered by mistake" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.bed, null);
    assert.notEqual((await t.prisma.bed.findFirstOrThrow({ where: { id: bedId } })).status, "OCCUPIED");
    // Registering with a chosen bed: it must be free and in the emergency ward.
    await t.prisma.bed.update({ where: { id: bedId }, data: { status: "AVAILABLE" } });
    const chosen = await register({ bedId });
    assert.equal(chosen.status, 201, JSON.stringify(chosen.body));
    assert.equal(chosen.body.data.bed.id, bedId);
    const twice = await register({ bedId });
    assert.equal(twice.status, 409, "the chosen bed already has a patient");
    const icuBed = await t.prisma.bed.findFirstOrThrow({ where: { tenantId: a.tenantId, ward: { code: "ICU" } } });
    assert.equal((await register({ bedId: icuBed.id })).status, 400);
    assert.equal((await register({ bedId, doctorId: bDoc.practitionerId }, bDesk.token)).status, 404, "another hospital cannot use this bed");
  });
});
