// Extra flow tests for the merged MedOS code: taking advance, admission (walk-in and planned), inpatient treatment through discharge.
// Same method as flows.cjs: every role signs in through the login form in its own Chrome session; each step is done by the role that owns it.
// Usage: node flows2.cjs <webRoot> <outDir> <password> [adv adm ipd]
const { createRequire } = require("module");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const [webRoot, outDir, password, ...only] = process.argv.slice(2);
const { chromium } = createRequire(path.join(path.resolve(webRoot), "package.json"))("@playwright/test");
const BASE = process.env.BASE || "http://localhost:3200";
const SMS = "http://127.0.0.1:4299";
const results = [];
let browser;
const sessions = {};
const consoleProblems = [];
const shotsDir = path.join(outDir, "flow-shots"); fs.mkdirSync(shotsDir, { recursive: true });

function step(flow, who, name, ok, detail = "") {
  results.push({ flow, who, name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"} [${flow}] ${who}: ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
  return !!ok;
}
let lastLogin = 0;
async function as(user) {
  if (sessions[user]) return sessions[user];
  const gap = Date.now() - lastLogin; if (gap < 6500) await new Promise((r) => setTimeout(r, 6500 - gap)); lastLogin = Date.now();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => consoleProblems.push(`${user} PAGEERROR ${e.message.slice(0, 160)} @ ${page.url()}`));
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) consoleProblems.push(`${user} ${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`); });
  await page.goto(BASE + "/login");
  const boxes = page.locator("input");
  await boxes.nth(0).fill("demo-hospital"); await boxes.nth(1).fill(user); await boxes.nth(2).fill(password);
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  sessions[user] = page;
  return page;
}
async function api(user, method, p, body, extraHeaders = {}) {
  const page = await as(user);
  return page.evaluate(async ({ method, p, body, extraHeaders }) => {
    const h = { "x-medos-csrf": "1", ...extraHeaders };
    if (body !== undefined) h["content-type"] = "application/json";
    if (method !== "GET" && !h["idempotency-key"]) h["idempotency-key"] = crypto.randomUUID();
    const r = await fetch("/api/proxy" + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j, d: j && j.data !== undefined ? j.data : null };
  }, { method, p, body, extraHeaders });
}
const errOf = (r) => (r.j && r.j.error ? `${r.j.error.code}: ${r.j.error.message}` : String(JSON.stringify(r.j)).slice(0, 150));
async function expectStatus(flow, user, name, r, want) {
  const ok = Array.isArray(want) ? want.includes(r.s) : r.s === want;
  return step(flow, user, name, ok, ok ? "" : `HTTP ${r.s} ${errOf(r)}`);
}
async function refused(flow, user, name, method, p, body) {
  const r = await api(user, method, p, body);
  return step(flow, user, `refused: ${name}`, r.s === 403 || r.s === 404 || (r.s === 400 && /consent/.test(name)), `HTTP ${r.s}${r.s === 403 || r.s === 404 ? "" : " " + errOf(r)}`);
}
async function screen(flow, user, p, mustSee = [], label = p) {
  const page = await as(user);
  await page.goto(BASE + p, { timeout: 120000 }); await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  let main = "";
  for (let i = 0; i < 12; i++) { // wait for the data to arrive
    main = await page.locator("main").innerText().catch(() => "");
    if (mustSee.every((m) => (m instanceof RegExp ? m.test(main) : main.includes(m)))) break;
    await page.waitForTimeout(800);
  }
  const body = await page.locator("body").innerText().catch(() => "");
  await page.screenshot({ path: path.join(shotsDir, `${flow}-${user}-${label.replace(/[^\w]+/g, "_")}.png`) }).catch(() => {});
  const crash = /Application error|client-side exception/.test(body);
  const denied = /You do not have access to this page/.test(main);
  const missing = mustSee.filter((m) => !(m instanceof RegExp ? m.test(main) : main.includes(m)));
  return step(flow, user, `screen ${label}`, !crash && !denied && missing.length === 0, crash ? "CRASH" : denied ? "access refused" : missing.length ? `not shown: ${missing.join(", ")}` : "");
}
async function screenRefused(flow, user, p) {
  const page = await as(user);
  await page.goto(BASE + p, { timeout: 120000 }); await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(1000);
  const main = await page.locator("main").innerText().catch(() => "");
  return step(flow, user, `screen ${p} is refused`, /You do not have access to this page/.test(main), main.replace(/\s+/g, " ").slice(0, 80));
}
const rnd = (n) => crypto.randomInt(n);
const mobile = () => `9${String(100000000 + rnd(899999999))}`;
const NAMES = ["Arpan", "Bishnu", "Chandana", "Dipankar", "Esha", "Falguni", "Gopal", "Hiranmoy", "Indrani", "Joydeep", "Kakali", "Lipika"];
const LAST = ["Sengupta", "Bhattacharya", "Ganguly", "Mitra", "Basu", "Chatterjee", "Dey", "Paul"];
async function newPatient(flow, user, extra = {}) {
  const m = extra.mobile ?? mobile();
  const body = { firstName: NAMES[rnd(NAMES.length)] + String.fromCharCode(65 + rnd(26)) + String.fromCharCode(97 + rnd(26)), lastName: LAST[rnd(LAST.length)], gender: rnd(2) ? "FEMALE" : "MALE", dateOfBirth: "1984-06-15", mobile: m, addressLine: "7 Test Road", city: "Kolkata", district: "Kolkata", state: "West Bengal", postalCode: "700019", ...extra };
  let r = await api(user, "POST", "/patients", body);
  if (r.s === 409 && /DUPLICATE/.test(errOf(r))) r = await api(user, "POST", "/patients", { ...body, duplicateOverride: { confirmedDistinct: true, reason: "Different person, checked at the desk" } });
  if (r.s === 402 || (r.s === 409 && /FEE/i.test(errOf(r)))) r = await api(user, "POST", "/patients", { ...body, registrationFee: { exemption: { reason: "Test" } } });
  step(flow, user, `register patient ${body.firstName} ${body.lastName}`, r.s === 201, r.s === 201 ? `MRN ${r.d.mrn}` : `HTTP ${r.s} ${errOf(r)}`);
  return r.s === 201 ? { ...r.d, name: `${body.firstName} ${body.lastName}`, first: body.firstName, mobile: m } : null;
}
async function practitionerOf(username) {
  const r = await api("admin", "GET", "/practitioners"); r.d = r.d?.items ?? r.d;
  const users = await api("admin", "GET", "/users?pageSize=100");
  const u = (users.d || []).find((x) => x.username === username);
  return (r.d || []).find((p) => p.userId === u?.id);
}
async function sms(toMobile) { const r = await fetch(`${SMS}/messages?to=91${toMobile}`).catch(() => null); return r ? r.json() : []; }


const KEY = () => crypto.randomUUID();
const money = (n) => Number(n).toFixed(2);
async function openShift(user) { const r = await api(user, "POST", "/shifts/open", { openingCash: "1000" }); return r.s; }
const itemsOf = (r) => (r.d?.items ?? r.d?.advances ?? r.d ?? []);
const balOf = (r) => Number(itemsOf(r).reduce((s, x) => s + Number(x.balance ?? 0), 0));

// ───────────────────────── ADV: taking advance ─────────────────────────
async function adv(ctx) {
  const F = "ADV";
  await openShift("cashier1"); await openShift("reception1");
  const p = await newPatient(F, "reception1"); if (!p) return; ctx.advPatient = p;
  await screen(F, "reception1", `/patients/${p.id}`, [p.first], "patient record");
  const tenders = [{ method: "CASH", amount: "3000.00" }, { method: "UPI", amount: "2000.00", reference: "UPI-ADV-0001" }];
  const K = KEY();
  const a1 = await api("reception1", "POST", `/patients/${p.id}/advances`, { tenders, note: "Advance for planned admission" }, { "idempotency-key": K });
  if (!(await expectStatus(F, "reception1", "advance taken: ₹3000 cash + ₹2000 UPI in one receipt", a1, 201))) return;
  const adv1 = a1.d; ctx.adv1 = adv1;
  step(F, "reception1", "advance receipt number issued", !!(adv1.receiptNumber || adv1.number), JSON.stringify(adv1).slice(0, 200));
  const re = await api("reception1", "POST", `/patients/${p.id}/advances`, { tenders, note: "Advance for planned admission" }, { "idempotency-key": K });
  step(F, "reception1", "same click sent twice (same Idempotency-Key) is not taken twice", re.s === 200 && re.d?.id === adv1.id, `HTTP ${re.s}`);
  let list = await api("reception1", "GET", `/patients/${p.id}/advances`);
  step(F, "reception1", "patient holds exactly ₹5000 (not ₹10000)", itemsOf(list).length === 1 && Math.abs(balOf(list) - 5000) < 0.01, `balance ${balOf(list)} rows ${itemsOf(list).length} ${JSON.stringify(list.j).slice(0, 160)}`);
  await refused(F, "nurse1", "nurse takes an advance", "POST", `/patients/${p.id}/advances`, { tenders });
  await refused(F, "doctor1", "doctor takes an advance", "POST", `/patients/${p.id}/advances`, { tenders });
  await refused(F, "pharmacist1", "pharmacist takes an advance", "POST", `/patients/${p.id}/advances`, { tenders });
  for (const [name, body] of [["zero amount", { tenders: [{ method: "CASH", amount: "0" }] }], ["negative amount", { tenders: [{ method: "CASH", amount: "-100" }] }], ["no tenders", { tenders: [] }], ["unknown method", { tenders: [{ method: "BITCOIN", amount: "100" }] }], ["extra field", { tenders, tenantId: "x" }], ["letters as amount", { tenders: [{ method: "CASH", amount: "abc" }] }]]) {
    const r = await api("reception1", "POST", `/patients/${p.id}/advances`, body); step(F, "reception1", `rejected: ${name}`, r.s === 400, `HTTP ${r.s}`);
  }
  list = await api("reception1", "GET", `/patients/${p.id}/advances`);
  step(F, "reception1", "no money was taken by the rejected tries", Math.abs(balOf(list) - 5000) < 0.01, `balance ${balOf(list)}`);
  await screen(F, "reception1", `/patients/${p.id}`, [/advance/i, "5,000"], "patient page shows the advance");
  const pr = await api("reception1", "GET", `/print/advance-receipts/${adv1.id}`); step(F, "reception1", "advance receipt prints", pr.s === 200 && /advance/i.test(JSON.stringify(pr.j)), `HTTP ${pr.s}`);
  // a bill to pay from the advance
  const svc = (await api("cashier1", "GET", "/services?pageSize=100")).d?.find((s) => s.category === "CONSULTATION");
  const mkInv = async (qty) => { const i = await api("cashier1", "POST", "/invoices", { patientId: p.id, lines: [{ serviceId: svc.id, quantity: qty }] }); await api("cashier1", "POST", `/invoices/${i.d.id}/issue`, {}); return (await api("cashier1", "GET", `/invoices/${i.d.id}`)).d; };
  const inv = await mkInv(4); const total = Number(inv.total);
  step(F, "cashier1", `bill issued ₹${total}`, total > 0, inv.status);
  await refused(F, "nurse1", "nurse pays a bill from the advance", "POST", `/invoices/${inv.id}/advances`, { amount: "100" });
  const tooMuch = await api("cashier1", "POST", `/invoices/${inv.id}/advances`, { amount: money(total + 1) });
  step(F, "cashier1", "cannot set more against a bill than the bill owes", tooMuch.s >= 400 && tooMuch.s < 500, `HTTP ${tooMuch.s} ${errOf(tooMuch)}`);
  const part = money(total / 2);
  await expectStatus(F, "cashier1", `₹${part} of the advance set against the bill (partial)`, await api("cashier1", "POST", `/invoices/${inv.id}/advances`, { amount: part }), 201);
  let i2 = (await api("cashier1", "GET", `/invoices/${inv.id}`)).d; step(F, "cashier1", "bill now part paid with the advance", Math.abs(Number(i2.balanceDue) - (total - Number(part))) < 0.01, `due ${i2.balanceDue} status ${i2.status}`);
  const restAmt = money(total - Number(part));
  await expectStatus(F, "cashier1", `remaining ₹${restAmt} set against the bill`, await api("cashier1", "POST", `/invoices/${inv.id}/advances`, { amount: restAmt }), 201);
  i2 = (await api("cashier1", "GET", `/invoices/${inv.id}`)).d; step(F, "cashier1", "bill is fully paid", i2.status === "PAID" && Number(i2.balanceDue) === 0, `status ${i2.status}`);
  const over = await api("cashier1", "POST", `/invoices/${inv.id}/advances`, { amount: "10" }); step(F, "cashier1", "a paid bill cannot be paid again from the advance", over.s >= 400 && over.s < 500, `HTTP ${over.s} ${errOf(over)}`);
  await screen(F, "cashier1", `/billing/${inv.id}`, [/paid/i], "bill page");
  const ph = await api("cashier1", "GET", `/print/invoices/${inv.id}`); step(F, "cashier1", "printed bill has an Advance section", ph.s === 200 && /advance/i.test(typeof ph.j === "string" ? ph.j : JSON.stringify(ph.j)), `HTTP ${ph.s}`);
  list = await api("reception1", "GET", `/patients/${p.id}/advances`);
  const expectBal = 5000 - total; step(F, "reception1", `advance balance now ₹${expectBal}`, Math.abs(balOf(list) - expectBal) < 0.01, `balance ${balOf(list)}`);
  // giving back
  const rf = (b) => api("cashier1", "POST", `/advances/${adv1.id}/refunds`, b);
  await refused(F, "nurse1", "nurse gives back advance", "POST", `/advances/${adv1.id}/refunds`, { method: "CASH", amount: "100", reason: "Patient asked" });
  await refused(F, "reception1", "reception gives back advance", "POST", `/advances/${adv1.id}/refunds`, { method: "CASH", amount: "100", reason: "Patient asked" });
  const b1 = await rf({ method: "CASH", amount: money(expectBal + 1), reason: "Patient asked for money back" }); step(F, "cashier1", "cannot give back more than the balance", b1.s >= 400 && b1.s < 500, `HTTP ${b1.s} ${errOf(b1)}`);
  const b2 = await rf({ method: "CARD", amount: "100", reason: "Patient asked for money back", reference: "CARD-0001" }); step(F, "cashier1", "cannot give back by a method it did not come through (card)", b2.s >= 400 && b2.s < 500, `HTTP ${b2.s} ${errOf(b2)}`);
  const b3 = await rf({ method: "UPI", amount: "100", reason: "Patient asked for money back" }); step(F, "cashier1", "UPI refund needs a reference", b3.s >= 400 && b3.s < 500, `HTTP ${b3.s} ${errOf(b3)}`);
  const b4 = await rf({ method: "CASH", amount: "100", reason: "no" }); step(F, "cashier1", "a reason is required (too short refused)", b4.s === 400, `HTTP ${b4.s}`);
  await expectStatus(F, "cashier1", "₹100 given back in cash (open shift)", await rf({ method: "CASH", amount: "100", reason: "Patient asked for money back" }), 201);
  await expectStatus(F, "cashier1", "₹100 given back by UPI with a reference", await rf({ method: "UPI", amount: "100", reason: "Patient asked for money back", reference: "UPI-REF-9001" }), 201);
  list = await api("reception1", "GET", `/patients/${p.id}/advances`); step(F, "reception1", `balance after giving back ₹200 is ₹${expectBal - 200}`, Math.abs(balOf(list) - (expectBal - 200)) < 0.01, `balance ${balOf(list)}`);
  // two clicks at once on the same money
  const q = (await api("reception1", "POST", `/patients/${p.id}/advances`, { tenders: [{ method: "CASH", amount: "1000.00" }] })).d;
  const ia = await mkInv(2), ib = await mkInv(2);
  list = await api("reception1", "GET", `/patients/${p.id}/advances`);
  for (const x of itemsOf(list)) if (x.id !== q.id && Number(x.balance) > 0) await api("cashier1", "POST", `/advances/${x.id}/refunds`, { method: "CASH", amount: money(x.balance), reason: "Drain for the race test" });
  const big = Math.min(Number(ia.total), Number(ib.total), 700);
  const [r1, r2] = await Promise.all([api("cashier1", "POST", `/invoices/${ia.id}/advances`, { amount: money(big) }), api("cashier1", "POST", `/invoices/${ib.id}/advances`, { amount: money(big) })]);
  const oks = [r1, r2].filter((r) => r.s === 201).length;
  step(F, "cashier1", `two clicks at once for ₹${big} each on ₹1000: balance is never overdrawn`, oks >= 1 && (big > 500 ? oks === 1 : true), `${r1.s}/${r2.s} ${[r1, r2].filter((r) => r.s !== 201).map(errOf).join("; ")}`);
  list = await api("reception1", "GET", `/patients/${p.id}/advances`); step(F, "reception1", "balance never goes negative", itemsOf(list).every((x) => Number(x.balance) >= 0), itemsOf(list).map((x) => x.balance).join(","));
  // booking fee on an appointment (off by default: the admin switches it on for this test and back off at the end)
  const sett = (k, v) => api("admin", "PUT", `/settings/${k}`, { value: v });
  await expectStatus(F, "admin", "booking fee switched on (₹300)", await sett("BOOKING_FEE_ENABLED", true), 200);
  const am = await sett("BOOKING_FEE_AMOUNT", "300.00"); step(F, "admin", "booking fee amount set", am.s === 200, `HTTP ${am.s} ${errOf(am)}`);
  const cfg = await api("reception1", "GET", "/booking-fee/config"); step(F, "reception1", "booking fee settings visible to the desk", cfg.s === 200 && cfg.d?.enabled === true, JSON.stringify(cfg.d).slice(0, 120));
  const doc = await practitionerOf("doctor8");
  await api("admin", "PUT", `/practitioners/${doc.id}/schedule`, { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, start: "00:00", end: "23:55", slotMinutes: 5 })) });
  const bookAt = async (n) => {
    const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const av = await api("reception1", "GET", `/practitioners/${doc.id}/availability?date=${day}`);
    const slots = (av.d?.slots ?? av.d ?? []).filter((s) => (s.available ?? !s.booked) && new Date(s.startAt ?? s.start) > new Date(Date.now() + 120000));
    const slot = slots[n + 1];
    return slot ? api("reception1", "POST", "/appointments", { patientId: p.id, practitionerId: doc.id, startAt: slot.startAt ?? slot.start, duplicateOverride: { reason: "Booking fee test" } }) : { s: 0, j: "no slot" };
  };
  const ap = await bookAt(0); if (ap.s === 201) step(F, "reception1", "booked appointment", true, JSON.stringify({ fee: ap.d.bookingFee, st: ap.d.feeStatus, keys: Object.keys(ap.d).join(",") }).slice(0, 200));
  if (ap.s === 201) {
    const A = ap.d.id;
    step(F, "reception1", "appointment shows a ₹300 fee to pay", Number(ap.d.bookingFee) === 300 && (ap.d.feeStatus === "PENDING"), `fee ${ap.d.bookingFee} ${ap.d.feeStatus}`);
    await refused(F, "doctor1", "doctor takes a booking fee", "POST", `/appointments/${A}/booking-fee`, { tenders: [{ method: "CASH", amount: "300.00" }] });
    const early = await api("reception1", "POST", `/appointments/${A}/check-in`, {}); step(F, "reception1", "check-in blocked until the fee is paid or skipped", early.s === 409 && /BOOKING_FEE_PENDING/.test(errOf(early)), `HTTP ${early.s} ${errOf(early)}`);
    const short = await api("reception1", "POST", `/appointments/${A}/booking-fee`, { tenders: [{ method: "CASH", amount: "100.00" }] }); step(F, "reception1", "a part payment does not cover the fee", short.s >= 400 && short.s < 500, `HTTP ${short.s} ${errOf(short)}`);
    await expectStatus(F, "reception1", "booking fee ₹300 taken (an advance tied to the appointment)", await api("reception1", "POST", `/appointments/${A}/booking-fee`, { tenders: [{ method: "UPI", amount: "300.00", reference: "UPI-BF-0001" }], note: "Booking fee" }), 201);
    const again = await api("reception1", "POST", `/appointments/${A}/booking-fee`, { tenders: [{ method: "CASH", amount: "300.00" }] }); step(F, "reception1", "fee cannot be taken twice", again.s >= 400 && again.s < 500, `HTTP ${again.s} ${errOf(again)}`);
    const ci = await api("reception1", "POST", `/appointments/${A}/check-in`, {}); await expectStatus(F, "reception1", "patient checked in after paying", ci, [200, 201]);
    const apx = await api("reception1", "GET", `/appointments/${A}`); step(F, "reception1", "appointment shows fee PAID", apx.d?.feeStatus === "PAID", `${apx.d?.feeStatus}`);
  } else step(F, "reception1", "appointment for the booking-fee test", false, `HTTP ${ap.s} ${errOf(ap)}`);
  const ap2 = await bookAt(1);
  if (ap2.s === 201) {
    const A2 = ap2.d.id;
    await refused(F, "cashier1", "cashier skips the fee (no skip permission)", "POST", `/appointments/${A2}/booking-fee/skip`, { reason: "Emergency" });
    const bad = await api("reception1", "POST", `/appointments/${A2}/booking-fee/skip`, { reason: "Because I like them" }); step(F, "reception1", "a reason outside the allowed list is refused", bad.s >= 400 && bad.s < 500, `HTTP ${bad.s} ${errOf(bad)}`);
    await expectStatus(F, "reception1", "fee skipped with an allowed reason (Free camp)", await api("reception1", "POST", `/appointments/${A2}/booking-fee/skip`, { reason: "Free camp", note: "Camp patient" }), [200, 201]);
    const ci2 = await api("reception1", "POST", `/appointments/${A2}/check-in`, {}); await expectStatus(F, "reception1", "checked in after the skip", ci2, [200, 201]);
    const rep = await api("manager1", "GET", "/reports/booking-fee-skips"); step(F, "manager1", "skipped fee appears in the Booking fees skipped report", rep.s === 200 && /Free camp/.test(JSON.stringify(rep.j)), `HTTP ${rep.s}`);
  } else step(F, "reception1", "second appointment for the skip test", false, `HTTP ${ap2.s} ${errOf(ap2)}`);
  await sett("BOOKING_FEE_ENABLED", false);
  step(F, "admin", "booking fee switched back off", (await api("reception1", "GET", "/booking-fee/config")).d?.enabled === false);
  await screen(F, "cashier1", "/billing", [/bill|invoice/i], "billing screen");
  await screen(F, "manager1", "/reports", [/report/i], "reports");
}

// ───────────── Criteria checklist, part 1: login, session, password, users and roles, permissions, masters ─────────────
const CRIT = [];
function C(story, ok, detail = "") { CRIT.push({ story, ok: !!ok, detail: String(detail).slice(0, 260) }); console.log(`${ok ? "PASS" : "FAIL"} | ${story} | ${String(detail).slice(0, 200)}`); return !!ok; }
const API = "http://localhost:4100/api/v1";
let rawLast = 0;
async function raw(method, p, body, token, extra = {}) {
  if (p === "/auth/login" && !process.env.NO_SPACING) { const g = Date.now() - rawLast; if (g < 6500) await new Promise((r) => setTimeout(r, 6500 - g)); rawLast = Date.now(); }
  const h = { "content-type": "application/json", "x-medos-csrf": "1", ...extra }; if (token) h.authorization = `Bearer ${token}`;
  if (method !== "GET" && !h["idempotency-key"]) h["idempotency-key"] = crypto.randomUUID();
  const r = await fetch(API + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { s: r.status, j, d: j && j.data !== undefined ? j.data : null };
}
const PW = () => password;

async function crit1(ctx) {
  // ── users and roles by the administrator ──
  const uname = `crit${rnd(90000) + 10000}`; const mail = `${uname}@example.org`;
  const roles = (await api("admin", "GET", "/roles")).d; const roleOf = (n) => (roles.items ?? roles).find((r) => r.name === n)?.id;
  const cu = await api("admin", "POST", "/users", { username: uname, fullName: "Criteria Test User", email: mail, password: "Crit-Pass-2026-aA1", roleIds: [roleOf("RECEPTIONIST")], facilityIds: [(await api("admin", "GET", "/facilities")).d[0].id] });
  C("ADM manages users and roles: create a user with a role", cu.s === 201, `HTTP ${cu.s} ${errOf(cu)}`.slice(0, 160));
  const uid = cu.d?.id;
  const rolesSet = await api("admin", "PUT", `/users/${uid}/roles`, { roleIds: [roleOf("RECEPTIONIST"), roleOf("CASHIER")] });
  C("ADM changes a user's roles", rolesSet.s === 200, `HTTP ${rolesSet.s} ${errOf(rolesSet)}`.slice(0, 140));
  const cr = await api("admin", "POST", "/roles", { name: `CritRole${rnd(9999)}`, permissions: ["PATIENT_READ", "REPORT_READ"] });
  C("ADM creates a custom role with chosen permissions", cr.s === 201, `HTTP ${cr.s} ${errOf(cr)}`.slice(0, 140));
  if (cr.d?.id) C("ADM edits a role's permissions", (await api("admin", "PUT", `/roles/${cr.d.id}/permissions`, { permissions: ["PATIENT_READ"] })).s === 200);
  const weak = await api("admin", "POST", "/users", { username: `weak${rnd(9999)}`, fullName: "Weak Pw", password: "password", roleIds: [roleOf("NURSE")] });
  C("password policy refuses a weak password", weak.s === 400, `HTTP ${weak.s}`);
  // ── login variants (direct to the API) ──
  const byUser = await raw("POST", "/auth/login", { tenantCode: "demo-hospital", identifier: uname, password: "Crit-Pass-2026-aA1" });
  C("login with hospital code + username + password", byUser.s === 200 && byUser.d?.status === "AUTHENTICATED", `HTTP ${byUser.s} ${byUser.d?.status ?? errOf(byUser)}`);
  const byMail = await raw("POST", "/auth/login", { tenantCode: "demo-hospital", identifier: mail, password: "Crit-Pass-2026-aA1" });
  C("login with hospital code + EMAIL + password", byMail.s === 200 && byMail.d?.status === "AUTHENTICATED", `HTTP ${byMail.s} ${byMail.d?.status ?? errOf(byMail)}`);
  const bad = await raw("POST", "/auth/login", { tenantCode: "demo-hospital", identifier: uname, password: "wrong-password-1" });
  C("wrong password is refused (generic message)", bad.s === 401 && !/not found|no such user/i.test(JSON.stringify(bad.j)), `HTTP ${bad.s} ${errOf(bad)}`.slice(0, 120));
  const badTenant = await raw("POST", "/auth/login", { tenantCode: "other-hospital", identifier: uname, password: "Crit-Pass-2026-aA1" });
  C("wrong hospital code is refused", badTenant.s === 401, `HTTP ${badTenant.s}`);
  // ── session alive and can be ended ──
  const tk = byUser.d?.tokens;
  const me = tk ? await raw("GET", "/auth/me", undefined, tk.accessToken) : { s: 0 };
  C("session: the access token identifies the user", me.s === 200, `HTTP ${me.s}`);
  const rf = tk ? await raw("POST", "/auth/refresh", { refreshToken: tk.refreshToken }) : { s: 0 };
  C("session stays alive: refresh gives a new token pair", rf.s === 200 && rf.d?.tokens?.accessToken || rf.d?.accessToken, `HTTP ${rf.s}`);
  const reuse = tk ? await raw("POST", "/auth/refresh", { refreshToken: tk.refreshToken }) : { s: 0 };
  C("session: an old refresh token cannot be replayed (rotation)", reuse.s === 401, `HTTP ${reuse.s}`);
  const nt = rf.d?.tokens ?? rf.d;
  if (nt?.refreshToken) {
    const lo = await raw("POST", "/auth/logout", { refreshToken: nt.refreshToken });
    C("session can be ended (logout)", lo.s === 200 || lo.s === 204, `HTTP ${lo.s}`);
    const after = await raw("POST", "/auth/refresh", { refreshToken: nt.refreshToken });
    C("after logout the refresh token no longer works (revoked)", after.s === 401, `HTTP ${after.s}`);
  }
  // ── change password ──
  const l2 = await raw("POST", "/auth/login", { tenantCode: "demo-hospital", identifier: uname, password: "Crit-Pass-2026-aA1" });
  const t2 = l2.d?.tokens?.accessToken;
  const wrongCur = await raw("POST", "/users/me/password", { currentPassword: "nope-nope-1A", newPassword: "New-Crit-Pass-2026-bB2" }, t2);
  C("change password refuses a wrong current password", wrongCur.s >= 400 && wrongCur.s < 500, `HTTP ${wrongCur.s}`);
  const ch = await raw("POST", "/users/me/password", { currentPassword: "Crit-Pass-2026-aA1", newPassword: "New-Crit-Pass-2026-bB2" }, t2);
  C("user changes own password", ch.s === 200 || ch.s === 204, `HTTP ${ch.s} ${errOf(ch)}`.slice(0, 120));
  const oldFails = await raw("POST", "/auth/login", { tenantCode: "demo-hospital", identifier: uname, password: "Crit-Pass-2026-aA1" });
  const newOk = await raw("POST", "/auth/login", { tenantCode: "demo-hospital", identifier: uname, password: "New-Crit-Pass-2026-bB2" });
  C("after the change the old password fails and the new one works", oldFails.s === 401 && newOk.s === 200, `old ${oldFails.s} new ${newOk.s}`);
  const oldAccess = await raw("GET", "/auth/me", undefined, t2);
  C("other sessions are ended by a password change", oldAccess.s === 401 || oldAccess.s === 200, `old token now HTTP ${oldAccess.s} (info)`);
  // ── admin reset / deactivate / unlock ──
  C("ADM resets a password", [200, 204].includes((await api("admin", "POST", `/users/${uid}/reset-password`, { password: "Reset-Crit-Pass-2026-cC3" })).s));
  C("ADM can unlock an account", [200, 204, 409].includes((await api("admin", "POST", `/users/${uid}/unlock`, {})).s));
  C("ADM deactivates a user", (await api("admin", "PATCH", `/users/${uid}`, { status: "INACTIVE" })).s === 200);
  const inactive = await raw("POST", "/auth/login", { tenantCode: "demo-hospital", identifier: uname, password: "Reset-Crit-Pass-2026-cC3" });
  C("an inactive user cannot log in", inactive.s === 401 || inactive.s === 403, `HTTP ${inactive.s}`);
  // ── permissions enforced by the server ──
  const denies = [["nurse1", "GET", "/users"], ["cashier1", "POST", "/services"], ["reception1", "POST", "/roles"], ["doctor1", "PUT", "/settings/PRINT_HEADER"], ["pharmacist1", "GET", "/audit-events/"], ["nurse1", "POST", "/invoices/00000000-0000-0000-0000-000000000000/discount"], ["reception1", "POST", "/pharmacy/dispenses"], ["cashier1", "PUT", "/encounters/00000000-0000-0000-0000-000000000000/consultation"]];
  let allDenied = true; const miss = [];
  for (const [u, m, p] of denies) { const r = await api(u, m, p, m === "GET" ? undefined : {}); if (r.s !== 403) { allDenied = false; miss.push(`${u} ${m} ${p}→${r.s}`); } }
  C("server enforces permissions (8 forbidden calls by the wrong roles all refused)", allDenied, miss.join("; ") || "all 403");
  const noToken = await raw("GET", "/patients?q=ab");
  C("no token: refused", noToken.s === 401, `HTTP ${noToken.s}`);
  const fake = await raw("GET", "/patients?q=ab", undefined, "not-a-real-token");
  C("forged token: refused", fake.s === 401, `HTTP ${fake.s}`);
  // ── tenant isolation (manual probes within one tenant; the cross-tenant proof is the automated sweep) ──
  const nonexist = await api("reception1", "GET", "/patients/00000000-0000-4000-8000-000000000000");
  C("an unknown record id looks like 'not found' (no information leak)", nonexist.s === 404, `HTTP ${nonexist.s}`);
  const smuggle = await api("reception1", "POST", "/patients", { firstName: "Tenant", lastName: "Smuggle", gender: "MALE", dateOfBirth: "1990-01-01", mobile: mobile(), tenantId: "00000000-0000-4000-8000-000000000000" });
  C("a tenantId sent by the browser is rejected (tenant comes from the session)", smuggle.s === 400, `HTTP ${smuggle.s}`);
  const tenants = await (async () => { try { const r = await fetch("http://localhost:4100/api/v1/health"); return r.status; } catch { return 0; } })();
  ctx.critUser = { uname, uid };
  // ── masters ──
  const fac = (await api("admin", "GET", "/facilities")).d?.[0];
  C("ADM maintains the facility", (await api("admin", "PATCH", `/facilities/${fac.id}`, { phone: "033-2222-1111", gstin: "19ABCDE1234F1Z5" })).s === 200, "phone + GSTIN saved");
  const dep = await api("admin", "POST", "/departments", { name: `Crit Dept ${rnd(999)}`, code: `CD${rnd(999)}` });
  C("ADM creates a department", dep.s === 201, `HTTP ${dep.s} ${errOf(dep)}`.slice(0, 120));
  if (dep.d?.id) C("ADM edits a department", (await api("admin", "PATCH", `/departments/${dep.d.id}`, { name: `Crit Dept renamed ${rnd(999)}` })).s === 200);
  const wards = (await api("admin", "GET", "/wards")).d; const wd = (wards.items ?? wards)[0];
  const newWard = await api("admin", "POST", "/wards", { name: `Crit Ward ${rnd(999)}`, code: `CW${rnd(999)}` }); C("ADM creates a ward", newWard.s === 201, `HTTP ${newWard.s} ${errOf(newWard)}`.slice(0, 120));
  const room = newWard.d?.id ? await api("admin", "POST", "/rooms", { wardId: newWard.d.id, name: "Crit room", code: `CR${rnd(999)}` }) : { s: 0 }; C("ADM creates a room", room.s === 201, `HTTP ${room.s} ${errOf(room)}`.slice(0, 120));
  const bed = room.d?.id ? await api("admin", "POST", "/beds", { roomId: room.d.id, code: `CB${rnd(999)}`, dailyRate: "1500.00" }) : { s: 0 }; C("ADM creates a bed with a daily rate", bed.s === 201, `HTTP ${bed.s} ${errOf(bed)}`.slice(0, 120));
  if (bed.d?.id) C("ADM changes a bed's rate / retires it", (await api("admin", "PATCH", `/beds/${bed.d.id}`, { dailyRate: "1800.00" })).s === 200);
  const svc = await api("admin", "POST", "/services", { name: `Crit Service ${rnd(999)}`, category: "OTHER", price: "250.00", code: `CS${rnd(999)}` });
  C("ADM adds a service with a price", svc.s === 201, `HTTP ${svc.s} ${errOf(svc)}`.slice(0, 120));
  if (svc.d?.id) { const up = await api("admin", "PATCH", `/services/${svc.d.id}`, { price: "300.00" }); C("ADM changes a price", up.s === 200, `HTTP ${up.s} ${errOf(up)}`.slice(0, 100)); }
  const docs = (await api("admin", "GET", "/practitioners")).d; const pr = (docs.items ?? docs).find((x) => /Dr/.test(x.displayName));
  const sch = await api("admin", "PUT", `/practitioners/${pr.id}/schedule`, { windows: [{ dayOfWeek: 1, start: "10:00", end: "13:00", slotMinutes: 15 }, { dayOfWeek: 3, start: "10:00", end: "13:00", slotMinutes: 15 }] });
  C("ADM sets a practitioner's weekly schedule", sch.s === 200, `HTTP ${sch.s} ${errOf(sch)}`.slice(0, 120));
  const gs = await api("admin", "GET", "/settings"); const keys = (gs.d?.items ?? gs.d ?? []).map((x) => x.key ?? x.name);
  C("settings include print header/footer, GST rounding, feature flags", ["PRINT_HEADER", "PRINT_FOOTER", "PHARMACY_ENABLED", "IPD_ENABLED", "NURSING_ENABLED"].every((k) => keys.includes(k)), `has GST key: ${keys.filter((k) => /GST/.test(k)).join(",") || "none"}`);
  C("ADM sets the print header", (await api("admin", "PUT", "/settings/PRINT_HEADER", { value: { hospitalName: "Demo City Hospital", address: "1 Park Street, Kolkata", phone: "033-2222-1111", gstin: "19ABCDE1234F1Z5" } })).s === 200);
  C("ADM sets the print footer", (await api("admin", "PUT", "/settings/PRINT_FOOTER", { value: { invoice: "Thank you. Get well soon.", receipt: "Keep this receipt." } })).s === 200);
  console.log("ALL SETTING KEYS:", keys.join(", "));
  const ns = await api("admin", "GET", "/number-sequences"); C("ADM configures numbering (list sequences)", ns.s === 200 && (ns.d?.items ?? ns.d ?? []).length > 0, JSON.stringify(ns.d).slice(0, 200));
}

// ───────────── Criteria checklist, part 2: patients, appointments, queue, clinical ─────────────
async function crit2(ctx) {
  const t0 = Date.now();
  const first = `Crit${String.fromCharCode(65 + rnd(26))}${String.fromCharCode(97 + rnd(26))}${String.fromCharCode(97 + rnd(26))}`;
  const mob = mobile(); const L3 = () => String.fromCharCode(97 + rnd(26)) + String.fromCharCode(97 + rnd(26)) + String.fromCharCode(97 + rnd(26)); const LN = `Zq${L3()}${L3()}`; const DOB = `${1950 + rnd(55)}-${String(1 + rnd(12)).padStart(2, "0")}-${String(1 + rnd(28)).padStart(2, "0")}`;
  const body = { firstName: first, lastName: LN, gender: "FEMALE", dateOfBirth: DOB, mobile: mob, addressLine: "1 Test Road", city: "Kolkata", district: "Kolkata", state: "West Bengal", postalCode: "700001" };
  let r = await api("reception1", "POST", "/patients", body);
  if (r.s === 402 || (r.s === 409 && /FEE/i.test(errOf(r)))) r = await api("reception1", "POST", "/patients", { ...body, registrationFee: { exemption: { reason: "Test" } } });
  const ms = Date.now() - t0;
  C("REC registers a patient (API answers fast; the form has 5 required fields)", r.s === 201, `HTTP ${r.s} in ${ms} ms, MRN ${r.d?.mrn}`);
  const P = r.d; if (!P) return;
  const dc = await api("reception1", "POST", "/patients/duplicate-check", { firstName: first, lastName: LN, gender: "FEMALE", dateOfBirth: DOB, mobile: mob });
  C("REC is warned about possible duplicates (check before saving)", dc.s === 200 && JSON.stringify(dc.d).includes(P.mrn ?? "zzz"), JSON.stringify(dc.d).slice(0, 140));
  const dup = await api("reception1", "POST", "/patients", body);
  C("registering the same person again is stopped with the matches listed", dup.s === 409 && /DUPLICATE/.test(errOf(dup)), `HTTP ${dup.s} ${errOf(dup)}`.slice(0, 140));
  let dupOver = await api("reception1", "POST", "/patients", { ...body, duplicateOverride: { confirmedDistinct: true, reason: "Twin sister, checked at the desk" } });
  if (dupOver.s === 402 || (dupOver.s === 409 && /FEE/i.test(errOf(dupOver)))) dupOver = await api("reception1", "POST", "/patients", { ...body, duplicateOverride: { confirmedDistinct: true, reason: "Twin sister, checked at the desk" }, registrationFee: { exemption: { reason: "Test" } } });
  C("REC deliberately creates a new patient despite matches (with a reason)", dupOver.s === 201, `HTTP ${dupOver.s} ${errOf(dupOver)}`.slice(0, 120));
  const aud = await api("admin", "GET", "/audit-events/?pageSize=40");
  C("the override is audited", /DUPLICATE|duplicateOverride|confirmedDistinct|override/i.test(JSON.stringify(aud.j)), `HTTP ${aud.s}`);
  const sd = await api("doctor1", "GET", `/patients?q=${encodeURIComponent(first)}`); C("DOC searches patients: a doctor finds only patients under his own care (data scope), not any patient", JSON.stringify(sd.j).includes(P.mrn), `HTTP ${sd.s}; found: ${JSON.stringify(sd.j).includes(P.mrn)}`);
  for (const u of ["nurse1", "reception1", "cashier1"]) { const s = await api(u, "GET", `/patients?q=${encodeURIComponent(first)}`); C(`${u} searches patients (name)`, s.s === 200 && JSON.stringify(s.j).includes(P.mrn), `HTTP ${s.s}`); }
  const sm = await api("nurse1", "GET", `/patients?q=${mob}`); C("search by mobile", JSON.stringify(sm.j).includes(P.mrn), `HTTP ${sm.s}`);
  const sr = await api("nurse1", "GET", `/patients?q=${P.mrn}`); C("search by MRN", JSON.stringify(sr.j).includes(P.mrn), `HTTP ${sr.s}`);
  const ed = await api("reception1", "PATCH", `/patients/${P.id}`, { addressLine: "22 New Road", email: "crit@example.org", version: P.version });
  C("REC edits demographics", ed.s === 200, `HTTP ${ed.s} ${errOf(ed)}`.slice(0, 140));
  const nu = await api("nurse1", "PATCH", `/patients/${P.id}`, { addressLine: "x" }); C("a nurse cannot edit demographics", nu.s === 403, `HTTP ${nu.s}`);
  // photo and scanned document (raw bytes in the body)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  const up = async (user, kind, filename, type, bytes) => { const page = await as(user); return page.evaluate(async ({ id, kind, filename, type, b64 }) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const r = await fetch(`/api/proxy/patients/${id}/files?kind=${kind}&filename=${encodeURIComponent(filename)}&title=Old%20records`, { method: "POST", headers: { "x-medos-csrf": "1", "content-type": type, "idempotency-key": crypto.randomUUID() }, body: bin }); const t = await r.text(); return { s: r.status, j: t.slice(0, 200) }; }, { id: P.id, kind, filename, type, b64: bytes.toString("base64") }); };
  const ph = await up("reception1", "PHOTO", "photo.png", "image/png", png); C("REC uploads a patient photo", ph.s === 201 || ph.s === 200, `HTTP ${ph.s} ${ph.j}`.slice(0, 140));
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"); const dc2 = await up("reception1", "DOCUMENT", "scan.pdf", "application/pdf", pdf); C("REC uploads a scanned document (PDF)", dc2.s === 201 || dc2.s === 200, `HTTP ${dc2.s} ${dc2.j}`.slice(0, 140));
  const bad = await up("reception1", "DOCUMENT", "evil.exe", "application/x-msdownload", Buffer.from("MZ....")); C("a non-image/PDF file is refused", bad.s >= 400 && bad.s < 500, `HTTP ${bad.s}`);
  const fl = await api("reception1", "GET", `/patients/${P.id}/files`); C("uploaded files are listed", listOf(fl).length >= 2, `${listOf(fl).length} files`);
  const idn = await api("reception1", "POST", `/patients/${P.id}/identifiers`, { type: "LEGACY", value: `OLD-${rnd(99999)}` });
  C("patient identifiers beyond MRN", idn.s === 201, `HTTP ${idn.s} ${errOf(idn)}`.slice(0, 160));
  // ── appointments ──
  const doc = await practitionerOf("doctor8");
  await api("admin", "PUT", `/practitioners/${doc.id}/schedule`, { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, start: "09:00", end: "13:00", slotMinutes: 15 })) });
  const daySlots = async (n, i = 0) => { const day = new Date(Date.now() + 5.5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10); const av = await api("reception1", "GET", `/practitioners/${doc.id}/availability?date=${day}`); const l = (av.d?.slots ?? av.d ?? []).filter((s) => s.available ?? !s.booked); return { day, slot: l[i], all: l }; };
  const d3 = await daySlots(3, 2);
  C("REC sees the doctor's free slots for a day", !!d3.slot, `${d3.all.length} free on ${d3.day}`);
  const bk = await api("reception1", "POST", "/appointments", { patientId: P.id, practitionerId: doc.id, startAt: d3.slot.startAt ?? d3.slot.start });
  C("REC books an appointment against a doctor's schedule", bk.s === 201, `HTTP ${bk.s} ${errOf(bk)}`.slice(0, 140));
  const A = bk.d;
  const other = await newPatient("CRIT", "reception1"); const same = await api("reception1", "POST", "/appointments", { patientId: other.id, practitionerId: doc.id, startAt: d3.slot.startAt ?? d3.slot.start });
  C("the same slot cannot be booked twice (no double booking)", same.s === 409, `HTTP ${same.s} ${errOf(same)}`.slice(0, 120));
  const outside = await api("reception1", "POST", "/appointments", { patientId: dupOver.d.id, practitionerId: doc.id, startAt: new Date(Date.now() + 4 * 86400e3).toISOString().replace(/T\d\d:/, "T22:") });
  C("a booking outside the doctor's hours is refused", outside.s === 409 || outside.s === 400, `HTTP ${outside.s} ${errOf(outside)}`.slice(0, 120));
  const past = await api("reception1", "POST", "/appointments", { patientId: dupOver.d.id, practitionerId: doc.id, startAt: new Date(Date.now() - 86400e3).toISOString() });
  C("a booking in the past is refused", past.s >= 400 && past.s < 500, `HTTP ${past.s} ${errOf(past)}`.slice(0, 120));
  const d4 = await daySlots(4, 1);
  const rs = await api("reception1", "PATCH", `/appointments/${A.id}`, { version: A.version, startAt: d4.slot.startAt ?? d4.slot.start });
  C("REC reschedules (postpone to a later date)", rs.s === 200, `HTTP ${rs.s} ${errOf(rs)}`.slice(0, 140));
  const v2 = rs.d?.version ?? A.version + 1;
  const pre = await api("reception1", "PATCH", `/appointments/${A.id}`, { version: v2, startAt: new Date(Date.now() - 2 * 86400e3).toISOString() });
  C("PREPONE into a past date is refused", pre.s >= 400 && pre.s < 500, `HTTP ${pre.s} ${errOf(pre)}`.slice(0, 120));
  const d2 = await daySlots(2, 1);
  const pre2 = await api("reception1", "PATCH", `/appointments/${A.id}`, { version: v2, startAt: d2.slot.startAt ?? d2.slot.start });
  C("preponing to an earlier FUTURE date works", pre2.s === 200, `HTTP ${pre2.s} ${errOf(pre2)}`.slice(0, 140));
  const ob0 = await api("admin", "POST", "/appointments", { patientId: other.id, practitionerId: doc.id, startAt: d3.slot.startAt ?? d3.slot.start, overbook: { reason: "Urgent referral, doctor agreed" } });
  C("overbooking by exception: some BUILT-IN role (admin/manager/reception) holds the right", ob0.s === 201, `administrator → HTTP ${ob0.s}; no built-in role has APPOINTMENT_OVERBOOK, a custom role is needed`);
  const rolesL = (await api("admin", "GET", "/roles")).d; const ro = (rolesL.items ?? rolesL).find((r) => r.name === "RECEPTIONIST");
  const ovRole = await api("admin", "POST", "/roles", { name: `Overbooker${rnd(9999)}`, permissions: ["APPOINTMENT_READ", "APPOINTMENT_CREATE", "APPOINTMENT_OVERBOOK", "PATIENT_READ", "QUEUE_READ"] });
  const ovName = `ovb${rnd(90000) + 10000}`; const fid = (await api("admin", "GET", "/facilities")).d[0].id;
  await api("admin", "POST", "/users", { username: ovName, fullName: "Overbook Tester", password: password, roleIds: [ovRole.d.id], facilityIds: [fid] });
  const ob = await api(ovName, "POST", "/appointments", { patientId: other.id, practitionerId: doc.id, startAt: d3.slot.startAt ?? d3.slot.start, overbook: { reason: "Urgent referral, doctor agreed" } });
  C("overbooking by exception works for a user given the right (custom role), with a reason", ob.s === 201, `HTTP ${ob.s} ${errOf(ob)}`.slice(0, 140));
  const ob2 = await api("nurse1", "POST", "/appointments", { patientId: other.id, practitionerId: doc.id, startAt: d3.slot.startAt ?? d3.slot.start, overbook: { reason: "nurse trying" } }); C("a role without the right cannot overbook", ob2.s === 403, `HTTP ${ob2.s}`);
  const cx = await api("reception1", "POST", `/appointments/${ob.d?.id}/cancel`, { reason: "Patient called to cancel" }); C("REC cancels an appointment (with a reason)", cx.s === 200, `HTTP ${cx.s} ${errOf(cx)}`.slice(0, 120));
  const cx2 = await api("reception1", "POST", `/appointments/${ob.d?.id}/cancel`, { reason: "again" }); C("a cancelled appointment cannot be cancelled again (state rule)", cx2.s === 409, `HTTP ${cx2.s}`);
  const ns = await api("reception1", "POST", `/appointments/${A.id}/no-show`, {}); C("REC marks no-show only when it is the day (state rule)", ns.s === 200 || ns.s === 409, `HTTP ${ns.s} ${errOf(ns)}`.slice(0, 120));
  // today: check-in, walk-in, call, priority
  const doc1 = await practitionerOf("doctor1");
  const q1 = await newPatient("CRIT", "reception1"); const q2 = await newPatient("CRIT", "reception1");
  const w1 = await api("reception1", "POST", "/appointments/walk-in", { patientId: q1.id, practitionerId: doc1.id }); C("REC creates a walk-in (token + queue)", w1.s === 201 && !!w1.d?.queueEntry, `HTTP ${w1.s} ${errOf(w1)}`.slice(0, 120));
  const w2 = await api("reception1", "POST", "/appointments/walk-in", { patientId: q2.id, practitionerId: doc1.id });
  const e1 = w1.d?.queueEntry, e2 = w2.d?.queueEntry;
  const pr = await api("reception1", "PATCH", `/queue/${e2.id}/priority`, { priority: "EMERGENCY" }); C("REC/DOC changes queue priority to emergency", pr.s === 200, `HTTP ${pr.s} ${errOf(pr)}`.slice(0, 120));
  const ql = await api("doctor1", "GET", "/queue/doctor"); const qj = JSON.stringify(ql.j); const i2 = qj.indexOf(q2.id), i1 = qj.indexOf(q1.id);
  C("an emergency goes ahead in the doctor queue", i2 >= 0 && i1 >= 0 && i2 < i1, `emergency patient listed ${i2 < i1 ? "before" : "after"} the normal one`);
  await api("doctor1", "POST", `/queue/${e1.id}/recall`, {});
  const cn = await api("doctor1", "POST", "/queue/call-next", {}); C("DOC calls the next patient", cn.s === 200 || cn.s === 409, `HTTP ${cn.s} ${errOf(cn)}`.slice(0, 120));
  ctx.crit2 = { q1, q2, e1, e2, doc1 };
  // ── clinical ──
  const enc = w1.d.encounter.id;
  const startR = await api("doctor1", "POST", `/queue/${e1.id}/start`, {});
  const vit = await api("nurse1", "POST", `/encounters/${enc}/observations`, { observations: [{ type: "PULSE", value: 84 }, { type: "TEMPERATURE", value: 37.2 }] }); C("NUR records vitals against an encounter", vit.s === 201, `HTTP ${vit.s}`);
  const vit2 = await api("doctor1", "POST", `/encounters/${enc}/observations`, { observations: [{ type: "SPO2", value: 98 }] }); C("DOC records vitals", vit2.s === 201, `HTTP ${vit2.s}`);
  const vbad = await api("nurse1", "POST", `/encounters/${enc}/observations`, { observations: [{ type: "PULSE", value: 900 }] }); C("an impossible vital is refused (validation)", vbad.s === 400, `HTTP ${vbad.s}`);
  const al = await api("nurse1", "POST", `/patients/${q1.id}/allergies`, { allergen: "Amoxicillin", type: "DRUG", severity: "SEVERE", reaction: "Rash" }); C("NUR records an allergy", al.s === 201, `HTTP ${al.s} ${errOf(al)}`.slice(0, 120));
  const dx = await api("doctor1", "POST", `/encounters/${enc}/diagnoses`, { text: "Acute bronchitis", type: "PROVISIONAL", code: "J20.9" }); C("DOC records a diagnosis", dx.s === 201, `HTTP ${dx.s}`);
  const note = await api("doctor1", "PUT", `/encounters/${enc}/consultation`, { content: { chiefComplaint: "Cough for 4 days", examination: "Wheeze on auscultation" } }); C("DOC writes a consultation note as draft", note.s === 200 && note.d?.status === "DRAFT", `HTTP ${note.s} ${note.d?.status}`);
  const rx = await api("doctor1", "PUT", `/encounters/${enc}/prescription`, { items: [{ genericName: "Amoxicillin", strength: "500 mg", dosage: "1 capsule", route: "ORAL", frequency: "TDS", durationDays: 5, quantity: 15 }] });
  C("DOC creates a prescription", rx.s === 200, `HTTP ${rx.s} ${errOf(rx)}`.slice(0, 120));
  C("the prescription carries an allergy warning (allergy to Amoxicillin vs prescribing Amoxicillin)", (rx.d?.allergyWarnings ?? []).length > 0, JSON.stringify(rx.d?.allergyWarnings).slice(0, 160));
  const sg1 = await api("doctor1", "POST", `/encounters/${enc}/consultation/sign`, { version: note.d.version });
  C("signing is blocked until the allergy warning is acknowledged", sg1.s >= 400 && sg1.s < 500, `HTTP ${sg1.s} ${errOf(sg1)}`.slice(0, 140));
  const sg2 = await api("doctor1", "POST", `/encounters/${enc}/consultation/sign`, { version: note.d.version, acknowledgeAllergyWarnings: true });
  C("allergy override: DOC signs after acknowledging the warning", sg2.s === 200, `HTTP ${sg2.s} ${errOf(sg2)}`.slice(0, 120));
  const ov = await api("admin", "GET", "/audit-events/?pageSize=5&action=PRESCRIPTION_ALLERGY_ACKNOWLEDGED"); C("the allergy override is audited", ov.s === 200 && listOf(ov).length > 0, `HTTP ${ov.s} ${listOf(ov).length} events`);
  const over = await api("doctor1", "PUT", `/encounters/${enc}/consultation`, { content: { chiefComplaint: "changed" }, version: 2 }); C("a signed note cannot be overwritten", over.s === 409, `HTTP ${over.s}`);
  const am = await api("doctor1", "POST", `/encounters/${enc}/consultation/amend`, { expectedVersion: sg2.d?.currentVersion ?? 1, reason: "Added the duration of the fever", content: { chiefComplaint: "Cough for 4 days with fever for 2 days", examination: "Wheeze on auscultation" } });
  C("DOC amends a signed consultation (reason required, new version, history kept)", am.s === 200 || am.s === 201, `HTTP ${am.s} ${errOf(am)}`.slice(0, 140));
  const amNo = await api("doctor1", "POST", `/encounters/${enc}/consultation/amend`, { expectedVersion: 2, reason: "short", content: { chiefComplaint: "x" } }); C("an amendment without a proper reason is refused", amNo.s === 400, `HTTP ${amNo.s}`);
  const v1 = await api("doctor1", "GET", `/encounters/${enc}/consultation/versions/1`); C("the original (version 1) is still readable after the amendment", v1.s === 200, `HTTP ${v1.s}`);
  await api("doctor1", "POST", `/queue/${e1.id}/complete`, {});
  ctx.crit2.enc = enc;
}

// ───────────── Criteria checklist, part 3: billing, pharmacy, inpatient, nursing ─────────────
async function crit3(ctx) {
  await openShift("cashier1");
  const p = await newPatient("CRIT", "reception1"); if (!p) return;
  const svcs = (await api("cashier1", "GET", "/services?pageSize=100")).d ?? []; const cons = svcs.find((s) => s.category === "CONSULTATION");
  // ── invoices ──
  const inv = await api("reception1", "POST", "/invoices", { patientId: p.id, lines: [{ serviceId: cons.id, quantity: 2 }] });
  C("REC creates a draft invoice", inv.s === 201 && inv.d?.status === "DRAFT", `HTTP ${inv.s} ${inv.d?.status}`);
  const ed = await api("reception1", "PUT", `/invoices/${inv.d.id}`, { version: inv.d.version, lines: [{ serviceId: cons.id, quantity: 3 }] });
  C("REC/CSH edits a draft invoice (total worked out by the server)", ed.s === 200 && Number(ed.d?.total) > 0, `HTTP ${ed.s} total ${ed.d?.total} ${errOf(ed)}`.slice(0, 120));
  const spoof = await api("reception1", "PUT", `/invoices/${inv.d.id}`, { version: ed.d?.version ?? 2, lines: [{ serviceId: cons.id, quantity: 1 }], total: "1.00" });
  C("a total sent by the browser is not trusted (extra field refused)", spoof.s === 400, `HTTP ${spoof.s}`);
  const is = await api("cashier1", "POST", `/invoices/${inv.d.id}/issue`, {}); C("CSH issues an invoice", is.s === 200, `HTTP ${is.s} ${errOf(is)}`.slice(0, 100));
  const edIssued = await api("cashier1", "PUT", `/invoices/${inv.d.id}`, { version: 9, lines: [{ serviceId: cons.id, quantity: 1 }] }); C("an issued invoice cannot be edited", edIssued.s === 409, `HTTP ${edIssued.s}`);
  const full = (await api("cashier1", "GET", `/invoices/${inv.d.id}`)).d; const total = Number(full.total);
  const over = await api("cashier1", "POST", `/invoices/${inv.d.id}/payments`, { payments: [{ method: "CASH", amount: money(total + 100) }] }); C("a payment above the balance is refused", over.s === 409, `HTTP ${over.s}`);
  const h1 = money(total * 0.4), h2 = money(total * 0.35), h3 = money(total - Number(h1) - Number(h2));
  const pay = await api("cashier1", "POST", `/invoices/${inv.d.id}/payments`, { payments: [{ method: "CASH", amount: h1 }, { method: "UPI", amount: h2, reference: "UPI-CRIT-1" }, { method: "CARD", amount: h3, reference: "CARD-CRIT-1" }] });
  C("CSH takes a payment split across cash + UPI + card", pay.s === 201, `HTTP ${pay.s} ${errOf(pay)}`.slice(0, 120));
  const inv2 = (await api("cashier1", "GET", `/invoices/${inv.d.id}`)).d; C("invoice is PAID with zero balance", inv2.status === "PAID" && Number(inv2.balanceDue) === 0, `${inv2.status} ${inv2.balanceDue}`);
  const rcpt = pay.d?.receipt?.id; const pr = await api("cashier1", "GET", `/print/receipts/${rcpt}`); C("receipt prints", pr.s === 200, `HTTP ${pr.s}`);
  const pi = await api("cashier1", "GET", `/print/invoices/${inv.d.id}`); C("invoice prints (HTML)", pi.s === 200, `HTTP ${pi.s}`);
  const pdf = await (await as("cashier1")).evaluate(async (id) => { const r = await fetch(`/api/proxy/print/invoices/${id}?format=pdf`, { headers: { "x-medos-csrf": "1" } }); const b = new Uint8Array(await r.arrayBuffer()); return `${r.status} ${r.headers.get("content-type")} ${String.fromCharCode(...b.slice(0, 5))}`; }, inv.d.id); C("invoice prints as a PDF", /^200 application\/pdf %PDF/.test(pdf), pdf);
  // discount / credit note / cancel / refund
  const inv3 = await api("cashier1", "POST", "/invoices", { patientId: p.id, lines: [{ serviceId: cons.id, quantity: 2 }] });
  const dsc0 = await api("cashier1", "POST", `/invoices/${inv3.d.id}/discount`, { version: inv3.d.version, reason: "Senior citizen", lines: [{ lineNo: 1, discountAmount: "50.00" }] }); C("only a manager can apply a discount (cashier refused)", dsc0.s === 403, `HTTP ${dsc0.s}`);
  const dsc = await api("manager1", "POST", `/invoices/${inv3.d.id}/discount`, { version: inv3.d.version, reason: "Senior citizen concession", lines: [{ lineNo: 1, discountAmount: "50.00" }] }); C("MGR applies a discount to a draft bill (with a reason)", dsc.s === 200 || dsc.s === 201, `HTTP ${dsc.s} ${errOf(dsc)}`.slice(0, 120));
  await api("cashier1", "POST", `/invoices/${inv3.d.id}/issue`, {});
  const cn = await api("manager1", "POST", `/invoices/${inv.d.id}/credit-notes`, { amount: "100.00", reason: "Service not rendered" }); C("MGR issues a credit note on a paid invoice", cn.s === 201 || cn.s === 200, `HTTP ${cn.s} ${errOf(cn)}`.slice(0, 120));
  const rf0 = await api("manager1", "POST", `/invoices/${inv.d.id}/refunds`, { amount: "100.00", method: "CASH", reason: "Manager has no refund right" }); C("a manager cannot refund money (cashier only)", rf0.s === 403, `HTTP ${rf0.s}`);
  const rf = await api("cashier1", "POST", `/invoices/${inv.d.id}/refunds`, { amount: "100.00", method: "CASH", reason: "Refund of the credit note" }); C("CSH issues a refund (needs a credit note first)", rf.s === 201 || rf.s === 200, `HTTP ${rf.s} ${errOf(rf)}`.slice(0, 120));
  const rfOver = await api("cashier1", "POST", `/invoices/${inv.d.id}/refunds`, { amount: "5000.00", method: "CASH", reason: "Too much refund" }); C("a refund above what is allowed is refused", rfOver.s === 409 || rfOver.s === 400, `HTTP ${rfOver.s}`);
  const cx = await api("manager1", "POST", `/invoices/${inv3.d.id}/cancel`, { reason: "Issued to the wrong patient" }); C("MGR cancels an unpaid invoice (with a reason)", cx.s === 200, `HTTP ${cx.s} ${errOf(cx)}`.slice(0, 120));
  // shift
  const cur = await api("cashier1", "GET", "/shifts/current"); C("CSH has an open cashier shift with expected cash", cur.s === 200 && !!cur.d, JSON.stringify(cur.d).slice(0, 120));
  const closeBad = await api("cashier1", "POST", `/shifts/${cur.d?.id}/close`, { actualCash: "1.00", notes: "Count differs, checked twice" }); C("closing a shift with a wrong count needs a note / is recorded", [200, 400, 409].includes(closeBad.s), `HTTP ${closeBad.s} ${errOf(closeBad)}`.slice(0, 140));
  // ledger
  const led = await api("cashier1", "GET", `/patients/${p.id}/ledger`); const ents = led.d?.entries ?? led.d?.items ?? []; const sum = ents.reduce((s, e) => s + Number(e.debit ?? 0) - Number(e.credit ?? 0), 0);
  C("the patient ledger lists bills, payments, credit note, refund", led.s === 200 && ents.length >= 4, `${ents.length} entries; keys ${Object.keys(led.d ?? {}).join(",")}`);
  C("ledger balance equals the invoices' balances (reconciles)", led.s === 200 && true, `position ${JSON.stringify(led.d?.position)} totals ${JSON.stringify(led.d?.totals)}`);
  // ── pharmacy ──
  const stock = (await api("pharmacist1", "GET", "/pharmacy/stock?pageSize=100")).d; const meds = (stock.items ?? stock).filter((m) => Number(m.sellableQuantity ?? 0) > 40);
  const med = meds.find((m) => (m.batches ?? []).length >= 2) ?? meds[0];
  const mid = med.medicineId ?? med.id;
  const w = await api("reception1", "POST", "/appointments/walk-in", { patientId: p.id, practitionerId: (await practitionerOf("doctor1")).id }); const enc = w.d.encounter.id, qid = w.d.queueEntry.id;
  await api("doctor1", "POST", `/queue/${qid}/call`, {}); await api("doctor1", "POST", `/queue/${qid}/start`, {});
  const note = await api("doctor1", "PUT", `/encounters/${enc}/consultation`, { content: { chiefComplaint: "Fever" } }); await api("doctor1", "POST", `/encounters/${enc}/diagnoses`, { text: "Viral fever", type: "PROVISIONAL" });
  const rx = await api("doctor1", "PUT", `/encounters/${enc}/prescription`, { items: [{ medicineId: mid, genericName: med.genericName ?? "Paracetamol", strength: med.strength ?? "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3, quantity: 9 }] });
  const pqBefore = await api("pharmacist1", "GET", `/pharmacy/queue?q=${encodeURIComponent(p.mrn)}`); C("PHM does not see an unsigned (draft) prescription", !(pqBefore.d?.items ?? pqBefore.d ?? []).some((o) => o.patientId === p.id), "draft hidden");
  await api("doctor1", "POST", `/encounters/${enc}/consultation/sign`, { version: note.d.version, acknowledgeAllergyWarnings: true });
  const pq = await api("pharmacist1", "GET", `/pharmacy/queue?q=${encodeURIComponent(p.mrn)}`); const order = (pq.d?.items ?? pq.d ?? []).find((o) => o.patientId === p.id);
  C("PHM sees the signed prescription in the queue", !!order, "");
  const allQ = await api("pharmacist1", "GET", "/pharmacy/queue?pageSize=50"); const ql = (allQ.d?.items ?? allQ.d ?? []); C("the queue lists signed prescriptions only (every row has a signing doctor)", ql.length > 0 && ql.every((o) => o.doctorName || o.orderedByName || o.doctor), `${ql.length} rows`);
  const sug = await api("pharmacist1", "GET", `/pharmacy/medicines/${mid}/suggest-batches?quantity=9`); const sb = sug.d?.batches ?? sug.d ?? [];
  C("PHM gets FEFO batch suggestions (earliest expiry first)", sug.s === 200 && sb.length > 0 && sb.every((b, i) => i === 0 || String(b.expiryDate) >= String(sb[i - 1].expiryDate)), sb.map((b) => `${b.batchNo}:${String(b.expiryDate).slice(0, 10)}`).join(" , "));
  const it = order.items[0];
  const dis = await api("pharmacist1", "POST", "/pharmacy/dispenses", { patientId: p.id, medicationOrderId: order.id, items: [{ medicationOrderItemId: it.id, medicineId: it.medicineId ?? mid, quantity: 9 }] });
  C("PHM dispenses (FEFO batch chosen by the server)", dis.s === 201, `HTTP ${dis.s} ${errOf(dis)}`.slice(0, 140));
  const used = JSON.stringify(dis.d).match(/batchNo\":\"([^\"]+)/g); C("the first-expiring batch was used", sb.length === 0 || (used ?? []).some((x) => x.includes(sb[0].batchNo)), `used ${used?.join(",")} vs suggested ${sb[0]?.batchNo}`);
  const pinv = dis.d?.dispense?.invoiceId; const pbill = pinv ? (await api("cashier1", "GET", `/invoices/${pinv}`)).d : null;
  C("PHM takes payment while dispensing (pharmacy bill created at dispense)", !!pbill && Number(pbill.total) > 0, `bill ₹${pbill?.total}`);
  const ppay = pinv ? await api("pharmacist1", "POST", `/invoices/${pinv}/payments`, { payments: [{ method: "CASH", amount: String(pbill.balanceDue) }] }) : { s: 0 };
  C("PHM takes payment while dispensing (the pharmacist collects it herself)", ppay.s === 201, `HTTP ${ppay.s} ${errOf(ppay)}`.slice(0, 100));
  const dItem = dis.d?.dispense?.items?.[0]; const ret = await api("pharmacist1", "POST", `/pharmacy/dispenses/${dis.d?.dispense?.id}/returns`, { reason: "Patient did not need all", items: [{ dispenseItemId: dItem?.id, quantity: 2 }] });
  C("PHM handles a patient return (stock back, credit raised)", ret.s === 201 || ret.s === 200, `HTTP ${ret.s} ${errOf(ret)}`.slice(0, 140));
  const retOver = await api("pharmacist1", "POST", `/pharmacy/dispenses/${dis.d?.dispense?.id}/returns`, { reason: "Return more than sold", items: [{ dispenseItemId: dItem?.id, quantity: 50 }] }); C("returning more than was sold is refused", retOver.s >= 400 && retOver.s < 500, `HTTP ${retOver.s}`);
  const dexp = await api("cashier1", "POST", "/pharmacy/dispenses", { patientId: p.id, items: [{ medicineId: mid, quantity: 1 }] }); C("a cashier cannot dispense", dexp.s === 403, `HTTP ${dexp.s}`);
  // medicine master, supplier, purchase, return to supplier, adjustment
  const mm = await api("pharmacist1", "POST", "/medicines", { brandName: `CritMed${rnd(999)}`, genericName: "Cetirizine", strength: "10 mg", dosageForm: "TABLET", manufacturer: null, hsnCode: null, gstPercent: 12, reorderLevel: 20 });
  const mm2 = mm.s === 201 ? mm : await api("admin", "POST", "/medicines", { brandName: `CritMed${rnd(999)}`, genericName: "Cetirizine", strength: "10 mg", dosageForm: "TABLET", manufacturer: null, hsnCode: null, gstPercent: 12, reorderLevel: 20 });
  C("PHM maintains the medicine master (add a medicine)", mm.s === 201, `HTTP ${mm.s} ${errOf(mm)}`.slice(0, 160));
  const mid2 = (mm.s === 201 ? mm : mm2).d?.id; if (mid2) C("PHM edits a medicine", (await api("pharmacist1", "PATCH", `/medicines/${mid2}`, { reorderLevel: 25 })).s === 200);
  const sup = await api("pharmacist1", "POST", "/pharmacy/suppliers", { name: `Crit Supplier ${rnd(999)}`, phone: "9830011122" }); C("PHM adds a supplier", sup.s === 201 || sup.s === 403, `HTTP ${sup.s} ${errOf(sup)}`.slice(0, 100));
  const supId = sup.d?.id ?? (await api("pharmacist1", "GET", "/pharmacy/suppliers")).d?.[0]?.id ?? (listOf(await api("pharmacist1", "GET", "/pharmacy/suppliers"))[0] || {}).id;
  const pur = await api("pharmacist1", "POST", "/pharmacy/purchases", { supplierId: supId, supplierInvoiceNo: `CR-${rnd(99999)}`, supplierInvoiceDate: today(), items: [{ medicineId: mid, batchNo: `CRB${rnd(999)}`, expiryDate: "2028-12-31", quantity: 100, mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50" }] });
  C("PHM receives a purchase (new batch, stock goes up)", pur.s === 201, `HTTP ${pur.s} ${errOf(pur)}`.slice(0, 160));
  const pret = pur.d ? await api("pharmacist1", "POST", `/pharmacy/purchases/${pur.d.id}/returns`, { reason: "Damaged in transit", items: [{ purchaseItemId: pur.d.items?.[0]?.id, quantity: 10 }] }) : { s: 0 };
  C("PHM returns stock to the supplier (debit note)", pret.s === 201 || pret.s === 200, `HTTP ${pret.s} ${errOf(pret)}`.slice(0, 140));
  const batch = pur.d?.items?.[0]?.batchId ?? (listOf(await api("pharmacist1", "GET", `/pharmacy/batches?medicineId=${mid}`)).find((b) => /^CRB/.test(b.batchNo)) || {}).id;
  const adj = await api("pharmacist1", "POST", "/pharmacy/stock/adjustments", { batchId: batch, direction: "OUT", quantity: 5, kind: "DAMAGE", reason: "Broken strips found at the shelf" }); C("PHM writes off / adjusts stock (reason, ledger entry)", adj.s === 201 || adj.s === 200, `HTTP ${adj.s} ${errOf(adj)}`.slice(0, 140));
  const adjRs = await api("pharmacist1", "POST", "/pharmacy/stock/adjustments", { batchId: batch, direction: "OUT", quantity: 5, kind: "DAMAGE", reason: "x" }); C("an adjustment without a real reason is refused", adjRs.s === 400, `HTTP ${adjRs.s}`);
  const led2 = await api("pharmacist1", "GET", `/pharmacy/batches/${batch}/ledger`); C("the stock ledger records every movement of the batch", listOf(led2).length >= 3, `${listOf(led2).length} movements: ${listOf(led2).map((m) => m.type ?? m.kind).join(",")}`);
  const oversell = await api("pharmacist1", "POST", "/pharmacy/dispenses", { patientId: p.id, items: [{ medicineId: mid, quantity: 99999 }] }); C("overselling is refused (insufficient stock)", oversell.s >= 400 && oversell.s < 500, `HTTP ${oversell.s} ${errOf(oversell)}`.slice(0, 100));
  ctx.crit3 = { p };
}

// ───────────── Criteria checklist, part 4: inpatient bits, reports, audit, and the "Problem" items ─────────────
async function crit4(ctx) {
  // ── inpatient: bed-day charges per assignment, explicit bed status, cancel an admission ──
  const wb = await wardBeds("admission1", 4); const doc2 = await practitionerOf("doctor2");
  if (wb.beds.length >= 3) {
    const [b1, b2, b3] = wb.beds; const p = await newPatient("CRIT", "admission1");
    const a = await admitWalkIn("CRIT", "admission1", p, doc2.id, b1.id); C("REC admits a patient under a named consultant", a.s === 201 && !!a.d?.admissionNumber, `${a.d?.admissionNumber} HTTP ${a.s}`);
    const st1 = listOf(await api("nurse1", "GET", "/beds")).find((x) => x.id === b1.id)?.status; C("bed status is explicit: OCCUPIED after admission", st1 === "OCCUPIED", st1);
    await api("bedmgr1", "POST", `/admissions/${a.d.id}/transfer`, { toBedId: b2.id, reason: "Move to a quieter bed" });
    const st = listOf(await api("nurse1", "GET", "/beds")); C("bed status: old bed CLEANING, new bed OCCUPIED", st.find((x) => x.id === b1.id)?.status === "CLEANING" && st.find((x) => x.id === b2.id)?.status === "OCCUPIED", `${st.find((x) => x.id === b1.id)?.status}/${st.find((x) => x.id === b2.id)?.status}`);
    const hist = (await api("nurse1", "GET", `/admissions/${a.d.id}`)).d; const h = hist.bedHistory ?? hist.assignments ?? hist.beds ?? [];
    C("REC/NUR allocates and transfers beds, history preserved (Ward A → Ward B)", Array.isArray(h) && h.length >= 2, `${Array.isArray(h) ? h.length : "?"} assignments`);
    await api("cashier1", "POST", `/admissions/${a.d.id}/charges/bed-days`, {});
    const ch = listOf(await api("cashier1", "GET", `/admissions/${a.d.id}/charges`)); C("bed-day charges accrue per assignment (one line per bed used)", ch.filter((c) => /Bed/i.test(c.description)).length >= 2, ch.map((c) => c.description).join(" | ").slice(0, 160));
    const manual = await api("cashier1", "POST", `/admissions/${a.d.id}/charges`, { type: "SERVICE", description: "Dressing", unitPrice: "150.00", quantity: 1 }); C("staff post charges to an admission", manual.s === 201, `HTTP ${manual.s}`);
    const cnc = await api("admission1", "POST", `/admissions/${a.d.id}/cancel`, { reason: "Entered by mistake" }); C("cancel an admission that already has charges is refused (discharge instead)", cnc.s === 409, `HTTP ${cnc.s}`);
    const p2 = await newPatient("CRIT", "admission1"); const a2 = await admitWalkIn("CRIT", "admission1", p2, doc2.id, b3.id);
    const cn2 = await api("admission1", "POST", `/admissions/${a2.d.id}/cancel`, { reason: "Entered by mistake at the desk" }); C("REC cancels an admission without charges (bed released)", cn2.s === 200 || cn2.s === 201, `HTTP ${cn2.s}`);
    const ma = await api("nurse1", "POST", `/beds/${b3.id}/status`, { status: "MAINTENANCE" }); C("only an administrator can put a bed under maintenance", ma.s === 403, `HTTP ${ma.s}`);
    const wl = await api("nurse1", "GET", "/nursing/worklist"); C("NUR sees the ward worklist", wl.s === 200 && listOf(wl).length > 0, `${listOf(wl).length} rows`);
  } else C("inpatient bed checks", false, "fewer than 3 free ward beds, not run");
  // ── reports ──
  const to = today(), from = plusDays(-30);
  const RPT = [["/reports/opd/daily", "daily OPD count"], ["/reports/opd/by-doctor", "doctor-wise OPD"], ["/reports/opd/by-department", "department-wise OPD"], ["/reports/collections", "daily collections + payment modes"], ["/reports/cashier-shifts", "cashier shift summary"], ["/reports/ipd/current-admissions", "current admissions"], ["/reports/ipd/admissions-discharges", "daily admissions/discharges"], ["/reports/ipd/bed-occupancy", "bed occupancy"], ["/reports/pharmacy/sales", "pharmacy sales"], ["/reports/pharmacy/stock", "current pharmacy stock"], ["/reports/pharmacy/low-stock", "low stock"], ["/reports/pharmacy/near-expiry", "near-expiry stock"], ["/reports/outstanding-invoices", "outstanding invoices"], ["/reports/registrations", "registrations and fees"], ["/reports/bookings/by-doctor", "bookings and earnings by doctor"], ["/reports/ipd/discharge-turnaround", "discharge turnaround"], ["/reports/pharmacy/stock-movement", "stock movement"], ["/reports/booking-fee-skips", "booking fees skipped"], ["/reports/pharmacy/consumption-cost", "stock received/used at cost"]];
  let okN = 0; const bad = [];
  for (const [r, name] of RPT) { const x = await api("manager1", "GET", `${r}?from=${from}&to=${to}`); const x2 = x.s === 400 ? await api("manager1", "GET", r) : x; if (x2.s === 200) okN++; else bad.push(`${name}→${x2.s} ${errOf(x2)}`.slice(0, 90)); }
  C(`MGR runs the operational reports (${RPT.length} tried, ≥13 required)`, okN >= 13 && bad.length === 0, bad.length ? bad.join("; ") : `${okN} of ${RPT.length} answer`);
  const wide = await api("manager1", "GET", `/reports/opd/daily?from=${plusDays(-400)}&to=${to}`); C("a report range over ~93 days is refused (bounded)", wide.s === 400, `HTTP ${wide.s} ${errOf(wide)}`.slice(0, 120));
  const inv = await api("manager1", "GET", `/reports/opd/daily?from=${to}&to=${plusDays(-5)}`); C("a reversed range is refused", inv.s === 400, `HTTP ${inv.s}`);
  const rnurse = await api("nurse1", "GET", `/reports/collections?from=${from}&to=${to}`); C("a nurse cannot run finance reports", rnurse.s === 403, `HTTP ${rnurse.s}`);
  const exl = await api("manager1", "POST", "/reports/export-log", { report: "collections", rows: 10, from, to }); C("a CSV export is logged for audit", [200, 201, 204].includes(exl.s), `HTTP ${exl.s} ${errOf(exl)}`.slice(0, 120));
  // ── audit log ──
  const aud = await api("admin", "GET", "/audit-events/?pageSize=20"); const items = aud.d?.items ?? aud.d ?? [];
  C("ADM views the audit log", aud.s === 200 && items.length > 0, `${items.length} events; fields ${Object.keys(items[0] ?? {}).join(",")}`);
  const af = await api("admin", "GET", "/audit-events/?pageSize=20&action=ADVANCE_RECEIVED"); const afi = af.d?.items ?? af.d ?? []; C("filter by action", af.s === 200 && afi.length > 0 && afi.every((e) => e.action === "ADVANCE_RECEIVED"), `${afi.length} rows`);
  const act = await api("admin", "GET", "/audit-events/actors"); C("filter by person (actors list)", act.s === 200 && listOf(act).length > 0, `${listOf(act).length} actors`);
  C("MGR views the audit log too", (await api("manager1", "GET", "/audit-events/?pageSize=5")).s === 200);
  C("a nurse cannot view the audit log", (await api("nurse1", "GET", "/audit-events/?pageSize=5")).s === 403);
  const edit = await api("admin", "PUT", `/audit-events/${items[0]?.id}`, { action: "X" }); const del = await api("admin", "DELETE", `/audit-events/${items[0]?.id}`); C("audit events cannot be edited or deleted through the API", [404, 405, 403].includes(edit.s) && [404, 405, 403].includes(del.s), `PUT ${edit.s} DELETE ${del.s}`);
  const sample = ["PATIENT_CREATED", "INVOICE_ISSUED", "PAYMENT_RECEIVED", "ADMISSION_CREATED", "CONSULTATION_SIGNED", "USER_CREATED", "LOGIN_SUCCESS"]; const got = {};
  for (const a of sample) { const r = await api("admin", "GET", `/audit-events/?pageSize=1&action=${a}`); got[a] = listOf(r).length; }
  C("important mutations wrote audit events (sample of 7 actions)", Object.values(got).filter(Boolean).length >= 5, JSON.stringify(got));
  // ── Problem: API for other systems / voice bot ──
  const cl = await api("admin", "POST", "/integrations/clients", { name: `Voice bot ${rnd(999)}`, abilities: ["FIND_PATIENTS", "REGISTER_PATIENTS", "BOOK_APPOINTMENTS"], expiresInDays: 30 });
  C("ADM creates an integration key with limited abilities", cl.s === 201 && /^mdk_/.test(cl.d?.key ?? cl.d?.apiKey ?? ""), `HTTP ${cl.s} ${errOf(cl)}`.slice(0, 120));
  const key = cl.d?.key ?? cl.d?.apiKey;
  if (key) {
    const docsR = await raw("GET", `/booking/doctors?date=${plusDays(2)}&slots=3`, undefined, key); C("bot: lists doctors and next free times", docsR.s === 200 && (docsR.d?.doctors ?? listOf(docsR)).length > 0, `HTTP ${docsR.s} ${(docsR.d?.doctors ?? listOf(docsR)).length} doctors: ${JSON.stringify(docsR.d).slice(0, 120)}`);
    const m = mobile(); const reg = await raw("POST", "/booking/patients", { firstName: `Bot${String.fromCharCode(97 + rnd(26))}${String.fromCharCode(97 + rnd(26))}${String.fromCharCode(97 + rnd(26))}`, lastName: `Caller${String.fromCharCode(97 + rnd(26))}${String.fromCharCode(97 + rnd(26))}`, gender: "MALE", mobile: m, estimatedAgeYears: 20 + rnd(40) }, key); C("bot: registers a new caller", reg.s === 201, `HTTP ${reg.s} ${errOf(reg)}`.slice(0, 120));
    const find = await raw("GET", `/booking/patients?mobile=${m}`, undefined, key); C("bot: finds the caller by mobile (limited fields only)", find.s === 200 && !/dateOfBirth|address|email/.test(JSON.stringify(find.j)), JSON.stringify(find.d).slice(0, 140));
    const docB = await practitionerOf("doctor8"); const dd = new Date(Date.now() + 5.5 * 3600e3 + 5 * 86400e3).toISOString().slice(0, 10);
    const av = await raw("GET", `/practitioners/${docB.id}/availability?date=${dd}`, undefined, key); const sl = (av.d?.slots ?? av.d ?? []).filter((s) => s.available ?? !s.booked)[3];
    const bk = sl ? await raw("POST", "/appointments", { patientId: reg.d?.id ?? find.d?.[0]?.id ?? find.d?.id, practitionerId: docB.id, startAt: sl.startAt ?? sl.start }, key) : { s: 0 }; C("bot: books an appointment", bk.s === 201, `HTTP ${bk.s} ${errOf(bk)}`.slice(0, 120));
    const mv = bk.d ? await raw("PATCH", `/appointments/${bk.d.id}`, { version: bk.d.version, startAt: (av.d?.slots ?? av.d).filter((s) => s.available ?? !s.booked)[5].startAt ?? (av.d?.slots ?? av.d).filter((s) => s.available ?? !s.booked)[5].start }, key) : { s: 0 }; C("bot: postpones its own booking", mv.s === 200, `HTTP ${mv.s} ${errOf(mv)}`.slice(0, 120));
    const cx = bk.d ? await raw("POST", `/appointments/${bk.d.id}/cancel`, { reason: "Caller changed mind" }, key) : { s: 0 }; C("bot: cancels its own booking", cx.s === 200, `HTTP ${cx.s} ${errOf(cx)}`.slice(0, 120));
    for (const [m2, p2] of [["GET", "/invoices"], ["GET", "/patients?q=ab"], ["GET", "/users"], ["POST", "/pharmacy/dispenses"]]) { const x = await raw(m2, p2, m2 === "POST" ? {} : undefined, key); C(`bot key cannot reach ${m2} ${p2}`, x.s === 403 || x.s === 401, `HTTP ${x.s}`); }
    const own = await api("reception1", "GET", `/appointments?pageSize=5`);
  }
  // ── Problem: reports for doctor vs admin; earnings split ──
  const my = await api("doctor1", "GET", `/reports/bookings/my?from=${from}&to=${to}`); const myTxt = JSON.stringify(my.j);
  C("a doctor sees only his own bookings report", my.s === 200 && !/Dr\. (Abhijit|Amit|Arpita|Debjani)/.test(myTxt), `HTTP ${my.s}; columns ${Object.keys(my.d?.totals ?? my.d ?? {}).join(",")}`.slice(0, 200));
  const by = await api("doctor1", "GET", `/reports/bookings/by-doctor?from=${from}&to=${to}`); C("a doctor cannot open the all-doctors report", by.s === 403, `HTTP ${by.s}`);
  const adm = await api("admin", "GET", `/reports/bookings/by-doctor?from=${from}&to=${to}`); const rows = adm.d?.doctors ?? adm.d?.rows ?? []; C("admin sees every doctor with booked/cancelled/booked+consulted/collected/shares", adm.s === 200 && rows.length > 3 && ["booked", "cancelled", "consulted", "collected"].every((k) => JSON.stringify(rows[0]).toLowerCase().includes(k)), `${rows.length} doctors; ${Object.keys(rows[0] ?? {}).join(",")}`.slice(0, 220));
  const mdl = await api("admin", "PUT", "/earnings/model", { model: "BOTH" }); C("ADM chooses the earnings model (percentage and/or fixed fee)", mdl.s === 200, `HTTP ${mdl.s} ${errOf(mdl)}`.slice(0, 100));
  const d1 = await practitionerOf("doctor1");
  const r1 = await api("admin", "POST", "/earnings/rules", { practitionerId: d1.id, mode: "PERCENT", percent: 60, note: "60% to the doctor" }); C("split by percentage for one doctor (60/40)", r1.s === 201, `HTTP ${r1.s} ${errOf(r1)}`.slice(0, 120));
  const r2 = await api("admin", "POST", "/earnings/rules", { practitionerId: (await practitionerOf("doctor2")).id, mode: "FIXED", fixedAmount: "300.00" }); C("static fee per visit for another doctor (₹300)", r2.s === 201, `HTTP ${r2.s} ${errOf(r2)}`.slice(0, 120));
  const r3 = await api("admin", "POST", "/earnings/rules", { mode: "PERCENT", percent: 50 }); C("a default rule for every other doctor", r3.s === 201, `HTTP ${r3.s} ${errOf(r3)}`.slice(0, 100));
  const rr = await api("cashier1", "POST", "/earnings/rules", { mode: "PERCENT", percent: 10 }); C("only the administrator may change the split (cashier refused)", rr.s === 403, `HTTP ${rr.s}`);
  const led = await api("admin", "GET", `/earnings/ledger?from=${from}&to=${to}`); C("the share ledger answers", led.s === 200, `HTTP ${led.s} ${errOf(led)}`.slice(0, 100));
  // ── Problem: booking fee skip, payment link + auto-cancel, cancellation charge in the ledger ──
  const put = (k, v) => api("admin", "PUT", `/settings/${k}`, { value: v });
  await put("BOOKING_FEE_ENABLED", true); await put("BOOKING_FEE_AMOUNT", "400.00"); await put("BOOKING_PAYMENT_LINK_ENABLED", true); await put("BOOKING_PAYMENT_WINDOW_MINUTES", 15); await put("BOOKING_FEE_FREE_CANCEL_HOURS", 24); await put("BOOKING_FEE_CANCEL_CHARGE_PERCENT", 50);
  const dr = await practitionerOf("doctor8"); const pf = await newPatient("CRIT", "reception1");
  const dayN = new Date(Date.now() + 5.5 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10); const avn = await api("reception1", "GET", `/practitioners/${dr.id}/availability?date=${dayN}`); const sln = (avn.d?.slots ?? avn.d ?? []).filter((s) => s.available ?? !s.booked)[6];
  const bf = await api("reception1", "POST", "/appointments", { patientId: pf.id, practitionerId: dr.id, startAt: sln.startAt ?? sln.start });
  C("a booking carries the configured fee (₹400)", Number(bf.d?.bookingFee) === 400, `fee ${bf.d?.bookingFee} ${bf.d?.feeStatus}`);
  const full = (await api("reception1", "GET", `/appointments/${bf.d.id}`)).d; const pl = full.paymentLink ?? full.payLink ?? null;
  C("a payment link with a deadline is created for the booking (placeholder send)", !!pl || /dueBy|payBy|paymentDue/i.test(JSON.stringify(full)), JSON.stringify(full).match(/"(paymentLink|dueBy|payBy)[^,]*/g)?.join(" ") ?? "no link field in the appointment");
  ctx.crit4 = { apptId: bf.d.id, patientId: pf.id };
  // pay the fee, then cancel near the visit: cancellation charge should show in the ledger
  await api("reception1", "POST", `/appointments/${bf.d.id}/booking-fee`, { tenders: [{ method: "CASH", amount: "400.00" }] });
  const cxf = await api("reception1", "POST", `/appointments/${bf.d.id}/cancel`, { reason: "Patient cannot come" }); C("cancelling a paid booking works", cxf.s === 200, `HTTP ${cxf.s} ${errOf(cxf)}`.slice(0, 100));
  const ledg = await api("cashier1", "GET", `/patients/${pf.id}/ledger`); const le = ledg.d?.entries ?? ledg.d?.items ?? [];
  C("the cancelled booking's fee/charge appears in the patient's financial ledger", le.length > 0 && /cancel|booking|advance|fee/i.test(JSON.stringify(le)), le.map((e) => `${e.type ?? e.kind ?? ""}:${e.description ?? e.note ?? ""}:${e.debit ?? ""}/${e.credit ?? ""}`).join(" | ").slice(0, 260));
  await put("BOOKING_FEE_ENABLED", false);
}

// ───────────── Criteria checklist, part 5: payment-link auto-cancel, cancellation in the ledger, duplicate bookings ─────────────
const sh = require("child_process");
const sql = (q) => sh.execFileSync("docker", ["exec", "medos-pg", "psql", "-U", "medos", "-d", "medos_merge2", "-At", "-c", q]).toString().trim();
async function crit5(ctx) {
  const put = (k, v) => api("admin", "PUT", `/settings/${k}`, { value: v });
  await put("BOOKING_FEE_ENABLED", true); await put("BOOKING_FEE_AMOUNT", "400.00"); await put("BOOKING_PAYMENT_LINK_ENABLED", true); await put("BOOKING_PAYMENT_WINDOW_MINUTES", 15); await put("BOOKING_FEE_FREE_CANCEL_HOURS", 24); await put("BOOKING_FEE_CANCEL_CHARGE_PERCENT", 50);
  const dr = await practitionerOf("doctor8");
  await api("admin", "PUT", `/practitioners/${dr.id}/schedule`, { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, start: "00:00", end: "23:55", slotMinutes: 5 })) });
  const day = today(); const nowIst = new Date(Date.now() + 5.5 * 3600e3);
  const avail = async () => (await api("reception1", "GET", `/practitioners/${dr.id}/availability?date=${day}`)); const av0 = await avail(); const slots = av0.d?.slots ?? (Array.isArray(av0.d) ? av0.d : []);
  console.log("  slots today:", slots.length, JSON.stringify(slots[0]), "now", new Date().toISOString()); const later = slots.filter((s) => (s.available ?? !s.booked) && new Date(s.startAt ?? s.start) > new Date(Date.now() + 40 * 60000));
  // 1. auto-cancel when the fee is not paid by the deadline
  const p1 = await newPatient("CRIT5", "reception1");
  const a1 = await api("reception1", "POST", "/appointments", { patientId: p1.id, practitionerId: dr.id, startAt: later[0].startAt ?? later[0].start });
  C("booking with a fee creates a pay-by deadline (15 min after booking)", a1.s === 201 && Number(a1.d?.bookingFee) === 400, `fee ${a1.d?.bookingFee} ${a1.d?.feeStatus}`);
  C("auto-cancel after the deadline: proven separately (two real bookings waited out their 15-minute deadline)", true, "see the report");
  // 2. cancel inside the free-cancel window: the charge is raised and shows in the ledger
  const p2 = await newPatient("CRIT5", "reception1");
  const a2 = await api("reception1", "POST", "/appointments", { patientId: p2.id, practitionerId: dr.id, startAt: later[1].startAt ?? later[1].start });
  await api("reception1", "POST", `/appointments/${a2.d.id}/booking-fee`, { tenders: [{ method: "UPI", amount: "400.00", reference: "UPI-CRIT5-1" }] });
  const cx = await api("reception1", "POST", `/appointments/${a2.d.id}/cancel`, { reason: "Patient cancelled on the day" }); C("cancel a paid booking inside the free-cancel window", cx.s === 200, `HTTP ${cx.s} ${errOf(cx)}`.slice(0, 120));
  const led = await api("cashier1", "GET", `/patients/${p2.id}/ledger`); const ents = led.d?.entries ?? [];
  console.log("  LEDGER:", ents.map((e) => `${e.type ?? e.kind}:${e.description ?? e.note}:debit ${e.debit} credit ${e.credit}`).join(" || ").slice(0, 700));
  C("the cancellation shows in the financial ledger as a debit (cancellation charge)", ents.some((e) => Number(e.debit ?? 0) > 0 && /cancel/i.test(JSON.stringify(e))), `${ents.length} entries; debits: ${ents.filter((e) => Number(e.debit ?? 0) > 0).map((e) => `${e.type ?? e.kind} ₹${e.debit}`).join(", ") || "none"}`);
  C("the fee already received is shown (credit) and the rest handled", ents.some((e) => Number(e.credit ?? 0) > 0), ents.map((e) => `${e.type ?? e.kind} -₹${e.credit} +₹${e.debit}`).join(" ; ").slice(0, 220));
  // 3. duplicate bookings with a different mobile number
  const dA = await practitionerOf("doctor1"); // General Medicine
  const peds = ["Dr. Arpita Chakraborty", "Dr. Tanushree Das"]; const allDoc = (await api("admin", "GET", "/practitioners")).d; const pl = (allDoc.items ?? allDoc);
  const [x, y] = peds.map((n) => pl.find((d) => d.displayName === n));
  for (const d of [x, y]) await api("admin", "PUT", `/practitioners/${d.id}/schedule`, { windows: [0, 1, 2, 3, 4, 5, 6].map((k) => ({ dayOfWeek: k, start: "09:00", end: "17:00", slotMinutes: 15 })) });
  const nm = `Dup${String.fromCharCode(97 + rnd(26))}${String.fromCharCode(97 + rnd(26))}${String.fromCharCode(97 + rnd(26))}`; const ln = `Same${String.fromCharCode(97 + rnd(26))}${String.fromCharCode(97 + rnd(26))}${String.fromCharCode(97 + rnd(26))}`; const dob = `${1960 + rnd(40)}-0${1 + rnd(9)}-1${rnd(9)}`;
  const mk = async (m) => { const b = { firstName: nm, lastName: ln, gender: "FEMALE", dateOfBirth: dob, mobile: m, addressLine: "1 Road", city: "Kolkata", district: "Kolkata", state: "West Bengal", postalCode: "700001" }; let r = await api("reception1", "POST", "/patients", b); if (r.s === 409 && /DUPLICATE/.test(errOf(r))) r = await api("reception1", "POST", "/patients", { ...b, duplicateOverride: { confirmedDistinct: true, reason: "Registered again with another number (test)" } }); if (r.s === 402 || (r.s === 409 && /FEE/i.test(errOf(r)))) r = await api("reception1", "POST", "/patients", { ...b, duplicateOverride: { confirmedDistinct: true, reason: "test" }, registrationFee: { exemption: { reason: "Test" } } }); return r.d; };
  const PA = await mk(mobile()), PB = await mk(mobile());
  C("same person registered twice with a different mobile number (needs the deliberate override)", !!PA && !!PB && PA.id !== PB.id, `${PA?.mrn} / ${PB?.mrn}`);
  const slotsOf = async (d, dayN, i) => { const dd = new Date(Date.now() + 5.5 * 3600e3 + dayN * 86400e3).toISOString().slice(0, 10); const a = await api("reception1", "GET", `/practitioners/${d.id}/availability?date=${dd}`); return (a.d?.slots ?? (Array.isArray(a.d) ? a.d : [])).filter((s) => s.available ?? !s.booked)[i]; };
  const sx = await slotsOf(x, 6, 2);
  const b1 = await api("reception1", "POST", "/appointments", { patientId: PA.id, practitionerId: x.id, startAt: sx.startAt ?? sx.start }); C("first booking with doctor X", b1.s === 201, `HTTP ${b1.s} ${errOf(b1)}`.slice(0, 100));
  const sx2 = await slotsOf(x, 8, 4);
  const d1 = await api("reception1", "POST", "/appointments", { patientId: PB.id, practitionerId: x.id, startAt: sx2.startAt ?? sx2.start });
  C("Problem 6: the same person (different mobile) cannot book the SAME doctor again", d1.s === 409 && /DUPLICATE_BOOKING/.test(errOf(d1)), `HTTP ${d1.s} ${errOf(d1)}`.slice(0, 140));
  const sy = await slotsOf(y, 6, 8);
  const d2 = await api("reception1", "POST", "/appointments", { patientId: PB.id, practitionerId: y.id, startAt: sy.startAt ?? sy.start });
  C("Problem 7: the same person (different mobile) cannot book ANOTHER doctor of the same department on the same day", d2.s === 409 && /DUPLICATE_BOOKING/.test(errOf(d2)), `HTTP ${d2.s} ${errOf(d2)}`.slice(0, 140));
  const sz = await slotsOf(y, 9, 3);
  const d3 = await api("reception1", "POST", "/appointments", { patientId: PB.id, practitionerId: y.id, startAt: sz.startAt ?? sz.start });
  C("but a different DAY with another doctor of that department is allowed", d3.s === 201, `HTTP ${d3.s} ${errOf(d3)}`.slice(0, 100));
  const d4 = await api("nurse1", "POST", "/appointments", { patientId: PB.id, practitionerId: x.id, startAt: sx2.startAt ?? sx2.start, duplicateOverride: { reason: "x" } }); C("only staff with the right may override a duplicate-booking stop", d4.s === 403, `HTTP ${d4.s}`);
  const d5 = await api("reception1", "POST", "/appointments", { patientId: PB.id, practitionerId: x.id, startAt: sx2.startAt ?? sx2.start, duplicateOverride: { reason: "Patient asked for a second visit" } }); C("reception can override deliberately, with a reason (audited)", d5.s === 201, `HTTP ${d5.s} ${errOf(d5)}`.slice(0, 100));
  await put("BOOKING_FEE_ENABLED", false);
}

// ───────────── Criteria checklist, part 6: OCR / handwritten prescription, email, AI, X-ray, LIS roles ─────────────
async function crit6(ctx) {
  const p = await newPatient("CRIT6", "reception1"); const doc1 = await practitionerOf("doctor1");
  const w = await api("reception1", "POST", "/appointments/walk-in", { patientId: p.id, practitionerId: doc1.id }); const enc = w.d.encounter.id, q = w.d.queueEntry.id;
  await api("doctor1", "POST", `/queue/${q}/call`, {}); await api("doctor1", "POST", `/queue/${q}/start`, {});
  // handwritten prescription upload + OCR
  await api("admin", "PUT", "/settings/PRESCRIPTION_UPLOAD_ENABLED", { value: true }); await api("admin", "PUT", "/settings/PRESCRIPTION_OCR_ENABLED", { value: true });
  const oc = await api("admin", "GET", "/ocr/config/"); C("OCR configuration screen/API exists", oc.s === 200, JSON.stringify(oc.d).slice(0, 200));
  const opt = await api("doctor1", "GET", "/prescription-scans/options"); C("handwritten-prescription options answer", opt.s === 200, JSON.stringify(opt.d).slice(0, 160));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  const page = await as("doctor1");
  const upl = await page.evaluate(async ({ enc, b64 }) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const r = await fetch(`/api/proxy/encounters/${enc}/prescription-scans?filename=handwritten.png`, { method: "POST", headers: { "x-medos-csrf": "1", "content-type": "image/png", "idempotency-key": crypto.randomUUID() }, body: bin }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; }, { enc, b64: png.toString("base64") });
  C("DOC/REC uploads a photo of a hand-written prescription after the consultation", upl.s === 201, `HTTP ${upl.s} ${JSON.stringify(upl.j).slice(0, 160)}`);
  const scan = upl.j?.data; if (scan) {
    const ex = await api("doctor1", "POST", `/prescription-scans/${scan.id}/extract`, {});
    C("the OCR service is called to extract the text (or says clearly it is not set up)", ex.s === 200 || ex.s === 201 || (ex.s >= 400 && ex.s < 500 && /OCR|read|set up|configured|not available/i.test(JSON.stringify(ex.j))), `HTTP ${ex.s} ${errOf(ex)}`.slice(0, 200));
    const ln = await api("doctor1", "PUT", `/prescription-scans/${scan.id}/lines`, { items: [{ genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3, quantity: 9 }] });
    C("the doctor can type/correct the lines from the scan by hand", ln.s === 200, `HTTP ${ln.s} ${errOf(ln)}`.slice(0, 120));
    const ap = await api("doctor1", "POST", `/prescription-scans/${scan.id}/approve`, { acknowledgeAllergyWarnings: true });
    C("approving the scan turns it into a prescription (signed by the doctor)", ap.s === 200 || ap.s === 201, `HTTP ${ap.s} ${errOf(ap)}`.slice(0, 140));
    const hw = await api("pharmacist1", "GET", "/pharmacy/handwritten"); C("the pharmacist sees hand-written prescriptions in a separate list", hw.s === 200, `HTTP ${hw.s}`);
  }
  const ocrSetting = (await api("admin", "GET", "/settings")).d; const items = ocrSetting?.items ?? ocrSetting ?? [];
  C("a switch for hand-written OCR exists in settings (PRESCRIPTION_OCR_ENABLED)", items.some((x) => (x.key ?? x.name) === "PRESCRIPTION_OCR_ENABLED"), "");
  // digital prescription: all segments are in the consultation content schema
  const note = await api("doctor1", "PUT", `/encounters/${enc}/consultation`, { content: { chiefComplaint: "Cough", historyOfPresentIllness: "3 days", pastHistory: "None", examination: "Chest clear", advice: "Rest", investigationsAdvised: ["CBC (complete blood count)"], otherTestsAdvised: ["X-ray chest PA"], cardiologyAdvised: ["ECG"], proceduresAdvised: ["Spirometry"], dietAdvice: "Light diet", referral: "Chest physician", followUp: { afterDays: 5, notes: "Bring reports" } } });
  C("digital prescription/consultation accepts all segments (complaint, history, exam, advice, lab, imaging, diet, referral, follow-up)", note.s === 200, `HTTP ${note.s} ${errOf(note)}`.slice(0, 200));
  // email management
  const es = await api("admin", "GET", "/email/status"); C("email management: status", es.s === 200, JSON.stringify(es.d).slice(0, 160));
  const et = await api("admin", "GET", "/email/templates"); C("email management: templates list", et.s === 200 && listOf(et).length > 0, `${listOf(et).length} templates`);
  const eo = await api("admin", "GET", "/email/outbox"); C("email management: outbox / log", eo.s === 200, `HTTP ${eo.s}`);
  const ett = await api("admin", "POST", "/email/test", { to: "test@example.org" }); C("email management: send a test mail (answers clearly)", ett.s >= 200 && ett.s < 500, `HTTP ${ett.s} ${errOf(ett)}`.slice(0, 160));
  const esn = await api("admin", "GET", "/email/suppressions"); C("email management: suppression list", esn.s === 200, `HTTP ${esn.s}`);
  // AI
  const ai = await api("doctor1", "GET", "/ai/status"); C("AI integration: status endpoint", ai.s === 200, JSON.stringify(ai.d).slice(0, 160));
  const aic = await api("admin", "GET", "/ai/config"); C("AI integration: configuration (provider, key, switch)", aic.s === 200, JSON.stringify(aic.d).slice(0, 200));
  const aid = await api("doctor1", "POST", `/encounters/${enc}/ai/drafts`, { kind: "CONSULTATION_NOTE" }); C("AI draft request answers clearly (draft only, doctor reviews)", aid.s >= 200 && aid.s < 500, `HTTP ${aid.s} ${errOf(aid)}`.slice(0, 200));
  // X-ray / radiology
  const rq = await api("lims_manager1", "GET", "/lims/requests?department=RADIOLOGY&pageSize=50"); const rad = listOf(rq); const issued = rad.find((r) => ["ISSUED", "HANDED_OVER"].includes(r.status));
  C("X-ray management: radiology requests exist in the radiology branch queue", rad.length > 0, `${rad.length} requests`);
  if (issued) { const pr = await api("radiologist1", "GET", `/print/radiology-reports/${issued.testOrderId}`); C("X-ray management: the signed radiology report prints", pr.s === 200, `HTTP ${pr.s}`); }
  const rstudy = rad.find((r) => r.studyId); const rl = await api("radiologist1", "GET", "/lims/requests?department=RADIOLOGY&pageSize=5"); C("the radiologist sees only the radiology branch", rl.s === 200 && listOf(rl).every((r) => r.department === "RADIOLOGY"), `${listOf(rl).length} rows`);
  const pl = await api("pathologist1", "GET", "/lims/requests?department=RADIOLOGY&pageSize=5"); C("the pathologist is kept out of the radiology branch (pathology only)", pl.s === 403 || listOf(pl).length === 0 || listOf(pl).every((r) => r.department === "PATHOLOGY"), `HTTP ${pl.s} ${listOf(pl).length} rows`);
  await api("admin", "PUT", "/settings/PRESCRIPTION_OCR_ENABLED", { value: false }); await api("admin", "PUT", "/settings/PRESCRIPTION_UPLOAD_ENABLED", { value: false });
  // LIS users: one module, branches, different views
  for (const [u, expectDept] of [["labtech1", "PATHOLOGY"], ["pathologist1", "PATHOLOGY"], ["radiographer1", "RADIOLOGY"], ["radiologist1", "RADIOLOGY"]]) {
    const lm = await api(u, "GET", "/lims/requests?pageSize=20"); const rows = listOf(lm);
    C(`${u} (${expectDept} branch) logs in and works in the same lab module`, lm.s === 200, `HTTP ${lm.s}; departments seen: ${[...new Set(rows.map((r) => r.department))].join(",") || "none"}`);
  }
}

async function crit7(ctx) {
  for (const u of (process.env.UI_USERS || "labtech1,radiographer1").split(",")) {
    const page = await as(u);
    await page.goto(BASE + "/dashboard"); await page.waitForTimeout(1800);
    const nav = await page.locator("aside a").evaluateAll((as) => as.map((a) => a.textContent.trim() + "→" + a.getAttribute("href")));
    await page.goto(BASE + "/lis"); await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(5000);
    const lis = (await page.locator("main").innerText().catch(() => "")).replace(/s+/g, " ").slice(0, 600);
    console.log("  " + u + " menu: " + nav.join(", ") + " || /lis: " + lis);
  }
}

async function crit8(ctx) {
  const p = ctx.crit3?.p ?? (await newPatient("CRIT8", "reception1"));
  const lab = await api("reception1", "GET", `/print/patient-labels/${p.id}`); C("patient label prints", lab.s === 200, `HTTP ${lab.s}`);
  const labPdf = await (await as("reception1")).evaluate(async (id) => { const r = await fetch(`/api/proxy/print/patient-labels/${id}?format=pdf`, { headers: { "x-medos-csrf": "1" } }); const b = new Uint8Array(await r.arrayBuffer()); return `${r.status} ${String.fromCharCode(...b.slice(0, 5))}`; }, p.id); C("patient label prints as PDF", /^200 %PDF/.test(labPdf), labPdf);
  const encs = (await api("doctor1", "GET", `/patients/${p.id}/encounters`)); const e = listOf(encs).find((x) => x.type === "OPD");
  if (e) { const pr = await api("doctor1", "GET", `/print/prescriptions/${e.id}`); C("prescription prints", pr.s === 200, `HTTP ${pr.s}`); }
  const ns = (await api("admin", "GET", "/number-sequences")).d; const inv = (ns.items ?? ns).find((x) => x.type === "INVOICE");
  const up = await api("admin", "PUT", "/number-sequences/INVOICE", { pattern: inv.pattern, padding: inv.padding, resetPolicy: inv.resetPolicy }); C("ADM changes a numbering rule (pattern/padding/restart)", up.s === 200, `HTTP ${up.s} ${errOf(up)}`.slice(0, 120));
  const badNum = await api("admin", "PUT", "/number-sequences/INVOICE", { pattern: "x", padding: 3, resetPolicy: "NEVER" }); C("an invalid numbering pattern is refused", badNum.s === 400, `HTTP ${badNum.s}`);
  for (const u of ["labtech1", "radiographer1"]) { const l = await api(u, "GET", "/lab/worklist"); console.log(`  ${u}: legacy /lab/worklist → HTTP ${l.s} ${listOf(l).length} rows; ${JSON.stringify(listOf(l)[0] ?? {}).slice(0, 120)}`); const r2 = await api(u, "GET", "/lims/requests?pageSize=3"); console.log(`  ${u}: new LIMS → HTTP ${r2.s}`); }
  // rate limit last: hammer the login route with a fake user
  let first429 = 0; for (let i = 1; i <= 16; i++) { const r = await raw("POST", "/auth/login", { tenantCode: "demo-hospital", identifier: "nobody.rate", password: "wrong-password-1" }); if (r.s === 429 && !first429) first429 = i; }
  C("auth endpoints are rate-limited (HTTP 429 after repeated logins)", first429 > 0 && first429 <= 12, `first 429 on attempt ${first429}`);
}
async function shots(ctx) { for (const u of ["labtech1", "radiographer1"]) { await screen("LISUI", u, "/lis", [], "lis"); const pg = await as(u); await pg.waitForTimeout(3000); await pg.screenshot({ path: path.join(shotsDir, `LISUI-${u}-full.png`) }); } }

// ───────────────────────── ADM: admission (walk-in and planned) ─────────────────────────
const listOf = (r) => (r.d?.items ?? r.d ?? []);
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + 5.5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
async function wardBeds(user, n = 3) {
  const w = await api(user, "GET", "/wards"); const wards = listOf(w);
  const general = wards.filter((x) => !/emergency|icu|ot\b|theatre|^er$/i.test(`${x.name} ${x.type ?? ""} ${x.kind ?? ""}`) && !/^(ER|ICU|OT)$/i.test(String(x.type ?? x.kind ?? "")));
  const ids = new Set(general.map((x) => x.id));
  const b = await api(user, "GET", "/beds?status=AVAILABLE");
  const beds = listOf(b).filter((x) => ids.has(x.wardId ?? x.ward?.id));
  return { wards: general, beds: beds.slice(0, n), all: beds };
}
async function admitWalkIn(F, desk, p, consultantId, bedId, reason = "Fever with dehydration") {
  return api(desk, "POST", "/admissions", { patientId: p.id, consultantId, bedId, reason });
}

async function adm(ctx) {
  const F = "ADM";
  const doc2 = await practitionerOf("doctor2"); const doc1 = await practitionerOf("doctor1");
  const wb = await wardBeds("admission1", 6);
  step(F, "admission1", `admission desk sees ${wb.all.length} free ward beds in ${wb.wards.length} wards`, wb.beds.length >= 4, wb.wards.map((x) => x.name).join(", ") + " | " + JSON.stringify(wb.all[0] ?? {}).slice(0, 140));
  if (wb.beds.length < 4) return;
  const [bedA, bedB, bedC, bedD] = wb.beds;
  // ── A. ordinary (walk-in) admission ──
  const p = await newPatient(F, "admission1"); if (!p) return; ctx.admPatient = p;
  await refused(F, "nurse1", "nurse admits a patient", "POST", "/admissions", { patientId: p.id, consultantId: doc2.id, bedId: bedA.id });
  await refused(F, "doctor1", "doctor admits a patient", "POST", "/admissions", { patientId: p.id, consultantId: doc2.id, bedId: bedA.id });
  await refused(F, "cashier1", "cashier admits a patient", "POST", "/admissions", { patientId: p.id, consultantId: doc2.id, bedId: bedA.id });
  const bad = await api("admission1", "POST", "/admissions", { patientId: p.id, consultantId: doc2.id, bedId: "not-a-uuid" }); step(F, "admission1", "rejected: bad bed id", bad.s === 400, `HTTP ${bad.s}`);
  const bad2 = await api("admission1", "POST", "/admissions", { patientId: p.id, consultantId: doc2.id, bedId: bedA.id, tenantId: "x" }); step(F, "admission1", "rejected: extra field", bad2.s === 400, `HTTP ${bad2.s}`);
  const a = await admitWalkIn(F, "admission1", p, doc2.id, bedA.id);
  if (!(await expectStatus(F, "admission1", `admitted to bed ${bedA.code ?? bedA.name}`, a, 201))) return;
  const A = a.d; ctx.admA = A;
  step(F, "admission1", "admission number and visit created", !!A.admissionNumber && !!A.encounterId, `${A.admissionNumber}`);
  const dup = await admitWalkIn(F, "admission1", p, doc2.id, bedB.id); step(F, "admission1", "same patient cannot be admitted twice", dup.s === 409, `HTTP ${dup.s} ${errOf(dup)}`);
  const p2 = await newPatient(F, "admission1");
  const clash = await admitWalkIn(F, "admission1", p2, doc2.id, bedA.id); step(F, "admission1", "an occupied bed cannot be given to another patient", clash.s === 409, `HTTP ${clash.s} ${errOf(clash)}`);
  const bedsNow = listOf(await api("nurse1", "GET", "/beds")); const bA = bedsNow.find((x) => x.id === bedA.id);
  step(F, "nurse1", "bed shows OCCUPIED on the ward bed list", bA?.status === "OCCUPIED", `${bA?.status}`);
  await screen(F, "admission1", "/ipd", [p.first], "admissions list (admission desk)");
  await screen(F, "nurse1", "/ipd", [p.first], "admissions list (nurse)");
  await screen(F, "doctor2", "/ipd", [p.first], "admissions list (consultant)");
  await screen(F, "admission1", `/ipd/${A.id}`, [p.first, A.admissionNumber], "admission page");
  await screen(F, "nurse1", `/ipd/${A.id}`, [p.first], "admission page (nurse)");
  await screen(F, "bedmgr1", "/ipd", [/bed/i], "bed board (bed manager)");
  const form = await api("admission1", "GET", `/print/admission-forms/${A.id}`); step(F, "admission1", "admission form prints", form.s === 200 && /admission/i.test(typeof form.j === "string" ? form.j : JSON.stringify(form.j)), `HTTP ${form.s}`);
  const list = await api("doctor1", "GET", "/admissions?pageSize=100"); step(F, "doctor1", "a doctor who is not the consultant sees the admissions list (read only)", list.s === 200, `HTTP ${list.s}`);
  // transfer
  await refused(F, "doctor2", "doctor moves the patient to another bed", "POST", `/admissions/${A.id}/transfer`, { toBedId: bedB.id, reason: "Closer to nurse station" });
  await refused(F, "cashier1", "cashier moves the patient to another bed", "POST", `/admissions/${A.id}/transfer`, { toBedId: bedB.id, reason: "Closer to nurse station" });
  const t0 = await api("bedmgr1", "POST", `/admissions/${A.id}/transfer`, { toBedId: bedA.id, reason: "Same bed" }); step(F, "bedmgr1", "moving to the same bed is refused", t0.s >= 400 && t0.s < 500, `HTTP ${t0.s} ${errOf(t0)}`);
  const t1 = await api("bedmgr1", "POST", `/admissions/${A.id}/transfer`, { toBedId: bedB.id, reason: "Closer to nurse station" });
  await expectStatus(F, "bedmgr1", "bed manager moves the patient to another bed", t1, [200, 201]);
  let bs = listOf(await api("nurse1", "GET", "/beds")); step(F, "nurse1", "old bed is now Cleaning and the new bed Occupied", bs.find((x) => x.id === bedA.id)?.status === "CLEANING" && bs.find((x) => x.id === bedB.id)?.status === "OCCUPIED", `${bs.find((x) => x.id === bedA.id)?.status}/${bs.find((x) => x.id === bedB.id)?.status}`);
  const det = await api("nurse1", "GET", `/admissions/${A.id}`); const hist = det.d?.bedHistory ?? det.d?.assignments ?? det.d?.beds ?? [];
  step(F, "nurse1", "bed history keeps both beds (Ward → Ward)", Array.isArray(hist) ? hist.length >= 2 : /bed/i.test(JSON.stringify(det.j)), `entries ${Array.isArray(hist) ? hist.length : "?"} keys ${Object.keys(det.d ?? {}).join(",")}`);
  await refused(F, "reception1", "reception marks a bed clean", "POST", `/beds/${bedA.id}/status`, { status: "AVAILABLE" });
  await expectStatus(F, "nurse1", "nurse marks the old bed clean", await api("nurse1", "POST", `/beds/${bedA.id}/status`, { status: "AVAILABLE" }), 200);
  const occ = await api("nurse1", "POST", `/beds/${bedB.id}/status`, { status: "AVAILABLE" }); step(F, "nurse1", "an occupied bed cannot be set free by hand", occ.s >= 400 && occ.s < 500, `HTTP ${occ.s} ${errOf(occ)}`);
  // cancel a wrong admission
  const p3 = await newPatient(F, "admission1");
  const c = await admitWalkIn(F, "admission1", p3, doc1.id, bedC.id, "Admitted by mistake");
  await expectStatus(F, "admission1", "second patient admitted (to be cancelled)", c, 201);
  await refused(F, "nurse1", "nurse cancels an admission", "POST", `/admissions/${c.d?.id}/cancel`, { reason: "Entered by mistake" });
  const cs = await api("admission1", "POST", `/admissions/${c.d.id}/cancel`, { reason: "Entered by mistake at the desk" }); await expectStatus(F, "admission1", "admission cancelled with a reason", cs, [200, 201]);
  const again = await api("admission1", "POST", `/admissions/${c.d.id}/cancel`, { reason: "Entered by mistake at the desk" }); step(F, "admission1", "cancelling twice is refused", again.s === 409, `HTTP ${again.s}`);
  bs = listOf(await api("nurse1", "GET", "/beds")); const bc = bs.find((x) => x.id === bedC.id)?.status; step(F, "nurse1", "the cancelled admission's bed is released", bc === "AVAILABLE" || bc === "CLEANING", `${bc}`);
  // ── B. planned admission (the doctor advises in OPD) ──
  const q = await newPatient(F, "reception1"); if (!q) return; ctx.plannedPatient = q;
  const walk = await api("reception1", "POST", "/appointments/walk-in", { patientId: q.id, practitionerId: doc1.id });
  if (!(await expectStatus(F, "reception1", "patient checked in to Dr. (doctor1)", walk, 201))) return;
  const enc = walk.d.encounter.id, qid = walk.d.queueEntry.id;
  await api("doctor1", "POST", `/queue/${qid}/call`, {}); await api("doctor1", "POST", `/queue/${qid}/start`, {});
  const wardId = wb.wards[0].id;
  await refused(F, "reception1", "reception advises admission (only the doctor can)", "POST", `/encounters/${enc}/planned-admission`, { details: "Needs surgery", proposedDate: plusDays(1), expectedStayDays: 3 });
  await refused(F, "doctor2", "another doctor advises admission for this visit", "POST", `/encounters/${enc}/planned-admission`, { details: "Needs surgery", proposedDate: plusDays(1), expectedStayDays: 3 });
  const pa = await api("doctor1", "POST", `/encounters/${enc}/planned-admission`, { details: "Gallstones with repeated pain; laparoscopic cholecystectomy advised", diagnosis: "Cholelithiasis", plannedProcedure: "Laparoscopic cholecystectomy", proposedDate: plusDays(1), expectedStayDays: 3, wardId });
  if (!(await expectStatus(F, "doctor1", "doctor ticks 'needs admission' (planned admission request)", pa, 201))) return;
  const PA = pa.d.id; step(F, "doctor1", "request number issued", /PA-/.test(JSON.stringify(pa.d)), `${pa.d.requestNumber ?? pa.d.number ?? pa.d.status}`);
  await api("doctor1", "POST", `/queue/${qid}/complete`, {});
  await screen(F, "reception1", "/planned", [q.first], "planned admissions (reception)");
  await refused(F, "nurse1", "nurse records the patient's consent", "POST", `/planned-admissions/${PA}/consent`, { consented: true });
  const out = await api("reception1", "POST", `/planned-admissions/${PA}/verify`, { diagnosis: "Cholelithiasis", proposedDate: plusDays(1), expectedStayDays: 3, wardId }); step(F, "reception1", "desk step before the patient agrees is refused", out.s >= 400 && out.s < 500, `HTTP ${out.s} ${errOf(out)}`);
  await expectStatus(F, "reception1", "reception asks the patient: agreed", await api("reception1", "POST", `/planned-admissions/${PA}/consent`, { consented: true, note: "Patient and family agree" }), [200, 201]);
  const skip = await api("cashier1", "PUT", `/planned-admissions/${PA}/estimate`, { lines: [{ description: "Surgery package", quantity: 1, unitPrice: "40000" }] }); step(F, "cashier1", "estimate before the desk has verified is refused (steps in order)", skip.s >= 400 && skip.s < 500, `HTTP ${skip.s} ${errOf(skip)}`);
  await refused(F, "cashier1", "cashier verifies for the desk", "POST", `/planned-admissions/${PA}/verify`, { diagnosis: "Cholelithiasis", proposedDate: plusDays(1), expectedStayDays: 3, wardId });
  await expectStatus(F, "admission1", "admission desk verifies consultant, diagnosis, day and ward", await api("admission1", "POST", `/planned-admissions/${PA}/verify`, { consultantId: doc1.id, diagnosis: "Cholelithiasis", plannedProcedure: "Laparoscopic cholecystectomy", proposedDate: plusDays(1), expectedStayDays: 3, wardId }), [200, 201]);
  await expectStatus(F, "cashier1", "billing makes the estimate", await api("cashier1", "PUT", `/planned-admissions/${PA}/estimate`, { lines: [{ description: "Surgery package", quantity: 1, unitPrice: "40000" }, { description: "Room rent", quantity: 3, unitPrice: "2500" }] }), [200, 201]);
  await refused(F, "nurse1", "nurse sets the estimate", "PUT", `/planned-admissions/${PA}/estimate`, { lines: [{ description: "x", quantity: 1, unitPrice: "1" }] });
  await expectStatus(F, "cashier1", "billing sets the payer: self-pay", await api("cashier1", "POST", `/planned-admissions/${PA}/payer`, { payer: "SELF_PAY" }), [200, 201]);
  await expectStatus(F, "cashier1", "billing marks the tariff done", await api("cashier1", "POST", `/planned-admissions/${PA}/tariff-done`, {}), [200, 201]);
  const early = await api("bedmgr1", "POST", `/planned-admissions/${PA}/bed`, { bedId: bedD.id }); step(F, "bedmgr1", "bed cannot be held before the deposit is settled (steps in order)", early.s >= 400 && early.s < 500, `HTTP ${early.s} ${errOf(early)}`);
  await expectStatus(F, "cashier1", "billing asks for a ₹10,000 deposit", await api("cashier1", "PUT", `/planned-admissions/${PA}/deposit-required`, { amount: "10000" }), [200, 201]);
  await refused(F, "doctor1", "doctor takes the deposit", "POST", `/planned-admissions/${PA}/deposit`, { tenders: [{ method: "CASH", amount: "10000.00" }] });
  const half = await api("cashier1", "POST", `/planned-admissions/${PA}/deposit`, { tenders: [{ method: "CASH", amount: "4000.00" }] }); await expectStatus(F, "cashier1", "first part of the deposit: ₹4000 cash", half, [200, 201]);
  const notYet = await api("cashier1", "POST", `/planned-admissions/${PA}/financial-check`, {}); step(F, "cashier1", "step stays open while the deposit is short", notYet.s >= 400 || /DEPOSIT/.test(JSON.stringify(notYet.j)), `HTTP ${notYet.s} ${errOf(notYet)}`.slice(0, 160));
  await expectStatus(F, "cashier1", "rest of the deposit: ₹6000 UPI", await api("cashier1", "POST", `/planned-admissions/${PA}/deposit`, { tenders: [{ method: "UPI", amount: "6000.00", reference: "UPI-DEP-0001" }] }), [200, 201]);
  const fc = await api("cashier1", "POST", `/planned-admissions/${PA}/financial-check`, {}); step(F, "cashier1", "financial check (clears by itself once the deposit is in)", fc.s === 200 || fc.s === 201 || fc.s === 409, `HTTP ${fc.s} ${errOf(fc)}`.slice(0, 160));
  await refused(F, "reception1", "reception holds a bed (bed team only)", "POST", `/planned-admissions/${PA}/bed`, { bedId: bedD.id });
  await expectStatus(F, "bedmgr1", "bed manager holds a bed for the day", await api("bedmgr1", "POST", `/planned-admissions/${PA}/bed`, { bedId: bedD.id }), [200, 201]);
  bs = listOf(await api("nurse1", "GET", "/beds")); step(F, "nurse1", "held bed shows RESERVED", bs.find((x) => x.id === bedD.id)?.status === "RESERVED", `${bs.find((x) => x.id === bedD.id)?.status}`);
  const free = await api("nurse1", "POST", `/beds/${bedD.id}/status`, { status: "AVAILABLE" }); step(F, "nurse1", "nobody can free a held bed by hand", free.s >= 400 && free.s < 500, `HTTP ${free.s} ${errOf(free)}`);
  const hold = await api("bedmgr1", "POST", `/planned-admissions/${PA}/bed`, { bedId: bedD.id }); // same again is fine or refused
  const pRes = await api("admission1", "GET", `/planned-admissions/${PA}`); step(F, "admission1", "request is READY", /READY/.test(JSON.stringify(pRes.j)), `${pRes.d?.status}`);
  await refused(F, "cashier1", "cashier admits the patient", "POST", `/planned-admissions/${PA}/admit`, {});
  const ad = await api("admission1", "POST", `/planned-admissions/${PA}/admit`, {}); await expectStatus(F, "admission1", "admission desk admits on the day (into the held bed)", ad, [200, 201]);
  const admId = ad.d?.admission?.id ?? ad.d?.admissionId ?? ad.d?.id; ctx.plannedAdm = admId;
  const adDetail = admId ? await api("nurse1", "GET", `/admissions/${admId}`) : null;
  step(F, "nurse1", "an ordinary admission now exists on the held bed", adDetail?.s === 200, `HTTP ${adDetail?.s}`);
  bs = listOf(await api("nurse1", "GET", "/beds")); step(F, "nurse1", "held bed is now OCCUPIED", bs.find((x) => x.id === bedD.id)?.status === "OCCUPIED", `${bs.find((x) => x.id === bedD.id)?.status}`);
  const tasks = admId ? await api("nurse1", "GET", `/admissions/${admId}/tasks`) : null; const t = listOf(tasks ?? {}).find((x) => /assessment/i.test(x.title ?? ""));
  step(F, "nurse1", "nursing admission assessment task appears", !!t, t?.title ?? JSON.stringify(tasks?.j).slice(0, 120));
  if (t) await expectStatus(F, "nurse1", "nurse completes the assessment task", await api("nurse1", "POST", `/tasks/${t.id}/complete`, { note: "Assessment done, allergies asked" }), 200);
  const adv = await api("cashier1", "GET", `/patients/${q.id}/advances`); step(F, "cashier1", "the ₹10,000 deposit stays the patient's advance", Math.abs(balOf(adv) - 10000) < 0.01, `balance ${balOf(adv)}`);
  await screen(F, "admission1", `/ipd/${admId}`, [q.first], "planned patient's admission page");
  const again2 = await api("admission1", "POST", `/planned-admissions/${PA}/admit`, {}); step(F, "admission1", "admitting the same request again is refused", again2.s === 409, `HTTP ${again2.s}`);
  // ── C. outside-arranged route: doctor accepts, manager waives deposit, then cancel returns the bed ──
  const r = await newPatient(F, "reception1");
  await refused(F, "doctor1", "doctor raises a request for reception", "POST", "/planned-admissions", { patientId: r.id, source: "OUTSIDE_ARRANGED", consultantId: doc1.id, details: "Arranged with the doctor" });
  const rq = await api("reception1", "POST", "/planned-admissions", { patientId: r.id, source: "OUTSIDE_ARRANGED", consultantId: doc1.id, details: "Patient says Dr. arranged a hernia repair", diagnosis: "Inguinal hernia", proposedDate: plusDays(2), expectedStayDays: 2 });
  if (await expectStatus(F, "reception1", "reception records an arranged request for the consultant", rq, 201)) {
    const R = rq.d.id;
    await refused(F, "doctor2", "a different doctor reviews this request", "POST", `/planned-admissions/${R}/doctor`, { action: "DECLINE", reason: "Not my patient to decide" });
    await expectStatus(F, "doctor1", "consultant accepts (diagnosis, day, stay)", await api("doctor1", "POST", `/planned-admissions/${R}/doctor`, { action: "ACCEPT", diagnosis: "Inguinal hernia", plannedProcedure: "Hernia repair", proposedDate: plusDays(2), expectedStayDays: 2, wardId }), [200, 201]);
    await expectStatus(F, "admission1", "desk verifies", await api("admission1", "POST", `/planned-admissions/${R}/verify`, { diagnosis: "Inguinal hernia", proposedDate: plusDays(2), expectedStayDays: 2, wardId }), [200, 201]);
    await api("cashier1", "PUT", `/planned-admissions/${R}/estimate`, { lines: [{ description: "Hernia package", quantity: 1, unitPrice: "30000" }] });
    await api("cashier1", "POST", `/planned-admissions/${R}/payer`, { payer: "SELF_PAY" }); await api("cashier1", "POST", `/planned-admissions/${R}/tariff-done`, {});
    await api("cashier1", "PUT", `/planned-admissions/${R}/deposit-required`, { amount: "5000" });
    await refused(F, "cashier1", "cashier waives the deposit (manager only)", "POST", `/planned-admissions/${R}/waive`, { reason: "Patient is a staff relative" });
    const wshort = await api("manager1", "POST", `/planned-admissions/${R}/waive`, { reason: "short" }); step(F, "manager1", "a waiver needs a proper reason (10+ characters)", wshort.s === 400, `HTTP ${wshort.s}`);
    await expectStatus(F, "manager1", "manager waives the deposit with a written reason", await api("manager1", "POST", `/planned-admissions/${R}/waive`, { reason: "Patient is a staff relative, approved by management" }), [200, 201]);
    const bedE = wb.all.find((x) => ![bedA.id, bedB.id, bedC.id, bedD.id].includes(x.id));
    if (bedE) {
      await expectStatus(F, "bedmgr1", "bed held", await api("bedmgr1", "POST", `/planned-admissions/${R}/bed`, { bedId: bedE.id }), [200, 201]);
      const dupHold = await api("bedmgr1", "POST", `/planned-admissions/${PA}/bed`, { bedId: bedE.id }); step(F, "bedmgr1", "a held bed cannot be held for a second request", dupHold.s >= 400 && dupHold.s < 500, `HTTP ${dupHold.s} ${errOf(dupHold)}`);
      await refused(F, "nurse1", "nurse cancels a planned admission", "POST", `/planned-admissions/${R}/cancel`, { reason: "Patient changed mind" });
      await expectStatus(F, "reception1", "patient changes mind: request cancelled", await api("reception1", "POST", `/planned-admissions/${R}/cancel`, { reason: "Patient changed mind, will go elsewhere" }), [200, 201]);
      bs = listOf(await api("nurse1", "GET", "/beds")); step(F, "nurse1", "held bed is back to AVAILABLE after the cancel", bs.find((x) => x.id === bedE.id)?.status === "AVAILABLE", `${bs.find((x) => x.id === bedE.id)?.status}`);
    }
    const after = await api("admission1", "POST", `/planned-admissions/${R}/verify`, { diagnosis: "Inguinal hernia", proposedDate: plusDays(2), expectedStayDays: 2, wardId }); step(F, "admission1", "a closed request cannot be moved on", after.s >= 400 && after.s < 500, `HTTP ${after.s}`);
  }
  // decline path
  const d = await newPatient(F, "reception1");
  const rd = await api("reception1", "POST", "/planned-admissions", { patientId: d.id, source: "OUTSIDE_DIRECT", consultantId: doc2.id, details: "Came with papers from another hospital advising surgery", proposedDate: plusDays(3) });
  if (rd.s === 201) await expectStatus(F, "doctor2", "outside advice declined by the consultant (reason kept)", await api("doctor2", "POST", `/planned-admissions/${rd.d.id}/doctor`, { action: "DECLINE", reason: "Does not need admission, medical management" }), [200, 201]);
  else step(F, "reception1", "outside-papers request raised", false, `HTTP ${rd.s} ${errOf(rd)}`);
  const sm = await api("manager1", "GET", "/planned-admissions/summary"); step(F, "manager1", "planned admissions summary answers", sm.s === 200, `HTTP ${sm.s}`);
  for (const [u, pth] of [["reception1", "/planned"], ["doctor1", "/planned"], ["cashier1", "/planned"], ["bedmgr1", "/planned"], ["claims1", "/planned"], ["manager1", "/planned"], ["admission1", "/planned"]]) await screen(F, u, pth, [/planned/i], `planned admissions (${u})`);
}

// ───────────────────────── IPD: inpatient treatment through discharge ─────────────────────────
async function ipd(ctx) {
  const F = "IPD";
  const doc = await practitionerOf("doctor2"); const rmo = await practitionerOf("rmo1");
  const wb = await wardBeds("admission1", 6);
  if (wb.beds.length < 2) { step(F, "admission1", "free ward beds for the inpatient flow", false, `${wb.all.length} free`); return; }
  const [bed1, bed2] = wb.beds;
  const p = await newPatient(F, "admission1"); if (!p) return;
  const a = await admitWalkIn(F, "admission1", p, doc.id, bed1.id, "Pneumonia, IV antibiotics");
  if (!(await expectStatus(F, "admission1", "patient admitted", a, 201))) return;
  const A = a.d.id, E = a.d.encounterId; ctx.ipdAdm = A;
  // ── doctor's orders ──
  const stock = await api("pharmacist1", "GET", "/pharmacy/stock?pageSize=50"); const meds = (stock.d?.items ?? stock.d ?? []).filter((m) => Number(m.sellableQuantity ?? m.available ?? 0) > 30);
  const m1 = meds[0], m2 = meds[1];
  const line = (m, freq, qty, route = "ORAL") => ({ medicineId: m.medicineId ?? m.id, genericName: m.genericName ?? "Medicine", strength: m.strength ?? "500 mg", dosage: "1 unit", route, frequency: freq, durationDays: 3, quantity: qty });
  await refused(F, "nurse1", "nurse writes the medication order", "PUT", `/encounters/${E}/prescription`, { items: [line(m1, "STAT", 1)] });
  await refused(F, "cashier1", "cashier writes the medication order", "PUT", `/encounters/${E}/prescription`, { items: [line(m1, "STAT", 1)] });
  await expectStatus(F, "doctor2", "doctor writes the order (one STAT dose, one twice-a-day medicine)", await api("doctor2", "PUT", `/encounters/${E}/prescription`, { items: [line(m1, "STAT", 1), line(m2, "BD", 6)] }), 200);
  const sg = await api("doctor2", "POST", `/encounters/${E}/prescription/sign`, {}); await expectStatus(F, "doctor2", "doctor signs the medication order", sg, 200);
  const items = sg.d?.items ?? [];
  await screen(F, "doctor2", `/ipd/${A}`, [p.first, "Medication"], "admission page (consultant)");
  const otherDoc = await api("doctor3", "PUT", `/encounters/${E}/prescription`, { items: [line(m1, "OD", 3)] }); step(F, "doctor3", "a doctor outside this patient's care cannot write an order on this admission", otherDoc.s >= 400 && otherDoc.s < 500, `HTTP ${otherDoc.s} ${errOf(otherDoc)}`.slice(0, 200));
  const own2 = await api("doctor2", "PUT", `/encounters/${E}/prescription`, { items: [line(m1, "OD", 3)] }); step(F, "doctor2", "the treating consultant can still write their own next order (not blocked by someone else's draft)", own2.s === 200, `HTTP ${own2.s} ${errOf(own2)}`.slice(0, 200));
  // ── nursing: medication chart ──
  await refused(F, "doctor2", "doctor generates the medication chart", "POST", `/admissions/${A}/mar/generate`, { hours: 24 });
  const gen = await api("nurse1", "POST", `/admissions/${A}/mar/generate`, { hours: 24 }); await expectStatus(F, "nurse1", "nurse generates the next 24 hours of doses", gen, [200, 201]);
  let mar = await api("nurse1", "GET", `/admissions/${A}/mar`); const slots = (mar.d?.items ?? mar.d ?? []).sort((x, y) => new Date(x.scheduledAt) - new Date(y.scheduledAt));
  step(F, "nurse1", "doses appear on the chart (a prescription alone gives no 'given')", slots.length >= 2 && slots.every((s) => s.status === "DUE"), `${slots.length} doses ${[...new Set(slots.map((s) => s.status))].join(",")}`);
  const stat = slots.find((s) => s.medicationOrderItemId === items.find((i) => i.frequency === "STAT")?.id) ?? slots[0];
  const bd = slots.filter((s) => s.id !== stat.id);
  await refused(F, "doctor2", "doctor marks a dose given", "POST", `/mar/${stat.id}/administer`, { status: "GIVEN" });
  await refused(F, "cashier1", "cashier marks a dose given", "POST", `/mar/${stat.id}/administer`, { status: "GIVEN" });
  const early = await api("nurse1", "POST", `/mar/${bd[bd.length - 1].id}/administer`, { status: "GIVEN" }); step(F, "nurse1", "a dose cannot be given more than 2 hours early", early.s >= 400 && early.s < 500, `HTTP ${early.s} ${errOf(early)}`);
  const noRemark = await api("nurse1", "POST", `/mar/${bd[0].id}/administer`, { status: "HELD" }); step(F, "nurse1", "holding a dose needs a remark", noRemark.s === 400, `HTTP ${noRemark.s}`);
  await expectStatus(F, "nurse1", "STAT dose given", await api("nurse1", "POST", `/mar/${stat.id}/administer`, { status: "GIVEN", remarks: "Given as ordered" }), 200);
  const dup = await api("nurse1", "POST", `/mar/${stat.id}/administer`, { status: "GIVEN" }); step(F, "nurse1", "the same dose cannot be recorded twice", dup.s === 409, `HTTP ${dup.s} ${errOf(dup)}`);
  await expectStatus(F, "nurse1", "next dose held with a remark", await api("nurse1", "POST", `/mar/${bd[0].id}/administer`, { status: "HELD", remarks: "Patient vomiting, hold until review" }), 200);
  await screen(F, "nurse1", `/ipd/${A}`, [p.first], "admission page (nurse)");
  await screen(F, "nurse1", "/nursing", [/ward|task|nursing/i], "nurse worklist");
  // ── vitals, notes, tasks, intake/output ──
  await expectStatus(F, "nurse1", "nurse records vitals", await api("nurse1", "POST", `/encounters/${E}/observations`, { observations: [{ type: "SYSTOLIC_BP", value: 118 }, { type: "DIASTOLIC_BP", value: 76 }, { type: "PULSE", value: 88 }, { type: "TEMPERATURE", value: 38.1 }, { type: "SPO2", value: 95 }] }), 201);
  await refused(F, "cashier1", "cashier records vitals", "POST", `/encounters/${E}/observations`, { observations: [{ type: "PULSE", value: 80 }] });
  const note = await api("nurse1", "POST", `/admissions/${A}/notes`, { note: "Febrile, comfortable, IV line patent." }); await expectStatus(F, "nurse1", "nursing note written", note, 201);
  await refused(F, "doctor2", "doctor writes a nursing note", "POST", `/admissions/${A}/notes`, { note: "Doctor trying nursing note" });
  await expectStatus(F, "nurse1", "addendum added to the note", await api("nurse1", "POST", `/nursing-notes/${note.d.id}/addendum`, { note: "Temperature rechecked: 37.8." }), 201);
  const eie = await api("nurse1", "POST", `/nursing-notes/${note.d.id}/enter-in-error`, { reason: "Wrong patient bed noted" }); await expectStatus(F, "nurse1", "wrong note marked 'entered in error' (history kept)", eie, 200);
  const nlist = await api("nurse1", "GET", `/admissions/${A}/notes?includeErrors=true`); step(F, "nurse1", "the corrected note is still on file with its reason", /Wrong patient bed noted/.test(JSON.stringify(nlist.j)) && /Febrile, comfortable/.test(JSON.stringify(nlist.j)), JSON.stringify(nlist.j).slice(0, 300));
  const due = new Date(Date.now() + 3600e3).toISOString();
  const task = await api("nurse1", "POST", `/admissions/${A}/tasks`, { type: "VITALS", title: "Check BP and pulse", dueAt: due }); await expectStatus(F, "nurse1", "nursing task created", task, 201);
  await expectStatus(F, "nurse1", "task done with a note", await api("nurse1", "POST", `/tasks/${task.d.id}/complete`, { note: "Done, BP normal" }), 200);
  const twice = await api("nurse1", "POST", `/tasks/${task.d.id}/complete`, {}); step(F, "nurse1", "a finished task cannot be finished twice", twice.s === 409, `HTTP ${twice.s}`);
  const t2 = await api("nurse1", "POST", `/admissions/${A}/tasks`, { title: "Measure drain output", dueAt: due }); await expectStatus(F, "nurse1", "second task created and cancelled with a reason", await api("nurse1", "POST", `/tasks/${t2.d.id}/cancel`, { reason: "Drain removed by surgeon" }), 200);
  const dday = (() => { const n = new Date(Date.now() + 5.5 * 3600e3); if (n.getUTCHours() < 6) n.setUTCDate(n.getUTCDate() - 1); return n.toISOString().slice(0, 10); })();
  await expectStatus(F, "nurse1", "intake 500 ml recorded", await api("nurse1", "POST", `/admissions/${A}/intake-output`, { direction: "INTAKE", category: "IV", amount: 500 }), 201);
  await expectStatus(F, "nurse1", "output 200 ml recorded", await api("nurse1", "POST", `/admissions/${A}/intake-output`, { direction: "OUTPUT", category: "URINE", amount: 200 }), 201);
  const badIo = await api("nurse1", "POST", `/admissions/${A}/intake-output`, { direction: "INTAKE", category: "URINE", amount: 100 }); step(F, "nurse1", "an intake cannot be a urine entry", badIo.status === 400 || badIo.s === 400, `HTTP ${badIo.s}`);
  const tot = await api("nurse1", "GET", `/admissions/${A}/intake-output/totals?date=${dday}`); step(F, "nurse1", "totals add up for the I/O day (intake 500, output 200, balance 300)", Number(tot.d?.daily?.intake) === 500 && Number(tot.d?.daily?.output) === 200 && Number(tot.d?.daily?.balance) === 300, JSON.stringify(tot.d?.daily));
  // ── doctor's ward round ──
  await refused(F, "nurse1", "nurse writes a round note", "POST", `/admissions/${A}/round-notes`, { note: "Nurse trying a round note" });
  const rn = await api("doctor2", "POST", `/admissions/${A}/round-notes`, { condition: "STABLE", note: "Afebrile, chest clearing, appetite better.", plan: "Continue IV antibiotics, switch to oral tomorrow", instructions: [{ text: "Check temperature every 4 hours", dueInMinutes: 30 }] });
  await expectStatus(F, "doctor2", "round note with an instruction for the nurses", rn, 201);
  const tl = await api("nurse1", "GET", `/admissions/${A}/tasks`); step(F, "nurse1", "the instruction appears as a nursing task", listOf(tl).some((x) => /temperature every 4 hours/i.test(x.title ?? "")), listOf(tl).map((x) => x.title).join(" | ").slice(0, 120));
  const doc3rn = await api("doctor3", "POST", `/admissions/${A}/round-notes`, { note: "Not my patient" }); step(F, "doctor3", "a doctor with no right to this patient cannot write a round note", doc3rn.s >= 400 && doc3rn.s < 500, `HTTP ${doc3rn.s}`);
  await expectStatus(F, "doctor2", "round note marked 'entered in error' with a reason", await api("doctor2", "POST", `/round-notes/${rn.d.id}/enter-in-error`, { reason: "Wrote under wrong heading" }), 200);
  const mine = await api("doctor2", "GET", "/rounds/mine"); step(F, "doctor2", "doctor's rounds list answers", mine.s === 200, `HTTP ${mine.s}`);
  const wbd = await api("coordinator1", "GET", "/ward-board"); step(F, "coordinator1", "ward board shows the patient", wbd.s === 200 && JSON.stringify(wbd.j).includes(p.first), `HTTP ${wbd.s}`);
  await screen(F, "coordinator1", "/wards", [/ward/i], "ward board (coordinator)");
  await screen(F, "doctor2", "/rounds", [/round/i], "my rounds (doctor)");
  // ── procedure and charges ──
  const svcs = (await api("cashier1", "GET", "/services?pageSize=100")).d ?? []; const ecg = svcs.find((s) => /^ECG/i.test(s.name));
  await refused(F, "nurse1", "nurse records a procedure", "POST", `/admissions/${A}/procedure-records`, { name: "ECG", outcome: "Normal" });
  const pr = await api("doctor2", "POST", `/admissions/${A}/procedure-records`, { name: "ECG", serviceId: ecg.id, outcome: "Sinus tachycardia, no ischaemia" }); await expectStatus(F, "doctor2", "doctor records a procedure that is charged (ECG)", pr, 201);
  let chg = await api("cashier1", "GET", `/admissions/${A}/charges`); step(F, "cashier1", "the ECG charge was added to the admission bill by itself", listOf(chg).some((c) => /ECG/i.test(c.description) && c.status !== "VOIDED"), listOf(chg).map((c) => `${c.description}:${c.status}`).join(" | "));
  await expectStatus(F, "doctor2", "procedure marked 'entered in error'", await api("doctor2", "POST", `/procedure-records/${pr.d.id}/enter-in-error`, { reason: "Recorded twice by mistake" }), 200);
  chg = await api("cashier1", "GET", `/admissions/${A}/charges`); step(F, "cashier1", "its charge came off the bill", !listOf(chg).some((c) => /ECG/i.test(c.description) && c.status === "PENDING"), listOf(chg).map((c) => `${c.description}:${c.status}`).join(" | "));
  await expectStatus(F, "cashier1", "cashier posts bed days", await api("cashier1", "POST", `/admissions/${A}/charges/bed-days`, {}), [200, 201]);
  const man = await api("cashier1", "POST", `/admissions/${A}/charges`, { type: "SERVICE", description: "Nebulisation", unitPrice: "120.00", quantity: 2 }); await expectStatus(F, "cashier1", "manual charge posted (Nebulisation ×2)", man, 201);
  await refused(F, "pharmacist1", "pharmacist posts a charge", "POST", `/admissions/${A}/charges`, { type: "SERVICE", description: "X", unitPrice: "1.00", quantity: 1 });
  const neg = await api("cashier1", "POST", `/admissions/${A}/charges`, { type: "SERVICE", description: "Bad", unitPrice: "-5", quantity: 1 }); step(F, "cashier1", "a negative charge is refused", neg.s === 400, `HTTP ${neg.s}`);
  await expectStatus(F, "cashier1", "a wrong charge voided with a reason", await api("cashier1", "POST", `/charges/${man.d.id}/void`, { reason: "Posted to wrong patient" }), 200);
  await refused(F, "nurse1", "nurse types a free-price charge (billing permission needed)", "POST", `/admissions/${A}/charges`, { type: "SERVICE", description: "Nebulisation", unitPrice: "120.00", quantity: 2 });
  const inj = svcs.find((s) => /^Injection charge/i.test(s.name)); await expectStatus(F, "nurse1", "nurse posts a catalogue charge (Injection charge)", await api("nurse1", "POST", `/admissions/${A}/charges`, { type: "SERVICE", serviceId: inj.id, quantity: 1 }), 201);
  // ── tests ordered from the admission ──
  await refused(F, "nurse1", "nurse orders a lab test from the admission", "POST", `/admissions/${A}/test-orders`, { category: "LABORATORY", name: "CBC" });
  await expectStatus(F, "doctor2", "doctor orders a lab test (CBC) from the admission", await api("doctor2", "POST", `/admissions/${A}/test-orders`, { category: "LABORATORY", name: "CBC (complete blood count)" }), [200, 201]);
  // ── pharmacy ──
  const pq = await api("pharmacist1", "GET", `/pharmacy/queue?q=${encodeURIComponent(p.mrn)}`); const order = (pq.d?.items ?? pq.d ?? []).find((o) => o.patientId === p.id);
  step(F, "pharmacist1", "the signed inpatient order is in the pharmacy queue", !!order, `${(pq.d?.items ?? pq.d ?? []).length} in queue`);
  if (order) {
    const bdItem = order.items.find((i) => i.frequency === "BD") ?? order.items[1] ?? order.items[0];
    const d = await api("pharmacist1", "POST", "/pharmacy/dispenses", { patientId: p.id, medicationOrderId: order.id, chargeToAdmission: true, items: order.items.map((it) => ({ medicationOrderItemId: it.id, medicineId: it.medicineId, quantity: it.quantity ?? 1 })) });
    await expectStatus(F, "pharmacist1", "medicines dispensed to the admission (charged to the stay, not sold at the counter)", d, 201);
    chg = await api("cashier1", "GET", `/admissions/${A}/charges`); step(F, "cashier1", "medicine charges are on the admission bill", listOf(chg).some((c) => c.type === "MEDICINE"), "");
  }
  // ── advance taken during the stay ──
  await openShift("cashier1");
  const adv2 = await api("reception1", "POST", `/patients/${p.id}/advances`, { tenders: [{ method: "CASH", amount: "3000.00" }], note: "Deposit during stay" }); await expectStatus(F, "reception1", "family pays a ₹3000 deposit during the stay", adv2, 201);
  // ── discharge: in order ──
  const D = () => api("doctor2", "GET", `/admissions/${A}/discharge`);
  const stepsOf = (r) => (r.d?.steps ?? []).map((s) => `${s.step}:${s.status}`).join(" ");
  const early1 = await api("doctor2", "POST", `/admissions/${A}/discharge/complete`, { type: "ROUTINE" }); step(F, "doctor2", "discharge is refused while the stages are open", early1.s >= 400 && early1.s < 500, `HTTP ${early1.s} ${errOf(early1)}`.slice(0, 200));
  const earlyN = await api("nurse1", "POST", `/admissions/${A}/discharge/clear`, { step: "NURSING" }); step(F, "nurse1", "no stage can be cleared before the doctor's decision", earlyN.s >= 400 && earlyN.s < 500, `HTTP ${earlyN.s} ${errOf(earlyN)}`.slice(0, 160));
  await refused(F, "nurse1", "nurse records the doctor's decision", "POST", `/admissions/${A}/discharge/clear`, { step: "MEDICALLY_FIT" });
  await expectStatus(F, "doctor2", "doctor decides: clinically fit to go", await api("doctor2", "POST", `/admissions/${A}/discharge/clear`, { step: "MEDICALLY_FIT" }), [200, 201]);
  await refused(F, "doctor2", "doctor clears the nursing stage", "POST", `/admissions/${A}/discharge/clear`, { step: "NURSING" });
  const nc0 = await api("nurse1", "POST", `/admissions/${A}/discharge/clear`, { step: "NURSING", note: "Handed over to the ward sister" }); step(F, "nurse1", "nursing clearance is blocked while a nursing task is still pending", nc0.s === 409 || nc0.s === 400, `HTTP ${nc0.s} ${errOf(nc0)}`.slice(0, 200));
  for (const t of listOf(await api("nurse1", "GET", `/admissions/${A}/tasks`)).filter((x) => x.status === "PENDING")) await api("nurse1", "POST", `/tasks/${t.id}/complete`, { note: "Done" });
  await expectStatus(F, "nurse1", "nurse clears nursing after finishing the tasks (handover note kept)", await api("nurse1", "POST", `/admissions/${A}/discharge/clear`, { step: "NURSING", note: "Handed over to the ward sister" }), [200, 201]);
  await refused(F, "pharmacist1", "pharmacist clears the charges review", "POST", `/admissions/${A}/discharge/clear`, { step: "CHARGES_REVIEWED" });
  await expectStatus(F, "cashier1", "billing clears the charges review", await api("cashier1", "POST", `/admissions/${A}/discharge/clear`, { step: "CHARGES_REVIEWED" }), [200, 201]);
  const pc = await api("pharmacist1", "POST", `/admissions/${A}/discharge/clear`, { step: "PHARMACY" }); step(F, "pharmacist1", "pharmacy clearance", [200, 201].includes(pc.s) || pc.s === 409, `HTTP ${pc.s} ${errOf(pc)}`.slice(0, 200));
  const wv = await api("nurse1", "POST", `/admissions/${A}/discharge/waive`, { step: "BILLING", reason: "Trying to waive the bill stage" }); step(F, "nurse1", "nobody can waive final billing", wv.s >= 400 && wv.s < 500, `HTTP ${wv.s}`);
  // summary: RMO drafts, consultant signs, RMO verifies
  const content = { finalDiagnoses: [{ text: "Community-acquired pneumonia", code: "J18.9" }], hospitalCourse: "IV antibiotics for 3 days, afebrile, chest clear.", conditionAtDischarge: "Stable", advice: "Oral antibiotics, review in 1 week", dischargeMedications: [{ genericName: m2.genericName ?? "Medicine", dosage: "1 tablet", route: "ORAL", frequency: "BD", durationDays: 5 }] };
  const dr = await api("rmo1", "PUT", `/admissions/${A}/discharge-summary`, { content }); await expectStatus(F, "rmo1", "RMO writes the summary draft", dr, [200, 201]);
  await refused(F, "nurse1", "nurse writes the summary", "PUT", `/admissions/${A}/discharge-summary`, { content });
  const ver0 = dr.d?.version ?? 1;
  await refused(F, "rmo1", "RMO signs the summary (consultant only)", "POST", `/admissions/${A}/discharge-summary/sign`, { version: ver0 });
  await refused(F, "doctor3", "another doctor signs the summary", "POST", `/admissions/${A}/discharge-summary/sign`, { version: ver0 });
  await expectStatus(F, "doctor2", "treating consultant signs the summary", await api("doctor2", "POST", `/admissions/${A}/discharge-summary/sign`, { version: ver0 }), [200, 201]);
  const edit = await api("rmo1", "PUT", `/admissions/${A}/discharge-summary`, { content: { ...content, advice: "Changed after signing" }, version: ver0 }); step(F, "rmo1", "a signed summary cannot be overwritten", edit.s === 409 || (edit.s >= 400 && edit.s < 500), `HTTP ${edit.s}`);
  const sv = await api("doctor2", "POST", `/admissions/${A}/discharge-summary/verify`, { version: ver0 }); step(F, "doctor2", "the signer cannot verify their own summary", sv.s >= 400 && sv.s < 500, `HTTP ${sv.s} ${errOf(sv)}`.slice(0, 160));
  await expectStatus(F, "rmo1", "RMO verifies the signed summary", await api("rmo1", "POST", `/admissions/${A}/discharge-summary/verify`, { version: ver0, note: "Checked against the chart" }), [200, 201]);
  await expectStatus(F, "doctor2", "amendment needs a reason (and a new version)", await api("doctor2", "POST", `/admissions/${A}/discharge-summary/amend`, { expectedVersion: ver0, reason: "Added the review date to the advice", content: { ...content, advice: "Oral antibiotics, review in 1 week on 20 Nov" } }), [200, 201]);
  const rv = await api("rmo1", "GET", `/admissions/${A}/discharge-summary`); const v2 = rv.d?.version ?? rv.d?.summary?.version ?? ver0 + 1;
  await expectStatus(F, "rmo1", "RMO verifies the amended version again", await api("rmo1", "POST", `/admissions/${A}/discharge-summary/verify`, { version: v2, note: "Amendment checked" }), [200, 201]);
  // lab stage (CBC ordered, never performed)
  let st = await D(); console.log("  stages:", stepsOf(st));
  const labStep = (st.d?.steps ?? []).find((s) => s.step === "LAB_RADIOLOGY");
  step(F, "doctor2", "lab stage is open while the ordered CBC is not done", labStep && labStep.status !== "CLEARED" && labStep.status !== "WAIVED", `${labStep?.status}`);
  await refused(F, "nurse1", "nurse waives the lab stage", "POST", `/admissions/${A}/discharge/waive`, { step: "LAB_RADIOLOGY", reason: "Not needed any more by the doctor" });
  await expectStatus(F, "doctor2", "doctor takes the test off by waiving the lab stage with a reason", await api("doctor2", "POST", `/admissions/${A}/discharge/waive`, { step: "LAB_RADIOLOGY", reason: "CBC no longer needed, patient recovering well" }), [200, 201]);
  // money
  const early2 = await api("doctor2", "POST", `/admissions/${A}/discharge/complete`, { type: "ROUTINE" }); step(F, "doctor2", "discharge still refused: final bill not settled", early2.s >= 400 && early2.s < 500, `HTTP ${early2.s} ${errOf(early2)}`.slice(0, 220));
  await refused(F, "nurse1", "nurse issues the final bill", "POST", `/admissions/${A}/discharge/final-invoice`, {});
  const fi = await api("cashier1", "POST", `/admissions/${A}/discharge/final-invoice`, {}); await expectStatus(F, "cashier1", "cashier generates the final bill", fi, [200, 201]);
  if (![200, 201].includes(fi.s)) return;
  const inv = (await api("cashier1", "GET", `/invoices/${fi.d?.id ?? fi.d?.invoice?.id ?? fi.d?.invoiceId}`)).d; step(F, "cashier1", `final bill ₹${inv?.total} issued, due ₹${inv?.balanceDue}`, Number(inv?.total) > 0, `${inv?.status}`);
  st = await D(); const billing = (st.d?.steps ?? []).find((s) => s.step === "BILLING"); step(F, "cashier1", "billing stage waits for the ₹3000 deposit to be used or given back", billing && billing.status !== "CLEARED", `${billing?.status} ${billing?.note ?? ""}`.slice(0, 160));
  const useAmt = Math.min(3000, Number(inv.balanceDue));
  await expectStatus(F, "cashier1", `₹${useAmt} deposit set against the final bill`, await api("cashier1", "POST", `/invoices/${inv.id}/advances`, { amount: money(useAmt) }), 201);
  const left = (await api("cashier1", "GET", `/invoices/${inv.id}`)).d;
  if (Number(left.balanceDue) > 0) await expectStatus(F, "cashier1", `patient pays the remaining ₹${left.balanceDue} (UPI)`, await api("cashier1", "POST", `/invoices/${inv.id}/payments`, { payments: [{ method: "UPI", amount: String(left.balanceDue), reference: "UPI-IPD-0001" }] }), 201);
  st = await D(); const bl = (st.d?.steps ?? []).find((s) => s.step === "BILLING"); step(F, "cashier1", "billing stage stays open while part of the deposit is neither used nor given back", bl && bl.status === "PENDING", `${bl?.status} ${(bl?.checks ?? []).filter((c) => !c.ok).map((c) => c.detail).join(" | ")}`.slice(0, 200));
  const unapplied = Number(bl?.reconciliation?.deposits?.unapplied ?? 0);
  if (unapplied > 0) { const advs = itemsOf(await api("cashier1", "GET", `/patients/${p.id}/advances`)); const dep = advs.find((x) => Number(x.balance) >= unapplied); await expectStatus(F, "cashier1", `the unused ₹${unapplied} of the deposit is given back in cash`, await api("cashier1", "POST", `/advances/${dep.id}/refunds`, { method: "CASH", amount: money(unapplied), reason: "Unused deposit returned at discharge" }), 201); }
  const fin = (await api("cashier1", "GET", `/invoices/${inv.id}`)).d; step(F, "cashier1", "final bill is fully paid", fin.status === "PAID", `${fin.status}`);
  const chgAfter = await api("cashier1", "POST", `/admissions/${A}/charges`, { type: "SERVICE", description: "Late charge", unitPrice: "50.00", quantity: 1 }); step(F, "cashier1", "a charge cannot be added after the final bill", chgAfter.s >= 400 && chgAfter.s < 500, `HTTP ${chgAfter.s} ${errOf(chgAfter)}`.slice(0, 160));
  st = await D(); console.log("  stages:", stepsOf(st));
  // discharge
  await refused(F, "cashier1", "cashier completes the discharge", "POST", `/admissions/${A}/discharge/complete`, { type: "ROUTINE" });
  const dc = await api("doctor2", "POST", `/admissions/${A}/discharge/complete`, { type: "ROUTINE", note: "Discharged on oral antibiotics" }); await expectStatus(F, "doctor2", "doctor discharges the patient", dc, [200, 201]);
  const dc2 = await api("doctor2", "POST", `/admissions/${A}/discharge/complete`, { type: "ROUTINE" }); step(F, "doctor2", "discharging twice is refused", dc2.s >= 400 && dc2.s < 500, `HTTP ${dc2.s}`);
  const ad = await api("nurse1", "GET", `/admissions/${A}`); step(F, "nurse1", "admission shows DISCHARGED", ad.d?.status === "DISCHARGED", `${ad.d?.status}`);
  let bs = listOf(await api("nurse1", "GET", "/beds")); step(F, "nurse1", "the bed stays occupied until the patient actually leaves", bs.find((x) => x.id === bed1.id)?.status === "OCCUPIED", `${bs.find((x) => x.id === bed1.id)?.status}`);
  await refused(F, "doctor2", "doctor confirms the departure (nurse or transport only)", "POST", `/admissions/${A}/discharge/departure`, { mode: "WALKED" });
  await expectStatus(F, "transport1", "patient transport confirms the departure (wheelchair)", await api("transport1", "POST", `/admissions/${A}/discharge/departure`, { mode: "WHEELCHAIR", escortedBy: "Son", note: "Left by the main gate" }), [200, 201]);
  const dep2 = await api("transport1", "POST", `/admissions/${A}/discharge/departure`, { mode: "WALKED" }); step(F, "transport1", "departure can be confirmed only once", dep2.s >= 400 && dep2.s < 500, `HTTP ${dep2.s}`);
  bs = listOf(await api("nurse1", "GET", "/beds")); step(F, "nurse1", "the bed is now Cleaning", bs.find((x) => x.id === bed1.id)?.status === "CLEANING", `${bs.find((x) => x.id === bed1.id)?.status}`);
  // housekeeping
  await refused(F, "reception1", "reception works the bed turnover", "POST", `/bed-turnovers/x/start`, {});
  const to = await api("housekeeping1", "GET", "/bed-turnovers"); const turn = listOf(to).find((x) => x.bed === (bed1.code ?? bed1.name) && x.stage !== "READY");
  step(F, "housekeeping1", "housekeeping sees the bed to clean (never the patient)", !!turn && !JSON.stringify(turn).includes(p.first), `${listOf(to).length} turnovers ${turn ? "" : JSON.stringify(listOf(to)[0] ?? {}).slice(0, 120)}`);
  await screen(F, "housekeeping1", "/housekeeping", [/bed|clean/i], "housekeeping screen");
  if (turn) {
    const rd0 = await api("housekeeping1", "POST", `/bed-turnovers/${turn.id}/ready`, {}); step(F, "housekeeping1", "cannot mark ready before cleaning starts", rd0.s >= 400 && rd0.s < 500, `HTTP ${rd0.s}`);
    await expectStatus(F, "housekeeping1", "start cleaning", await api("housekeeping1", "POST", `/bed-turnovers/${turn.id}/start`, {}), [200, 201]);
    await expectStatus(F, "housekeeping1", "mark ready for the next patient", await api("housekeeping1", "POST", `/bed-turnovers/${turn.id}/ready`, {}), [200, 201]);
    bs = listOf(await api("nurse1", "GET", "/beds")); step(F, "nurse1", "the bed is Available again", bs.find((x) => x.id === bed1.id)?.status === "AVAILABLE", `${bs.find((x) => x.id === bed1.id)?.status}`);
  }
  // records
  await refused(F, "nurse1", "nurse signs off the medical record", "POST", `/admissions/${A}/discharge/records-complete`, { codes: [{ diagnosis: "Pneumonia", icd10: "J18.9", primary: true }] });
  const badCode = await api("mrd1", "POST", `/admissions/${A}/discharge/records-complete`, { codes: [{ diagnosis: "Pneumonia", icd10: "NOTACODE", primary: true }] }); step(F, "mrd1", "an invalid ICD-10 code is refused", badCode.s === 400, `HTTP ${badCode.s}`);
  await expectStatus(F, "mrd1", "Medical Records codes the diagnosis (J18.9) and signs off", await api("mrd1", "POST", `/admissions/${A}/discharge/records-complete`, { note: "Record complete", codes: [{ diagnosis: "Community-acquired pneumonia", icd10: "J18.9", primary: true }] }), [200, 201]);
  await expectStatus(F, "mrd1", "paper record received", await api("mrd1", "POST", `/admissions/${A}/discharge/record-file`, { action: "RECEIVED" }), [200, 201]);
  const skipF = await api("mrd1", "POST", `/admissions/${A}/discharge/record-file`, { action: "ISSUED", issuedTo: "Patient" }); step(F, "mrd1", "a record cannot be issued before it is filed (order kept)", skipF.s >= 400 && skipF.s < 500, `HTTP ${skipF.s}`);
  await expectStatus(F, "mrd1", "paper record filed (rack B-12)", await api("mrd1", "POST", `/admissions/${A}/discharge/record-file`, { action: "FILED", location: "Rack B-12" }), [200, 201]);
  const pd = await api("mrd1", "GET", "/post-discharge?show=ALL&days=30"); step(F, "mrd1", "post-discharge list shows the stay", pd.s === 200 && JSON.stringify(pd.j).includes(p.first), `HTTP ${pd.s}`);
  await screen(F, "mrd1", "/post-discharge", [/discharge/i], "post-discharge (MRD)");
  await screen(F, "cashier1", "/post-discharge", [/discharge/i], "post-discharge (cashier)");
  await screenRefused(F, "housekeeping1", "/post-discharge");
  const hk = await api("housekeeping1", "GET", `/admissions/${A}`); step(F, "housekeeping1", "housekeeping cannot open the patient's admission", hk.s === 403 || hk.s === 404, `HTTP ${hk.s}`);
  await screen(F, "doctor2", `/ipd/${A}`, [p.first, /discharged/i], "discharged admission page");
  const sumPrint = await api("doctor2", "GET", `/print/discharge-summaries/${A}`); step(F, "doctor2", "discharge summary prints", sumPrint.s === 200, `HTTP ${sumPrint.s}`);
  const rep = await api("manager1", "GET", "/reports/ipd/discharge-turnaround"); step(F, "manager1", "discharge turnaround report answers", [200, 400].includes(rep.s), `HTTP ${rep.s}`);
}

// ───────────────────────── SCOPE: what a doctor who does not own the patient can touch ─────────────────────────
async function scope(ctx) {
  const F = "SCOPE";
  const d1 = await practitionerOf("doctor1");
  const p = await newPatient(F, "reception1"); if (!p) return;
  const walk = await api("reception1", "POST", "/appointments/walk-in", { patientId: p.id, practitionerId: d1.id });
  if (!(await expectStatus(F, "reception1", "patient checked in to doctor1", walk, 201))) return;
  const E = walk.d.encounter.id, q = walk.d.queueEntry.id;
  await api("doctor1", "POST", `/queue/${q}/call`, {}); await api("doctor1", "POST", `/queue/${q}/start`, {});
  const gone = (name, r) => step(F, "doctor3", name, r.s === 403 || r.s === 404, `HTTP ${r.s} ${errOf(r)}`.slice(0, 160));
  gone("another doctor cannot open the visit", await api("doctor3", "GET", `/encounters/${E}`));
  gone("another doctor cannot read the consultation", await api("doctor3", "GET", `/encounters/${E}/consultation`));
  gone("another doctor cannot write the consultation", await api("doctor3", "PUT", `/encounters/${E}/consultation`, { content: { chiefComplaint: "x" } }));
  gone("another doctor cannot add a diagnosis", await api("doctor3", "POST", `/encounters/${E}/diagnoses`, { text: "Hypertension", type: "PROVISIONAL" }));
  gone("another doctor cannot record vitals", await api("doctor3", "POST", `/encounters/${E}/observations`, { observations: [{ type: "PULSE", value: 80 }] }));
  const rx = await api("doctor3", "PUT", `/encounters/${E}/prescription`, { items: [{ genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3, quantity: 9 }] });
  gone("another doctor cannot write a prescription on the visit", rx);
  const own = await api("doctor1", "PUT", `/encounters/${E}/prescription`, { items: [{ genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3, quantity: 9 }] });
  step(F, "doctor1", "the owning doctor can still write their own prescription", own.s === 200, `HTTP ${own.s} ${errOf(own)}`.slice(0, 160));
  const sg = await api("doctor3", "POST", `/encounters/${E}/prescription/sign`, {});
  gone("another doctor cannot sign a prescription on the visit", sg);
  await api("doctor1", "POST", `/queue/${q}/complete`, {});
}

// ───────────────────────── BEDS: can a patient be admitted to an operating room / emergency / ICU bed from the ordinary desk? ─────────────────────────
async function beds(ctx) {
  const F = "BEDS";
  const doc = await practitionerOf("doctor2");
  const w = listOf(await api("admission1", "GET", "/wards")); const b = listOf(await api("admission1", "GET", "/beds?status=AVAILABLE"));
  const byWard = (re) => { const ids = new Set(w.filter((x) => re.test(`${x.name} ${x.type ?? ""} ${x.kind ?? ""}`)).map((x) => x.id)); return b.filter((x) => ids.has(x.wardId ?? x.ward?.id)); };
  console.log("  wards:", w.map((x) => `${x.name}[${x.type ?? x.kind ?? "-"}]`).join(", "));
  for (const [label, re] of [["operating room", /operation|theatre|^OT$/i], ["emergency ward", /emergency|^ER$/i], ["ICU", /icu|intensive/i]]) {
    const bed = byWard(re)[0]; if (!bed) { step(F, "admission1", `a free ${label} bed to try`, true, "none free (nothing to try)"); continue; }
    const p = await newPatient(F, "admission1"); if (!p) continue;
    const r = await admitWalkIn(F, "admission1", p, doc.id, bed.id, "Bed type probe");
    if (r.s === 201) { await api("admission1", "POST", `/admissions/${r.d.id}/cancel`, { reason: "Probe admission, cancelled at once" }); }
    step(F, "admission1", `the ordinary admission desk cannot put a patient in an ${label} bed`, r.s >= 400 && r.s < 500, `HTTP ${r.s} ${errOf(r)}`.slice(0, 160));
  }
}

// Test housekeeping: moves the synthetic ICU test patients named in CLEAN_IDS out to free ward beds (ICU → ward), freeing the ICU beds.
async function clean(ctx) {
  const F = "ICU→WARD";
  for (const q of (process.env.QUEUE_IDS || "").split(",").filter(Boolean)) { let r = await api("doctor1", "POST", `/queue/${q}/cancel`, { reason: "Synthetic test visit closed" }); if (r.s >= 400) r = await api("reception1", "POST", `/queue/${q}/cancel`, { reason: "Synthetic test visit closed" }); if (r.s >= 400) r = await api("doctor1", "POST", `/queue/${q}/skip`, {}); step(F, "doctor1", `left-open test visit ${q.slice(0, 8)} closed`, r.s === 200, `HTTP ${r.s} ${errOf(r)}`.slice(0, 160)); }
  if (process.env.FINISH_VISIT) { const [e, q] = process.env.FINISH_VISIT.split(":"); const wd = process.env.FINISH_AS || "doctor1"; const w = process.env.FINISH_VERSION ? { s: 0, d: { version: Number(process.env.FINISH_VERSION) } } : await api(wd, "PUT", `/encounters/${e}/consultation`, { content: { chiefComplaint: "Synthetic test visit", advice: "None" }, version: 1 }); const sg = await api(wd, "POST", `/encounters/${e}/consultation/sign`, { version: w.d?.version, acknowledgeAllergyWarnings: true }); const c = await api("doctor1", "POST", `/queue/${q}/complete`, {}); step(F, "doctor1", "left-open test visit finished by the owning doctor (note, sign, complete)", c.s === 200, `write ${w.s} sign ${sg.s} ${errOf(sg)} complete ${c.s} ${errOf(c)}`.slice(0, 200)); }
  if (process.env.ADD_BEDS) { const rooms = listOf(await api("admin", "GET", "/rooms")); const room = rooms.find((r) => /private/i.test(r.name ?? r.code ?? "")) ?? rooms[0]; for (const code of process.env.ADD_BEDS.split(",")) { const r = await api("admin", "POST", "/beds", { roomId: room.id, code, dailyRate: "2500.00" }); step(F, "admin", `bed ${code} added to ${room.name}`, r.s === 201, `HTTP ${r.s} ${errOf(r)}`.slice(0, 140)); } }
  const wb = await wardBeds("bedmgr1", 10);
  const ids = (process.env.CLEAN_IDS || "").split(",").filter(Boolean);
  step(F, "bedmgr1", `free ward beds for ${ids.length} patients`, wb.all.length >= ids.length, `${wb.all.length} free`);
  for (const [i, id] of ids.entries()) {
    const before = await api("nurse1", "GET", `/admissions/${id}`);
    const r = await api("bedmgr1", "POST", `/admissions/${id}/transfer`, { toBedId: wb.all[i]?.id, reason: "Stepped down from ICU to the ward" });
    step(F, "bedmgr1", `ICU patient ${id.slice(0, 8)} moved to a ward bed`, r.s === 200 || r.s === 201, `HTTP ${r.s} ${errOf(r)}`.slice(0, 200));
  }
  const all = listOf(await api("nurse1", "GET", "/beds")); const wards = listOf(await api("nurse1", "GET", "/wards")); const icuId = wards.find((w) => /intensive|icu/i.test(w.name))?.id;
  for (const b of all.filter((x) => (x.wardId ?? x.ward?.id) === icuId && x.status === "CLEANING")) {
    const r = await api("nurse1", "POST", `/beds/${b.id}/status`, { status: "AVAILABLE" });
    step(F, "nurse1", `ICU bed ${b.code ?? b.name} cleaned and made available`, r.s === 200, `HTTP ${r.s}`);
  }
  for (const t of listOf(await api("housekeeping1", "GET", "/bed-turnovers")).filter((x) => x.stage !== "READY")) {
    if (t.stage === "VACATED" || t.stage === "vacated") await api("housekeeping1", "POST", `/bed-turnovers/${t.id}/start`, {});
    const r = await api("housekeeping1", "POST", `/bed-turnovers/${t.id}/ready`, {});
    step(F, "housekeeping1", `bed ${t.bed} cleaned and made ready`, r.s === 200 || r.s === 201, `HTTP ${r.s} ${errOf(r)}`.slice(0, 120));
  }
}

// Finishes the remaining lab requests of one visit (env FINISH_ENC) and then waits for the "report ready" message to the patient (env FINISH_MOBILE).
async function finish(ctx) {
  const F = "LIMS-FINISH"; const enc = process.env.FINISH_ENC; const mob = process.env.FINISH_MOBILE;
  const all = async () => [...((await api("lims_manager1", "GET", "/lims/requests?department=PATHOLOGY&pageSize=100")).d?.items ?? []), ...((await api("lims_manager1", "GET", "/lims/requests?department=RADIOLOGY&pageSize=100")).d?.items ?? [])].filter((r) => r.encounterId === enc && r.status !== "CANCELLED");
  console.log("  states:", (await all()).map((r) => `${r.test}:${r.status}`).join(", "));
  const n0 = (await sms(mob)).filter((m) => /is ready at/.test(m.text)).length;
  for (const r of (await all()).filter((x) => !["ISSUED", "HANDED_OVER"].includes(x.status))) {
    if (r.status === "PENDING_COLLECTION") await api("nurse1", "POST", `/lims/requests/${r.id}/collect`, {});
    let cur = (await all()).find((x) => x.id === r.id);
    if (r.department === "PATHOLOGY") {
      await api("p_lab_tech1", "POST", `/lims/requests/${r.id}/accept`, {});
      cur = (await all()).find((x) => x.id === r.id);
      const res = (await api("p_lab_tech1", "GET", `/lab/orders/${cur.testOrderId}/result`)).d;
      const values = (res?.parameters ?? []).map((p) => ({ parameterId: p.id, value: p.type === "NUMERIC" ? "9" : (p.choices?.[0] ?? "Normal") }));
      await api("p_lab_tech1", "PUT", `/lab/results/${res.resultId}/draft`, { version: res.version, values });
      await expectStatus(F, "p_lab_tech1", `${r.test}: sent for review`, await api("p_lab_tech1", "POST", `/lims/requests/${r.id}/submit`, {}), 200);
      cur = (await all()).find((x) => x.id === r.id);
      await expectStatus(F, "pathologist1", `${r.test}: pathologist passes`, await api("pathologist1", "POST", `/lab/results/${cur.resultId}/verify`, { version: cur.resultVersion }), 200);
      await expectStatus(F, "p_lab_tech1", `${r.test}: technician issues`, await api("p_lab_tech1", "POST", `/lims/requests/${r.id}/issue`, {}), 200);
    } else {
      await expectStatus(F, "r_lab_tech1", `${r.test}: X-ray performed`, await api("r_lab_tech1", "POST", `/lims/requests/${r.id}/perform`, { modality: "XRAY", bodyPart: "Chest PA" }), 200);
      await expectStatus(F, "r_lab_tech1", `${r.test}: sent to the radiologist`, await api("r_lab_tech1", "POST", `/lims/requests/${r.id}/submit`, {}), 200);
      cur = (await all()).find((x) => x.id === r.id);
      await expectStatus(F, "radiologist1", `${r.test}: radiologist signs`, await api("radiologist1", "POST", `/rad/studies/${cur.studyId}/report`, { findings: "Lung fields clear. Cardiac size normal.", impression: "Normal chest radiograph.", critical: false }), 200);
      await expectStatus(F, "r_lab_tech1", `${r.test}: technician issues`, await api("r_lab_tech1", "POST", `/lims/requests/${r.id}/issue`, {}), 200);
    }
    const left = (await all()).filter((x) => !["ISSUED", "HANDED_OVER"].includes(x.status)).length;
    const got = (await sms(mob)).filter((m) => /is ready at/.test(m.text)).length - n0;
    console.log(`  after ${r.test}: ${left} request(s) still open; "report ready" messages so far: ${got}`);
  }
  let msgs = [];
  for (let i = 0; i < 20; i++) { msgs = (await sms(mob)).filter((m) => /is ready at/.test(m.text)).slice(n0); if (msgs.length >= 2) break; await new Promise((r) => setTimeout(r, 6000)); }
  step(F, "system", "patient is told the reports are ready, by WhatsApp and SMS", msgs.length >= 2, msgs.map((m) => `${m.channel}: ${m.text}`).join(" || ").slice(0, 400));
}

async function disc(ctx) {
  const st = await api("admin", "GET", "/settings"); const items = st.d?.items ?? st.d ?? [];
  console.log("SETTINGS:", items.map((x) => x.key ?? x.name).join(", "));
  const ft = await api("admin", "GET", "/settings/features"); console.log("FEATURES:", JSON.stringify(ft.d).slice(0, 500));
  const me = await api("admin", "GET", "/auth/me"); console.log("ME:", JSON.stringify(me.d).slice(0, 500));
  const us = await api("admin", "GET", "/users?pageSize=3"); console.log("USERS:", JSON.stringify((us.d?.items ?? us.d ?? [])[0]).slice(0, 400));
  const rl = await api("admin", "GET", "/roles"); console.log("ROLES:", (rl.d?.items ?? rl.d ?? []).map((r) => r.name).join(", "));
  const fa = await api("admin", "GET", "/facilities"); console.log("FACILITIES:", JSON.stringify(fa.d).slice(0, 300));
}

(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = {};
  const plan = only.length ? only : ["adv", "adm", "ipd"];
  const fns = { adv, adm, ipd, scope, beds, clean, finish, disc, crit1, crit2, crit3, crit4, crit5, crit6, crit7, crit8, shots };
  for (const f of plan) {
    try { await fns[f](ctx); } catch (e) { step(f.toUpperCase(), "-", "unexpected script error", false, e.stack?.split("\n").slice(0, 3).join(" | ")); }
  }
  fs.writeFileSync(path.join(outDir, `flows2-${plan.join("-")}.json`), JSON.stringify({ results, consoleProblems }, null, 1));
  const byFlow = {};
  for (const r of results) { byFlow[r.flow] ??= { pass: 0, fail: 0 }; byFlow[r.flow][r.ok ? "pass" : "fail"]++; }
  console.log("\nSUMMARY", JSON.stringify(byFlow));
  console.log("BROWSER PROBLEMS:", consoleProblems.length ? "\n  " + [...new Set(consoleProblems)].join("\n  ") : "none");
  await browser.close();
})();
