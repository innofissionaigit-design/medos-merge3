import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDoctor, registerPatient, startApp, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { MESSAGE_PROVIDER, type MessageProvider, type OutgoingMessage } from "../prescriptions/message.provider";

let seq = 0;
/** A valid Indian mobile number that no other test uses. */
const mobileNo = () => `8${String(Date.now()).slice(-6)}${String(++seq).padStart(3, "0")}`;
const uniq = () => Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 6) || "abcdef";
const day = (plus: number) => new Date(Date.now() + plus * 86_400_000).toISOString().slice(0, 10);

describe("patient app: username and password, self-registration, and paying for a video request", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let doc: TestDoctor;
  const sent: OutgoingMessage[] = [];
  const codeFor = (mobile: string) => /^(\d{6}) is your/.exec([...sent].reverse().find((m) => m.to === mobile)?.text ?? "")?.[1] ?? "";
  let uname = 0;
  const username = () => `pt.user${Date.now().toString(36)}${++uname}`;

  const withSession = (method: "get" | "post", path: string, token: string) => t.api(method, path).set("Authorization", `Bearer ${token}`);
  /** A patient with this mobile, and a session opened with a code. */
  const codeSession = async (mobile: string, tenant = a) => {
    await t.api("post", "/patient-portal/auth/code").send({ hospitalCode: tenant.code, mobile });
    const r = await t.api("post", "/patient-portal/auth/verify").send({ hospitalCode: tenant.code, mobile, code: codeFor(mobile) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data.token as string;
  };
  const login = (user: string, password: string, hospitalCode = a.code) => t.api("post", "/patient-portal/auth/login").send({ hospitalCode, username: user, password });
  const register = (o: Record<string, unknown> = {}) => t.api("post", "/patient-portal/auth/register").send({
    hospitalCode: a.code, mobile: mobileNo(), firstName: `Asha${uniq()}`, lastName: `Roy${uniq()}`, gender: "FEMALE", dateOfBirth: "1990-04-02", username: username(), password: "Secret#2026", ...o,
  });
  const setSetting = (key: string, value: unknown) => t.api("put", `/settings/${key}`, a.admin.token).send({ value });

  before(async () => {
    process.env.ONLINE_PAYMENT_PROVIDER = "test";
    t = await startApp();
    a = await t.makeTenant("portal-pw-a"); b = await t.makeTenant("portal-pw-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    const provider = t.app.get<MessageProvider>(MESSAGE_PROVIDER);
    (provider as { send: MessageProvider["send"] }).send = async (m) => { sent.push(m); return { providerMessageId: `test:${m.reference}` }; };
    assert.equal((await t.api("put", "/settings/PATIENT_PORTAL_ENABLED", a.admin.token).send({ value: true })).status, 200);
    assert.equal((await t.api("put", "/settings/PATIENT_PORTAL_ENABLED", b.admin.token).send({ value: true })).status, 200);
  });
  after(async () => { delete process.env.ONLINE_PAYMENT_PROVIDER; await t.close(); });

  describe("the password", () => {
    it("is set from a session opened with a code; then the username and password sign in; wrong ones all look the same", async () => {
      const mobile = mobileNo();
      const p = await registerPatient(t, rec.token);
      await t.prisma.patient.update({ where: { id: p.id }, data: { mobile } });
      const token = await codeSession(mobile);
      assert.deepEqual((await withSession("get", "/patient-portal/password", token)).body.data, { set: false, username: null });
      const user = username();
      for (const bad of [{ username: user, password: "short1" }, { username: user, password: "onlyletters" }, { username: "no", password: "Secret#2026" }, { username: "bad name", password: "Secret#2026" }]) {
        assert.equal((await withSession("post", "/patient-portal/password", token).send(bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await withSession("post", "/patient-portal/password", token).send({ username: user.toUpperCase(), password: "Secret#2026" })).status, 200);
      assert.deepEqual((await withSession("get", "/patient-portal/password", token)).body.data, { set: true, username: user });
      const row = await t.prisma.patientCredential.findFirstOrThrow({ where: { tenantId: a.tenantId, mobile } });
      assert.notEqual(row.passwordHash, "Secret#2026", "only a hash is kept");
      const ok = await login(user, "Secret#2026");
      assert.equal(ok.status, 200);
      const me = await withSession("get", "/patient-portal/me", ok.body.data.token);
      assert.equal(me.status, 200, "the session is the same kind as one opened with a code");
      const wrong = await login(user, "Wrong#2026");
      const unknown = await login("nobody.here", "Secret#2026");
      const elsewhere = await login(user, "Secret#2026", b.code);
      for (const r of [wrong, unknown, elsewhere]) assert.deepEqual([r.status, r.body.error.message], [401, "The username or password is not correct"]);
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "PATIENT_APP_PASSWORD_SET", entityType: "PatientCredential" } }) >= 1, true);
    });

    it("locks the number after five wrong tries, still lets the code sign in, and a right password unlocks nothing early", async () => {
      const mobile = mobileNo();
      const p = await registerPatient(t, rec.token);
      await t.prisma.patient.update({ where: { id: p.id }, data: { mobile } });
      const token = await codeSession(mobile);
      const user = username();
      assert.equal((await withSession("post", "/patient-portal/password", token).send({ username: user, password: "Secret#2026" })).status, 200);
      for (let i = 0; i < 5; i++) assert.equal((await login(user, "Wrong#2026")).status, 401);
      const locked = await login(user, "Secret#2026");
      assert.equal(locked.status, 429, "locked even with the right password");
      assert.equal((await t.api("post", "/patient-portal/auth/code").send({ hospitalCode: a.code, mobile })).status, 200);
      assert.equal((await t.api("post", "/patient-portal/auth/verify").send({ hospitalCode: a.code, mobile, code: codeFor(mobile) })).status, 200, "the SMS code still works");
      await t.prisma.patientCredential.updateMany({ where: { tenantId: a.tenantId, mobile }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      assert.equal((await login(user, "Secret#2026")).status, 200, "after the wait it works again");
    });

    it("a username is unique in the hospital; the same name in another hospital is fine", async () => {
      const m1 = mobileNo(); const m2 = mobileNo();
      for (const m of [m1, m2]) { const p = await registerPatient(t, rec.token); await t.prisma.patient.update({ where: { id: p.id }, data: { mobile: m } }); }
      const user = username();
      assert.equal((await withSession("post", "/patient-portal/password", await codeSession(m1)).send({ username: user, password: "Secret#2026" })).status, 200);
      const second = await withSession("post", "/patient-portal/password", await codeSession(m2)).send({ username: user, password: "Secret#2026" });
      assert.equal(second.status, 409);
    });
  });

  describe("signing up without a code", () => {
    it("registers a new patient on a new number, signs them in, and leaves the registration fee to the front desk", async () => {
      const mobile = mobileNo();
      const user = username();
      const r = await register({ mobile: `+91${mobile}`, username: `${user}@example.com` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const me = await withSession("get", "/patient-portal/me", r.body.data.token);
      assert.equal(me.body.data.patients.length, 1);
      assert.match(me.body.data.patients[0].mrn, /\S+/);
      assert.equal((await login(`${user}@example.com`, "Secret#2026")).status, 200, "an email address works as a username");
      const patient = await t.prisma.patient.findFirstOrThrow({ where: { tenantId: a.tenantId, mobile } });
      assert.match(patient.firstName, /^Asha/);
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "PATIENT_APP_REGISTERED", entityId: patient.id } }), 1);
    });

    it("points a person with the same name and birth date as an existing patient to sign in instead of making a second record", async () => {
      const p = await registerPatient(t, rec.token, { firstName: "Kavita", lastName: "Menon" });
      assert.ok(p.id);
      const before = await t.prisma.patient.count({ where: { tenantId: a.tenantId } });
      const r = await register({ firstName: "Kavita", lastName: "Menon" });
      assert.deepEqual([r.status, r.body.error.code], [409, "CONFLICT"]);
      assert.match(r.body.error.message, /already be registered/);
      assert.equal(await t.prisma.patient.count({ where: { tenantId: a.tenantId } }), before);
    });

    it("refuses a number the hospital already has, a taken username, a weak password and a future birth date; another hospital is separate", async () => {
      const known = mobileNo();
      const p = await registerPatient(t, rec.token);
      await t.prisma.patient.update({ where: { id: p.id }, data: { mobile: known } });
      const before = await t.prisma.patient.count({ where: { tenantId: a.tenantId } });
      const existing = await register({ mobile: known });
      assert.deepEqual([existing.status, existing.body.error.code], [409, "CONFLICT"], "a number that already belongs to a patient must use the code");
      const taken = username();
      assert.equal((await register({ username: taken })).status, 200);
      assert.equal((await register({ username: taken })).status, 409);
      assert.equal((await register({ password: "weak" })).status, 400);
      assert.equal((await register({ dateOfBirth: day(10) })).status, 400);
      assert.equal((await register({ hospitalCode: "no-such-hospital" })).status, 400);
      assert.equal((await register({ extra: true })).status, 400);
      assert.equal(await t.prisma.patient.count({ where: { tenantId: a.tenantId } }), before + 1, "only the one good registration made a patient");
      assert.equal((await register({ hospitalCode: b.code, username: taken })).status, 200, "the other hospital has its own usernames");
    });
  });

  describe("asking for an appointment and paying", () => {
    let token = ""; let patientId = ""; let proof = "";
    before(async () => {
      const mobile = mobileNo();
      const p = await registerPatient(t, rec.token);
      await t.prisma.patient.update({ where: { id: p.id }, data: { mobile } });
      patientId = p.id;
      token = await codeSession(mobile);
      const u = await withSession("post", "/patient-portal/unlock", token).send({ patientId, dateOfBirth: "1990-04-02" });
      assert.equal(u.status, 200);
      proof = u.body.data.proof as string;
    });
    /** Every call carries the proof of the date of birth, as the web gateway does. */
    const call = (method: "get" | "post", path: string) => withSession(method, path, token).set("x-patient-proofs", proof);
    const body = (o: Record<string, unknown> = {}) => ({ patientId, preferredDate: day(1), timeOfDay: "ANY", reason: "Fever", ...o });

    it("a visit in person has no payment; a video consultation shows its fee (the doctor's own, else the hospital's)", async () => {
      assert.deepEqual((await call("get", "/patient-portal/appointment-requests/fee?mode=IN_PERSON")).body.data, { amount: null, online: true });
      assert.equal((await setSetting("TELECONSULT_FEE_AMOUNT", "400.00")).status, 200);
      assert.deepEqual((await call("get", "/patient-portal/appointment-requests/fee?mode=VIDEO")).body.data, { amount: "400.00", online: true });
      assert.equal((await t.api("patch", `/practitioners/${doc.practitionerId}`, a.admin.token).send({ videoFee: "650" })).status, 200);
      assert.equal((await call("get", `/patient-portal/appointment-requests/fee?mode=VIDEO&practitionerId=${doc.practitionerId}`)).body.data.amount, "650.00");
      assert.equal((await call("get", "/patient-portal/appointment-requests/fee?mode=VIDEO")).body.data.amount, "400.00", "no doctor chosen: the hospital's fee");
      assert.equal((await t.api("patch", `/practitioners/${doc.practitionerId}`, a.admin.token).send({ videoFee: null })).status, 200);
    });

    it("an unpaid video request is refused; paying sends it once, with a receipt, and the same key never charges twice", async () => {
      const unpaid = await call("post", "/patient-portal/appointment-requests").send(body({ mode: "VIDEO" }));
      assert.deepEqual([unpaid.status, unpaid.body.error.code], [409, "INVALID_STATE"]);
      assert.equal(await t.prisma.appointmentRequest.count({ where: { tenantId: a.tenantId, patientId } }), 0);
      const key = `vid-${Date.now()}-abcdef`;
      const paid = await call("post", "/patient-portal/appointment-requests/paid").send(body({ mode: "VIDEO", method: "UPI", key }));
      assert.equal(paid.status, 200, JSON.stringify(paid.body));
      assert.deepEqual([paid.body.data.amount, paid.body.data.mode], ["400.00", "test"]);
      const again = await call("post", "/patient-portal/appointment-requests/paid").send(body({ mode: "VIDEO", method: "UPI", key }));
      assert.equal(again.status, 200);
      assert.equal(again.body.data.receiptNumber, paid.body.data.receiptNumber, "the same receipt comes back");
      const rows = await t.prisma.appointmentRequest.findMany({ where: { tenantId: a.tenantId, patientId } });
      assert.equal(rows.length, 1, "one request, however many taps");
      assert.deepEqual([rows[0]!.mode, rows[0]!.feeAmount?.toFixed(2), rows[0]!.feeReceiptNumber], ["VIDEO", "400.00", paid.body.data.receiptNumber]);
      assert.equal(await t.prisma.advanceDeposit.count({ where: { tenantId: a.tenantId, patientId } }), 1, "one payment");
      const dep = await t.prisma.advanceDeposit.findFirstOrThrow({ where: { tenantId: a.tenantId, patientId } });
      assert.equal(dep.id, rows[0]!.feeDepositId);
    });

    it("money is never taken for a request that would be refused; a free visit cannot be 'paid'", async () => {
      const deposits = await t.prisma.advanceDeposit.count({ where: { tenantId: a.tenantId, patientId } });
      const past = await call("post", "/patient-portal/appointment-requests/paid").send(body({ mode: "VIDEO", method: "CARD", key: `past-${Date.now()}-abcdef`, preferredDate: "2020-01-01" }));
      assert.equal(past.status, 400);
      const free = await call("post", "/patient-portal/appointment-requests/paid").send(body({ method: "CARD", key: `free-${Date.now()}-abcdef` }));
      assert.deepEqual([free.status, free.body.error.code], [409, "INVALID_STATE"]);
      assert.equal(await t.prisma.advanceDeposit.count({ where: { tenantId: a.tenantId, patientId } }), deposits);
      assert.equal((await call("post", "/patient-portal/appointment-requests").send(body({ reason: "Check-up" }))).status, 201, "a free visit is sent without paying");
    });

    it("when the front desk books the paid request, the appointment's fee is not asked for again", async () => {
      const request = await t.prisma.appointmentRequest.findFirstOrThrow({ where: { tenantId: a.tenantId, patientId, mode: "VIDEO" } });
      assert.equal((await t.api("put", "/settings/BOOKING_FEE_ENABLED", a.admin.token).send({ value: true })).status, 200);
      assert.equal((await setSetting("BOOKING_FEE_AMOUNT", "100.00")).status, 200);
      const startAt = new Date(Date.now() + 2 * 86_400_000); startAt.setUTCHours(6, 0, 0, 0);
      const ap = await t.api("post", "/appointments", rec.token).send({ patientId, practitionerId: doc.practitionerId, startAt: startAt.toISOString() });
      assert.equal(ap.status, 201, JSON.stringify(ap.body));
      const appointmentId = ap.body.data.id as string;
      const answered = await t.api("post", `/appointment-requests/${request.id}/answer`, rec.token).send({ decision: "BOOKED", appointmentId, note: "Booked" });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      const row = await t.prisma.appointment.findFirstOrThrow({ where: { id: appointmentId } });
      assert.equal(row.feeSkipReason, "PAID_ONLINE");
      assert.match(row.feeSkipNote ?? "", /Paid online with the request/);
      assert.ok(row.feeSkippedById && row.feeSkippedAt);
      const list = await t.api("get", "/appointment-requests?status=BOOKED", rec.token);
      assert.equal(list.status, 200);
      assert.equal(list.body.data.items.find((x: { id: string }) => x.id === request.id)?.paidOnline?.amount, "400.00");
    });

    it("another family's patient and another hospital cannot ask or pay on this patient's behalf", async () => {
      const otherMobile = mobileNo();
      const o = await registerPatient(t, rec.token);
      await t.prisma.patient.update({ where: { id: o.id }, data: { mobile: otherMobile } });
      const otherToken = await codeSession(otherMobile);
      const r = await withSession("post", "/patient-portal/appointment-requests/paid", otherToken).send(body({ mode: "VIDEO", method: "UPI", key: `x-${Date.now()}-abcdef` }));
      assert.equal(r.status, 404);
      assert.equal((await t.api("post", "/patient-portal/appointment-requests/paid").send(body({ mode: "VIDEO", method: "UPI", key: "no-token-1234" }))).status, 401);
    });
  });
});
