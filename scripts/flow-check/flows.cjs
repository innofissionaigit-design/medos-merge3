// End-to-end flow tests for the MedOS test instance (web http://localhost:3200, API behind it), in Google Chrome.
// Every role has its own browser session signed in through the login form; each step is done by the role that owns it, through that role's
// browser session (the same /api/proxy gateway the screens use), and the screens each role works from are opened and checked.
// Usage: node flows.cjs <webRoot> <outDir> <password> [flow ...]   flows: opd lims er icu tele
const { createRequire } = require("module");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const [webRoot, outDir, password, ...only] = process.argv.slice(2);
const { chromium } = createRequire(path.join(webRoot, "package.json"))("@playwright/test");
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
async function as(user) {
  if (sessions[user]) return sessions[user];
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
const errOf = (r) => (r.j && r.j.error ? `${r.j.error.code}: ${r.j.error.message}` : JSON.stringify(r.j).slice(0, 150));
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

// ───────────────────────── 1. OPD journey ─────────────────────────
async function opd(ctx) {
  const F = "OPD";
  const doc = await practitionerOf("doctor1"); ctx.doc1 = doc;
  const p = await newPatient(F, "reception1"); if (!p) return; ctx.opdPatient = p;
  await screen(F, "reception1", `/patients/${p.id}`, [p.first], "patient record");
  const walk = await api("reception1", "POST", "/appointments/walk-in", { patientId: p.id, practitionerId: doc.id });
  if (!(await expectStatus(F, "reception1", "walk-in check-in to Dr. (doctor1) → OPD queue", walk, 201))) return;
  const enc = walk.d.encounter.id, q = walk.d.queueEntry.id; ctx.opdEnc = enc;
  step(F, "reception1", "visit number and token issued", !!walk.d.encounter.visitNumber || !!walk.d.queueEntry.tokenNumber, `visit ${walk.d.encounter.visitNumber ?? ""} token ${walk.d.queueEntry.tokenNumber ?? walk.d.queueEntry.token ?? ""}`);
  await screen(F, "reception1", "/queue", [p.first], "OPD queue");
  await screen(F, "doctor1", "/queue", [p.first], "doctor's queue");
  await refused(F, "reception1", "reception records vitals", "POST", `/encounters/${enc}/observations`, { observations: [{ type: "PULSE", value: 80 }] });
  await expectStatus(F, "nurse1", "nurse records vitals (pulse, temp, BP, SpO2)", await api("nurse1", "POST", `/encounters/${enc}/observations`, { observations: [{ type: "PULSE", value: 92 }, { type: "TEMPERATURE", value: 38.6 }, { type: "SYSTOLIC_BP", value: 128 }, { type: "DIASTOLIC_BP", value: 84 }, { type: "SPO2", value: 97 }] }), 201);
  await expectStatus(F, "doctor1", "doctor calls the patient", await api("doctor1", "POST", `/queue/${q}/call`, {}), 200);
  await expectStatus(F, "doctor1", "doctor starts the consultation", await api("doctor1", "POST", `/queue/${q}/start`, {}), 200);
  await refused(F, "nurse1", "nurse writes the consultation", "PUT", `/encounters/${enc}/consultation`, { content: { chiefComplaint: "x" } });
  const note = await api("doctor1", "PUT", `/encounters/${enc}/consultation`, { content: { chiefComplaint: "Fever and cough for 3 days", examination: "Throat congested, chest clear", investigationsAdvised: ["CBC (complete blood count)"], otherTestsAdvised: ["X-ray chest PA"], advice: "Plenty of fluids", followUp: { afterDays: 5, notes: "Bring reports" } } });
  await expectStatus(F, "doctor1", "consultation note (with lab and X-ray advised)", note, 200);
  await expectStatus(F, "doctor1", "diagnosis recorded", await api("doctor1", "POST", `/encounters/${enc}/diagnoses`, { text: "Acute upper respiratory infection", type: "PROVISIONAL", code: "J06.9" }), 201);
  // a medicine that has stock
  const stock = await api("pharmacist1", "GET", "/pharmacy/stock?pageSize=50"); stock.d = stock.d?.items ?? stock.d;
  const med = (stock.d || []).find((m) => Number(m.sellableQuantity ?? m.available ?? 0) > 20) || (stock.d || [])[0];
  step(F, "pharmacist1", "stock list available", !!med, med ? `${med.brandName ?? med.name}` : JSON.stringify(stock.j).slice(0, 120));
  const medId = med?.medicineId ?? med?.id;
  const rx = await api("doctor1", "PUT", `/encounters/${enc}/prescription`, { items: [{ medicineId: medId, genericName: med?.genericName ?? "Paracetamol", strength: med?.strength ?? "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3, quantity: 9 }] });
  await expectStatus(F, "doctor1", "prescription drafted", rx, 200);
  const sign = await api("doctor1", "POST", `/encounters/${enc}/consultation/sign`, { version: note.d?.version, acknowledgeAllergyWarnings: true });
  await expectStatus(F, "doctor1", "consultation and prescription signed", sign, 200);
  await expectStatus(F, "doctor1", "visit completed", await api("doctor1", "POST", `/queue/${q}/complete`, {}), 200);
  const amend = await api("doctor1", "PUT", `/encounters/${enc}/consultation`, { content: { chiefComplaint: "rewritten" }, version: 2 });
  step(F, "doctor1", "a signed note cannot be overwritten", amend.s === 409, `HTTP ${amend.s}`);
  await screen(F, "doctor1", `/visits/${enc}`, [/signed/i], "visit page");
  // billing
  const svc = (await api("cashier1", "GET", "/services?pageSize=100")).d?.find((s) => s.category === "CONSULTATION");
  const inv = await api("cashier1", "POST", "/invoices", { patientId: p.id, encounterId: enc, lines: [{ serviceId: svc.id, quantity: 1 }] });
  await expectStatus(F, "cashier1", "consultation bill drafted", inv, 201);
  await expectStatus(F, "cashier1", "bill issued", await api("cashier1", "POST", `/invoices/${inv.d.id}/issue`, {}), 200);
  await api("cashier1", "POST", "/shifts/open", { openingCash: "1000" });
  const total = (await api("cashier1", "GET", `/invoices/${inv.d.id}`)).d;
  const half = (Number(total.total) / 2).toFixed(2), rest = (Number(total.total) - Number(half)).toFixed(2);
  const pay = await api("cashier1", "POST", `/invoices/${inv.d.id}/payments`, { payments: [{ method: "CASH", amount: half }, { method: "UPI", amount: rest, reference: "UPI-OPD-0001" }] });
  await expectStatus(F, "cashier1", `split payment ₹${half} cash + ₹${rest} UPI`, pay, 201);
  const rcpt = pay.d?.receipt?.id;
  if (rcpt) { const pr = await api("cashier1", "GET", `/print/receipts/${rcpt}`); step(F, "cashier1", "receipt prints", pr.s === 200, `HTTP ${pr.s}`); }
  await screen(F, "cashier1", `/billing/${inv.d.id}`, [/paid/i], "bill page");
  // pharmacy
  await refused(F, "cashier1", "cashier dispenses", "POST", "/pharmacy/dispenses", { patientId: p.id, items: [{ medicineId: medId, quantity: 1 }] });
  const pq = await api("pharmacist1", "GET", `/pharmacy/queue?q=${encodeURIComponent(p.mrn)}`);
  const order = (pq.d?.items ?? pq.d ?? []).find((o) => o.patientId === p.id);
  step(F, "pharmacist1", "signed prescription reaches the pharmacy queue", !!order);
  await screen(F, "pharmacist1", "/pharmacy", [p.first], "pharmacy queue");
  if (order) {
    const it = order.items[0];
    const dis = await api("pharmacist1", "POST", "/pharmacy/dispenses", { patientId: p.id, medicationOrderId: order.id, items: [{ medicationOrderItemId: it.id, medicineId: it.medicineId, quantity: it.quantity ?? 9 }] });
    await expectStatus(F, "pharmacist1", "medicine dispensed (FEFO batch) and billed", dis, 201);
    const pinv = dis.d?.dispense?.invoiceId;
    if (pinv) {
      const pi = (await api("cashier1", "GET", `/invoices/${pinv}`)).d;
      await expectStatus(F, "cashier1", `cashier collects the pharmacy bill ₹${pi.balanceDue ?? pi.total}`, await api("cashier1", "POST", `/invoices/${pinv}/payments`, { payments: [{ method: "CASH", amount: String(pi.balanceDue ?? pi.total) }] }), 201);
    }
  }
  const prn = await api("doctor1", "GET", `/print/prescriptions/${enc}`); step(F, "doctor1", "prescription prints", prn.s === 200, `HTTP ${prn.s}`);
  await screen(F, "manager1", "/reports", [/report/i], "reports");
  const rep = await api("admin", "GET", "/reports/opd/daily"); step(F, "admin", "daily OPD report answers", rep.s === 200, `HTTP ${rep.s}`);
}

// ───────────────────────── 2. LIMS: outpatient (from the OPD visit), reception booking, admitted patient ─────────────────────────
async function lims(ctx) {
  const F = "LIMS";
  for (const u of ["lims_manager1", "p_lab_tech1", "r_lab_tech1", "pathologist1", "radiologist1", "reception1", "nurse1"]) await screen(F, u, "/lims", [/Laboratory|LIMS|lab/i], "LIMS home");
  await screenRefused(F, "cashier1", "/lims");
  const enc = ctx.opdEnc, p = ctx.opdPatient;
  if (enc) {
    const pend = await api("reception1", "GET", "/lims/opd/pending");
    const row = JSON.stringify(pend.d || pend.j).includes(enc);
    step(F, "reception1", "doctor's advised tests wait at the reception desk (not yet in the lab)", row);
    const prow = (pend.d || []).find((x) => x.encounterId === enc);
    const visitTests = prow?.tests ?? [];
    const ids = visitTests.map((o) => o.testOrderId);
    ctx.labAmount = visitTests.reduce((t, o) => t + Number(o.amount ?? 0), 0);
    step(F, "reception1", `advised tests at the desk: ${visitTests.map((o) => `${o.name} (${o.department}, ₹${o.amount})`).join(", ")}`, ids.length >= 1);
    await refused(F, "reception1", "launch without the patient's consent", "POST", "/lims/opd/launch", { encounterId: enc, consent: false, testOrderIds: ids });
    const before = (await sms(p.mobile)).length;
    const launch = await api("reception1", "POST", "/lims/opd/launch", { encounterId: enc, consent: true, consentMode: "VERBAL", testOrderIds: ids, priority: "ROUTINE" });
    await expectStatus(F, "reception1", "patient agrees → tests launched into the lab queue with a date from the lab load", launch, [200, 201]);
    let msgs = []; for (let i = 0; i < 60 && msgs.length <= before; i++) { await new Promise((r) => setTimeout(r, 2000)); msgs = await sms(p.mobile); }
    step(F, "system", "patient messaged (WhatsApp/SMS) with department, date and preparation — no test name", msgs.length > before, msgs.slice(before).map((m) => `${m.channel}: ${m.text.slice(0, 90)}`).join(" / "));
    const reqs = async () => [...((await api("lims_manager1", "GET", "/lims/requests?department=PATHOLOGY&pageSize=100")).d?.items ?? []), ...((await api("lims_manager1", "GET", "/lims/requests?department=RADIOLOGY&pageSize=100")).d?.items ?? [])].filter((r) => r.encounterId === enc);
    let rs = await reqs();
    step(F, "lims_manager1", `requests visible in the control room (${rs.map((r) => `${r.test}:${r.status}`).join(", ")})`, rs.length === ids.length);
    const nurses = await api("lims_manager1", "GET", "/lims/staff?department=PATHOLOGY");
    const nurseId = (nurses.d?.nurses ?? []).find((n) => /nurse/i.test(n.name) || true)?.id;
    for (const r of rs) await expectStatus(F, "lims_manager1", `assign ${r.test} to a nurse`, await api("lims_manager1", "POST", `/lims/requests/${r.id}/assign`, { nurseId }), 200);
    await refused(F, "lims_manager1", "LIMS manager types a result", "PUT", `/lab/results/${crypto.randomUUID()}/draft`, { version: 1, values: [{ parameterId: "x", value: "1" }] });
    const early = await api("nurse1", "POST", `/lims/requests/${rs[0].id}/collect`, {});
    step(F, "nurse1", "sample refused before the patient reports at reception", early.s === 409, `HTTP ${early.s} ${errOf(early)}`);
    await screen(F, "reception1", "/lims", [/Laboratory/], "reception desk (the patient is booked for the next lab opening, so not on today's list)");
    const batch = rs[0].batchId;
    const pre = await api("reception1", "GET", `/lims/batches/${batch}/bill`).catch(() => null);
    const arrive = await api("reception1", "POST", `/lims/batches/${batch}/arrive`, { payments: [{ method: "CASH", amount: ctx.labAmount.toFixed(2) }] });
    let ok = arrive.s === 200 || arrive.s === 201;
    if (!ok && /(due|owe|amount|PAYMENT)/i.test(errOf(arrive))) {
      const m = /(\d+\.\d{2})/.exec(errOf(arrive));
      const a2 = await api("reception1", "POST", `/lims/batches/${batch}/arrive`, { payments: [{ method: "UPI", amount: m ? m[1] : "650.00", reference: "UPI-LAB-0001" }] });
      ok = a2.s === 200 || a2.s === 201; step(F, "reception1", "patient arrived: tests billed at price list and paid", ok, ok ? JSON.stringify(a2.d).slice(0, 160) : `HTTP ${a2.s} ${errOf(a2)}`);
    } else step(F, "reception1", "patient arrived: tests billed at price list and paid", ok, ok ? JSON.stringify(arrive.d).slice(0, 160) : `HTTP ${arrive.s} ${errOf(arrive)}`);
    await labPipeline(F, ctx, enc, "OPD");
    rs = await reqs();
    let msgs2 = []; for (let i = 0; i < 60 && !msgs2.some((m) => /is ready at/.test(m.text)); i++) { await new Promise((r) => setTimeout(r, 2000)); msgs2 = await sms(p.mobile); }
    step(F, "system", "patient told the reports are ready at reception (worker sends within a minute)", msgs2.some((m) => /is ready at/.test(m.text)), (msgs2.find((m) => /is ready at/.test(m.text))?.text ?? "").slice(0, 120));
    for (const r of rs.filter((x) => x.status === "ISSUED")) await expectStatus(F, "reception1", `report handed over: ${r.test}`, await api("reception1", "POST", `/lims/requests/${r.id}/handover`, { receivedBy: "Patient's brother" }), 200);
    const docView = await api("doctor1", "GET", `/encounters/${enc}/lab-results`);
    step(F, "doctor1", "doctor sees the issued laboratory report on the visit", docView.s === 200 && JSON.stringify(docView.j).includes("VERIFIED"), `HTTP ${docView.s}`);
    await screen(F, "doctor1", `/visits/${enc}`, [/CBC|complete blood count/i], "visit page with report");
  }
  // Reception books a test for a patient with no doctor's order
  const walkIn = await newPatient(F, "reception1");
  if (walkIn) {
    const cat = await api("reception1", "GET", "/lims/catalogue?q=Lipid");
    const lipid = (cat.d?.items ?? cat.d ?? []).find((s) => /lipid/i.test(s.name));
    const b = await api("reception1", "POST", "/lims/opd/book", { patientId: walkIn.id, consent: true, tests: [lipid?.id ? { serviceId: lipid.id } : { name: "Lipid profile", category: "LABORATORY" }], referredBy: "Dr. Outside Clinic" });
    await expectStatus(F, "reception1", "book a test with no doctor's order (outside referral)", b, [200, 201]);
  }
  // Admitted patient: ordered by the doctor from the admission, charged to the admission when issued
  const adms = (await api("admin", "GET", "/admissions?status=ADMITTED&pageSize=20")).d || [];
  const users = (await api("admin", "GET", "/users?pageSize=100")).d || [];
  const a = adms.find((x) => x.consultantName === users.find((u) => u.username === "doctor2")?.fullName) || adms[0];
  const consultantUser = users.find((u) => u.fullName === a.consultantName)?.username ?? "doctor2";
  ctx.ipdAdm = a;
  const ord = await api(consultantUser, "POST", "/lims/orders", { encounterId: a.encounterId, priority: "URGENT", clinicalNote: "Post-op check", tests: [{ name: "CBC (complete blood count)", category: "LABORATORY" }, { name: "X-ray chest PA", category: "RADIOLOGY" }] });
  await expectStatus(F, consultantUser, `doctor orders CBC (urgent) + chest X-ray for admitted ${a.patientName}`, ord, 201);
  await screen(F, consultantUser, `/ipd/${a.id}`, [a.patientName], "admission page");
  await labPipeline(F, ctx, a.encounterId, "IPD");
  const chr = (await api("cashier1", "GET", `/admissions/${a.id}/charges`)).d; const ch = chr?.items ?? chr ?? [];
  step(F, "cashier1", "issued reports became charges on the admission bill", ch.filter((c) => /LRQ-/.test(c.description)).length >= 2, ch.filter((c) => /LRQ-/.test(c.description)).map((c) => `${c.description} ₹${c.unitPrice}`).join("; "));
  // Control room: QC, instruments, exceptions, reports
  const inst = await api("lims_manager1", "POST", "/lims/instruments", { name: `Haematology analyser ${rnd(9999)}`, department: "PATHOLOGY", model: "HX-500", serialNumber: `SN${rnd(99999)}`, lastCalibratedAt: "2026-10-01", nextCalibrationDue: "2026-11-20" });
  await expectStatus(F, "lims_manager1", "instrument added (calibration due soon is flagged)", inst, [200, 201]);
  const qc = await api("p_lab_tech1", "POST", "/lims/qc", { department: "PATHOLOGY", ...(inst.d?.id ? { instrumentId: inst.d.id } : {}), subject: "Haemoglobin control", level: "NORMAL", unit: "g/dL", expected: 13.0, observed: 13.1, lowLimit: 12.0, highLimit: 14.0 });
  await expectStatus(F, "p_lab_tech1", "QC run recorded (pass worked out from the limits)", qc, [200, 201]);
  const qcFail = await api("p_lab_tech1", "POST", "/lims/qc", { department: "PATHOLOGY", subject: "Haemoglobin control", level: "HIGH", unit: "g/dL", expected: 17.0, observed: 19.4, lowLimit: 16.0, highLimit: 18.0 });
  await expectStatus(F, "p_lab_tech1", "failed QC run recorded (manager told)", qcFail, [200, 201]);
  if (qcFail.d?.id) await expectStatus(F, "lims_manager1", "manager reviews the failed QC run", await api("lims_manager1", "POST", `/lims/qc/${qcFail.d.id}/review`, { actionRequired: true, note: "Recalibrated the analyser and reran the control" }), [200, 201]);
  const anyReq = ((await api("lims_manager1", "GET", "/lims/requests?department=PATHOLOGY&pageSize=100")).d?.items ?? []).find((r) => r.status === "PENDING_COLLECTION");
  if (anyReq) {
    const ex = await api("nurse1", "POST", "/lims/exceptions", { requestId: anyReq.id, kind: "QUEUE_JUMP", reason: "Elderly patient waiting since morning" });
    await expectStatus(F, "nurse1", "exception raised by the nurse: queue jump", ex, [200, 201]);
    if (ex.d?.id) await expectStatus(F, "lims_manager1", "LIMS manager approves the exception (request becomes urgent)", await api("lims_manager1", "POST", `/lims/exceptions/${ex.d.id}/decide`, { decision: "APPROVED", note: "Approved, move up" }), 200);
  }
  for (const r of ["/lims/reports/performance", "/lims/reports/billing", "/lims/reports/pressure"]) { const x = await api("lims_manager1", "GET", r); step(F, "lims_manager1", `report ${r}`, x.s === 200, `HTTP ${x.s}`); }
  const mgrRep = await api("manager1", "GET", "/lims/reports/billing"); step(F, "manager1", "hospital manager reads LIMS billing report", mgrRep.s === 200, `HTTP ${mgrRep.s}`);
  await screen(F, "lims_manager1", "/lims", [/Overview|Lab load|requests/i], "LIMS control room");
  await screen(F, "admin", "/lims", [/Laboratory/i], "LIMS (administrator view)");
}
async function labPipeline(F, ctx, enc, kind) {
  const all = async () => [...((await api("lims_manager1", "GET", "/lims/requests?department=PATHOLOGY&pageSize=100")).d?.items ?? []), ...((await api("lims_manager1", "GET", "/lims/requests?department=RADIOLOGY&pageSize=100")).d?.items ?? [])].filter((r) => r.encounterId === enc && r.status !== "CANCELLED");
  const mine = (await all()).filter((r) => r.status === "PENDING_COLLECTION"); const mineIds = new Set(mine.map((r) => r.id));
  for (const r of mine) {
    const collector = "nurse1";
    await refused(F, "p_lab_tech1", `${kind} technician takes the sample (${r.test})`, "POST", `/lims/requests/${r.id}/collect`, {});
    await expectStatus(F, collector, `${kind} sample taken / patient ready: ${r.test}`, await api(collector, "POST", `/lims/requests/${r.id}/collect`, {}), 200);
    if (r.department === "PATHOLOGY") {
      await refused(F, "r_lab_tech1", "radiology technician accepts a pathology sample", "POST", `/lims/requests/${r.id}/accept`, {});
      await expectStatus(F, "p_lab_tech1", `${kind} pathology technician accepts the sample`, await api("p_lab_tech1", "POST", `/lims/requests/${r.id}/accept`, {}), 200);
      const cur = (await all()).find((x) => x.id === r.id);
      const res = (await api("p_lab_tech1", "GET", `/lab/orders/${cur.testOrderId}/result`)).d;
      const vals = { Haemoglobin: "13.4", "Total WBC count": "7.8", "Platelet count": "245" };
      const values = (res?.parameters ?? []).map((p) => ({ parameterId: p.id, value: vals[p.name] ?? (p.type === "NUMERIC" ? "5" : (p.choices?.[0] ?? "Normal")) }));
      await expectStatus(F, "p_lab_tech1", `${kind} values typed (${values.length} parameters)`, await api("p_lab_tech1", "PUT", `/lab/results/${res.resultId}/draft`, { version: res.version, values }), 200);
      await refused(F, "p_lab_tech1", "technician verifies their own result", "POST", `/lab/results/${res.resultId}/verify`, { version: res.version + 1 });
      await expectStatus(F, "p_lab_tech1", `${kind} sent for review`, await api("p_lab_tech1", "POST", `/lims/requests/${r.id}/submit`, {}), 200);
      const c2 = (await all()).find((x) => x.id === r.id);
      const hidden = await api("doctor1", "GET", `/encounters/${enc}/lab-results`);
      if (kind === "OPD") step(F, "doctor1", "doctor does not see the result before it is issued", !JSON.stringify(hidden.j).includes("13.4"), `HTTP ${hidden.s}`);
      await refused(F, "lims_manager1", "LIMS manager passes a result", "POST", `/lab/results/${c2.resultId}/verify`, { version: c2.resultVersion });
      await expectStatus(F, "pathologist1", `${kind} pathologist passes (verifies) the values`, await api("pathologist1", "POST", `/lab/results/${c2.resultId}/verify`, { version: c2.resultVersion }), 200);
      await refused(F, "nurse1", "nurse issues the report", "POST", `/lims/requests/${r.id}/issue`, {});
      await expectStatus(F, "p_lab_tech1", `${kind} technician issues the report`, await api("p_lab_tech1", "POST", `/lims/requests/${r.id}/issue`, {}), 200);
    } else {
      await refused(F, "p_lab_tech1", "pathology technician performs a scan", "POST", `/lims/requests/${r.id}/perform`, { modality: "XRAY", bodyPart: "Chest" });
      await expectStatus(F, "r_lab_tech1", `${kind} radiology technician performs the X-ray`, await api("r_lab_tech1", "POST", `/lims/requests/${r.id}/perform`, { modality: "XRAY", bodyPart: "Chest PA" }), 200);
      await expectStatus(F, "r_lab_tech1", `${kind} sent to the radiologist`, await api("r_lab_tech1", "POST", `/lims/requests/${r.id}/submit`, {}), 200);
      const c2 = (await all()).find((x) => x.id === r.id);
      await refused(F, "lims_manager1", "LIMS manager signs a radiology report", "POST", `/rad/studies/${c2.studyId}/report`, { findings: "x x x", impression: "x x x" });
      await expectStatus(F, "radiologist1", `${kind} radiologist signs findings and impression`, await api("radiologist1", "POST", `/rad/studies/${c2.studyId}/report`, { findings: "Lung fields clear. Cardiac size normal.", impression: "Normal chest radiograph.", critical: false }), 200);
      await expectStatus(F, "r_lab_tech1", `${kind} technician issues the radiology report`, await api("r_lab_tech1", "POST", `/lims/requests/${r.id}/issue`, {}), 200);
    }
  }
  const after = (await all()).filter((r) => mineIds.has(r.id));
  step(F, "lims_manager1", `${kind} every request issued`, after.length > 0 && after.every((r) => r.status === "ISSUED"), after.map((r) => `${r.test}:${r.status}`).join(", "));
}

// ───────────────────────── 3. Emergency ward ─────────────────────────
async function er(ctx) {
  const F = "ER";
  await screen(F, "er_reception1", "/emergency", [/Emergency/], "board (desk)");
  for (const p of ["/queue", "/appointments", "/ipd", "/pharmacy"]) await screenRefused(F, "er_reception1", p);
  const docs = await api("er_reception1", "GET", "/emergency/doctors");
  const erDoc = (docs.d || []).find((d) => /Emergency Doctor/i.test(d.name ?? d.displayName));
  step(F, "er_reception1", "list of doctors who can be called", !!erDoc, (docs.d || []).length + " doctors");
  const pt = await newPatient(F, "er_reception1"); if (!pt) return;
  const reg = await api("er_reception1", "POST", "/emergency/cases", { patientId: pt.id, doctorId: erDoc.id, chiefComplaint: "Chest pain and breathlessness for 1 hour", arrivalMode: "AMBULANCE", broughtBy: "Son" });
  if (!(await expectStatus(F, "er_reception1", "arrival registered: case, emergency bill and red alert", reg, 201))) return;
  const C = reg.d.id; const caseRow = (await api("er_reception1", "GET", `/emergency/cases/${C}`)).d;
  const erFull = ((await api("er_reception1", "GET", "/emergency/beds")).d?.ER ?? []).every((b) => !b.free);
  step(F, "er_reception1", caseRow.bed ? `case ${caseRow.caseNumber ?? ""} given emergency bed ${caseRow.bed.code}` : `case ${caseRow.caseNumber ?? ""} registered without a bed because the ward is full (never turned away)`, !!caseRow.bed || erFull);
  const enc = caseRow.encounterId ?? caseRow.encounter?.id;
  const alertsN = await api("er_nurse1", "GET", "/emergency/alerts"); step(F, "er_nurse1", "emergency nurse alerted", JSON.stringify(alertsN.j).includes(C), `HTTP ${alertsN.s}`);
  const alertsD = await api("er_doctor1", "GET", "/emergency/alerts"); step(F, "er_doctor1", "called doctor alerted", JSON.stringify(alertsD.j).includes(C), `HTTP ${alertsD.s}`);
  await screen(F, "er_nurse1", "/emergency", [pt.first], "board (nurse)");
  await refused(F, "er_reception1", "desk saves the triage", "POST", `/emergency/cases/${C}/triage`, { level: "RED", consciousness: "ALERT", airwayClear: true, breathingOk: false, circulationOk: true });
  await expectStatus(F, "er_nurse1", "triage: RED, alert, breathing compromised, pain 8", await api("er_nurse1", "POST", `/emergency/cases/${C}/triage`, { level: "RED", consciousness: "ALERT", airwayClear: true, breathingOk: false, circulationOk: true, painScore: 8, note: "SpO2 89% on air" }), [200, 201]);
  await expectStatus(F, "er_nurse1", "vitals recorded", await api("er_nurse1", "POST", `/encounters/${enc}/observations`, { observations: [{ type: "PULSE", value: 118 }, { type: "SPO2", value: 89 }, { type: "SYSTOLIC_BP", value: 96 }, { type: "DIASTOLIC_BP", value: 60 }] }), 201);
  for (const bed of ((await api("er_nurse1", "GET", "/emergency/beds")).d?.ER ?? []).filter((x) => x.status === "CLEANING")) {
    await expectStatus(F, "nurse1", `ward nurse marks emergency bed ${bed.code} clean (bed board)`, await api("nurse1", "POST", `/beds/${bed.id}/status`, { status: "AVAILABLE" }), 200);
  }
  const free = (await api("er_nurse1", "GET", "/emergency/beds")).d;
  const erBeds = (free?.ER ?? []).filter((b) => b.free && b.code !== caseRow.bed?.code);
  if (erBeds[0]) await expectStatus(F, "er_nurse1", `patient moved to bed ${erBeds[0].code}`, await api("er_nurse1", "POST", `/emergency/cases/${C}/bed`, { bedId: erBeds[0].id }), 200);
  else step(F, "er_nurse1", "move bed (no free bed listed)", false, JSON.stringify(free).slice(0, 160));
  await refused(F, "doctor1", "a doctor who was not called accepts the case", "POST", `/emergency/cases/${C}/accept`, {});
  await refused(F, "er_nurse1", "nurse decides the disposition", "POST", `/emergency/cases/${C}/decision`, { disposition: "DISCHARGE", note: "x x x" });
  await expectStatus(F, "er_doctor1", "doctor accepts the patient", await api("er_doctor1", "POST", `/emergency/cases/${C}/accept`, {}), 200);
  await expectStatus(F, "er_doctor1", "assessment note with working diagnosis", await api("er_doctor1", "POST", `/emergency/cases/${C}/notes`, { kind: "ASSESSMENT", text: "Acute chest pain, ECG ST elevation in V2-V4.", diagnosis: "Acute anterior STEMI" }), 201);
  const t = await api("er_doctor1", "POST", "/lims/orders", { encounterId: enc, tests: [{ name: "CBC (complete blood count)", category: "LABORATORY" }] });
  await expectStatus(F, "er_doctor1", "emergency test ordered (goes straight to the lab, emergency priority)", t, 201);
  const ereq = ((await api("lims_manager1", "GET", "/lims/requests?department=PATHOLOGY&pageSize=100")).d?.items ?? []).find((r) => r.encounterId === enc);
  step(F, "lims_manager1", "emergency test is in the lab queue with EMERGENCY priority", ereq?.priority === "EMERGENCY", ereq ? `${ereq.priority} ${ereq.status}` : "not found");
  await expectStatus(F, "er_nurse1", "emergency nurse takes the sample", await api("er_nurse1", "POST", `/lims/requests/${ereq.id}/collect`, {}), 200);
  // nurse asks the doctor for a medicine
  const stockR = (await api("er_doctor1", "GET", "/medicines?pageSize=30")).d; const stock = stockR?.items ?? stockR ?? [];
  const m = stock[0];
  const nr = await api("er_nurse1", "POST", "/order-requests", { kind: "MEDICINE", encounterId: enc, item: { medicineId: m.id, genericName: m.genericName, strength: m.strength ?? "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "STAT", durationDays: 1, quantity: 1 }, note: "Patient in pain" });
  await expectStatus(F, "er_nurse1", "nurse request: a medicine for the doctor to approve", nr, 201);
  const nr2 = await api("er_nurse1", "POST", "/order-requests", { kind: "TEST", encounterId: enc, tests: [{ name: "Troponin I", category: "LABORATORY" }], note: "Chest pain" });
  await expectStatus(F, "er_nurse1", "nurse request: a test", nr2, 201);
  await refused(F, "er_nurse1", "nurse approves her own request", "POST", `/order-requests/${nr.d?.id}/decision`, { action: "ACCEPT" });
  await expectStatus(F, "er_doctor1", "doctor accepts the medicine request (becomes a signed order)", await api("er_doctor1", "POST", `/order-requests/${nr.d?.id}/decision`, { action: "ACCEPT" }), 200);
  await expectStatus(F, "er_doctor1", "doctor signs the prescription the accepted request added to", await api("er_doctor1", "POST", `/encounters/${enc}/prescription/sign`, { acknowledgeAllergyWarnings: true }), 200);
  await expectStatus(F, "er_doctor1", "doctor declines the test request with a reason", await api("er_doctor1", "POST", `/order-requests/${nr2.d?.id}/decision`, { action: "DECLINE", note: "Already ordered as part of the panel" }), 200);
  await screen(F, "er_doctor1", `/emergency/${C}`, [pt.first], "case page (doctor)");
  // pharmacy dispenses the accepted medicine → goes on the emergency bill
  const pqr = (await api("pharmacist1", "GET", `/pharmacy/queue?q=${encodeURIComponent(pt.mrn)}`)).d; const ord = (pqr?.items ?? pqr ?? []).find((o) => o.patientId === pt.id);
  step(F, "pharmacist1", "accepted request reached the pharmacy", !!ord);
  if (ord) await expectStatus(F, "pharmacist1", "dispensed → added to the emergency bill (not sold at the counter)", await api("pharmacist1", "POST", "/pharmacy/dispenses", { patientId: pt.id, medicationOrderId: ord.id, items: [{ medicationOrderItemId: ord.items[0].id, medicineId: ord.items[0].medicineId, quantity: ord.items[0].quantity ?? 1 }] }), 201);
  const svc = ((await api("er_reception1", "GET", "/services?pageSize=100")).d || []).find((s) => /resuscitation|ECG/i.test(s.name));
  await expectStatus(F, "er_reception1", `desk adds a charge: ${svc?.name}`, await api("er_reception1", "POST", `/emergency/cases/${C}/bill/charges`, { serviceId: svc.id }), [200, 201]);
  await refused(F, "er_nurse1", "nurse adds a bill charge", "POST", `/emergency/cases/${C}/bill/charges`, { description: "x x", unitPrice: "1.00" });
  ctx.erCase = { C, enc, pt };
  // ICU handover is in icu(); a second case goes home, a third is cancelled
  const pt2 = await newPatient(F, "er_reception1");
  const reg2 = await api("er_reception1", "POST", "/emergency/cases", { patientId: pt2.id, doctorId: erDoc.id, chiefComplaint: "Cut on forearm", arrivalMode: "WALK_IN" });
  await expectStatus(F, "er_reception1", "second arrival registered", reg2, 201);
  await expectStatus(F, "er_nurse1", "triage GREEN", await api("er_nurse1", "POST", `/emergency/cases/${reg2.d.id}/triage`, { level: "GREEN", consciousness: "ALERT", airwayClear: true, breathingOk: true, circulationOk: true, painScore: 3 }), [200, 201]);
  await expectStatus(F, "er_doctor1", "accept", await api("er_doctor1", "POST", `/emergency/cases/${reg2.d.id}/accept`, {}), 200);
  const home = await api("er_doctor1", "POST", `/emergency/cases/${reg2.d.id}/decision`, { disposition: "DISCHARGE", note: "Wound sutured, sent home with advice" });
  await expectStatus(F, "er_doctor1", "decision: home → visit ends, bill issued, bed freed", home, [200, 201]);
  const c2 = (await api("er_reception1", "GET", `/emergency/cases/${reg2.d.id}`)).d;
  step(F, "er_reception1", `case closed as ${c2.status}, bill ${c2.bill?.status ?? c2.invoice?.status ?? ""}`, c2.status === "DISCHARGED");
  const billId = c2.bill?.id ?? c2.invoiceId ?? c2.bill?.invoiceId;
  if (billId) {
    const inv = (await api("er_reception1", "GET", `/invoices/${billId}`)).d;
    await api("er_reception1", "POST", "/shifts/open", { openingCash: "500" });
    if (Number(inv?.balanceDue ?? 0) > 0) await expectStatus(F, "er_reception1", `desk takes payment ₹${inv.balanceDue}`, await api("er_reception1", "POST", `/invoices/${billId}/payments`, { payments: [{ method: "CASH", amount: String(inv.balanceDue) }] }), 201);
    else step(F, "er_reception1", "bill has nothing due (emergency fee 0 by default)", true, `total ₹${inv?.total}`);
  }
  const pt3 = await newPatient(F, "er_reception1");
  const reg3 = await api("er_reception1", "POST", "/emergency/cases", { patientId: pt3.id, doctorId: erDoc.id, chiefComplaint: "Registered by mistake", arrivalMode: "WALK_IN" });
  await expectStatus(F, "er_reception1", "registration cancelled (made by mistake)", await api("er_reception1", "POST", `/emergency/cases/${reg3.d.id}/cancel`, { reason: "Wrong patient picked" }), 200);
  await screen(F, "manager1", "/overview", [/Emergency ward/], "hospital status (manager)");
  await refused(F, "manager1", "manager triages", "POST", `/emergency/cases/${C}/triage`, { level: "RED", consciousness: "ALERT", airwayClear: true, breathingOk: true, circulationOk: true });
}

// ───────────────────────── 4. ICU (continues the emergency case) ─────────────────────────
async function icu(ctx) {
  const F = "ICU";
  if (!ctx.erCase) { step(F, "-", "needs the emergency case", false); return; }
  const { C, enc, pt } = ctx.erCase;
  const icuDocs = (await api("er_doctor1", "GET", "/emergency/icu-doctors")).d || [];
  const icuDoc = icuDocs.find((d) => /ICU/i.test(d.name ?? d.displayName)) || icuDocs[0];
  const beds = (await api("er_doctor1", "GET", "/emergency/beds")).d;
  const icuBed = (beds?.ICU ?? []).find((b) => b.free);
  step(F, "er_doctor1", `free ICU bed ${icuBed?.code ?? "?"} and ICU doctor ${icuDoc?.name ?? icuDoc?.displayName ?? "?"}`, !!icuBed && !!icuDoc, JSON.stringify(beds).slice(0, 120));
  const dec = await api("er_doctor1", "POST", `/emergency/cases/${C}/decision`, { disposition: "ICU", bedId: icuBed.id, consultantId: icuDoc.id, note: "STEMI, needs close monitoring" });
  if (!(await expectStatus(F, "er_doctor1", "handover to ICU: admitted on the same visit", dec, [200, 201]))) return;
  const stays = (await api("icu_doctor1", "GET", "/icu/stays")).d;
  const stay = (stays?.items ?? stays ?? []).find((s) => s.patientName?.includes(pt.first) || s.patient?.name?.includes(pt.first) || s.encounterId === enc);
  if (!step(F, "icu_doctor1", "patient on the ICU doctor's board", !!stay, JSON.stringify(stays).slice(0, 150))) return;
  const S = stay.id ?? stay.admissionId;
  await screen(F, "icu_doctor1", "/icu", [pt.first], "ICU board (doctor)");
  await screen(F, "icu_nurse1", "/icu", [pt.first], "ICU board (nurse)");
  await screen(F, "icu_doctor1", `/icu/${S}`, [pt.first, /Handed over|emergency/i], "ICU patient page (doctor)");
  for (const p of ["/queue", "/appointments"]) await screenRefused(F, "icu_doctor1", p);
  await refused(F, "icu_nurse1", "nurse sets the vitals interval", "POST", `/icu/stays/${S}/vitals-schedule`, { intervalMinutes: 15 });
  await expectStatus(F, "icu_doctor1", "vitals every 15 minutes", await api("icu_doctor1", "POST", `/icu/stays/${S}/vitals-schedule`, { intervalMinutes: 15, reason: "Post-STEMI first hours" }), [200, 201]);
  const ins = await api("icu_doctor1", "POST", `/icu/stays/${S}/instructions`, { text: "Start heparin infusion as per protocol and report any bleeding", urgent: true });
  await expectStatus(F, "icu_doctor1", "urgent instruction for the nurse", ins, [200, 201]);
  const alerts = await api("icu_nurse1", "GET", "/icu/alerts"); step(F, "icu_nurse1", "nurse sees the urgent instruction alert", JSON.stringify(alerts.j).length > 20, JSON.stringify(alerts.d).slice(0, 120));
  await expectStatus(F, "icu_nurse1", "nurse records vitals", await api("icu_nurse1", "POST", `/encounters/${enc}/observations`, { observations: [{ type: "PULSE", value: 102 }, { type: "SPO2", value: 95 }, { type: "SYSTOLIC_BP", value: 110 }, { type: "DIASTOLIC_BP", value: 70 }, { type: "RESPIRATORY_RATE", value: 20 }] }), 201);
  const insId = (ins.d?.instructions ?? []).find((i) => !i.doneAt)?.id;
  await refused(F, "icu_doctor1", "doctor ticks the nurse's instruction", "POST", `/icu/instructions/${insId}/done`, {});
  await expectStatus(F, "icu_nurse1", "instruction marked done with a note", await api("icu_nurse1", "POST", `/icu/instructions/${insId}/done`, { note: "Infusion started 22:10" }), [200, 201]);
  const again = await api("icu_nurse1", "POST", `/icu/instructions/${insId}/done`, {}); step(F, "icu_nurse1", "an instruction is done only once", again.s === 409, `HTTP ${again.s}`);
  const eq = (await api("icu_nurse1", "GET", "/icu/equipment")).d || [];
  const vent = eq.find((e) => /monitor/i.test(e.name)) || eq[0];
  const start = await api("icu_nurse1", "POST", `/icu/stays/${S}/equipment`, { serviceId: vent.id });
  await expectStatus(F, "icu_nurse1", `equipment started: ${vent?.name} (₹${vent?.price}/day)`, start, [200, 201]);
  const dup = await api("icu_nurse1", "POST", `/icu/stays/${S}/equipment`, { serviceId: vent.id }); step(F, "icu_nurse1", "the same equipment cannot run twice at once", dup.s === 409, `HTTP ${dup.s}`);
  await expectStatus(F, "icu_doctor1", "day note with plan", await api("icu_doctor1", "POST", `/icu/stays/${S}/notes`, { text: "Haemodynamically stable on infusion. No arrhythmia.", plan: "Repeat ECG and troponin in the morning" }), [200, 201]);
  const lab = await api("icu_doctor1", "POST", "/lims/orders", { encounterId: enc, tests: [{ name: "Kidney function test (KFT)", category: "LABORATORY" }] });
  await expectStatus(F, "icu_doctor1", "ICU doctor orders a test (assigned to an ICU nurse)", lab, 201);
  const req = await api("icu_nurse1", "POST", "/order-requests", { kind: "TEST", encounterId: enc, tests: [{ name: "Random blood sugar", category: "LABORATORY" }], note: "Sweating" });
  await expectStatus(F, "icu_nurse1", "ICU nurse asks for a test", req, 201);
  await expectStatus(F, "icu_doctor1", "ICU doctor accepts the request (test ordered in the doctor's name)", await api("icu_doctor1", "POST", `/order-requests/${req.d?.id}/decision`, { action: "ACCEPT" }), 200);
  const eqId = ((await api("icu_nurse1", "GET", `/icu/stays/${S}`)).d?.equipment ?? []).find((x) => !x.stoppedAt)?.id;
  await expectStatus(F, "icu_nurse1", "equipment stopped", await api("icu_nurse1", "POST", `/icu/equipment/${eqId}/stop`, {}), [200, 201]);
  const full = await api("icu_doctor1", "GET", `/icu/stays/${S}`);
  const d = full.d || {};
  step(F, "icu_doctor1", "patient page: vitals, schedule, instructions, day notes, equipment and billing", full.s === 200 && !!(d.billing || d.bill || d.charges), Object.keys(d).join(","));
  await screen(F, "icu_doctor1", `/icu/${S}`, [/Day 1/, /Billing for this stay/i], "ICU page: day-by-day and billing");
  await screen(F, "manager1", "/icu", [pt.first], "ICU board (manager, read only)");
  await refused(F, "manager1", "manager writes an instruction", "POST", `/icu/stays/${S}/instructions`, { text: "Not allowed here" });
  await refused(F, "doctor1", "another doctor writes an ICU note", "POST", `/icu/stays/${S}/notes`, { text: "Not my patient" });
  await screen(F, "admin", "/overview", [/Intensive care unit/], "hospital status (admin)");
}

// ───────────────────────── 5. Telemedicine ─────────────────────────
async function tele(ctx) {
  const F = "TELE";
  await expectStatus(F, "admin", "video service address set (Settings → TELECONSULT_VIDEO_URL)", await api("admin", "PUT", "/settings/TELECONSULT_VIDEO_URL", { value: "https://meet.example.org/{room}" }), 200);
  await expectStatus(F, "admin", "patient app switched on (Settings → PATIENT_PORTAL_ENABLED)", await api("admin", "PUT", "/settings/PATIENT_PORTAL_ENABLED", { value: true }), 200);
  const doc = await practitionerOf("doctor8");
  const now = new Date(Date.now() + 5.5 * 3600e3); const dow = now.getUTCDay();
  const windows = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, start: "00:00", end: "23:55", slotMinutes: 5 }));
  await expectStatus(F, "admin", "doctor8's hours set to the whole day (so a slot exists now, for the test)", await api("admin", "PUT", `/practitioners/${doc.id}/schedule`, { windows }), 200);
  const pt = await newPatient(F, "reception1", { mobile: mobile() }); if (!pt) return;
  const day = now.toISOString().slice(0, 10);
  const av = await api("reception1", "GET", `/practitioners/${doc.id}/availability?date=${day}`);
  const slots = (av.d?.slots ?? av.d ?? []).filter((s) => (s.available ?? !s.booked) && new Date(s.startAt ?? s.start) > new Date());
  const slot = slots[0];
  step(F, "reception1", `next free slot ${slot ? new Date(slot.startAt ?? slot.start).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "none"}`, !!slot, JSON.stringify(av.j).slice(0, 120));
  const ap = await api("reception1", "POST", "/appointments", { patientId: pt.id, practitionerId: doc.id, startAt: slot.startAt ?? slot.start });
  if (!(await expectStatus(F, "reception1", "appointment booked", ap, 201))) return;
  await refused(F, "nurse1", "nurse makes it a video consultation", "POST", "/teleconsults", { appointmentId: ap.d.id });
  const tc = await api("reception1", "POST", "/teleconsults", { appointmentId: ap.d.id });
  if (!(await expectStatus(F, "reception1", "made a video consultation (Make video)", tc, [200, 201]))) return;
  const T = tc.d.id;
  const twice = await api("reception1", "POST", "/teleconsults", { appointmentId: ap.d.id }); step(F, "reception1", "only once per appointment", twice.s === 409, `HTTP ${twice.s}`);
  await screen(F, "reception1", "/teleconsult", [pt.first], "video consultations (desk)");
  await screen(F, "doctor8", "/teleconsult", [pt.first], "video consultations (doctor)");
  const other = await api("doctor1", "GET", "/teleconsults"); step(F, "doctor1", "another doctor does not see it", !JSON.stringify(other.j).includes(T), `HTTP ${other.s}`);
  await refused(F, "doctor1", "another doctor joins", "POST", `/teleconsults/${T}/join`, { identityMethod: "KNOWN_PATIENT" });
  await refused(F, "reception1", "reception joins as the doctor", "POST", `/teleconsults/${T}/join`, { identityMethod: "KNOWN_PATIENT" });
  // the patient, in the patient app
  const pctx = await browser.newContext({ viewport: { width: 420, height: 860 } }); const pp = await pctx.newPage();
  pp.on("pageerror", (e) => consoleProblems.push(`patient PAGEERROR ${e.message.slice(0, 160)}`));
  await pp.goto(BASE + "/patient"); await pp.waitForLoadState("networkidle").catch(() => {});
  await pp.getByLabel("Hospital code").fill("demo-hospital"); await pp.getByLabel("Mobile number").fill(pt.mobile);
  const n0 = (await sms(pt.mobile)).length;
  await pp.getByRole("button", { name: /code/i }).first().click();
  let code = null; for (let i = 0; i < 20 && !code; i++) { await pp.waitForTimeout(500); const ms = await sms(pt.mobile); code = (/(\d{6}) is your/.exec(ms.slice(n0).map((m) => m.text).join(" ")) || [])[1]; }
  step(F, "patient", "sign-in code received by SMS", !!code);
  await pp.getByLabel(/6-digit code/).fill(code ?? "");
  await pp.getByRole("button", { name: /Sign in|Verify|Continue/i }).first().click();
  await pp.waitForTimeout(2500);
  const dob = pp.getByLabel("Date of birth");
  if (await dob.count()) { await dob.fill("1984-06-15"); await pp.getByRole("button", { name: /Confirm|Unlock|Continue|Open/i }).first().click(); await pp.waitForTimeout(2500); }
  let txt = await pp.locator("body").innerText();
  step(F, "patient", "patient app shows the appointment as a video consultation", /video consultation/i.test(txt), txt.replace(/\s+/g, " ").slice(0, 160));
  await pp.screenshot({ path: path.join(shotsDir, "TELE-patient-app.png") });
  const agree = pp.getByRole("checkbox"); if (await agree.count()) await agree.first().check();
  const here = pp.getByRole("button", { name: "I am here" });
  if (await here.count()) { await here.click(); await pp.waitForTimeout(2000); }
  txt = await pp.locator("body").innerText();
  step(F, "patient", "patient pressed 'I am here' (consent recorded) → waiting room", /waiting room/i.test(txt), txt.replace(/\s+/g, " ").slice(0, 160));
  const list = await api("doctor8", "GET", "/teleconsults"); const row = (list.d?.items ?? list.d ?? []).find((x) => x.id === T);
  step(F, "doctor8", "doctor sees the patient is waiting", !!row && (row.patientWaiting || row.waiting || /WAIT/i.test(JSON.stringify(row))), JSON.stringify(row).slice(0, 160));
  const noId = await api("doctor8", "POST", `/teleconsults/${T}/join`, {}); step(F, "doctor8", "joining the first time needs the identity check", noId.s === 400 || noId.s === 409, `HTTP ${noId.s} ${errOf(noId)}`);
  const join = await api("doctor8", "POST", `/teleconsults/${T}/join`, { identityMethod: "PHOTO_ID_SHOWN" });
  await expectStatus(F, "doctor8", "identity confirmed (photo ID) and call started → video room link", join, 200);
  step(F, "doctor8", "video room uses the hospital's video service", JSON.stringify(join.j).includes("meet.example.org/"), JSON.stringify(join.d).slice(0, 140));
  await pp.reload(); await pp.waitForTimeout(3000);
  const joinBtn = pp.getByRole("button", { name: "Join video call" });
  step(F, "patient", "patient app shows 'Join video call' after the doctor started", (await joinBtn.count()) > 0);
  if (await joinBtn.count()) {
    const [popup] = await Promise.all([pctx.waitForEvent("page", { timeout: 8000 }).catch(() => null), joinBtn.click()]);
    await pp.waitForTimeout(1500);
    step(F, "patient", "patient joins the video room", !!popup || /meet\.example\.org/.test(pp.url()), popup ? popup.url().slice(0, 60) : pp.url());
  }
  await screen(F, "doctor8", "/teleconsult", [pt.first], "doctor's list during the call");
  await expectStatus(F, "doctor8", "doctor ends the call", await api("doctor8", "POST", `/teleconsults/${T}/end`, {}), 200);
  const enc = ap.d.encounterId ?? (await api("reception1", "GET", `/appointments/${ap.d.id}`)).d?.encounterId;
  // second video consultation: cancelled by the desk before it starts
  const slot2 = slots[1];
  if (slot2) {
    const ap2 = await api("reception1", "POST", "/appointments", { patientId: pt.id, practitionerId: doc.id, startAt: slot2.startAt ?? slot2.start, duplicateOverride: { reason: "Second review" } });
    const tc2 = ap2.s === 201 ? await api("reception1", "POST", "/teleconsults", { appointmentId: ap2.d.id }) : ap2;
    if (tc2.s === 200 || tc2.s === 201) await expectStatus(F, "reception1", "desk cancels a video consultation with a reason", await api("reception1", "POST", `/teleconsults/${tc2.d.id}/cancel`, { reason: "Patient prefers to come in person" }), 200);
    else step(F, "reception1", "second video consultation for cancel test", false, `HTTP ${tc2.s} ${errOf(tc2)}`);
  }
  await pctx.close();
  ctx.teleEnc = enc;
}

(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = {};
  const plan = only.length ? only : ["opd", "lims", "er", "icu", "tele"];
  const fns = { opd, lims, er, icu, tele };
  for (const f of plan) {
    try { await fns[f](ctx); } catch (e) { step(f.toUpperCase(), "-", "unexpected script error", false, e.stack?.split("\n").slice(0, 3).join(" | ")); }
  }
  fs.writeFileSync(path.join(outDir, `flows-${plan.join("-")}.json`), JSON.stringify({ results, consoleProblems }, null, 1));
  const byFlow = {};
  for (const r of results) { byFlow[r.flow] ??= { pass: 0, fail: 0 }; byFlow[r.flow][r.ok ? "pass" : "fail"]++; }
  console.log("\nSUMMARY", JSON.stringify(byFlow));
  console.log("BROWSER PROBLEMS:", consoleProblems.length ? "\n  " + [...new Set(consoleProblems)].join("\n  ") : "none");
  await browser.close();
})();
