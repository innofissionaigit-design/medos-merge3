import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startApp, type TestApp, type TestTenant } from "../../test/harness";

let seq = 0;
/** A valid Indian mobile number that no other test uses. */
const mobileNo = () => `7${String(Date.now()).slice(-6)}${String(++seq).padStart(3, "0")}`;
const uniq = () => Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 6) || "abcdef";

describe("administration: the patient app accounts and online payments", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let uname = 0;
  const username = () => `adm.user${Date.now().toString(36)}${++uname}`;
  const withSession = (method: "get" | "post", path: string, token: string) => t.api(method, path).set("Authorization", `Bearer ${token}`);
  const login = (user: string, password: string, hospitalCode = a.code) => t.api("post", "/patient-portal/auth/login").send({ hospitalCode, username: user, password });
  const register = async (tenant = a, o: Record<string, unknown> = {}) => {
    const mobile = mobileNo();
    const user = username();
    const first = `Asha${uniq()}`;
    const r = await t.api("post", "/patient-portal/auth/register").send({ hospitalCode: tenant.code, mobile, firstName: first, lastName: `Roy${uniq()}`, gender: "FEMALE", dateOfBirth: "1990-04-02", username: user, password: "Secret#2026", ...o });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const cred = await t.prisma.patientCredential.findFirstOrThrow({ where: { tenantId: tenant.tenantId, username: user } });
    return { mobile, user, first, token: r.body.data.token as string, credId: cred.id };
  };

  before(async () => {
    process.env.ONLINE_PAYMENT_PROVIDER = "test";
    t = await startApp();
    a = await t.makeTenant("portal-adm-a"); b = await t.makeTenant("portal-adm-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    for (const x of [a, b]) assert.equal((await t.api("put", "/settings/PATIENT_PORTAL_ENABLED", x.admin.token).send({ value: true })).status, 200);
  });
  after(async () => { delete process.env.ONLINE_PAYMENT_PROVIDER; await t.close(); });

  it("lists the app accounts with the username, the patient and only the last four digits of the mobile; never a password", async () => {
    const p = await register();
    const r = await t.api("get", "/patient-app/accounts", a.admin.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = (r.body.data.rows as { id: string; username: string; mobile: string; patients: { name: string }[]; locked: boolean }[]).find((x) => x.id === p.credId);
    assert.ok(row, "the new account is listed");
    assert.equal(row.username, p.user);
    assert.equal(row.mobile.endsWith(p.mobile.slice(-4)), true);
    assert.equal(row.mobile.includes(p.mobile.slice(0, 6)), false, "the rest of the number is hidden");
    assert.equal(row.patients[0]?.name.startsWith(p.first), true);
    assert.equal(row.locked, false);
    assert.equal(JSON.stringify(r.body).includes("passwordHash"), false, "no password material is ever returned");
    for (const q of [`search=${p.user}`, `search=${p.first}`, `search=${p.mobile.slice(-6)}`]) {
      const s = await t.api("get", `/patient-app/accounts?${q}`, a.admin.token);
      assert.equal((s.body.data.rows as { id: string }[]).some((x) => x.id === p.credId), true, q);
    }
    assert.equal((await t.api("get", "/patient-app/accounts?search=nobody-with-this-name", a.admin.token)).body.data.rows.length, 0);
  });

  it("shows a locked-out patient, unlocks them at once, and audits who did it", async () => {
    const p = await register();
    for (let i = 0; i < 5; i++) assert.equal((await login(p.user, "Wrong#2026")).status, 401);
    assert.equal((await login(p.user, "Secret#2026")).status, 429, "locked even with the right password");
    const locked = await t.api("get", "/patient-app/accounts?status=LOCKED", a.admin.token);
    assert.equal((locked.body.data.rows as { id: string }[]).some((x) => x.id === p.credId), true);
    assert.ok(locked.body.data.locked >= 1);
    const un = await t.api("post", `/patient-app/accounts/${p.credId}/unlock`, a.admin.token).send({});
    assert.deepEqual([un.status, un.body.data.wasLocked], [200, true]);
    assert.equal((await login(p.user, "Secret#2026")).status, 200, "signs in straight away");
    const ev = await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "PATIENT_APP_ACCOUNT_UNLOCKED", entityId: p.credId } });
    assert.ok(ev, "the unlock is in the audit trail");
    assert.equal(ev.actorUserId, a.admin.id);
  });

  it("resets a forgotten password: the old one stops working, open sign-ins end, the new one works, and the password is never recorded", async () => {
    const p = await register();
    assert.equal((await withSession("get", "/patient-portal/password", p.token)).status, 200, "signed in before the reset");
    for (const bad of ["short1", "onlyletters", "12345678"]) assert.equal((await t.api("post", `/patient-app/accounts/${p.credId}/reset-password`, a.admin.token).send({ password: bad })).status, 400, bad);
    assert.equal((await t.api("post", `/patient-app/accounts/${p.credId}/reset-password`, a.admin.token).send({ password: "Fresh#2026", extra: 1 })).status, 400);
    const r = await t.api("post", `/patient-app/accounts/${p.credId}/reset-password`, a.admin.token).send({ password: "Fresh#2026" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.sessionsEnded >= 1);
    assert.equal((await withSession("get", "/patient-portal/password", p.token)).status, 401, "the open session was ended");
    assert.equal((await login(p.user, "Secret#2026")).status, 401, "the old password no longer works");
    assert.equal((await login(p.user, "Fresh#2026")).status, 200);
    const ev = await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "PATIENT_APP_PASSWORD_RESET", entityId: p.credId } });
    assert.ok(ev);
    assert.equal(ev.actorUserId, a.admin.id);
    assert.equal(JSON.stringify(ev.metadata).includes("Fresh#2026"), false, "the password is not in the audit trail");
  });

  it("lists what patients paid online, with the receipt, the method and any refund", async () => {
    assert.equal((await t.api("put", "/settings/TELECONSULT_FEE_AMOUNT", a.admin.token).send({ value: "400.00" })).status, 200);
    const before = await t.api("get", "/patient-app/payments", a.admin.token);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    const p = await register();
    const patient = await t.prisma.patient.findFirstOrThrow({ where: { tenantId: a.tenantId, mobile: p.mobile }, select: { id: true } });
    const unlock = await withSession("post", "/patient-portal/unlock", p.token).send({ patientId: patient.id, dateOfBirth: "1990-04-02" });
    assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
    const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const paid = await withSession("post", "/patient-portal/appointment-requests/paid", p.token).set("x-patient-proofs", unlock.body.data.proof as string)
      .send({ patientId: patient.id, preferredDate: day, timeOfDay: "ANY", reason: "Fever", mode: "VIDEO", method: "UPI", key: `adm-${Date.now()}-abcdef` });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const after = await t.api("get", "/patient-app/payments", a.admin.token);
    assert.equal(after.body.data.summary.count, before.body.data.summary.count + 1);
    assert.equal(Number(after.body.data.summary.collected) - Number(before.body.data.summary.collected), 400);
    const row = (after.body.data.rows as { receiptNumber: string; amount: string; method: string; refunded: string; kind: string; patient: { name: string } }[]).find((x) => x.receiptNumber === paid.body.data.receiptNumber);
    assert.ok(row, "the payment is listed with its receipt");
    assert.deepEqual([row.amount, row.method, row.refunded, row.kind], ["400.00", "UPI", "0.00", "FEE"]);
    assert.equal(row.patient.name.startsWith(p.first), true);
    const other = await t.api("get", "/patient-app/payments", b.admin.token);
    assert.equal(other.body.data.rows.some((x: { receiptNumber: string }) => x.receiptNumber === paid.body.data.receiptNumber), false, "another hospital sees none of it");
  });


  it("refunds an online payment from the administrator's screen: the new row shows what can be given back, a refund needs a reason, and the money is audited", async () => {
    const sum = async () => (await t.api("get", "/patient-app/payments?pageSize=100", a.admin.token)).body.data as { total: number; rows: { receiptNumber: string; amount: string; refunded: string; refund: { kind: string; id: string; refundable: string } | null }[] };
    const before = await sum();
    const fee = before.rows.find((r) => r.refund?.kind === "ADVANCE");
    assert.ok(fee, "a fee paid in the app is listed with its refund target");
    assert.equal(fee.refund?.refundable, fee.amount, "all of it can still be given back");
    const target = fee.refund as { id: string };
    const refund = (body: Record<string, unknown>, token = a.admin.token, key = `rf-${Date.now()}-${Math.random().toString(36).slice(2)}`) => t.api("post", `/advances/${target.id}/refunds`, token).set("Idempotency-Key", key).send(body);
    assert.equal((await refund({ method: "UPI", amount: "100.00", reason: "ok" })).status, 400, "a written reason is required");
    assert.equal((await refund({ method: "UPI", amount: "100.00", reason: "Patient asked to cancel the video visit" }, rec.token)).status, 403, "reception cannot refund");
    assert.equal((await refund({ method: "UPI", amount: "100.00", reason: "Patient asked to cancel the video visit", reference: "RF-TEST-0001" })).status, 201);
    assert.equal((await refund({ method: "UPI", amount: "9999.00", reason: "Too much", reference: "RF-TEST-0002" })).status, 409, "more than what is left is refused");
    const after = await sum();
    const row = after.rows.find((r) => r.receiptNumber === fee.receiptNumber);
    assert.deepEqual([row?.refunded, row?.refund?.refundable], ["100.00", (Number(fee.amount) - 100).toFixed(2)]);
    const summary = (await t.api("get", "/patient-app/payments", a.admin.token)).body.data.summary as { refunded: string };
    assert.equal(Number(summary.refunded) >= 100, true);
    const ev = await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ADVANCE_REFUNDED", entityId: target.id } });
    assert.ok(ev, "the refund is in the audit trail");
    assert.equal(ev.actorUserId, a.admin.id);
  });

  it("pages the lists: a total, a page size and a second page", async () => {
    for (let i = 0; i < 3; i++) await register();
    const all = (await t.api("get", "/patient-app/accounts?pageSize=100", a.admin.token)).body.data as { total: number; rows: { id: string }[] };
    assert.ok(all.total >= 4);
    const p1 = (await t.api("get", "/patient-app/accounts?pageSize=2&page=1", a.admin.token)).body.data as { total: number; rows: { id: string }[] };
    const p2 = (await t.api("get", "/patient-app/accounts?pageSize=2&page=2", a.admin.token)).body.data as { total: number; rows: { id: string }[] };
    assert.deepEqual([p1.rows.length, p2.rows.length, p1.total], [2, 2, all.total]);
    assert.equal(p1.rows.some((r) => p2.rows.some((q) => q.id === r.id)), false, "no account on both pages");
    assert.equal(all.rows.length, all.total);
    const pay1 = (await t.api("get", "/patient-app/payments?pageSize=1&page=1", a.admin.token)).body.data as { total: number; rows: { receiptNumber: string }[] };
    assert.equal(pay1.rows.length, 1);
    assert.ok(pay1.total >= 1);
  });

  it("is for the administrator only, and another hospital's account cannot be seen, unlocked or reset", async () => {
    const p = await register();
    for (const [method, path] of [["get", "/patient-app/accounts"], ["get", "/patient-app/payments"], ["post", `/patient-app/accounts/${p.credId}/unlock`], ["post", `/patient-app/accounts/${p.credId}/reset-password`]] as const) {
      const r = await t.api(method, path, rec.token).send(method === "post" ? { password: "Fresh#2026" } : undefined);
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    assert.equal((await t.api("get", "/patient-app/accounts")).status, 401, "no token, no answer");
    const list = await t.api("get", `/patient-app/accounts?search=${p.user}`, b.admin.token);
    assert.equal(list.body.data.rows.length, 0, "another hospital cannot see the account");
    assert.equal((await t.api("post", `/patient-app/accounts/${p.credId}/unlock`, b.admin.token).send({})).status, 404);
    assert.equal((await t.api("post", `/patient-app/accounts/${p.credId}/reset-password`, b.admin.token).send({ password: "Fresh#2026" })).status, 404);
    assert.equal((await login(p.user, "Secret#2026")).status, 200, "the account is untouched");
  });
});
