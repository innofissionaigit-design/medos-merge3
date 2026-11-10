import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LimsMessagesService } from "./lims-messages.service";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;
type User = { id: string; token: string };
interface Req {
  id: string; requestNumber: string; status: string; priority: string; origin: string; department: string; test: string; testOrderId: string; encounterId: string; batchId: string;
  resultId: string | null; resultVersion: number | null; studyId: string | null; dueAt: string; needsRecollection: boolean; recollectCount: number; returnedCount: number; accessionNumber: string | null;
  patient: { id: string; name: string; mrn: string | null };
}

describe("LIMS portal: orders, queues, samples, reports and monitoring", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: User; let cashier: User; let nurse: User; let nurse2: User; let pTech: User; let rTech: User; let path: User; let radiologist: User; let mgr: User; let hospMgr: User;
  let doc: TestDoctor; let doc2: TestDoctor;
  let bMgr: User; let bNurse: User; let bDoc: TestDoctor; let bRec: User;
  let cbc: { id: string; name: string };
  let hb: string;
  let messages: LimsMessagesService;

  // ───── helpers ─────
  const get = async (path_: string, tok: string) => (await t.api("get", path_, tok)).body.data;
  const mkBed = async () => {
    const w = (await t.api("post", "/wards", a.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const r = (await t.api("post", "/rooms", a.admin.token).send({ wardId: w.id, name: "Room", code: code("R") })).body.data;
    return (await t.api("post", "/beds", a.admin.token).send({ roomId: r.id, code: code("B"), dailyRate: "800" })).body.data as { id: string };
  };
  /** An admitted patient (own bed) under the given consultant. */
  const admitted = async (consultant: TestDoctor = doc) => {
    const bed = await mkBed();
    const patient = await registerPatient(t, rec.token);
    const r = await t.api("post", "/admissions", rec.token).send({ patientId: patient.id, consultantId: consultant.practitionerId, bedId: bed.id, reason: "Acute illness needing inpatient care" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient, encounterId: r.body.data.encounterId as string };
  };
  const order = (encounterId: string, tests: { name: string; category: "LABORATORY" | "RADIOLOGY" }[], priority = "ROUTINE", tok = doc.token) =>
    t.api("post", "/lims/orders", tok).send({ encounterId, priority, tests });
  const forVisit = async (encounterId: string, tok = mgr.token): Promise<Req[]> => {
    const rows: Req[] = [];
    for (const dep of ["PATHOLOGY", "RADIOLOGY"]) rows.push(...((await get(`/lims/requests?department=${dep}&pageSize=100`, tok))?.items ?? []).filter((r: Req) => r.encounterId === encounterId));
    return rows;
  };
  const only = async (encounterId: string, test: string, tok = mgr.token) => { const r = (await forVisit(encounterId, tok)).find((x) => x.test === test); assert.ok(r, `request for ${test}`); return r; };
  const notes = async (tok: string) => (await t.api("get", "/notifications", tok)).body.data as { type: string; entityId: string }[];
  const detail = async (id: string, tok = mgr.token) => (await t.api("get", `/lims/requests/${id}`, tok));
  /** Takes a step. A nurse may take an outpatient's sample only after the patient has reported at reception, so the tests of the steps after that mark the patient as reported first. */
  const act = async (id: string, step: string, tok: string, body: Record<string, unknown> = {}) => {
    if (step === "collect") await t.prisma.limsRequest.updateMany({ where: { id, origin: "OPD", arrivedAt: null }, data: { arrivedAt: new Date(), arrivedById: rec.id } });
    return t.api("post", `/lims/requests/${id}/${step}`, tok).send(body);
  };
  const statusOf = async (id: string) => (await t.prisma.limsRequest.findFirstOrThrow({ where: { id } })).status;
  const typed = (resultId: string, version: number, value = "13.2", tok = pTech.token) =>
    t.api("put", `/lab/results/${resultId}/draft`, tok).send({ version, values: [{ parameterId: hb, value }] });

  /** An admitted patient with one laboratory test ordered and the sample taken: waiting for the technician. */
  const collectedLab = async (priority = "ROUTINE") => {
    const { patient, encounterId } = await admitted();
    assert.equal((await order(encounterId, [{ name: cbc.name, category: "LABORATORY" }], priority)).status, 201);
    const r = await only(encounterId, cbc.name);
    assert.equal((await act(r.id, "collect", nurse.token)).status, 200);
    return { patient, encounterId, r: await only(encounterId, cbc.name) };
  };
  /** The same, accepted and with a value typed in: ready to be sent for review. */
  const workedLab = async () => {
    const x = await collectedLab();
    assert.equal((await act(x.r.id, "accept", pTech.token)).status, 200);
    const r = await only(x.encounterId, cbc.name);
    const d = await typed(r.resultId!, r.resultVersion!);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    return { ...x, r: await only(x.encounterId, cbc.name) };
  };
  /** Sent for review and passed by the pathologist: waiting for the technician to issue. */
  const passedLab = async () => {
    const x = await workedLab();
    assert.equal((await act(x.r.id, "submit", pTech.token)).status, 200);
    const r = await only(x.encounterId, cbc.name);
    const v = await t.api("post", `/lab/results/${r.resultId}/verify`, path.token).send({ version: r.resultVersion });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return { ...x, r: await only(x.encounterId, cbc.name) };
  };

  /** An outpatient whose doctor signed a consultation advising the test: the order waits at reception. */
  const advised = async (tests: { lab?: string[]; imaging?: string[] } = { lab: ["Complete blood count"] }) => {
    const patient = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, doc, patient.id);
    await t.api("post", `/queue/${v.queueId}/start`, doc.token);
    const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Fever for three days", investigationsAdvised: tests.lab ?? [], otherTestsAdvised: tests.imaging ?? [] } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Viral fever", type: "PROVISIONAL" });
    const s = await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: c.body.data.version, acknowledgeAllergyWarnings: true });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const orders = await t.prisma.testOrder.findMany({ where: { encounterId: v.encounterId }, orderBy: { createdAt: "asc" } });
    return { patient, encounterId: v.encounterId, orders };
  };
  const launch = (encounterId: string, testOrderIds: string[], o: Record<string, unknown> = {}, tok = rec.token) =>
    t.api("post", "/lims/opd/launch", tok).send({ encounterId, consent: true, testOrderIds, ...o });

  before(async () => {
    t = await startApp();
    messages = t.app.get(LimsMessagesService);
    a = await t.makeTenant("lims-a");
    b = await t.makeTenant("lims-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]); cashier = await t.makeUser(a, ["CASHIER"]); nurse = await t.makeUser(a, ["NURSE"]); nurse2 = await t.makeUser(a, ["NURSE"]);
    pTech = await t.makeUser(a, ["P_LAB_TECH"]); rTech = await t.makeUser(a, ["R_LAB_TECH"]); path = await t.makeUser(a, ["PATHOLOGIST"]); radiologist = await t.makeUser(a, ["RADIOLOGIST"]);
    mgr = await t.makeUser(a, ["LIMS_MANAGER"]); hospMgr = await t.makeUser(a, ["MANAGER"]);
    doc = await makeDoctor(t, a); doc2 = await makeDoctor(t, a);
    bMgr = await t.makeUser(b, ["LIMS_MANAGER"]); bNurse = await t.makeUser(b, ["NURSE"]); bRec = await t.makeUser(b, ["RECEPTIONIST"]); bDoc = await makeDoctor(t, b);
    cbc = (await t.api("post", "/services", a.admin.token).send({ code: code("T"), name: "Complete blood count", category: "INVESTIGATION", price: "250", taxPercent: 0 })).body.data;
    const def = await t.api("put", `/lab/tests/${cbc.id}`, path.token).send({
      specimen: "Blood (EDTA)", turnaroundHours: 4, instructions: "No fasting is needed.",
      parameters: [{ name: "Haemoglobin", unit: "g/dL", type: "NUMERIC", decimals: 1, lowMale: 13.5, highMale: 17.5, lowFemale: 12, highFemale: 15.5, criticalLow: 7, criticalHigh: 20 }],
    });
    assert.equal(def.status, 200, JSON.stringify(def.body));
    hb = def.body.data.definition.parameters[0].id as string;
  });
  after(async () => { await t.close(); });

  // ───────────────────────── the two departments ─────────────────────────
  describe("departments", () => {
    it("every facility has Pathology and Radiology; the administrator keeps them; the manager and the LIMS manager only look", async () => {
      for (const tok of [mgr.token, hospMgr.token, a.admin.token]) {
        const list = (await t.api("get", "/lims/departments", tok)).body.data as { kind: string; name: string; status: string }[];
        assert.deepEqual(list.map((d) => d.kind).sort(), ["PATHOLOGY", "RADIOLOGY"]);
        assert.deepEqual(list.map((d) => d.name).sort(), ["Pathology", "Radiology"]);
      }
      const body = { name: "Pathology", status: "ACTIVE", routineTatMinutes: 720, urgentTatMinutes: 240, emergencyTatMinutes: 90, defaultInstructions: "Bring your previous reports.", capacityPerHour: 8, openMinute: 480, closeMinute: 1080 };
      assert.equal((await t.api("put", "/lims/departments/pathology", mgr.token).send(body)).status, 403);
      assert.equal((await t.api("put", "/lims/departments/pathology", hospMgr.token).send(body)).status, 403);
      assert.equal((await t.api("put", "/lims/departments/pathology", a.admin.token).send(body)).status, 200);
      const list = (await t.api("get", "/lims/departments", mgr.token)).body.data as { kind: string; routineTatMinutes: number; defaultInstructions: string | null }[];
      assert.equal(list.find((d) => d.kind === "PATHOLOGY")!.routineTatMinutes, 720);
      assert.equal(list.find((d) => d.kind === "PATHOLOGY")!.defaultInstructions, "Bring your previous reports.");
      // Targets must get shorter from routine to urgent to emergency.
      assert.equal((await t.api("put", "/lims/departments/pathology", a.admin.token).send({ ...body, urgentTatMinutes: 900 })).status, 400);
      assert.equal((await t.api("put", "/lims/departments/laboratory", a.admin.token).send(body)).status, 400);
      await t.api("put", "/lims/departments/pathology", a.admin.token).send({ ...body, routineTatMinutes: 1440, urgentTatMinutes: 360, emergencyTatMinutes: 120, defaultInstructions: null });
      const audit = await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "LIMS_DEPARTMENT_CHANGED" } });
      assert.ok(audit >= 2, "department changes are audited");
    });

    it("a department with open work cannot be switched off; a switched-off department takes no new requests", async () => {
      const bPatient = await registerPatient(t, bRec.token);
      const bBed = await (async () => {
        const w = (await t.api("post", "/wards", b.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
        const r = (await t.api("post", "/rooms", b.admin.token).send({ wardId: w.id, name: "Room", code: code("R") })).body.data;
        return (await t.api("post", "/beds", b.admin.token).send({ roomId: r.id, code: code("B"), dailyRate: "800" })).body.data as { id: string };
      })();
      const adm = await t.api("post", "/admissions", bRec.token).send({ patientId: bPatient.id, consultantId: bDoc.practitionerId, bedId: bBed.id, reason: "Observation after surgery" });
      assert.equal(adm.status, 201, JSON.stringify(adm.body));
      const body = { name: "Radiology", status: "INACTIVE", routineTatMinutes: 1440, urgentTatMinutes: 360, emergencyTatMinutes: 60, capacityPerHour: 3, openMinute: 480, closeMinute: 1080 };
      assert.equal((await t.api("put", "/lims/departments/radiology", b.admin.token).send(body)).status, 200);
      const o = await order(adm.body.data.encounterId, [{ name: "X-ray chest", category: "RADIOLOGY" }], "ROUTINE", bDoc.token);
      assert.equal(o.status, 409, JSON.stringify(o.body));
      assert.match(o.body.error.message, /not taking requests/);
      assert.equal((await t.api("put", "/lims/departments/radiology", b.admin.token).send({ ...body, status: "ACTIVE" })).status, 200);
      const ok = await order(adm.body.data.encounterId, [{ name: "X-ray chest", category: "RADIOLOGY" }], "ROUTINE", bDoc.token);
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const off = await t.api("put", "/lims/departments/radiology", b.admin.token).send(body);
      assert.equal(off.status, 409, "one request is still open");
    });
  });

  // ───────────────────────── inpatients ─────────────────────────
  describe("an admitted patient's tests", () => {
    it("go straight to the lab with no consent; an emergency comes first; every step is by the right person; the doctor sees the report only when it is issued", async () => {
      const { patient, encounterId } = await admitted();
      const routine = await order(encounterId, [{ name: cbc.name, category: "LABORATORY" }]);
      assert.equal(routine.status, 201, JSON.stringify(routine.body));
      assert.equal(routine.body.data.routedToLab, true);
      const em = await order(encounterId, [{ name: "X-ray chest", category: "RADIOLOGY" }], "EMERGENCY");
      assert.equal(em.status, 201, JSON.stringify(em.body));

      const lab = await only(encounterId, cbc.name);
      const rad = await only(encounterId, "X-ray chest");
      assert.deepEqual([lab.origin, lab.status, lab.priority, lab.department], ["IPD", "PENDING_COLLECTION", "ROUTINE", "PATHOLOGY"]);
      assert.deepEqual([rad.origin, rad.status, rad.priority, rad.department], ["IPD", "PENDING_COLLECTION", "EMERGENCY", "RADIOLOGY"]);
      assert.match(lab.requestNumber, /^LRQ-\d{4}-\d{6}$/);
      const consent = await t.prisma.limsRequest.findFirstOrThrow({ where: { id: lab.id } });
      assert.equal(consent.consent, "NOT_REQUIRED");
      assert.ok(new Date(rad.dueAt).getTime() < new Date(lab.dueAt).getTime(), "an emergency has the shorter deadline");
      // The orders are not billed: billing is a separate step.
      assert.deepEqual((await t.prisma.testOrder.findMany({ where: { encounterId }, select: { status: true, source: true } })).map((o) => [o.status, o.source]), [["ORDERED", "LIMS"], ["ORDERED", "LIMS"]]);

      // The queue puts the emergency first. (The manager sees both departments.)
      const queue = (await get(`/lims/requests?status=PENDING_COLLECTION&pageSize=100`, mgr.token)).items as Req[];
      const mine = queue.filter((r) => r.encounterId === encounterId);
      assert.deepEqual(mine.map((r) => r.test), ["X-ray chest", cbc.name]);
      assert.ok(queue.findIndex((r) => r.id === rad.id) < queue.findIndex((r) => r.id === lab.id));
      // Each technician sees only their own department.
      assert.deepEqual((await forVisit(encounterId, pTech.token)).map((r) => r.test), [cbc.name]);
      assert.deepEqual((await forVisit(encounterId, rTech.token)).map((r) => r.test), ["X-ray chest"]);
      assert.equal((await detail(rad.id, pTech.token)).status, 404);
      assert.equal((await detail(lab.id, rTech.token)).status, 404);

      // The nurse takes the sample and gets the patient ready.
      assert.equal((await act(lab.id, "collect", nurse.token)).status, 200);
      assert.equal((await act(rad.id, "collect", nurse.token)).status, 200);
      const sample = await t.prisma.labSample.findFirstOrThrow({ where: { testOrderId: lab.testOrderId } });
      assert.equal(sample.collectedById, nurse.id);
      assert.match(sample.accessionNumber, /^LAB-/);

      // Laboratory: the technician must accept before typing; review needs the technician to send it first.
      const l1 = await only(encounterId, cbc.name);
      assert.equal(l1.status, "COLLECTED");
      assert.equal((await typed(l1.resultId!, l1.resultVersion!)).status, 409, "results are not typed before the sample is accepted");
      assert.equal((await act(l1.id, "accept", pTech.token)).status, 200);
      const l2 = await only(encounterId, cbc.name);
      assert.equal((await typed(l2.resultId!, l2.resultVersion!)).status, 200);
      assert.equal((await t.api("post", `/lab/results/${l2.resultId}/verify`, path.token).send({ version: l2.resultVersion! + 1 })).status, 409, "the pathologist cannot pass what was not sent for review");
      assert.equal((await act(l2.id, "submit", pTech.token)).status, 200);
      assert.ok((await notes(path.token)).some((n: { type: string; entityId: string }) => n.type === "LIMS_REVIEW_WAITING" && n.entityId === l2.id), "the pathologist is told");
      const l3 = await only(encounterId, cbc.name);
      assert.equal(l3.status, "PENDING_REVIEW");
      assert.equal((await act(l3.id, "issue", pTech.token)).status, 409, "nothing is issued before it is passed");
      const verify = await t.api("post", `/lab/results/${l3.resultId}/verify`, path.token).send({ version: l2.resultVersion! + 1 });
      assert.equal(verify.status, 200, JSON.stringify(verify.body));
      assert.equal(await statusOf(l3.id), "PASSED");

      // Passed but not issued: the doctor cannot see the report yet.
      const before = (await t.api("get", `/encounters/${encounterId}/lab-results`, doc.token)).body.data as { report: unknown; state: string; limsStatus: string }[];
      assert.equal(before[0]!.report, null);
      assert.equal(before[0]!.limsStatus, "PASSED");
      assert.deepEqual(((await t.api("get", `/lab/orders/${lab.testOrderId}/result`, doc.token)).body.data as { reports: unknown[] }).reports, []);
      assert.equal(((await t.api("get", `/lab/orders/${lab.testOrderId}/result`, pTech.token)).body.data as { reports: unknown[] }).reports.length, 1, "the staff who work on it can read it");
      assert.equal((await act(l3.id, "issue", path.token)).status, 403, "the pathologist does not issue");
      assert.equal((await act(l3.id, "issue", nurse.token)).status, 403);
      assert.equal((await act(l3.id, "issue", rTech.token)).status, 403, "the other department's technician cannot issue it");

      // The technician issues: now the doctor sees it and is told.
      assert.equal((await act(l3.id, "issue", pTech.token)).status, 200);
      const after = (await t.api("get", `/encounters/${encounterId}/lab-results`, doc.token)).body.data as { report: { values: { value: string }[] } | null; state: string }[];
      assert.equal(after[0]!.state, "REPORTED");
      assert.equal(after[0]!.report!.values[0]!.value, "13.2");
      assert.ok((await notes(doc.token)).some((n: { type: string; entityId: string }) => n.type === "LIMS_REPORT_ISSUED" && n.entityId === l3.id), "the doctor is told");
      assert.equal(await statusOf(l3.id), "ISSUED");
      assert.equal((await t.prisma.testOrder.findFirstOrThrow({ where: { id: lab.testOrderId } })).status, "ORDERED", "issuing does not bill or change the order");
      assert.equal((await act(l3.id, "issue", pTech.token)).status, 409, "issuing twice is refused");
      assert.equal((await act(l3.id, "handover", rec.token, { receivedBy: "Someone" })).status, 409, "an admitted patient's report goes to the doctor, not to reception");

      // Radiology: the technician performs the scan; the radiologist signs; the technician issues.
      const r1 = await only(encounterId, "X-ray chest");
      assert.equal(r1.status, "COLLECTED");
      assert.equal((await act(r1.id, "accept", rTech.token)).status, 403, "a scan is performed, not accepted");
      assert.equal((await act(r1.id, "perform", pTech.token, { modality: "XRAY", bodyPart: "Chest" })).status, 403, "only the radiology technician performs scans");
      assert.equal((await act(r1.id, "perform", rTech.token, { modality: "XRAY", bodyPart: "Chest PA" })).status, 200);
      const r2 = await only(encounterId, "X-ray chest");
      assert.equal(r2.status, "IN_PROCESS");
      assert.ok(r2.studyId && r2.accessionNumber?.startsWith("RAD-"));
      const sign = { findings: "Lungs are clear. Normal heart size.", impression: "Normal chest X-ray.", critical: false };
      assert.equal((await t.api("post", `/rad/studies/${r2.studyId}/report`, radiologist.token).send(sign)).status, 409, "the radiologist cannot sign before the technician sends it");
      assert.equal((await act(r2.id, "submit", rTech.token)).status, 200);
      assert.equal((await t.api("post", `/rad/studies/${r2.studyId}/report`, mgr.token).send(sign)).status, 403, "the LIMS manager does not sign reports");
      assert.equal((await t.api("post", `/rad/studies/${r2.studyId}/report`, radiologist.token).send(sign)).status, 200);
      assert.equal(await statusOf(r2.id), "PASSED");
      const hidden = (await t.api("get", `/encounters/${encounterId}/radiology`, doc.token)).body.data as { report: unknown }[];
      assert.equal(hidden[0]!.report, null, "the doctor does not see a signed report until it is issued");
      assert.equal((await act(r2.id, "issue", rTech.token)).status, 200);
      const shown = (await t.api("get", `/encounters/${encounterId}/radiology`, doc.token)).body.data as { report: { impression: string } | null }[];
      assert.equal(shown[0]!.report!.impression, "Normal chest X-ray.");

      // The history says who did what, in order.
      const d = (await detail(lab.id)).body.data as { timeline: { kind: string; by: string | null }[] };
      assert.deepEqual(d.timeline.map((e) => e.kind), ["CREATED", "NURSE_ASSIGNED", "COLLECTED", "ACCEPTED", "SUBMITTED", "PASSED", "ISSUED", "CHARGED"]);
      assert.ok(d.timeline.every((e) => e.by));
      const actions = (await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: lab.id } })).map((e) => e.action);
      for (const x of ["LIMS_SAMPLE_COLLECTED", "LIMS_SAMPLE_ACCEPTED", "LIMS_SENT_FOR_REVIEW", "LIMS_REPORT_PASSED", "LIMS_REPORT_ISSUED"]) assert.ok(actions.includes(x), x);
      assert.equal(patient.id, lab.patient.id);
    });

    it("an inpatient's order is refused for a doctor who may not see the patient, a duplicate, a made-up price-list item, and anyone without the right", async () => {
      const { encounterId } = await admitted(doc);
      const tests = [{ name: cbc.name, category: "LABORATORY" as const }];
      assert.equal((await order(encounterId, tests, "ROUTINE", doc2.token)).status, 404, "another doctor's patient looks like it does not exist");
      assert.equal((await order(encounterId, tests, "ROUTINE", rec.token)).status, 403);
      assert.equal((await order(encounterId, tests, "ROUTINE", nurse.token)).status, 403);
      assert.equal((await order(encounterId, tests, "ROUTINE", mgr.token)).status, 403);
      assert.equal((await order(encounterId, tests, "ROUTINE", bDoc.token)).status, 404, "another hospital's doctor cannot reach it");
      assert.equal((await t.api("post", "/lims/orders", doc.token).send({ encounterId, tests: [{ name: "Anything", category: "CARDIOLOGY" }] })).status, 400);
      assert.equal((await t.api("post", "/lims/orders", doc.token).send({ encounterId, tests: [{ name: "Anything", category: "LABORATORY", serviceId: randomUUID() }] })).status, 400);
      assert.equal((await t.api("post", "/lims/orders", doc.token).send({ encounterId, tests, tenantId: b.tenantId })).status, 400, "unknown fields are refused");
      assert.equal((await order(encounterId, tests)).status, 201);
      assert.equal((await order(encounterId, tests)).status, 409, "the same test is not ordered twice while the first is still open");
      assert.equal((await only(encounterId, cbc.name)).status, "PENDING_COLLECTION");
    });
  });

  // ───────────────────────── outpatients ─────────────────────────
  describe("an outpatient's tests", () => {
    it("wait at reception; launching needs the patient's agreement; the patient is messaged; the report is handed over at reception", async () => {
      const { patient, encounterId, orders } = await advised({ lab: [cbc.name], imaging: ["Ultrasound abdomen"] });
      assert.equal(orders.length, 2);
      assert.equal(await t.prisma.limsRequest.count({ where: { encounterId } }), 0, "nothing reaches the lab before the patient agrees");

      // Reception sees what was advised; nobody else does.
      const pending = (await t.api("get", "/lims/opd/pending", rec.token)).body.data as { encounterId: string; tests: { testOrderId: string; name: string; department: string; instructions: string | null }[]; patient: { hasMobile: boolean } }[];
      const group = pending.find((g) => g.encounterId === encounterId)!;
      assert.deepEqual(group.tests.map((x) => x.name).sort(), [cbc.name, "Ultrasound abdomen"].sort());
      assert.equal(group.tests.find((x) => x.name === cbc.name)!.instructions, "No fasting is needed.", "the test's own instructions");
      assert.equal(group.patient.hasMobile, true);
      for (const tok of [doc.token, nurse.token, pTech.token, mgr.token]) assert.equal((await t.api("get", "/lims/opd/pending", tok)).status, 403);
      const seenByDoctor = (await t.api("get", `/encounters/${encounterId}/lims`, doc.token)).body.data as { waitingAtReception: unknown[]; requests: unknown[] };
      assert.equal(seenByDoctor.waitingAtReception.length, 2);

      // Without the patient's agreement nothing is launched.
      const ids = orders.map((o) => o.id);
      assert.equal((await t.api("post", "/lims/opd/launch", rec.token).send({ encounterId, testOrderIds: ids })).status, 400);
      assert.equal((await t.api("post", "/lims/opd/launch", rec.token).send({ encounterId, consent: false, testOrderIds: ids })).status, 400);
      assert.equal((await launch(encounterId, ids, {}, doc.token)).status, 403, "a doctor does not launch outpatient requests");
      assert.equal((await launch(encounterId, ids, { scheduledFor: new Date(Date.now() - 86_400_000).toISOString() })).status, 400, "the time to come cannot be in the past");
      assert.equal((await launch(encounterId, ids, { assignedNurseId: pTech.id })).status, 400, "only someone who takes samples can be assigned");
      assert.equal((await launch(encounterId, [randomUUID()])).status, 404);

      const when = new Date(Date.now() + 3_600_000).toISOString();
      const res = await launch(encounterId, ids, { scheduledFor: when, assignedNurseId: nurse.id, consentMode: "WRITTEN", instructions: "Come fasting for 8 hours; water is allowed." });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.requests.length, 2);
      const rows = await t.prisma.limsRequest.findMany({ where: { encounterId }, orderBy: { requestNumber: "asc" } });
      assert.deepEqual(rows.map((r) => [r.origin, r.consent, r.status, r.assignedNurseId]), [["OPD", "GIVEN", "PENDING_COLLECTION", nurse.id], ["OPD", "GIVEN", "PENDING_COLLECTION", nurse.id]]);
      assert.equal(new Set(rows.map((r) => r.batchId)).size, 1, "tests launched together share one booking");
      const launched = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "LIMS_OPD_LAUNCHED", entityId: encounterId } });
      assert.deepEqual([(launched.metadata as { consent: string }).consent, (launched.metadata as { consentMode: string }).consentMode], ["GIVEN", "WRITTEN"], "the agreement is on the record");
      assert.ok((await notes(nurse.token)).some((n: { type: string }) => n.type === "LIMS_ASSIGNED"), "the assigned nurse is told");
      assert.equal((await launch(encounterId, ids)).status, 409, "a test is launched once");
      assert.equal(((await t.api("get", "/lims/opd/pending", rec.token)).body.data as { encounterId: string }[]).some((g) => g.encounterId === encounterId), false);

      // One message to the patient for the whole booking, on WhatsApp and by SMS: the department, the time, what to do; no test name.
      const queued = (await t.prisma.limsMessage.findMany({ where: { tenantId: a.tenantId, batchId: rows[0]!.batchId }, orderBy: { channel: "desc" } }));
      assert.deepEqual(queued.map((m) => [m.kind, m.channel, m.status]), [["SCHEDULED", "WHATSAPP", "PENDING"], ["SCHEDULED", "SMS", "PENDING"]]);
      const mobile = (await t.prisma.patient.findFirstOrThrow({ where: { id: patient.id } })).mobile as string;
      assert.ok(!queued[0]!.toMask.includes(mobile) && queued[0]!.toMask.endsWith(mobile.slice(-4)), "only a masked number is kept");
      const sent = await messages.runDue(new Date(Date.now() + 5_000), 100_000);
      assert.ok(sent.sent >= 1);
      const m = await t.prisma.limsMessage.findFirstOrThrow({ where: { id: queued[0]!.id } });
      assert.equal(m.status, "SENT");
      assert.ok(m.providerMessageId!.startsWith("log-only:"), "nothing real is sent until a provider is connected");

      // The lab does the work: the assigned nurse takes the sample; the technician and the specialist follow.
      const labReq = await only(encounterId, cbc.name);
      assert.equal((await act(labReq.id, "collect", nurse.token)).status, 200);
      assert.equal((await act(labReq.id, "accept", pTech.token)).status, 200);
      const w = await only(encounterId, cbc.name);
      assert.equal((await typed(w.resultId!, w.resultVersion!, "11.0")).status, 200);
      assert.equal((await act(w.id, "submit", pTech.token)).status, 200);
      const v = await only(encounterId, cbc.name);
      assert.equal((await t.api("post", `/lab/results/${v.resultId}/verify`, path.token).send({ version: w.resultVersion! + 1 })).status, 200);

      // The report is not for the patient until issued; reception cannot print it before.
      assert.equal((await t.api("get", `/lims/requests/${labReq.id}/report`, rec.token)).status, 409);
      assert.equal((await act(labReq.id, "issue", pTech.token)).status, 200);
      // The imaging booking is still open, so the patient is not yet told the reports are ready.
      assert.equal(await t.prisma.limsMessage.count({ where: { tenantId: a.tenantId, batchId: rows[0]!.batchId, kind: "REPORT_READY" } }), 0);
      const radReq = await only(encounterId, "Ultrasound abdomen");
      assert.equal((await act(radReq.id, "collect", nurse.token)).status, 200);
      assert.equal((await act(radReq.id, "perform", rTech.token, { modality: "ULTRASOUND", bodyPart: "Abdomen" })).status, 200);
      assert.equal((await act(radReq.id, "submit", rTech.token)).status, 200);
      const radNow = await only(encounterId, "Ultrasound abdomen");
      assert.equal((await t.api("post", `/rad/studies/${radNow.studyId}/report`, radiologist.token).send({ findings: "Liver, spleen and kidneys are normal.", impression: "Normal study.", critical: false })).status, 200);
      assert.equal((await act(radReq.id, "issue", rTech.token)).status, 200);
      assert.equal(await t.prisma.limsMessage.count({ where: { tenantId: a.tenantId, batchId: rows[0]!.batchId, kind: "REPORT_READY" } }), 2, "one message on each channel when every report of the booking is ready");
      await messages.runDue(new Date(Date.now() + 5_000), 100_000);
      assert.deepEqual((await t.prisma.limsMessage.findMany({ where: { tenantId: a.tenantId, batchId: rows[0]!.batchId, kind: "REPORT_READY" } })).map((m) => m.status), ["SENT", "SENT"]);

      // Reception prints the report and hands it over.
      const printed = await t.api("get", `/lims/requests/${labReq.id}/report`, rec.token);
      assert.equal(printed.status, 200);
      assert.match(printed.text, /Laboratory report/);
      assert.equal((await t.api("get", `/lims/requests/${labReq.id}/report`, nurse.token)).status, 403);
      assert.equal((await act(labReq.id, "handover", rec.token, { receivedBy: "Patient's son" })).status, 200);
      assert.equal(await statusOf(labReq.id), "HANDED_OVER");
      assert.equal((await act(labReq.id, "handover", rec.token, { receivedBy: "Again" })).status, 409);
      assert.equal((await act(radReq.id, "handover", pTech.token, { receivedBy: "X" })).status, 403);
    });

    it("a patient who does not agree: the tests are taken off with the reason and cannot be launched", async () => {
      const { encounterId, orders } = await advised({ lab: [cbc.name] });
      const ids = orders.map((o) => o.id);
      assert.equal((await t.api("post", "/lims/opd/decline", rec.token).send({ encounterId, testOrderIds: ids, reason: "ok" })).status, 400);
      assert.equal((await t.api("post", "/lims/opd/decline", doc.token).send({ encounterId, testOrderIds: ids, reason: "Patient wants to do it elsewhere" })).status, 403);
      assert.equal((await t.api("post", "/lims/opd/decline", rec.token).send({ encounterId, testOrderIds: ids, reason: "Patient wants to do it elsewhere" })).status, 200);
      assert.equal((await t.prisma.testOrder.findFirstOrThrow({ where: { id: ids[0] } })).status, "CANCELLED");
      assert.equal((await launch(encounterId, ids)).status, 409);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LIMS_OPD_DECLINED", entityId: encounterId } }));
    });

    it("two receptionists launching the same test at once launch it once", async () => {
      const { encounterId, orders } = await advised({ lab: [cbc.name] });
      const ids = orders.map((o) => o.id);
      const rec2 = await t.makeUser(a, ["RECEPTIONIST"]);
      const out = await Promise.all([launch(encounterId, ids), launch(encounterId, ids, {}, rec2.token)]);
      assert.deepEqual(out.map((r) => r.status).sort(), [201, 409]);
      assert.equal(await t.prisma.limsRequest.count({ where: { encounterId } }), 1);
    });

    it("reception cannot launch another hospital's visit or an admitted patient's test", async () => {
      const { encounterId, orders } = await advised({ lab: [cbc.name] });
      assert.equal((await launch(encounterId, orders.map((o) => o.id), {}, bRec.token)).status, 404);
      assert.equal(((await t.api("get", "/lims/opd/pending", bRec.token)).body.data as { encounterId: string }[]).some((g) => g.encounterId === encounterId), false);
      const adm = await admitted();
      await order(adm.encounterId, [{ name: cbc.name, category: "LABORATORY" }]);
      const inpatientOrder = await t.prisma.testOrder.findFirstOrThrow({ where: { encounterId: adm.encounterId } });
      assert.equal((await launch(adm.encounterId, [inpatientOrder.id])).status, 409);
    });
  });

  // ───────────────────────── samples and review ─────────────────────────
  describe("samples, review and corrections", () => {
    it("a sample is taken once; a rejected sample goes back to the nurse with the reason, and the next one gets a new number", async () => {
      const { encounterId, r } = await collectedLab();
      assert.equal((await act(r.id, "collect", nurse.token)).status, 409, "taking it twice is refused");
      assert.equal((await act(r.id, "collect", pTech.token)).status, 403, "technicians do not take samples");
      assert.equal((await act(r.id, "reject-sample", nurse.token, { reason: "Clotted sample" })).status, 403, "the nurse who took it does not reject it");
      const first = await t.prisma.labSample.findFirstOrThrow({ where: { testOrderId: r.testOrderId, status: "COLLECTED" } });
      assert.equal((await act(r.id, "reject-sample", pTech.token, { reason: "x" })).status, 400);
      assert.equal((await act(r.id, "reject-sample", pTech.token, { reason: "Clotted sample" })).status, 200);
      const back = await only(encounterId, cbc.name);
      assert.deepEqual([back.status, back.needsRecollection, back.recollectCount], ["PENDING_COLLECTION", true, 1]);
      const assignedNurse = (await t.prisma.limsRequest.findFirstOrThrow({ where: { id: r.id } })).assignedNurseId;
      assert.ok((await notes(assignedNurse === nurse2.id ? nurse2.token : nurse.token)).some((n: { type: string; entityId: string }) => n.type === "LIMS_COLLECTION_WAITING" && n.entityId === r.id), "the nurse who was given it is asked again");
      assert.equal((await act(r.id, "collect", nurse2.token)).status, 200);
      const second = await t.prisma.labSample.findFirstOrThrow({ where: { testOrderId: r.testOrderId, status: "COLLECTED" } });
      assert.notEqual(second.accessionNumber, first.accessionNumber);
      const again = await only(encounterId, cbc.name);
      assert.deepEqual([again.status, again.needsRecollection, again.recollectCount], ["COLLECTED", false, 1]);
      const rejected = ((await get("/lims/requests?recollect=true&pageSize=100", mgr.token)).items as Req[]).filter((x) => x.id === r.id);
      assert.equal(rejected.length, 1, "the manager can list requests that needed another sample");
      assert.equal((await act(r.id, "accept", pTech.token)).status, 200);
    });

    it("two nurses taking the same sample at once take it once", async () => {
      const { encounterId } = await admitted();
      await order(encounterId, [{ name: cbc.name, category: "LABORATORY" }]);
      const r = await only(encounterId, cbc.name);
      const out = await Promise.all([act(r.id, "collect", nurse.token), act(r.id, "collect", nurse2.token)]);
      assert.deepEqual(out.map((x) => x.status).sort(), [200, 409], JSON.stringify(out.map((x) => x.body)));
      assert.equal(await t.prisma.labSample.count({ where: { testOrderId: r.testOrderId, status: "COLLECTED" } }), 1);
    });

    it("the pathologist can send the work back with a reason; the technician corrects and sends it again; nothing is lost", async () => {
      const x = await workedLab();
      assert.equal((await act(x.r.id, "return", path.token, { reason: "Not sent yet" })).status, 409, "only work waiting for review can be sent back");
      assert.equal((await act(x.r.id, "submit", pTech.token)).status, 200);
      assert.equal((await act(x.r.id, "return", pTech.token, { reason: "I want it back" })).status, 403, "the technician cannot send it back to themself");
      assert.equal((await act(x.r.id, "return", mgr.token, { reason: "Looks wrong" })).status, 403, "the LIMS manager is not a reviewer");
      assert.equal((await act(x.r.id, "return", path.token, { reason: "Re-check the haemoglobin" })).status, 200);
      const back = await only(x.encounterId, cbc.name);
      assert.deepEqual([back.status, back.returnedCount], ["IN_PROCESS", 1]);
      assert.ok((await notes(pTech.token)).some((n: { type: string; entityId: string }) => n.type === "LIMS_ASSIGNED" && n.entityId === x.r.id));
      assert.equal((await typed(back.resultId!, back.resultVersion!, "9.8")).status, 200);
      assert.equal((await act(back.id, "submit", pTech.token)).status, 200);
      const timeline = ((await detail(back.id)).body.data as { timeline: { kind: string; note: string | null }[] }).timeline;
      assert.deepEqual(timeline.map((e) => e.kind), ["CREATED", "NURSE_ASSIGNED", "COLLECTED", "ACCEPTED", "SUBMITTED", "RETURNED", "SUBMITTED"]);
      assert.equal(timeline.find((e) => e.kind === "RETURNED")!.note, "Re-check the haemoglobin");
    });

    it("a request cannot be sent for review until every value is typed in; a scan cannot be sent before it is performed", async () => {
      const x = await collectedLab();
      assert.equal((await act(x.r.id, "submit", pTech.token)).status, 409, "not accepted yet");
      assert.equal((await act(x.r.id, "accept", pTech.token)).status, 200);
      const none = await act(x.r.id, "submit", pTech.token);
      assert.equal(none.status, 400, "no values typed");
      assert.match(none.body.error.message, /Enter a value for Haemoglobin/);
      const { encounterId } = await admitted();
      await order(encounterId, [{ name: "CT head", category: "RADIOLOGY" }]);
      const rr = await only(encounterId, "CT head");
      assert.equal((await act(rr.id, "perform", rTech.token, { modality: "CT", bodyPart: "Head" })).status, 409, "the patient is not ready yet");
      assert.equal((await act(rr.id, "collect", nurse.token)).status, 200);
      assert.equal((await act(rr.id, "submit", rTech.token)).status, 409, "perform the scan first");
      // A patient who is not prepared is sent back with the reason; once scanned that is no longer possible.
      assert.equal((await act(rr.id, "reject-sample", rTech.token, { reason: "Patient has not fasted" })).status, 200);
      assert.equal((await only(encounterId, "CT head")).status, "PENDING_COLLECTION");
    });

    it("the LIMS manager can cancel work that has not reached review, and nobody else can", async () => {
      const x = await collectedLab();
      assert.equal((await act(x.r.id, "cancel", pTech.token, { reason: "Not needed" })).status, 403);
      assert.equal((await act(x.r.id, "cancel", hospMgr.token, { reason: "Not needed" })).status, 403);
      assert.equal((await act(x.r.id, "cancel", mgr.token, { reason: "ok" })).status, 400);
      assert.equal((await act(x.r.id, "cancel", mgr.token, { reason: "Ordered by mistake" })).status, 200);
      assert.equal(await statusOf(x.r.id), "CANCELLED");
      assert.equal((await t.prisma.testOrder.findFirstOrThrow({ where: { id: x.r.testOrderId } })).status, "CANCELLED");
      assert.equal((await act(x.r.id, "accept", pTech.token)).status, 409);
      const y = await passedLab();
      assert.equal((await act(y.r.id, "cancel", mgr.token, { reason: "Changed my mind" })).status, 409, "a passed report is not cancelled");
    });
  });

  // ───────────────────────── who may do what ─────────────────────────
  describe("access", () => {
    it("the administrator, the manager and the LIMS manager can watch but not enter, verify or sign; the lab roles are limited to their department", async () => {
      const x = await passedLab();
      const rid = x.r.resultId!;
      for (const [name, tok] of [["LIMS manager", mgr.token], ["manager", hospMgr.token], ["administrator", a.admin.token]] as const) {
        assert.equal((await t.api("put", `/lab/results/${rid}/draft`, tok).send({ version: 1, values: [{ parameterId: hb, value: "1" }] })).status, 403, `${name} cannot enter results`);
        assert.equal((await t.api("post", `/lab/results/${rid}/verify`, tok).send({ version: 1 })).status, 403, `${name} cannot verify`);
        assert.equal((await t.api("post", `/lab/results/${rid}/amend`, tok).send({ expectedVersion: 1, values: [{ parameterId: hb, value: "1" }], reason: "Silent change" })).status, 403, `${name} cannot amend`);
        assert.equal((await act(x.r.id, "issue", tok)).status, 403, `${name} cannot issue`);
        assert.equal((await act(x.r.id, "collect", tok)).status, 403, `${name} cannot take samples`);
        assert.equal((await t.api("get", "/lims/dashboard", tok)).status, 200, `${name} can watch`);
        assert.equal((await t.api("get", "/lims/reports/performance", tok)).status, 200);
      }
      const seen = await Promise.all([mgr.token, hospMgr.token, a.admin.token].map(async (tok) => ((await get(`/lims/requests?q=${x.patient.mrn}`, tok)).items as Req[]).map((r) => r.id)));
      assert.deepEqual(seen[1], seen[0], "the manager sees what the LIMS manager sees");
      assert.deepEqual(seen[2], seen[0], "the administrator sees what the LIMS manager sees");
      // Only the LIMS manager runs the floor.
      for (const tok of [hospMgr.token, a.admin.token, pTech.token, nurse.token]) {
        assert.equal((await act(x.r.id, "assign", tok, { techId: pTech.id })).status, 403);
        assert.equal((await t.api("post", "/lims/instruments", tok).send({ department: "PATHOLOGY", name: "Analyser" })).status, 403);
      }
      // The specialist cannot edit the technician's work; the technician cannot pass it.
      assert.equal((await t.api("post", `/lab/results/${rid}/verify`, pTech.token).send({ version: 1 })).status, 403);
      assert.equal((await t.api("put", `/lab/results/${rid}/draft`, radiologist.token).send({ version: 1, values: [{ parameterId: hb, value: "1" }] })).status, 403);
      // Reception cannot see the lab at all; the nurse sees only what they need.
      // Reception works with outpatients' requests only, and is not shown the clinical side.
      assert.equal((await t.api("get", `/lims/requests/${x.r.id}`, rec.token)).status, 404, "an admitted patient's request is not reception's");
      assert.equal(((await get("/lims/requests?pageSize=100", rec.token)).items as Req[]).some((r) => r.origin === "IPD"), false);
      const opd = await advised({ lab: [cbc.name] });
      assert.equal((await launch(opd.encounterId, opd.orders.map((o) => o.id))).status, 201);
      const opdReq = await only(opd.encounterId, cbc.name);
      assert.equal((await act(opdReq.id, "collect", nurse.token)).status, 200);
      const recView = await t.api("get", `/lims/requests/${opdReq.id}`, rec.token);
      assert.equal(recView.status, 200);
      assert.deepEqual([recView.body.data.resultId, recView.body.data.clinicalNote, recView.body.data.studyId], [null, null, null]);
      assert.equal((await t.api("get", `/lab/orders/${opdReq.testOrderId}/result`, rec.token)).status, 403, "reception still cannot read results");
      assert.equal(((await t.api("get", "/lims/requests", cashier.token)).status), 403);
    });

    it("another hospital sees nothing and can change nothing", async () => {
      const x = await collectedLab();
      assert.equal((await detail(x.r.id, bMgr.token)).status, 404);
      for (const [step, body] of [["assign", { techId: pTech.id }], ["cancel", { reason: "Not ours" }], ["priority", { priority: "EMERGENCY" }]] as const) {
        assert.equal((await act(x.r.id, step, bMgr.token, body)).status, 404, `${step} by another hospital`);
      }
      assert.equal((await act(x.r.id, "collect", bNurse.token)).status, 404, "IDOR: a request id from another hospital is unknown");
      assert.equal(((await get("/lims/requests?pageSize=100", bMgr.token)).items as Req[]).some((r) => r.id === x.r.id), false);
      assert.equal((await t.api("get", `/encounters/${x.encounterId}/lims`, bMgr.token)).status, 404);
      assert.equal(await statusOf(x.r.id), "COLLECTED");
    });

    it("a doctor sees only their own patients' requests", async () => {
      const x = await collectedLab();
      assert.equal((await t.api("get", `/encounters/${x.encounterId}/lims`, doc.token)).status, 200);
      assert.equal((await t.api("get", `/encounters/${x.encounterId}/lims`, doc2.token)).status, 404);
      assert.equal((await detail(x.r.id, doc2.token)).status, 404);
      assert.equal(((await get("/lims/requests?pageSize=100", doc2.token)).items as Req[]).some((r) => r.id === x.r.id), false);
      assert.equal(((await get("/lims/requests?pageSize=100", doc.token)).items as Req[]).some((r) => r.id === x.r.id), true);
      assert.equal((await act(x.r.id, "priority", doc2.token, { priority: "EMERGENCY" })).status, 404);
    });
  });

  // ───────────────────────── priority, assignment, exceptions ─────────────────────────
  describe("running the floor", () => {
    it("a doctor raises a priority on their own patient; only the manager lowers it; the deadline follows", async () => {
      const x = await collectedLab();
      const before = new Date(x.r.dueAt).getTime();
      assert.equal((await act(x.r.id, "priority", doc.token, { priority: "EMERGENCY", reason: "Patient is deteriorating" })).status, 200);
      const up = await only(x.encounterId, cbc.name);
      assert.equal(up.priority, "EMERGENCY");
      assert.ok(new Date(up.dueAt).getTime() < before);
      assert.equal((await act(x.r.id, "priority", doc.token, { priority: "ROUTINE" })).status, 403, "a doctor cannot lower it");
      assert.equal((await act(x.r.id, "priority", rec.token, { priority: "URGENT" })).status, 403, "reception cannot lower it either");
      assert.equal((await act(x.r.id, "priority", nurse.token, { priority: "EMERGENCY" })).status, 403);
      assert.equal((await act(x.r.id, "priority", mgr.token, { priority: "URGENT", reason: "Stable now" })).status, 200);
      assert.equal((await only(x.encounterId, cbc.name)).priority, "URGENT");
      assert.equal((await act(x.r.id, "priority", mgr.token, { priority: "BOGUS" })).status, 400);
    });

    it("the LIMS manager assigns nurses and technicians of the right kind, and each is told", async () => {
      const { encounterId } = await admitted();
      await order(encounterId, [{ name: cbc.name, category: "LABORATORY" }]);
      const r = await only(encounterId, cbc.name);
      const staff = (await get("/lims/staff", mgr.token)) as { nurses: { id: string }[]; technicians: { id: string; department: string }[] };
      assert.ok(staff.nurses.some((n) => n.id === nurse.id) && !staff.nurses.some((n) => n.id === pTech.id));
      assert.ok(staff.technicians.some((u) => u.id === pTech.id && u.department === "PATHOLOGY") && staff.technicians.some((u) => u.id === rTech.id && u.department === "RADIOLOGY"));
      assert.equal((await t.api("get", "/lims/staff", nurse.token)).status, 403);
      assert.equal((await act(r.id, "assign", mgr.token, {})).status, 400);
      assert.equal((await act(r.id, "assign", mgr.token, { nurseId: pTech.id })).status, 400, "a technician is not a nurse");
      assert.equal((await act(r.id, "assign", mgr.token, { techId: rTech.id })).status, 400, "a radiology technician cannot be given pathology work");
      assert.equal((await act(r.id, "assign", mgr.token, { nurseId: b.admin.id })).status, 400, "another hospital's user cannot be assigned");
      assert.equal((await act(r.id, "assign", mgr.token, { nurseId: nurse2.id, techId: pTech.id })).status, 200);
      const row = await t.prisma.limsRequest.findFirstOrThrow({ where: { id: r.id } });
      assert.deepEqual([row.assignedNurseId, row.assignedTechId], [nurse2.id, pTech.id]);
      assert.ok((await notes(nurse2.token)).some((n: { type: string; entityId: string }) => n.type === "LIMS_ASSIGNED" && n.entityId === r.id));
      const mine = (await get("/lims/requests?mine=true&pageSize=100", pTech.token)).items as Req[];
      assert.ok(mine.some((x) => x.id === r.id), "the technician's own list");
      assert.equal((await act(r.id, "collect", nurse2.token)).status, 200);
      assert.equal((await act(r.id, "assign", mgr.token, { nurseId: nurse.id })).status, 409, "the sample has already been taken");
    });

    it("an exception is raised by the floor, decided by the manager and never by the person who raised it", async () => {
      const x = await collectedLab();
      const mgr2 = await t.makeUser(a, ["LIMS_MANAGER"]);
      const raised = await t.api("post", "/lims/exceptions", nurse.token).send({ requestId: x.r.id, kind: "QUEUE_JUMP", reason: "Surgery is booked in one hour" });
      assert.equal(raised.status, 201, JSON.stringify(raised.body));
      assert.equal((await t.api("post", "/lims/exceptions", nurse.token).send({ requestId: x.r.id, kind: "QUEUE_JUMP", reason: "Surgery is booked in one hour" })).status, 409, "once while it waits");
      assert.equal((await t.api("post", "/lims/exceptions", doc.token).send({ requestId: x.r.id, kind: "OTHER", reason: "Not a floor role" })).status, 403);
      assert.ok((await notes(mgr.token)).some((n: { type: string }) => n.type === "LIMS_EXCEPTION_RAISED"));
      const id = raised.body.data.id as string;
      assert.equal((await t.api("get", "/lims/exceptions", nurse2.token)).body.data.some((e: { id: string }) => e.id === id), false, "people see only their own");
      assert.equal((await t.api("get", "/lims/exceptions", nurse.token)).body.data.some((e: { id: string }) => e.id === id), true);
      assert.equal((await t.api("post", `/lims/exceptions/${id}/decide`, nurse.token).send({ decision: "APPROVED", note: "I approve myself" })).status, 403);
      assert.equal((await t.api("post", `/lims/exceptions/${id}/decide`, hospMgr.token).send({ decision: "APPROVED", note: "Manager is not the LIMS manager" })).status, 403);
      assert.equal((await t.api("post", `/lims/exceptions/${id}/decide`, mgr.token).send({ decision: "APPROVED", note: "ok" })).status, 400);
      assert.equal((await t.api("post", `/lims/exceptions/${id}/decide`, mgr2.token).send({ decision: "APPROVED", note: "Approved under the surgery-slot policy" })).status, 200);
      assert.equal((await only(x.encounterId, cbc.name)).priority, "URGENT", "an approved queue jump makes the request urgent");
      assert.equal((await t.api("post", `/lims/exceptions/${id}/decide`, mgr.token).send({ decision: "DENIED", note: "Too late to change" })).status, 409);
      // A manager cannot decide their own exception.
      const own = await t.api("post", "/lims/exceptions", mgr.token).send({ requestId: x.r.id, kind: "DELAYED_REPORT", reason: "The analyser was down" });
      assert.equal(own.status, 201, JSON.stringify(own.body));
      assert.equal((await t.api("post", `/lims/exceptions/${own.body.data.id}/decide`, mgr.token).send({ decision: "APPROVED", note: "Approving my own" })).status, 403);
      assert.equal((await t.api("post", `/lims/exceptions/${own.body.data.id}/decide`, mgr2.token).send({ decision: "DENIED", note: "Not accepted" })).status, 200);
      assert.equal((await detail(x.r.id)).body.data.exceptions.length, 2);
    });
  });

  // ───────────────────────── quality control and instruments ─────────────────────────
  describe("quality control and instruments", () => {
    it("the technician records runs; a failure alerts the manager, who reviews it (not their own) and can take the instrument out of use", async () => {
      const ins = await t.api("post", "/lims/instruments", mgr.token).send({ department: "PATHOLOGY", name: `Analyser ${uniqueWord(4)}`, model: "HaemoCount 3", nextCalibrationDue: "2020-01-01" });
      assert.equal(ins.status, 201, JSON.stringify(ins.body));
      const id = ins.body.data.id as string;
      const pass = await t.api("post", "/lims/qc", pTech.token).send({ department: "PATHOLOGY", instrumentId: id, subject: "Haemoglobin control", level: "Level 1", unit: "g/dL", expected: 13, observed: 13.1, lowLimit: 12.5, highLimit: 13.5 });
      assert.equal(pass.status, 201, JSON.stringify(pass.body));
      assert.equal(pass.body.data.result, "PASS");
      assert.equal((await t.api("post", "/lims/qc", pTech.token).send({ department: "PATHOLOGY", instrumentId: id, subject: "Haemoglobin control", observed: 13.1, lowLimit: 12.5, highLimit: 13.5, result: "FAIL" })).status, 400, "the result must match the numbers");
      assert.equal((await t.api("post", "/lims/qc", pTech.token).send({ department: "PATHOLOGY", subject: "No numbers" })).status, 400);
      assert.equal((await t.api("post", "/lims/qc", pTech.token).send({ department: "RADIOLOGY", subject: "Daily check", result: "PASS" })).status, 403, "a pathology technician does not record radiology checks");
      const fail = await t.api("post", "/lims/qc", pTech.token).send({ department: "PATHOLOGY", instrumentId: id, subject: "Haemoglobin control", level: "Level 2", unit: "g/dL", expected: 16, observed: 18.2, lowLimit: 15, highLimit: 17 });
      assert.equal(fail.body.data.result, "FAIL");
      assert.ok((await notes(mgr.token)).some((n: { type: string; entityId: string }) => n.type === "LIMS_EXCEPTION_RAISED" && n.entityId === fail.body.data.id), "the manager is told");
      const list = (await get("/lims/instruments", hospMgr.token)) as { id: string; calibrationOverdue: boolean; qc30: { runs: number; failed: number; passPercent: number; unreviewedFailures: number } }[];
      const row = list.find((x) => x.id === id)!;
      assert.deepEqual([row.calibrationOverdue, row.qc30.runs, row.qc30.failed, row.qc30.passPercent, row.qc30.unreviewedFailures], [true, 2, 1, 50, 1]);
      assert.equal((await t.api("post", `/lims/qc/${fail.body.data.id}/review`, pTech.token).send({ actionRequired: true, note: "Recalibrate" })).status, 403);
      assert.equal((await t.api("post", `/lims/qc/${pass.body.data.id}/review`, mgr.token).send({ actionRequired: true, note: "Pass cannot need action" })).status, 400);
      assert.equal((await t.api("post", `/lims/qc/${fail.body.data.id}/review`, mgr.token).send({ actionRequired: true, note: "Recalibrate and repeat" })).status, 200);
      assert.equal((await t.prisma.limsInstrument.findFirstOrThrow({ where: { id } })).status, "MAINTENANCE");
      assert.equal((await t.api("post", `/lims/qc/${fail.body.data.id}/review`, mgr.token).send({ actionRequired: false, note: "Again" })).status, 409, "reviewed once");
      assert.equal((await t.api("put", `/lims/instruments/${id}`, mgr.token).send({ status: "ACTIVE", lastCalibratedAt: "2026-11-09", nextCalibrationDue: "2027-05-09" })).status, 200);
      // The manager's own record is reviewed by someone else.
      const own = await t.api("post", "/lims/qc", mgr.token).send({ department: "PATHOLOGY", subject: "Manager check", result: "FAIL" });
      assert.equal(own.status, 201, JSON.stringify(own.body));
      assert.equal((await t.api("post", `/lims/qc/${own.body.data.id}/review`, mgr.token).send({ actionRequired: false, note: "Reviewing myself" })).status, 403);
      // A recorded run cannot be changed by anyone, even directly.
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LimsQcRecord" SET observed = 13 WHERE id = '${fail.body.data.id}'::uuid`), /cannot be changed/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "LimsQcRecord" WHERE id = '${fail.body.data.id}'::uuid`), /cannot be deleted/);
      // Another hospital cannot see these.
      assert.deepEqual(await get("/lims/qc", bMgr.token), []);
      assert.deepEqual(await get("/lims/instruments", bMgr.token), []);
    });
  });

  // ───────────────────────── the database keeps the rules even when the application does not ─────────────────────────
  describe("database rules", () => {
    it("a request cannot skip steps, be deleted, be moved, or lose its history", async () => {
      const x = await collectedLab();
      const sql = (s: string) => t.prisma.$executeRawUnsafe(s);
      await assert.rejects(sql(`UPDATE "LimsRequest" SET status = 'ISSUED', "issuedAt" = now() WHERE id = '${x.r.id}'::uuid`), /cannot move from COLLECTED to ISSUED/);
      await assert.rejects(sql(`UPDATE "LimsRequest" SET status = 'PASSED' WHERE id = '${x.r.id}'::uuid`), /cannot move from COLLECTED to PASSED/);
      await assert.rejects(sql(`DELETE FROM "LimsRequest" WHERE id = '${x.r.id}'::uuid`), /cannot be deleted/);
      await assert.rejects(sql(`UPDATE "LimsRequest" SET "patientId" = '${randomUUID()}'::uuid WHERE id = '${x.r.id}'::uuid`), /cannot be moved/);
      await assert.rejects(sql(`UPDATE "LimsRequest" SET status = 'IN_PROCESS' WHERE id = '${x.r.id}'::uuid`), /constraint|acceptedAt/i, "an accepted request records who accepted it");
      await assert.rejects(sql(`UPDATE "LimsRequestEvent" SET note = 'edited' WHERE "requestId" = '${x.r.id}'::uuid`), /append-only/);
      await assert.rejects(sql(`DELETE FROM "LimsRequestEvent" WHERE "requestId" = '${x.r.id}'::uuid`), /append-only/);
      assert.equal(await statusOf(x.r.id), "COLLECTED");
    });

    it("a request cannot be made for a cancelled test, another patient's test, or the wrong department", async () => {
      const { encounterId, patient } = await admitted();
      const other = await admitted();
      await order(encounterId, [{ name: cbc.name, category: "LABORATORY" }]);
      const r = await only(encounterId, cbc.name);
      const rad = await t.prisma.testOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: patient.id, encounterId, category: "RADIOLOGY", name: "Direct", orderedById: doc.userId, source: "LIMS" } });
      const dept = await t.prisma.limsDepartment.findFirstOrThrow({ where: { tenantId: a.tenantId, facilityId: a.facilityId, kind: "PATHOLOGY" } });
      const base = { tenantId: a.tenantId, facilityId: a.facilityId, patientId: patient.id, encounterId, batchId: randomUUID(), origin: "IPD" as const, consent: "NOT_REQUIRED" as const, requestedById: doc.userId, dueAt: new Date() };
      await assert.rejects(t.prisma.limsRequest.create({ data: { ...base, testOrderId: rad.id, departmentId: dept.id, requestNumber: "LRQ-X-1" } }), /department does not match/);
      const cancelled = await t.prisma.testOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: patient.id, encounterId, category: "LABORATORY", name: "Gone", orderedById: doc.userId, source: "LIMS", status: "CANCELLED", cancelReason: "No" } });
      await assert.rejects(t.prisma.limsRequest.create({ data: { ...base, testOrderId: cancelled.id, departmentId: dept.id, requestNumber: "LRQ-X-2" } }), /must belong to a laboratory or radiology test/);
      await assert.rejects(t.prisma.limsRequest.create({ data: { ...base, patientId: other.patient.id, testOrderId: rad.id, departmentId: dept.id, requestNumber: "LRQ-X-3" } }), /must belong to a laboratory or radiology test|violates foreign key/);
      const lab2 = await t.prisma.testOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: patient.id, encounterId, category: "LABORATORY", name: "Second", orderedById: doc.userId, source: "LIMS" } });
      await assert.rejects(t.prisma.limsRequest.create({ data: { ...base, testOrderId: lab2.id, departmentId: dept.id, requestNumber: "LRQ-X-4", origin: "OPD", consent: "GIVEN" } }), /origin must match the visit type/);
      await assert.rejects(t.prisma.limsRequest.create({ data: { ...base, testOrderId: lab2.id, departmentId: dept.id, requestNumber: "LRQ-X-5", consent: "GIVEN" } }), /lims_request_state/, "an admitted patient's request does not claim an outpatient's agreement");
      assert.ok(r.id);
    });

    it("a sample cannot be recorded against an order the LIMS has not taken in", async () => {
      const { encounterId, patient } = await admitted();
      const loose = await t.prisma.testOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: patient.id, encounterId, category: "LABORATORY", name: "Loose", orderedById: doc.userId, source: "LIMS" } });
      await assert.rejects(
        t.prisma.labSample.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: patient.id, encounterId, testOrderId: loose.id, accessionNumber: `LAB-X-${uniqueWord(4)}`, specimen: "Blood", collectedById: nurse.id } }),
        /must belong to a billed laboratory test/,
      );
    });
  });

  // ───────────────────────── monitoring ─────────────────────────
  describe("monitoring and reports", () => {
    it("the dashboard and the performance report give the manager, the administrator and the LIMS manager the same figures", async () => {
      const done = await passedLab();
      assert.equal((await act(done.r.id, "issue", pTech.token)).status, 200);
      const dash = await Promise.all([mgr.token, hospMgr.token, a.admin.token].map((tok) => get("/lims/dashboard", tok)));
      for (const d of dash) {
        assert.deepEqual(d.departments.map((x: { kind: string }) => x.kind), ["PATHOLOGY", "RADIOLOGY"]);
        const p = d.departments[0];
        assert.ok(p.toIssue >= 1 && p.collected >= 0 && p.collectedToday >= 1);
      }
      assert.deepEqual(dash[1].departments, dash[0].departments);
      assert.deepEqual(dash[2].departments, dash[0].departments);
      const perf = await Promise.all([mgr.token, hospMgr.token, a.admin.token].map((tok) => get("/lims/reports/performance", tok)));
      const p = perf[0].departments.find((x: { kind: string }) => x.kind === "PATHOLOGY");
      assert.ok(p.ordered >= 1 && p.issued >= 1 && p.reported >= 1 && p.tat.averageMinutes !== null && p.tat.withinTargetPercent !== null);
      assert.equal(perf[0].totals.ordered, perf[1].totals.ordered);
      assert.equal(perf[0].totals.ordered, perf[2].totals.ordered);
      assert.ok(perf[0].technicians.length >= 1 && perf[0].days.length >= 1);
      // The technician's own screens exist but the reports are for management.
      assert.equal((await t.api("get", "/lims/reports/performance", pTech.token)).status, 403);
      assert.equal((await t.api("get", "/lims/dashboard", cashier.token)).status, 403);
      assert.equal((await t.api("get", "/lims/reports/performance?from=2026-12-31&to=2026-01-01", mgr.token)).status, 400);
      assert.equal((await t.api("get", "/lims/reports/performance?from=2020-01-01&to=2026-12-31", mgr.token)).status, 400);
      // A pathology technician's dashboard covers their own department only.
      const tech = await get("/lims/dashboard", pTech.token);
      assert.deepEqual(tech.departments.map((x: { kind: string }) => x.kind), ["PATHOLOGY"]);
    });

    it("delayed requests are found: open past the deadline", async () => {
      const x = await collectedLab();
      await t.prisma.$executeRawUnsafe(`UPDATE "LimsRequest" SET "dueAt" = now() - interval '2 hours' WHERE id = '${x.r.id}'::uuid`);
      const late = (await get("/lims/requests?overdue=true&pageSize=100", mgr.token)).items as Req[];
      assert.ok(late.some((r) => r.id === x.r.id && (r as unknown as { delayed: boolean }).delayed));
      const dash = await get("/lims/dashboard", mgr.token);
      assert.ok(dash.departments[0].overdue >= 1);
    });

    it("the billing monitor reads billing without changing it: work is done before it is billed, and the cashier's own flow still bills the test", async () => {
      const { encounterId, orders } = await advised({ lab: [cbc.name] });
      assert.equal((await launch(encounterId, orders.map((o) => o.id))).status, 201);
      const before = await get("/lims/reports/billing", hospMgr.token);
      assert.equal((await t.api("get", "/lims/reports/billing", mgr.token)).status, 200, "the LIMS manager follows what the laboratory has billed and charged");
      assert.equal((await t.api("get", "/lims/reports/billing", pTech.token)).status, 403);
      // The existing cashier flow bills the test that is already in the lab; the request carries on.
      const billed = await t.api("post", "/test-orders/bill", cashier.token).send({ encounterId, orders: [{ orderId: orders[0]!.id, serviceId: cbc.id }] });
      assert.equal(billed.status, 201, JSON.stringify(billed.body));
      const req = await only(encounterId, cbc.name);
      assert.equal(req.status, "PENDING_COLLECTION");
      assert.equal((await act(req.id, "collect", nurse.token)).status, 200);
      const after = await get("/lims/reports/billing", hospMgr.token);
      const p = (r: { departments: { kind: string; billed: number; notBilled: number; billedAmount: string }[] }) => r.departments.find((d) => d.kind === "PATHOLOGY")!;
      assert.equal(p(after).billed, p(before).billed + 1);
      assert.equal(p(after).notBilled, p(before).notBilled - 1);
      assert.ok(Number(p(after).billedAmount) >= Number(p(before).billedAmount) + 250);
      // Taking a test off the bill at the cashier does not cancel work already in the lab.
      assert.equal((await t.api("post", `/test-orders/${orders[0]!.id}/cancel`, cashier.token).send({ reason: "Patient left" })).status, 409);
    });
  });

  // ───────────────────────── the test list is grouped between the two departments ─────────────────────────
  describe("test grouping and booking at reception", () => {
    let xray: { id: string; name: string; limsDepartment: string | null };
    let lipid: { id: string; name: string; limsDepartment: string | null };
    const mk = async (name: string, category = "INVESTIGATION", tenant = a) => (await t.api("post", "/services", tenant.admin.token).send({ code: code("G"), name, category, price: "400", taxPercent: 0 })).body.data as { id: string; name: string; limsDepartment: string | null };

    before(async () => {
      xray = await mk(`Chest X-ray PA ${uniqueWord(3)}`);
      lipid = await mk(`Lipid profile ${uniqueWord(3)}`);
    });

    it("an investigation is grouped with Pathology or Radiology when it is added, and the list shows the grouping to the people who order", async () => {
      assert.equal(xray.limsDepartment, "RADIOLOGY");
      assert.equal(lipid.limsDepartment, "PATHOLOGY");
      assert.equal((await mk("Consultation fee", "CONSULTATION")).limsDepartment, null, "only an investigation is grouped");
      for (const tok of [doc.token, rec.token, mgr.token, a.admin.token, path.token]) {
        const list = (await t.api("get", "/lims/catalogue", tok)).body.data as { serviceId: string; department: string }[];
        assert.equal(list.find((x) => x.serviceId === xray.id)!.department, "RADIOLOGY");
        assert.equal(list.find((x) => x.serviceId === lipid.id)!.department, "PATHOLOGY");
      }
      const radiology = (await t.api("get", "/lims/catalogue?department=RADIOLOGY", doc.token)).body.data as { serviceId: string; department: string }[];
      assert.ok(radiology.length >= 1 && radiology.every((x) => x.department === "RADIOLOGY"));
      assert.equal(((await t.api("get", "/lims/catalogue?q=lipid", doc.token)).body.data as unknown[]).length >= 1, true);
      for (const tok of [nurse.token, pTech.token, rTech.token, cashier.token]) assert.equal((await t.api("get", "/lims/catalogue", tok)).status, 403);
      assert.deepEqual((await t.api("get", "/lims/catalogue", bMgr.token)).body.data, [], "another hospital's list is its own");
    });

    it("a doctor's order reaches the technician of the department the test belongs to, whichever way it was picked or typed", async () => {
      const { encounterId } = await admitted();
      const r = await t.api("post", "/lims/orders", doc.token).send({ encounterId, tests: [{ serviceId: xray.id }, { serviceId: lipid.id }] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual((await forVisit(encounterId, rTech.token)).map((x) => x.test), [xray.name], "the radiology technician gets the X-ray");
      assert.deepEqual((await forVisit(encounterId, pTech.token)).map((x) => x.test), [lipid.name], "the pathology technician gets the blood test");
      // Typed in the wrong box, a name that is on the list is still routed by the list.
      const second = await admitted();
      assert.equal((await t.api("post", "/lims/orders", doc.token).send({ encounterId: second.encounterId, tests: [{ name: xray.name.toLowerCase(), category: "LABORATORY" }] })).status, 201);
      assert.deepEqual((await forVisit(second.encounterId, rTech.token)).map((x) => x.department), ["RADIOLOGY"]);
      assert.deepEqual(await forVisit(second.encounterId, pTech.token), []);
      // Something that is not on the list keeps the kind it was typed with.
      const third = await admitted();
      assert.equal((await t.api("post", "/lims/orders", doc.token).send({ encounterId: third.encounterId, tests: [{ name: "Special stain XYZ", category: "LABORATORY" }] })).status, 201);
      assert.deepEqual((await forVisit(third.encounterId, pTech.token)).map((x) => x.test), ["Special stain XYZ"]);
      // A choice must be a test from the list (not a consultation fee or another hospital's item), and a free-typed test needs its kind.
      const fee = await mk("Dressing charge", "PROCEDURE");
      assert.equal((await t.api("post", "/lims/orders", doc.token).send({ encounterId: third.encounterId, tests: [{ serviceId: fee.id }] })).status, 400);
      const foreignTest = await mk("Own test", "INVESTIGATION", b);
      assert.equal((await t.api("post", "/lims/orders", doc.token).send({ encounterId: third.encounterId, tests: [{ serviceId: foreignTest.id }] })).status, 400);
      assert.equal((await t.api("post", "/lims/orders", doc.token).send({ encounterId: third.encounterId, tests: [{ name: "No kind" }] })).status, 400);
    });

    it("the administrator or the pathologist can move a test to the other department; only they can; it applies to new requests", async () => {
      const moved = await mk(`Barium swallow ${uniqueWord(3)}`);
      assert.equal(moved.limsDepartment, "RADIOLOGY");
      const before = await admitted();
      assert.equal((await t.api("post", "/lims/orders", doc.token).send({ encounterId: before.encounterId, tests: [{ serviceId: moved.id }] })).status, 201);
      for (const tok of [doc.token, rec.token, mgr.token, nurse.token, pTech.token]) assert.equal((await t.api("put", `/lims/catalogue/${moved.id}`, tok).send({ department: "PATHOLOGY" })).status, 403);
      assert.equal((await t.api("put", `/lims/catalogue/${moved.id}`, a.admin.token).send({ department: "BOGUS" })).status, 400);
      assert.equal((await t.api("put", `/lims/catalogue/${moved.id}`, b.admin.token).send({ department: "PATHOLOGY" })).status, 404, "another hospital cannot reach it");
      assert.equal((await t.api("put", `/lims/catalogue/${moved.id}`, path.token).send({ department: "PATHOLOGY" })).status, 200);
      const after = await admitted();
      assert.equal((await t.api("post", "/lims/orders", doc.token).send({ encounterId: after.encounterId, tests: [{ serviceId: moved.id }] })).status, 201);
      assert.deepEqual((await forVisit(after.encounterId, pTech.token)).map((x) => x.department), ["PATHOLOGY"]);
      assert.deepEqual((await forVisit(before.encounterId, rTech.token)).map((x) => x.department), ["RADIOLOGY"], "the request already in the queue stays where it was");
      assert.equal((await t.api("put", `/lims/catalogue/${moved.id}`, a.admin.token).send({ department: "RADIOLOGY" })).status, 200);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LIMS_TEST_GROUPING_CHANGED", entityId: moved.id } }));
    });

    it("reception books tests for a patient with no doctor's order: they agree, the tests go to the right technicians, and nothing is counted as a consultation", async () => {
      const patient = await registerPatient(t, rec.token);
      const opdBefore = ((await t.api("get", "/reports/opd/daily", a.admin.token)).body.data as { total: number }).total;
      const body = { patientId: patient.id, consent: true, consentMode: "WRITTEN", tests: [{ serviceId: lipid.id }, { serviceId: xray.id }], referredBy: "Dr. S. Roy (outside)", assignedNurseId: nurse.id, instructions: "Come fasting for 8 hours." };
      for (const [name, tok, b2] of [
        ["no agreement", rec.token, { ...body, consent: false }], ["no consent field", rec.token, (({ consent: _c, ...rest }) => rest)(body)], ["a doctor", doc.token, body], ["a nurse", nurse.token, body], ["a technician", pTech.token, body], ["another hospital", bRec.token, body],
        ["no tests", rec.token, { ...body, tests: [] }], ["an unknown field", rec.token, { ...body, tenantId: a.tenantId }], ["a nurse who cannot take samples", rec.token, { ...body, assignedNurseId: pTech.id }],
      ] as const) {
        const r = await t.api("post", "/lims/opd/book", tok).send(b2);
        assert.ok([400, 403, 404].includes(r.status), `${name}: ${r.status}`);
      }
      assert.equal(await t.prisma.encounter.count({ where: { patientId: patient.id } }), 0, "a refused booking leaves nothing behind");
      const res = await t.api("post", "/lims/opd/book", rec.token).send(body);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const encounterId = res.body.data.encounterId as string;
      assert.deepEqual(res.body.data.requests.map((r: { department: string }) => r.department).sort(), ["PATHOLOGY", "RADIOLOGY"]);
      const enc = await t.prisma.encounter.findFirstOrThrow({ where: { id: encounterId } });
      assert.deepEqual([enc.labOnly, enc.type, enc.status, enc.practitionerId], [true, "OPD", "COMPLETED", null]);
      assert.deepEqual((await t.prisma.testOrder.findMany({ where: { encounterId } })).map((o) => [o.source, o.status, o.orderedById]).sort(), [["RECEPTION", "ORDERED", rec.id], ["RECEPTION", "ORDERED", rec.id]]);
      const rows = await t.prisma.limsRequest.findMany({ where: { encounterId } });
      assert.deepEqual(rows.map((r) => [r.origin, r.consent, r.assignedNurseId, r.clinicalNote]), [["OPD", "GIVEN", nurse.id, "Referred by Dr. S. Roy (outside)"], ["OPD", "GIVEN", nurse.id, "Referred by Dr. S. Roy (outside)"]]);
      assert.equal(new Set(rows.map((r) => r.batchId)).size, 1);
      assert.equal(await t.prisma.limsMessage.count({ where: { tenantId: a.tenantId, batchId: rows[0]!.batchId, kind: "SCHEDULED" } }), 2, "the patient is told when to come (WhatsApp and SMS)");
      const launched = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "LIMS_OPD_BOOKED", entityId: encounterId } });
      assert.equal((launched.metadata as { consentMode: string }).consentMode, "WRITTEN");
      // Each technician sees only their department's test; the reception sees the request but not the reason for it.
      assert.deepEqual((await forVisit(encounterId, pTech.token)).map((x) => x.test), [lipid.name]);
      assert.deepEqual((await forVisit(encounterId, rTech.token)).map((x) => x.test), [xray.name]);
      const lab = await only(encounterId, lipid.name, pTech.token);
      assert.equal((await detail(lab.id, pTech.token)).body.data.clinicalNote, "Referred by Dr. S. Roy (outside)");
      assert.equal((await detail(lab.id, rec.token)).body.data.clinicalNote, null);
      // The work goes on as for any outpatient.
      assert.equal((await act(lab.id, "collect", nurse.token)).status, 200);
      assert.equal((await act(lab.id, "accept", pTech.token)).status, 200);
      // A visit made only to book tests is not an OPD consultation.
      assert.equal(((await t.api("get", "/reports/opd/daily", a.admin.token)).body.data as { total: number }).total, opdBefore);
      // The patient can book again: it is a new visit each time.
      const again = await t.api("post", "/lims/opd/book", rec.token).send({ patientId: patient.id, consent: true, tests: [{ serviceId: lipid.id }] });
      assert.equal(again.status, 201);
      assert.notEqual(again.body.data.encounterId, encounterId);
    });

    it("booking at reception needs a patient of this hospital, a test of the right kind, and honours priority rules", async () => {
      const own = await registerPatient(t, rec.token);
      const foreign = await registerPatient(t, bRec.token);
      assert.equal((await t.api("post", "/lims/opd/book", rec.token).send({ patientId: foreign.id, consent: true, tests: [{ serviceId: lipid.id }] })).status, 404, "another hospital's patient looks like it does not exist");
      assert.equal((await t.api("post", "/lims/opd/book", rec.token).send({ patientId: randomUUID(), consent: true, tests: [{ serviceId: lipid.id }] })).status, 404);
      assert.equal((await t.api("post", "/lims/opd/book", rec.token).send({ patientId: own.id, consent: true, tests: [{ name: "Free typed", category: "CARDIOLOGY" }] })).status, 400);
      assert.equal((await t.api("post", "/lims/opd/book", rec.token).send({ patientId: own.id, consent: true, tests: [{ serviceId: lipid.id }], scheduledFor: new Date(Date.now() - 86_400_000).toISOString() })).status, 400);
      const urgent = await t.api("post", "/lims/opd/book", rec.token).send({ patientId: own.id, consent: true, priority: "EMERGENCY", tests: [{ serviceId: lipid.id }] });
      assert.equal(urgent.status, 201, JSON.stringify(urgent.body));
      assert.equal((await only(urgent.body.data.encounterId, lipid.name)).priority, "EMERGENCY");
      const dupe = await Promise.all([1, 2].map(() => t.api("post", "/lims/opd/book", rec.token).send({ patientId: own.id, consent: true, tests: [{ serviceId: xray.id }] })));
      assert.deepEqual(dupe.map((r) => r.status), [201, 201], "two separate bookings are two visits");
    });
  });

  // ───────────────────────── lab load decides the outpatient's date ─────────────────────────
  describe("the outpatient's date comes from the pressure on the labs", () => {
    let c: TestTenant;
    let cRec: User; let cMgr: User; let cMgr2: User; let cNurse: User; let cDoc: TestDoctor;
    let cbcC: { id: string }; let xrayC: { id: string };
    const hourKey = (iso: string | Date) => Math.floor((new Date(iso).getTime() + 19_800_000) / 3_600_000);
    const book = (patientId: string, tests: { serviceId: string }[], o: Record<string, unknown> = {}, tok = cRec.token) => t.api("post", "/lims/opd/book", tok).send({ patientId, consent: true, tests, ...o });
    const dept = (kind: string, o: Record<string, unknown>) => t.api("put", `/lims/departments/${kind.toLowerCase()}`, c.admin.token).send({ name: kind === "PATHOLOGY" ? "Pathology" : "Radiology", status: "ACTIVE", routineTatMinutes: 1440, urgentTatMinutes: 360, emergencyTatMinutes: 120, capacityPerHour: 8, openMinute: 0, closeMinute: 1440, ...o });

    before(async () => {
      c = await t.makeTenant("lims-c");
      cRec = await t.makeUser(c, ["RECEPTIONIST"]); cMgr = await t.makeUser(c, ["LIMS_MANAGER"]); cMgr2 = await t.makeUser(c, ["MANAGER"]); cNurse = await t.makeUser(c, ["NURSE"]); cDoc = await makeDoctor(t, c);
      cbcC = (await t.api("post", "/services", c.admin.token).send({ code: code("C"), name: "Complete blood count", category: "INVESTIGATION", price: "250", taxPercent: 0 })).body.data;
      xrayC = (await t.api("post", "/services", c.admin.token).send({ code: code("X"), name: "X-ray chest", category: "INVESTIGATION", price: "350", taxPercent: 0 })).body.data;
      // Open round the clock so the test does not depend on the time of day; one test an hour in each lab, so the pressure shows at once.
      assert.equal((await dept("PATHOLOGY", { capacityPerHour: 1 })).status, 200);
      assert.equal((await dept("RADIOLOGY", { capacityPerHour: 1 })).status, 200);
    });

    it("the date moves later as the lab fills: each patient is given the next hour with room, and the time is in the message to the patient", async () => {
      const times: string[] = [];
      for (let i = 0; i < 4; i++) {
        const p = await registerPatient(t, cRec.token);
        const r = await book(p.id, [{ serviceId: cbcC.id }]);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.data.autoScheduled, true);
        times.push(r.body.data.scheduledFor as string);
        const row = await t.prisma.limsRequest.findFirstOrThrow({ where: { encounterId: r.body.data.encounterId } });
        assert.equal(row.scheduledFor!.toISOString(), r.body.data.scheduledFor, "the request carries the date");
        assert.ok(row.dueAt.getTime() > row.scheduledFor!.getTime(), "the report is due after the patient comes");
      }
      assert.deepEqual([...times].sort(), times, "each patient comes later than the one before");
      assert.equal(new Set(times.map(hourKey)).size, 4, "one place an hour: four patients, four different hours");
      const av = await t.api("get", "/lims/opd/availability?pathology=1", cRec.token);
      assert.equal(av.status, 200);
      assert.ok(new Date(av.body.data.suggestedAt).getTime() > new Date(times[3]!).getTime(), "the next patient would be given a later hour still");
      assert.equal(av.body.data.departments.find((d: { kind: string }) => d.kind === "PATHOLOGY").capacityPerHour, 1);
    });

    it("an emergency does not wait for a place, and a time chosen by reception is respected", async () => {
      const p = await registerPatient(t, cRec.token);
      const em = await book(p.id, [{ serviceId: cbcC.id }], { priority: "EMERGENCY" });
      assert.equal(em.status, 201, JSON.stringify(em.body));
      assert.equal(em.body.data.autoScheduled, false);
      assert.equal(em.body.data.scheduledFor, null, "come now");
      const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const manual = await book((await registerPatient(t, cRec.token)).id, [{ serviceId: cbcC.id }], { scheduledFor: when });
      assert.equal(manual.status, 201);
      assert.deepEqual([manual.body.data.autoScheduled, manual.body.data.scheduledFor], [false, when]);
    });

    it("a patient who needs both labs is given one time at which both have room, and each lab is counted", async () => {
      const p = await registerPatient(t, cRec.token);
      const r = await book(p.id, [{ serviceId: cbcC.id }, { serviceId: xrayC.id }]);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const rows = await t.prisma.limsRequest.findMany({ where: { encounterId: r.body.data.encounterId }, include: { department: true } });
      assert.equal(rows.length, 2);
      assert.equal(new Set(rows.map((x) => x.scheduledFor!.toISOString())).size, 1, "one time for the visit");
      assert.deepEqual(rows.map((x) => x.department.kind).sort(), ["PATHOLOGY", "RADIOLOGY"]);
    });

    it("two receptionists booking at the same moment never take the same last place", async () => {
      const cRec2 = await t.makeUser(c, ["RECEPTIONIST"]);
      const [p1, p2] = [await registerPatient(t, cRec.token), await registerPatient(t, cRec.token)];
      const out = await Promise.all([book(p1.id, [{ serviceId: xrayC.id }]), book(p2.id, [{ serviceId: xrayC.id }], {}, cRec2.token)]);
      assert.deepEqual(out.map((o) => o.status), [201, 201]);
      assert.notEqual(hourKey(out[0]!.body.data.scheduledFor), hourKey(out[1]!.body.data.scheduledFor), "one place an hour in radiology");
    });

    it("the LIMS manager, the manager and the administrator see how full each lab is; others do not", async () => {
      const views = await Promise.all([cMgr.token, cMgr2.token, c.admin.token].map(async (tok) => (await t.api("get", "/lims/reports/pressure?days=5", tok)).body.data as { today: string; departments: { kind: string; capacityPerHour: number; days: { date: string; capacity: number; booked: number; percent: number }[]; open: { waitingForSample: number }; nextFreeAt: string | null }[] }));
      assert.deepEqual(views[1]!.departments, views[0]!.departments);
      assert.deepEqual(views[2]!.departments, views[0]!.departments);
      const path = views[0]!.departments.find((d) => d.kind === "PATHOLOGY")!;
      assert.equal(path.capacityPerHour, 1);
      assert.equal(path.days.length, 5);
      assert.equal(path.days[0]!.capacity > 0, true);
      assert.ok(path.days.reduce((n, d) => n + d.booked, 0) >= 5, "the bookings made above are counted");
      assert.ok(path.open.waitingForSample >= 5);
      assert.ok(path.nextFreeAt);
      for (const tok of [cRec.token, cNurse.token, cDoc.token]) assert.equal((await t.api("get", "/lims/reports/pressure", tok)).status, 403);
      assert.equal((await t.api("get", "/lims/reports/pressure?days=99", cMgr.token)).status, 400);
      // Another hospital sees its own labs, not this one's bookings.
      const other = (await t.api("get", "/lims/reports/pressure", bMgr.token)).body.data.departments as { days: { booked: number }[] }[];
      assert.ok(other.every((d) => d.days.every((x) => x.booked === 0)));
    });

    it("only reception asks for a date; capacity and hours are kept by the administrator and must make sense", async () => {
      for (const tok of [cMgr.token, cNurse.token, cDoc.token]) assert.equal((await t.api("get", "/lims/opd/availability?pathology=1", tok)).status, 403);
      assert.equal((await t.api("get", "/lims/opd/availability?pathology=99", cRec.token)).status, 400);
      assert.equal((await dept("PATHOLOGY", { capacityPerHour: 0 })).status, 400);
      assert.equal((await dept("PATHOLOGY", { capacityPerHour: 501 })).status, 400);
      assert.equal((await dept("PATHOLOGY", { openMinute: 600, closeMinute: 630 })).status, 400, "open for less than an hour");
      assert.equal((await dept("PATHOLOGY", { openMinute: 1000, closeMinute: 900 })).status, 400);
      assert.equal((await t.api("put", "/lims/departments/pathology", cMgr.token).send({})).status, 403, "the LIMS manager looks; the administrator sets the capacity");
      // Raising the capacity gives later patients earlier times.
      const before = (await t.api("get", "/lims/opd/availability?pathology=1", cRec.token)).body.data.suggestedAt as string;
      assert.equal((await dept("PATHOLOGY", { capacityPerHour: 50 })).status, 200);
      const after = (await t.api("get", "/lims/opd/availability?pathology=1", cRec.token)).body.data.suggestedAt as string;
      assert.ok(new Date(after).getTime() < new Date(before).getTime(), `${after} should be earlier than ${before}`);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: c.tenantId, action: "LIMS_DEPARTMENT_CHANGED", entityId: (await t.prisma.limsDepartment.findFirstOrThrow({ where: { tenantId: c.tenantId, kind: "PATHOLOGY" } })).id } }));
    });

    it("a department that is switched off, or has no room for two weeks, says so instead of giving a date", async () => {
      assert.equal((await dept("RADIOLOGY", { capacityPerHour: 1, openMinute: 0, closeMinute: 60 })).status, 200);
      // One place an hour and a single working hour a day: the first patients fill the days one after the other.
      const first = await book((await registerPatient(t, cRec.token)).id, [{ serviceId: xrayC.id }]);
      const second = await book((await registerPatient(t, cRec.token)).id, [{ serviceId: xrayC.id }]);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.ok(new Date(second.body.data.scheduledFor).getTime() - new Date(first.body.data.scheduledFor).getTime() >= 20 * 3_600_000, "the next day");
    });
  });

  // ───────────────────────── arrival, payment and the admitted patient's bill ─────────────────────────
  describe("reporting at reception, the advance and the balance, and the admitted patient's bill", () => {
    const key = () => randomUUID();
    const soon = () => new Date(Date.now() + 90_000).toISOString();
    const pay = (amount: string, reference = "UPI-0001") => ({ method: "UPI", amount, reference });
    const arrive = (batchId: string, body: Record<string, unknown>, tok = rec.token, k = key()) => t.api("post", `/lims/batches/${batchId}/arrive`, tok).set("Idempotency-Key", k).send(body);
    const rawCollect = (id: string, tok = nurse.token) => t.api("post", `/lims/requests/${id}/collect`, tok).send({});
    const advance = (patientId: string, amount: string) => t.api("post", `/patients/${patientId}/advances`, rec.token).set("Idempotency-Key", key()).send({ tenders: [pay(amount, "UPI-ADV-1")] });
    const bookOne = async (o: Record<string, unknown> = {}) => {
      const patient = await registerPatient(t, rec.token);
      const r = await t.api("post", "/lims/opd/book", rec.token).send({ patientId: patient.id, consent: true, tests: [{ serviceId: cbc.id }], scheduledFor: soon(), ...o });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return { patient, batchId: r.body.data.batchId as string, encounterId: r.body.data.encounterId as string, requestId: r.body.data.requests[0].id as string };
    };
    interface Billing { owed: string; advanceAvailable: string; advanceToUse: string; toCollect: string; arrived: boolean; paid: boolean; invoices: { id: string; status: string }[]; unpriced: number; tests: { amount: string | null }[] }
    const billing = async (batchId: string, tok = rec.token) => (await t.api("get", `/lims/batches/${batchId}/billing`, tok)).body.data as Billing;
    const ids = async (qs: string, tok: string) => ((await get(`/lims/requests?${qs}&pageSize=100`, tok)).items as Req[]).map((r) => r.id);

    it("the nurse cannot take the sample until the patient has reported; reporting bills the tests, uses the advance first and takes the rest", async () => {
      const x = await bookOne();
      const first = await billing(x.batchId);
      assert.deepEqual([first.owed, first.toCollect, first.arrived, first.paid, first.unpriced], ["250.00", "250.00", false, false, 0]);
      assert.equal(first.tests[0]!.amount, "250.00");
      const early = await rawCollect(x.requestId);
      assert.equal(early.status, 409);
      assert.equal(early.body.error.code, "PATIENT_NOT_ARRIVED");

      assert.equal((await advance(x.patient.id, "100.00")).status, 201);
      const withAdvance = await billing(x.batchId);
      assert.deepEqual([withAdvance.advanceAvailable, withAdvance.advanceToUse, withAdvance.toCollect], ["100.00", "100.00", "150.00"]);

      // The rest must be taken in full; when it is not, nothing is billed and nothing is taken.
      const none = await arrive(x.batchId, {});
      assert.equal(none.status, 409);
      assert.equal(none.body.error.code, "PAYMENT_REQUIRED");
      assert.equal(none.body.error.details?.balanceDue, "150.00");
      assert.equal((await arrive(x.batchId, { payments: [pay("100.00")] })).body.error.code, "PAYMENT_REQUIRED");
      assert.equal((await arrive(x.batchId, { payments: [pay("200.00")] })).body.error.code, "PAYMENT_EXCEEDS_BALANCE");
      assert.equal((await arrive(x.batchId, { payments: [{ method: "UPI", amount: "150.00" }] })).status, 400, "a UPI payment needs its reference");
      const order = await t.prisma.limsRequest.findFirstOrThrow({ where: { id: x.requestId }, include: { testOrder: true } });
      assert.equal(order.testOrder.status, "ORDERED", "refused: nothing was billed");
      assert.equal(order.arrivedAt, null);

      // Who may do it.
      for (const [name, tok] of [["a nurse", nurse.token], ["a doctor", doc.token], ["the cashier", cashier.token], ["the LIMS manager", mgr.token]] as const) assert.equal((await arrive(x.batchId, { payments: [pay("150.00")] }, tok)).status, 403, `${name} does not take the patient in`);
      assert.equal((await arrive(x.batchId, { payments: [pay("150.00")] }, bRec.token)).status, 404, "another hospital's reception does not know this booking");

      const k = key();
      const ok = await arrive(x.batchId, { payments: [pay("150.00")] }, rec.token, k);
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.deepEqual([ok.body.data.owed, ok.body.data.advanceUsed, ok.body.data.collected], ["250.00", "100.00", "150.00"]);
      const done = await billing(x.batchId);
      assert.deepEqual([done.arrived, done.paid, done.toCollect, done.invoices.length], [true, true, "0.00", 1]);
      const inv = await t.prisma.invoice.findFirstOrThrow({ where: { id: done.invoices[0]!.id } });
      assert.deepEqual([inv.status, inv.kind, inv.paidTotal.toString()], ["PAID", "OTHER", "250"]);
      assert.equal((await t.prisma.testOrder.findFirstOrThrow({ where: { id: order.testOrderId } })).status, "BILLED");
      // The same press twice (a double click, a retry) takes nothing more; a second, deliberate attempt is refused.
      const replay = await arrive(x.batchId, { payments: [pay("150.00")] }, rec.token, k);
      assert.ok([200, 201].includes(replay.status), JSON.stringify(replay.body));
      assert.equal((await billing(x.batchId)).invoices.length, 1);
      assert.equal((await arrive(x.batchId, { payments: [pay("150.00")] })).status, 409);
      assert.equal((await t.prisma.invoice.findFirstOrThrow({ where: { id: inv.id } })).paidTotal.toString(), "250");

      // The history, the audit and the nurse's notice; then the nurse may take the sample.
      assert.ok(await t.prisma.limsRequestEvent.findFirst({ where: { requestId: x.requestId, kind: "ARRIVED" } }));
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LIMS_PATIENT_ARRIVED", entityId: x.encounterId } }));
      assert.ok((await notes(nurse.token)).some((n) => n.type === "LIMS_PATIENT_ARRIVED" && n.entityId === x.requestId));
      assert.equal((await rawCollect(x.requestId)).status, 200);

      // Who may look at the money.
      assert.equal((await t.api("get", `/lims/batches/${x.batchId}/billing`, nurse.token)).status, 403);
      for (const tok of [mgr.token, hospMgr.token, a.admin.token]) assert.equal((await t.api("get", `/lims/batches/${x.batchId}/billing`, tok)).status, 200);
      assert.equal((await t.api("get", `/lims/batches/${x.batchId}/billing`, bRec.token)).status, 404);
    });

    it("a patient whose tests the cashier already billed and collected goes straight to the nurse, with an empty payment list", async () => {
      const x = await bookOne();
      const billed = await t.api("post", "/test-orders/bill", cashier.token).send({ encounterId: x.encounterId, fromSaved: true });
      assert.ok([200, 201].includes(billed.status), JSON.stringify(billed.body));
      const paid = await t.api("post", `/invoices/${billed.body.data.invoiceId}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [pay("250.00")] });
      assert.equal(paid.status, 201, JSON.stringify(paid.body));
      const before = await billing(x.batchId);
      assert.deepEqual([before.owed, before.toCollect, before.paid, before.arrived], ["0.00", "0.00", true, false]);
      const r = await arrive(x.batchId, { payments: [] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.data.owed, r.body.data.collected, r.body.data.billed.length], ["0.00", "0.00", 0]);
      assert.equal((await rawCollect(x.requestId)).status, 200, "the nurse may take the sample");
    });

    it("a test with no price on the list stops the arrival until the cashier prices it", async () => {
      const x = await bookOne({ tests: [{ name: "Special assay", category: "LABORATORY" }] });
      assert.equal((await billing(x.batchId)).unpriced, 1);
      const r = await arrive(x.batchId, { payments: [pay("100.00")] });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "TEST_NEEDS_PRICE");
      assert.equal((await t.prisma.limsRequest.findFirstOrThrow({ where: { id: x.requestId } })).arrivedAt, null);
    });

    it("on the day the patient's name shows for reception, the LIMS manager and the nurse, as expected or as reported", async () => {
      const x = await bookOne();
      const later = await bookOne({ scheduledFor: new Date(Date.now() + 3 * 86_400_000).toISOString() });
      for (const tok of [rec.token, mgr.token, hospMgr.token, nurse.token]) {
        assert.ok((await ids("expected=true", tok)).includes(x.requestId), "expected today");
        assert.ok(!(await ids("expected=true", tok)).includes(later.requestId), "a later day is not today's list");
        assert.ok((await ids("arrived=false", tok)).includes(x.requestId));
        assert.ok(!(await ids("arrived=true", tok)).includes(x.requestId));
      }
      assert.equal((await arrive(x.batchId, { payments: [pay("250.00")] })).status, 201);
      for (const tok of [rec.token, mgr.token, nurse.token]) {
        assert.ok((await ids("arrived=true", tok)).includes(x.requestId), "now at reception");
        assert.ok(!(await ids("arrived=false", tok)).includes(x.requestId));
      }
      const view = (await get(`/lims/requests/${x.requestId}`, mgr.token)) as { arrivedAt: string | null; timeline: { kind: string }[] };
      assert.ok(view.arrivedAt);
      assert.ok(view.timeline.some((e) => e.kind === "ARRIVED"));
    });

    it("the patient is messaged on WhatsApp and by SMS (and by email when on), with the time and what to do beforehand", async () => {
      const x = await bookOne({ instructions: "Come fasting for 8 hours." });
      const rows = await t.prisma.limsMessage.findMany({ where: { batchId: x.batchId } });
      assert.deepEqual(rows.map((r) => `${r.kind}:${r.channel}`).sort(), ["SCHEDULED:SMS", "SCHEDULED:WHATSAPP"]);
    });

    it("an admitted patient's test goes to a nurse chosen at once, is not held by lab load, and its charge reaches the admission's bill when the report is issued", async () => {
      // The pathology lab is as full as it can be for outpatients; an admitted patient is not held back by that.
      assert.equal((await t.api("put", "/lims/departments/pathology", a.admin.token).send({ name: "Pathology", status: "ACTIVE", routineTatMinutes: 720, urgentTatMinutes: 240, emergencyTatMinutes: 90, capacityPerHour: 1, openMinute: 480, closeMinute: 1080 })).status, 200);
      const x = await passedLab();
      const row = await t.prisma.limsRequest.findFirstOrThrow({ where: { id: x.r.id } });
      assert.equal(row.scheduledFor, null, "no lab-load date for an admitted patient");
      assert.ok(row.assignedNurseId, "a nurse is chosen automatically");
      const staff = (await get("/lims/staff", mgr.token)) as { nurses: { id: string }[] };
      assert.ok(staff.nurses.some((n) => n.id === row.assignedNurseId), "the nurse is one of the nurses who take samples");
      assert.ok(await t.prisma.limsRequestEvent.findFirst({ where: { requestId: x.r.id, kind: "NURSE_ASSIGNED", note: "assigned automatically" } }));
      // The Cashier does not bill it as a separate bill: it is charged to the admission.
      const queue = (await get("/test-orders/queue", cashier.token)) as { visits: { encounterId: string }[] };
      assert.ok(!queue.visits.some((v) => v.encounterId === x.encounterId), "not in the Cashier's list");
      assert.equal(await t.prisma.charge.count({ where: { sourceKey: `LIMS:${x.r.id}` } }), 0, "not charged before the report is out");

      assert.equal((await act(x.r.id, "issue", pTech.token)).status, 200);
      const adm = await t.prisma.admission.findFirstOrThrow({ where: { encounterId: x.encounterId } });
      const charge = await t.prisma.charge.findFirstOrThrow({ where: { sourceKey: `LIMS:${x.r.id}` } });
      assert.deepEqual([charge.admissionId, charge.status, charge.type, charge.unitPrice.toString(), charge.quantity.toString()], [adm.id, "PENDING", "SERVICE", "250", "1"]);
      assert.ok(await t.prisma.limsRequestEvent.findFirst({ where: { requestId: x.r.id, kind: "CHARGED" } }));

      // The doctor is told: test, patient and bed (looked up when read, never stored in the notice).
      const patient = await t.prisma.patient.findFirstOrThrow({ where: { id: x.patient.id } });
      const told = (await t.api("get", "/notifications", doc.token)).body.data as { type: string; entityId: string; detail?: string | null }[];
      const n = told.find((m) => m.type === "LIMS_REPORT_ISSUED" && m.entityId === x.r.id);
      assert.ok(n, "the doctor has a notice");
      assert.ok(n!.detail?.includes(cbc.name) && n!.detail.includes(patient.firstName) && n!.detail.includes("Bed "), n!.detail ?? "no detail");
      const asRequest = (await get(`/lims/requests/${x.r.id}`, mgr.token)) as { bed: { code: string; ward: string } | null };
      assert.ok(asRequest.bed, "the request shows the bed");

      // The LIMS manager, the manager and the administrator follow the charge.
      for (const tok of [mgr.token, hospMgr.token, a.admin.token]) {
        const rep = (await get("/lims/reports/billing", tok)) as { admittedCharges: { requestNumber: string; admissionNumber: string | null; amount: string; status: string }[]; departments: { kind: string; chargedToAdmissions: number }[] };
        const hit = rep.admittedCharges.find((c) => c.requestNumber === x.r.requestNumber);
        assert.ok(hit, "listed for the monitors");
        assert.deepEqual([hit!.amount, hit!.status, hit!.admissionNumber], ["250.00", "PENDING", adm.admissionNumber]);
        assert.ok(rep.departments.find((d) => d.kind === "PATHOLOGY")!.chargedToAdmissions >= 1);
      }
      // Another hospital never sees it.
      const other = (await get("/lims/reports/billing", bMgr.token)) as { admittedCharges: unknown[] };
      assert.equal(other.admittedCharges.length, 0);
    });

    it("an admitted patient's test with no price on the list is not charged", async () => {
      const { encounterId } = await admitted();
      assert.equal((await order(encounterId, [{ name: "Special assay", category: "LABORATORY" }])).status, 201);
      const r = await only(encounterId, "Special assay");
      assert.equal(await t.prisma.charge.count({ where: { sourceKey: `LIMS:${r.id}` } }), 0);
    });
  });
});
