import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeClinicianWith, makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;
interface BoardRow { id: string; name: string; status: string; overdue: boolean; surgeonName: string | null; patient: { name: string; mrn: string | null }; admission: { number: string | null; bed: string | null; ward: string | null } }

describe("the operation theatre board: every procedure in one list, read only", () => {
  let t: TestApp;
  let x: { tenant: TestTenant; rec: { id: string; token: string }; doc: TestDoctor; doc2: TestDoctor; rmo: { id: string; token: string }; coord: { id: string; token: string }; manager: { id: string; token: string }; nurse: { id: string; token: string }; cashier: { id: string; token: string } };
  let appen = ""; let admA = ""; let admB = ""; let procA = ""; let procB = ""; let ward = "";

  const admit = async (doc: TestDoctor) => {
    const w = (await t.api("post", "/wards", x.tenant.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    ward = w.name as string;
    const room = (await t.api("post", "/rooms", x.tenant.admin.token).send({ wardId: w.id, name: "Room", code: code("R") })).body.data;
    const bed = (await t.api("post", "/beds", x.tenant.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1000" })).body.data;
    const patient = await registerPatient(t, x.rec.token);
    const r = await t.api("post", "/admissions", x.rec.token).send({ patientId: patient.id, consultantId: doc.practitionerId, bedId: bed.id, reason: "Acute appendicitis" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.data.id as string, bed: bed.code as string };
  };
  const board = (token: string, query = "") => t.api("get", `/procedures${query}`, token);

  before(async () => {
    t = await startApp();
    const tenant = await t.makeTenant("theatre-board");
    x = {
      tenant, rec: await t.makeUser(tenant, ["RECEPTIONIST"]), doc: await makeDoctor(t, tenant), doc2: await makeDoctor(t, tenant), rmo: await t.makeUser(tenant, ["RMO"]),
      coord: await t.makeUser(tenant, ["OT_COORDINATOR"]), manager: await t.makeUser(tenant, ["MANAGER"]), nurse: await t.makeUser(tenant, ["NURSE"]), cashier: await t.makeUser(tenant, ["CASHIER"]),
    };
    appen = (await t.api("post", "/services", tenant.admin.token).send({ code: code("S"), name: `Appendectomy ${uniqueWord(4)}`, category: "PROCEDURE", price: "15000", taxPercent: "0" })).body.data.id;
    const a = await admit(x.doc); admA = a.id;
    const b = await admit(x.doc2); admB = b.id;
    const pa = await t.api("post", `/admissions/${admA}/procedures`, x.doc.token).send({ serviceId: appen, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), surgeonId: x.doc.practitionerId });
    assert.equal(pa.status, 201, JSON.stringify(pa.body)); procA = pa.body.data.id;
    const pb = await t.api("post", `/admissions/${admB}/procedures`, x.doc2.token).send({ serviceId: appen });
    assert.equal(pb.status, 201, JSON.stringify(pb.body)); procB = pb.body.data.id;
  });
  after(async () => { await t.close(); });

  it("lists the procedures of every admission with the patient, the bed, the surgeon and a summary; the soonest first", async () => {
    const r = await board(x.coord.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = r.body.data.rows as BoardRow[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.id, procA, "a scheduled procedure comes before one with no time");
    assert.ok(rows[0]?.surgeonName, "who operates");
    assert.ok(rows[0]?.patient.name && rows[0]?.patient.mrn, "who the patient is");
    assert.ok(rows[0]?.admission.number && rows[0]?.admission.bed && rows[0]?.admission.ward, "where they are");
    assert.equal(rows[0]?.overdue, false);
    assert.deepEqual([r.body.data.summary.planned, r.body.data.summary.performed, r.body.data.total], [2, 0, 2]);
    assert.equal(r.body.data.summary.today >= 0, true);
  });

  it("the coordinator's work (planned, then performed) stays under OPEN; finalising moves it to DONE; a cancelled one is its own list", async () => {
    assert.equal((await t.api("post", `/procedures/${procA}/perform`, x.coord.token).send({})).status, 200);
    let open = (await board(x.coord.token, "?view=OPEN")).body.data;
    assert.deepEqual([open.total, open.summary.planned, open.summary.performed], [2, 1, 1], "performed but not finalised is still open work");
    assert.equal((await t.api("post", `/procedures/${procA}/finalise`, x.coord.token)).status, 200);
    open = (await board(x.coord.token, "?view=OPEN")).body.data;
    assert.deepEqual([open.total, open.rows[0].id], [1, procB]);
    const done = (await board(x.coord.token, "?view=DONE")).body.data;
    assert.deepEqual([done.total, done.rows[0].id, done.summary.finalisedWeek], [1, procA, 1]);
    assert.equal((await t.api("post", `/procedures/${procB}/cancel`, x.doc2.token).send({ reason: "Patient improved" })).status, 200);
    const cancelled = (await board(x.coord.token, "?view=CANCELLED")).body.data;
    assert.deepEqual([cancelled.total, cancelled.rows[0].id, cancelled.rows[0].cancelReason], [1, procB, "Patient improved"]);
    assert.equal((await board(x.coord.token, "?view=ALL")).body.data.total, 2);
    assert.equal((await board(x.coord.token, "?view=OPEN")).body.data.total, 0);
  });

  it("pages the list", async () => {
    const p1 = (await board(x.coord.token, "?view=ALL&pageSize=1&page=1")).body.data;
    const p2 = (await board(x.coord.token, "?view=ALL&pageSize=1&page=2")).body.data;
    assert.deepEqual([p1.total, p1.rows.length, p2.rows.length], [2, 1, 1]);
    assert.notEqual(p1.rows[0].id, p2.rows[0].id);
    for (const bad of ["?view=NOPE", "?pageSize=0", "?pageSize=500", "?extra=1"]) assert.equal((await board(x.coord.token, bad)).status, 400, bad);
  });

  it("is read only and limited by role: the coordinator, RMO, manager and administrator read it; a nurse, a cashier and a receptionist do not", async () => {
    for (const who of [x.coord, x.rmo, x.manager, x.tenant.admin]) assert.equal((await board(who.token)).status, 200);
    for (const who of [x.nurse, x.cashier, x.rec]) assert.equal((await board(who.token)).status, 403);
    assert.equal((await t.api("get", "/procedures")).status, 401);
    assert.equal((await t.api("post", `/procedures/${procA}/perform`, x.manager.token).send({})).status, 403, "reading the board does not allow changing a procedure");
    assert.equal((await t.api("post", `/procedures/${procA}/perform`, x.tenant.admin.token).send({})).status, 403);
  });

  it("a clinician sees only their own patients' procedures, and another hospital sees none of them", async () => {
    // The board is for the coordinating roles; a doctor is not given it. A clinician who is given it is still held to their own patients.
    assert.equal((await board(x.doc.token, "?view=ALL")).status, 403, "an ordinary doctor does not hold the board");
    const clin = await makeClinicianWith(t, x.tenant, ["THEATRE_READ", "ADMISSION_READ"]);
    const mineAdm = await admit(clin);
    const mine = await t.api("post", `/admissions/${mineAdm.id}/procedures`, x.rmo.token).send({ serviceId: appen });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    const seen = (await board(clin.token, "?view=ALL")).body.data as { total: number; rows: BoardRow[] };
    assert.deepEqual([seen.total, seen.rows[0]?.id], [1, mine.body.data.id], "one procedure: the clinician's own patient's, not the other two");
    assert.equal((await board(x.coord.token, "?view=ALL")).body.data.total, 3, "the coordinator still sees all three");
    const other = await t.makeTenant("theatre-board-other");
    const rows = (await board(other.admin.token, "?view=ALL")).body.data;
    assert.deepEqual([rows.total, rows.rows.length], [0, 0], "another hospital sees none of it");
    assert.equal(ward.length > 0, true);
  });
});
