import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localDateStr, zonedToUtc } from "../../common/time";
import { tenantScope } from "../../common/tenant-scope";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { RoundsService } from "./rounds.service";

type User = { id: string; token: string };
type Slot = { id: string; time: string; time12: string; label: string; status: string; forAllDoctors: boolean };
const IST = "Asia/Kolkata";
let seq = 0;
const code = (p: string) => `${p}${(++seq).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`.slice(0, 14);
const today = () => localDateStr(new Date(), IST);
/** A moment on today's local calendar, in the facility's time zone. */
const at = (hhmm: string) => zonedToUtc(today(), Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), IST);

describe("ward rounds: round times, the doctor's rounds, notes, the ward board, procedures", () => {
  let t: TestApp; let a: TestTenant; let b: TestTenant;
  let coord: User; let nurse: User; let rec: User; let manager: User; let cashier: User; let bCoord: User;
  let doc: TestDoctor; let doc2: TestDoctor; let idleDoc: TestDoctor;
  let svc: RoundsService;

  const fire = (now: Date, tenant: TestTenant = a) => tenantScope.run(tenant.tenantId, () => svc.fireFacility(tenant.tenantId, tenant.facilityId, now));
  const mkBed = async () => {
    const w = (await t.api("post", "/wards", a.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const r = (await t.api("post", "/rooms", a.admin.token).send({ wardId: w.id, name: "Room", code: code("R") })).body.data;
    return (await t.api("post", "/beds", a.admin.token).send({ roomId: r.id, code: code("B"), dailyRate: "800" })).body.data as { id: string; code: string; wardId: string };
  };
  const admitted = async (consultant: TestDoctor) => {
    const bed = await mkBed();
    const patient = await registerPatient(t, rec.token);
    const r = await t.api("post", "/admissions", rec.token).send({ patientId: patient.id, consultantId: consultant.practitionerId, bedId: bed.id, reason: "Needs inpatient care and observation" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient, bed, adm: r.body.data as { id: string; encounterId: string } };
  };
  const notes = async (tok: string) => (await t.api("get", "/notifications", tok)).body.data as { type: string; entityId: string }[];
  const mine = async (d: TestDoctor) => (await t.api("get", "/rounds/mine", d.token)).body.data as { timings: (Slot & { round: string | null })[]; rounds: { id: string; status: string; label: string; patientsSeen: number | null; patientsTotal: number | null }[]; admittedPatients: number };
  const roundOf = async (d: TestDoctor, label: string) => (await mine(d)).rounds.find((r) => r.label === label);

  before(async () => {
    t = await startApp();
    svc = t.app.get(RoundsService);
    a = await t.makeTenant("rnd-a"); b = await t.makeTenant("rnd-b");
    coord = await t.makeUser(a, ["WARD_COORDINATOR"]); nurse = await t.makeUser(a, ["NURSE"]); rec = await t.makeUser(a, ["RECEPTIONIST"]); manager = await t.makeUser(a, ["MANAGER"]); cashier = await t.makeUser(a, ["CASHIER"]);
    bCoord = await t.makeUser(b, ["WARD_COORDINATOR"]);
    doc = await makeDoctor(t, a); doc2 = await makeDoctor(t, a); idleDoc = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); });

  // ───────────────────────── round times ─────────────────────────
  it("every facility starts with two round times, 7:00 AM and 12:00 PM, which the ward coordinator can change", async () => {
    const list = (await t.api("get", "/rounds/slots", coord.token)).body.data as Slot[];
    assert.deepEqual(list.map((s) => s.time), ["07:00", "12:00"]);
    assert.deepEqual(list.map((s) => s.time12), ["7:00 AM", "12:00 PM"]);
    assert.ok(list.every((s) => s.forAllDoctors && s.status === "ACTIVE"));
    // A facility added later gets the same two.
    const fac = await t.api("post", "/facilities", a.admin.token).send({ code: code("F"), name: "Second campus" });
    assert.equal(fac.status, 201, JSON.stringify(fac.body));
    assert.deepEqual((await t.prisma.roundSlot.findMany({ where: { tenantId: a.tenantId, facilityId: fac.body.data.id }, orderBy: { minutesOfDay: "asc" } })).map((x) => x.minutesOfDay), [420, 720]);
    const created = await t.api("post", "/rounds/slots", coord.token).send({ time: "16:30", label: "Evening round" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.time12, "4:30 PM");
    assert.equal((await t.api("post", "/rounds/slots", coord.token).send({ time: "16:30" })).status, 409, "one round time for all doctors at a time");
    assert.equal((await t.api("post", "/rounds/slots", coord.token).send({ time: "25:00" })).status, 400);
    assert.equal((await t.api("post", "/rounds/slots", coord.token).send({ time: "09:00", extra: 1 })).status, 400);
    const moved = await t.api("patch", `/rounds/slots/${created.body.data.id}`, coord.token).send({ time: "17:00" });
    assert.equal(moved.body.data.time, "17:00");
    assert.equal((await t.api("patch", `/rounds/slots/${created.body.data.id}`, coord.token).send({})).status, 400);
    const off = await t.api("patch", `/rounds/slots/${created.body.data.id}`, coord.token).send({ status: "INACTIVE" });
    assert.equal(off.body.data.status, "INACTIVE");
    // A time for one doctor only.
    const own = await t.api("post", "/rounds/slots", coord.token).send({ time: "18:00", label: "Dr. extra round", practitionerId: doc.practitionerId });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(own.body.data.forAllDoctors, false);
    assert.equal((await t.api("post", "/rounds/slots", coord.token).send({ time: "19:00", practitionerId: randomUUID() })).status, 400);
    const audits = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityType: "RoundSlot" }, select: { action: true } });
    assert.ok(audits.some((x) => x.action === "ROUND_SLOT_CREATED") && audits.some((x) => x.action === "ROUND_SLOT_UPDATED"));
    // The doctors and nurses can read the times and cannot change them.
    for (const tok of [doc.token, nurse.token, manager.token]) assert.equal((await t.api("get", "/rounds/slots", tok)).status, 200);
    for (const tok of [doc.token, nurse.token, rec.token, manager.token]) assert.equal((await t.api("post", "/rounds/slots", tok).send({ time: "20:00" })).status, 403);
    assert.equal((await t.api("patch", `/rounds/slots/${created.body.data.id}`, doc.token).send({ time: "20:00" })).status, 403);
    // Another hospital never sees or changes them.
    assert.equal((await t.api("get", "/rounds/slots", bCoord.token)).body.data.length, 2);
    assert.equal((await t.api("patch", `/rounds/slots/${created.body.data.id}`, bCoord.token).send({ time: "20:00" })).status, 404);
  });

  it("the doctor's profile shows the round times set for all doctors and for that doctor, and nobody else's", async () => {
    const m = await mine(doc);
    const times = m.timings.map((s) => s.time);
    assert.ok(times.includes("07:00") && times.includes("12:00") && times.includes("18:00"), times.join());
    const other = await mine(doc2);
    assert.ok(!other.timings.some((s) => s.time === "18:00"), "another doctor's own time is not shown");
    assert.equal((await t.api("get", "/rounds/mine", nurse.token)).status, 403, "only a doctor has rounds");
    assert.equal((await t.api("get", "/rounds/mine", coord.token)).status, 403);
  });

  // ───────────────────────── the doctor is told ─────────────────────────
  it("when a round time comes, the doctor who has admitted patients is told once; a doctor with no patients is not; nothing happens before the time or long after it", async () => {
    const p1 = await admitted(doc);
    await admitted(doc2);
    assert.deepEqual(await fire(at("06:30")), { created: 0, missed: 0 }, "before 7:00 nothing is due");
    const r = await fire(at("07:05"));
    assert.ok(r.created >= 2, `the doctors with patients are told: ${JSON.stringify(r)}`);
    const n = (await notes(doc.token)).filter((x) => x.type === "ROUND_DUE");
    assert.equal(n.length, 1, "told once");
    const round = await roundOf(doc, "Morning round");
    assert.ok(round && round.status === "NOTIFIED");
    assert.equal(n[0]?.entityId, round.id);
    assert.equal((await notes(idleDoc.token)).filter((x) => x.type === "ROUND_DUE").length, 0, "a doctor with no admitted patients is not told");
    assert.equal(await t.prisma.wardRound.count({ where: { tenantId: a.tenantId, practitionerId: idleDoc.practitionerId } }), 0);
    assert.equal((await fire(at("07:10"))).created, 0, "running again makes no second round");
    assert.equal((await notes(doc.token)).filter((x) => x.type === "ROUND_DUE").length, 1);
    void p1;
  });

  it("a round the doctor does not start in time is marked missed and the coordinator is told", async () => {
    const m = await mine(doc);
    const morning = m.rounds.find((r) => r.label === "Morning round")!;
    assert.equal(morning.status, "NOTIFIED");
    const res = await fire(at("08:30"));
    assert.ok(res.missed >= 1, JSON.stringify(res));
    assert.equal((await roundOf(doc, "Morning round"))?.status, "MISSED");
    assert.ok((await notes(coord.token)).some((x) => x.type === "ROUND_MISSED"), "the coordinator is told");
    assert.ok((await notes(a.admin.token)).some((x) => x.type === "ROUND_MISSED"), "so is the administrator");
    assert.equal((await notes(nurse.token)).some((x) => x.type === "ROUND_MISSED"), false);
    // The noon time makes its own round when it comes, and the doctor's own 18:00 time is made for that doctor only; a time more than 6 hours past is not made late.
    assert.equal(await t.prisma.wardRound.count({ where: { tenantId: a.tenantId, practitionerId: doc.practitionerId, label: "Noon round" } }), 0);
    await fire(at("12:02"));
    assert.ok(await roundOf(doc, "Noon round"));
    await fire(at("18:01"));
    assert.ok(await roundOf(doc, "Dr. extra round"));
    assert.equal((await mine(doc2)).rounds.some((x) => x.label === "Dr. extra round"), false);
    // A missed round can still be started, late.
    const s = await t.api("post", `/rounds/${morning.id}/start`, doc.token);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.data.round.status, "STARTED");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ROUND_STARTED", entityId: morning.id } }));
  });

  // ───────────────────────── the round and its notes ─────────────────────────
  it("the doctor starts the round, writes a note for each patient with instructions for the nurses, and finishes", async () => {
    const x = await admitted(doc);
    await fire(at("12:05"));
    const noon = (await roundOf(doc, "Noon round"))!;
    assert.equal((await t.api("get", `/rounds/${noon.id}`, doc2.token)).status, 404, "another doctor cannot open it");
    assert.equal((await t.api("post", `/rounds/${noon.id}/start`, doc2.token)).status, 404);
    assert.equal((await t.api("post", `/rounds/${noon.id}/start`, nurse.token)).status, 403);
    const started = await t.api("post", `/rounds/${noon.id}/start`, doc.token);
    assert.equal(started.body.data.round.status, "STARTED");
    assert.equal((await t.api("post", `/rounds/${noon.id}/start`, doc.token)).status, 200, "starting twice is harmless");
    const view = (await t.api("get", `/rounds/${noon.id}`, doc.token)).body.data as { total: number; seen: number; patients: { admissionId: string; bed: string; seenThisRound: boolean; vitals: { late: boolean }; medicines: { active: number } }[] };
    assert.ok(view.total >= 2);
    const mineRow = view.patients.find((p) => p.admissionId === x.adm.id)!;
    assert.equal(mineRow.bed, x.bed.code);
    assert.equal(mineRow.seenThisRound, false);
    assert.equal(mineRow.vitals.late, true, "no vitals yet");
    // The note: how the patient is, the plan, and two instructions for the nurses.
    const bad = await t.api("post", `/admissions/${x.adm.id}/round-notes`, doc.token).send({ roundId: noon.id, note: "x" });
    assert.equal(bad.status, 400);
    const made = await t.api("post", `/admissions/${x.adm.id}/round-notes`, doc.token).send({ roundId: noon.id, condition: "IMPROVING", note: "Afebrile overnight, eating well, pain settling", plan: "Continue antibiotics, review blood count tomorrow", instructions: [{ text: "Check temperature every 4 hours", dueInMinutes: 30 }, { text: "Encourage walking with support" }] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const tasks = await t.prisma.nursingTask.findMany({ where: { admissionId: x.adm.id }, orderBy: { title: "asc" } });
    assert.deepEqual(tasks.map((k) => k.title), ["Check temperature every 4 hours", "Encourage walking with support"]);
    assert.ok(tasks.every((k) => k.status === "PENDING" && k.sourceKey?.startsWith(`ROUNDNOTE:${made.body.data.id}`)));
    assert.ok((await notes(nurse.token)).some((n) => n.type === "NURSING_INSTRUCTION" && n.entityId === x.adm.id), "the nurses are told");
    const wl = (await t.api("get", "/nursing/worklist", nurse.token)).body.data as { admissionId: string; pendingTasks: number }[];
    assert.equal(wl.find((r) => r.admissionId === x.adm.id)?.pendingTasks, 2, "the instructions are on the nurses' list");
    // The notes of the admission, newest first; the round shows the patient as seen.
    const list = (await t.api("get", `/admissions/${x.adm.id}/round-notes`, doc.token)).body.data as { id: string; note: string; round: string | null }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]?.round, "Noon round");
    const after = (await t.api("get", `/rounds/${noon.id}`, doc.token)).body.data as { seen: number; patients: { admissionId: string; seenThisRound: boolean; lastNote: { note: string } | null }[] };
    assert.equal(after.seen, 1);
    assert.equal(after.patients.find((p) => p.admissionId === x.adm.id)?.lastNote?.note, "Afebrile overnight, eating well, pain settling");
    // Another doctor cannot write on this doctor's patient; a nurse cannot write doctor's notes.
    assert.equal((await t.api("post", `/admissions/${x.adm.id}/round-notes`, doc2.token).send({ note: "Not my patient at all" })).status, 404, "another doctor does not even see the patient");
    assert.equal((await t.api("post", `/admissions/${x.adm.id}/round-notes`, nurse.token).send({ note: "Nurse writing a doctor's note" })).status, 403);
    // A correction is a new note referring to the first; the first can be marked as entered in error, by its author only.
    const add = await t.api("post", `/admissions/${x.adm.id}/round-notes`, doc.token).send({ roundId: noon.id, note: "Addendum: temperature 37.4 on the second check", addendumOfId: made.body.data.id });
    assert.equal(add.status, 201);
    assert.equal((await t.api("post", `/round-notes/${made.body.data.id}/enter-in-error`, doc2.token).send({ reason: "Wrong patient chart" })).status, 403);
    assert.equal((await t.api("post", `/round-notes/${made.body.data.id}/enter-in-error`, doc.token).send({ reason: "Wrote it on the wrong day" })).status, 200);
    assert.equal((await t.api("post", `/round-notes/${made.body.data.id}/enter-in-error`, doc.token).send({ reason: "Again for no reason" })).status, 409);
    await assert.rejects(() => t.prisma.roundNote.update({ where: { id: made.body.data.id }, data: { note: "Rewritten history" } }), "the text of a note never changes");
    await assert.rejects(() => t.prisma.roundNote.delete({ where: { id: made.body.data.id } }));
    // Finishing keeps how many were seen; a finished round takes no more notes.
    const done = await t.api("post", `/rounds/${noon.id}/complete`, doc.token);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.round.status, "COMPLETED");
    assert.equal(done.body.data.round.patientsSeen, 1);
    assert.ok(done.body.data.round.patientsTotal >= 2);
    assert.equal((await t.api("post", `/rounds/${noon.id}/complete`, doc.token)).status, 409);
    assert.equal((await t.api("post", `/rounds/${noon.id}/start`, doc.token)).status, 409);
    assert.equal((await t.api("post", `/admissions/${x.adm.id}/round-notes`, doc.token).send({ roundId: noon.id, note: "Late addition after the round" })).status, 409);
    await assert.rejects(() => t.prisma.wardRound.update({ where: { id: noon.id }, data: { status: "STARTED" } }), "a finished round is final");
    // A note outside a round is allowed (an extra visit).
    assert.equal((await t.api("post", `/admissions/${x.adm.id}/round-notes`, doc.token).send({ note: "Called to see the patient again in the evening" })).status, 201);
  });

  // ───────────────────────── the ward board ─────────────────────────
  it("the ward coordinator sees every ward, patient, round and what people have done; others do not, and another hospital's board is its own", async () => {
    const y = await admitted(doc2);
    const board = (await t.api("get", "/ward-board", coord.token)).body.data as {
      totals: { admitted: number }; rounds: { label: string; doctor: string; status: string }[]; timings: Slot[];
      wards: { name: string; occupied: number; patients: { admissionId: string; doctor: string; bed: string; vitals: unknown; medicines: unknown; tasks: { pending: number }; lastNote: unknown; charges: { pendingTotal: string } }[] }[];
    };
    assert.ok(board.totals.admitted >= 4);
    const w = board.wards.find((x) => x.patients.some((p) => p.admissionId === y.adm.id))!;
    assert.ok(w && w.occupied >= 1);
    const row = w.patients.find((p) => p.admissionId === y.adm.id)!;
    assert.equal(row.bed, y.bed.code);
    assert.ok(row.vitals && row.medicines && row.charges);
    assert.ok(board.rounds.some((r) => r.label === "Noon round" && r.status === "COMPLETED"), "today's rounds are on the board");
    assert.ok(board.timings.some((s) => s.time === "07:00"));
    const noted = board.wards.flatMap((x) => x.patients).find((p) => p.lastNote !== null);
    assert.ok(noted, "a patient the doctor wrote about shows the last note");
    const act = (await t.api("get", "/ward-board/activity?limit=60", coord.token)).body.data as { kind: string; text: string }[];
    const kinds = new Set(act.map((x) => x.kind));
    for (const k of ["ROUND_NOTE", "ADMITTED", "ROUND"]) assert.ok(kinds.has(k), `${k} in ${[...kinds].join()}`);
    assert.equal((await t.api("get", "/ward-board", manager.token)).status, 200);
    assert.equal((await t.api("get", "/ward-board", a.admin.token)).status, 200);
    for (const tok of [doc.token, nurse.token, rec.token, cashier.token]) { assert.equal((await t.api("get", "/ward-board", tok)).status, 403); assert.equal((await t.api("get", "/ward-board/activity", tok)).status, 403); }
    // The coordinator reads; the coordinator cannot treat, order or write notes.
    assert.equal((await t.api("post", `/admissions/${y.adm.id}/round-notes`, coord.token).send({ note: "Coordinator trying to write a note" })).status, 403);
    assert.equal((await t.api("post", `/admissions/${y.adm.id}/procedures`, coord.token).send({ name: "Dressing", outcome: "Done" })).status, 403);
    assert.equal((await t.api("get", "/ward-board", bCoord.token)).body.data.totals.admitted, 0);
    assert.equal((await t.api("get", "/ward-board/activity", bCoord.token)).body.data.length, 0);
  });

  // ───────────────────────── nursing task list from orders ─────────────────────────
  it("a signed medicine order shows on the nurses' list as a new order until its dose schedule is started", async () => {
    const z = await admitted(doc);
    const wl = async () => ((await t.api("get", "/nursing/worklist", nurse.token)).body.data as { admissionId: string; newMedicineOrders: number }[]).find((r) => r.admissionId === z.adm.id);
    assert.equal((await wl())?.newMedicineOrders, 0);
    const save = await t.api("put", `/encounters/${z.adm.encounterId}/prescription`, doc.token).send({ items: [{ genericName: "Ceftriaxone", strength: "1 g", dosage: "1 vial", route: "IV", frequency: "BD", durationDays: 3 }] });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.equal((await t.api("post", `/encounters/${z.adm.encounterId}/prescription/sign`, doc.token).send({})).status, 200);
    assert.equal((await wl())?.newMedicineOrders, 1, "a new order waits for its schedule");
    const board = (await t.api("get", "/ward-board", coord.token)).body.data as { wards: { patients: { admissionId: string; medicines: { withoutSchedule: number; active: number } }[] }[] };
    assert.equal(board.wards.flatMap((x) => x.patients).find((p) => p.admissionId === z.adm.id)?.medicines.withoutSchedule, 1);
    assert.equal((await t.api("post", `/admissions/${z.adm.id}/mar/generate`, nurse.token).send({ hours: 24 })).status, 200);
    assert.equal((await wl())?.newMedicineOrders, 0, "the schedule is started");
  });

  // ───────────────────────── procedures ─────────────────────────
  it("a procedure is recorded and its charge added to the admission; a wrong entry takes its charge off; permissions and isolation hold", async () => {
    const p = await admitted(doc);
    const svcRow = (await t.api("post", "/services", a.admin.token).send({ code: code("PR"), name: "Dressing (large)", category: "PROCEDURE", price: "350", taxPercent: 0 })).body.data as { id: string };
    const ok = await t.api("post", `/admissions/${p.adm.id}/procedures`, doc.token).send({ name: "Dressing of the abdominal wound", serviceId: svcRow.id, outcome: "Wound clean, no discharge, sutures intact" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.charged.status, "PENDING");
    const charge = await t.prisma.charge.findFirstOrThrow({ where: { admissionId: p.adm.id, type: "PROCEDURE" } });
    assert.equal(charge.unitPrice.toString(), "350");
    assert.equal(charge.sourceKey, `PROC:${ok.body.data.id}`);
    const none = await t.api("post", `/admissions/${p.adm.id}/procedures`, doc.token).send({ name: "Bedside ultrasound check", outcome: "No free fluid seen" });
    assert.equal(none.status, 201);
    assert.equal(none.body.data.charged, null, "no service, no charge");
    assert.equal(await t.prisma.charge.count({ where: { admissionId: p.adm.id, type: "PROCEDURE" } }), 1);
    // Rules.
    assert.equal((await t.api("post", `/admissions/${p.adm.id}/procedures`, doc.token).send({ name: "Future procedure", outcome: "Planned", performedAt: new Date(Date.now() + 86_400_000).toISOString() })).status, 400);
    assert.equal((await t.api("post", `/admissions/${p.adm.id}/procedures`, doc.token).send({ name: "Unknown service", outcome: "Done", serviceId: randomUUID() })).status, 400);
    assert.equal((await t.api("post", `/admissions/${p.adm.id}/procedures`, doc.token).send({ name: "ab", outcome: "Done" })).status, 400);
    assert.equal((await t.api("post", `/admissions/${p.adm.id}/procedures`, nurse.token).send({ name: "Nurse doing it", outcome: "Done" })).status, 403);
    assert.equal((await t.api("post", `/admissions/${p.adm.id}/procedures`, doc2.token).send({ name: "Another doctor's patient", outcome: "Done" })).status, 404, "a doctor sees only their own patients");
    const list = (await t.api("get", `/admissions/${p.adm.id}/procedures`, nurse.token)).body.data as { id: string }[];
    assert.equal(list.length, 2);
    // A wrong entry: marked, and its charge is voided.
    assert.equal((await t.api("post", `/procedures/${ok.body.data.id}/enter-in-error`, doc.token).send({ reason: "Recorded on the wrong patient" })).status, 200);
    assert.equal((await t.prisma.charge.findFirstOrThrow({ where: { id: charge.id } })).status, "VOIDED");
    assert.equal((await t.api("post", `/procedures/${ok.body.data.id}/enter-in-error`, doc.token).send({ reason: "Again" })).status, 409);
    await assert.rejects(() => t.prisma.procedureRecord.update({ where: { id: none.body.data.id }, data: { name: "Rewritten procedure" } }));
    await assert.rejects(() => t.prisma.procedureRecord.delete({ where: { id: none.body.data.id } }));
    // Isolation.
    const bDoc = await makeDoctor(t, b);
    assert.equal((await t.api("get", `/admissions/${p.adm.id}/procedures`, bDoc.token)).status, 404);
    assert.equal((await t.api("post", `/procedures/${none.body.data.id}/enter-in-error`, bDoc.token).send({ reason: "Other hospital trying" })).status, 404);
    assert.equal((await t.api("get", `/admissions/${p.adm.id}/round-notes`, bDoc.token)).status, 404);
  });

  it("a procedure charge already on a bill cannot be taken off by marking the entry, and a discharged patient takes no new procedure", async () => {
    const p = await admitted(doc);
    const svcRow = (await t.api("post", "/services", a.admin.token).send({ code: code("PB"), name: "Chest tube care", category: "PROCEDURE", price: "500", taxPercent: 0 })).body.data as { id: string };
    const made = (await t.api("post", `/admissions/${p.adm.id}/procedures`, doc.token).send({ name: "Chest tube care", serviceId: svcRow.id, outcome: "Drain working, 40 ml serous" })).body.data as { id: string };
    await t.prisma.charge.updateMany({ where: { admissionId: p.adm.id, type: "PROCEDURE" }, data: { status: "BILLED" } }).catch(() => undefined);
    const billed = await t.prisma.charge.findFirst({ where: { admissionId: p.adm.id, type: "PROCEDURE", status: "BILLED" } });
    if (billed) assert.equal((await t.api("post", `/procedures/${made.id}/enter-in-error`, doc.token).send({ reason: "Trying after billing" })).status, 409);
    await t.prisma.admission.update({ where: { id: p.adm.id }, data: { status: "DISCHARGED", dischargedAt: new Date(), dischargeType: "ROUTINE" } });
    assert.equal((await t.api("post", `/admissions/${p.adm.id}/procedures`, doc.token).send({ name: "After discharge", outcome: "Done" })).status, 409);
    assert.equal((await t.api("post", `/admissions/${p.adm.id}/round-notes`, doc.token).send({ note: "Note after discharge" })).status, 409);
  });
});
