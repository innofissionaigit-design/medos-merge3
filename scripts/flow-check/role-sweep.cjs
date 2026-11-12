// Role-by-role screen sweep of the MedOS test instance (http://localhost:3200) in Google Chrome.
// For every seeded role: sign in through the login form, open every page in the role's menu and a set of pages it should not reach,
// and record crashes, refusals, API 5xx answers and console errors. Usage: node role-sweep.cjs <webRoot> <outDir> <password>
const { createRequire } = require("module");
const path = require("path");
const fs = require("fs");
const [webRoot, outDir, password] = process.argv.slice(2);
const req = createRequire(path.join(webRoot, "package.json"));
const { chromium } = req("@playwright/test");
const BASE = process.env.BASE || "http://localhost:3200";
const ROLES = ["reception1", "doctor1", "nurse1", "cashier1", "pharmacist1", "manager1", "admin",
  "er_reception1", "er_nurse1", "er_doctor1", "icu_doctor1", "icu_nurse1",
  "lims_manager1", "p_lab_tech1", "r_lab_tech1", "pathologist1", "radiologist1",
  "admission1", "bedmgr1", "coordinator1", "claims1"];
const PROBE = ["/emergency", "/icu", "/lims", "/lis", "/teleconsult", "/queue", "/appointments", "/billing", "/pharmacy", "/nursing", "/ipd", "/admin", "/reports", "/overview", "/patients"];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const results = [];
  for (const user of ROLES) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    const consoleErrors = []; const serverErrors = [];
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + String(e.message).slice(0, 200)));
    page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) serverErrors.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`); });
    const out = { user, pages: [], blocked: [] };
    try {
      await page.goto(BASE + "/login");
      const boxes = page.locator("input");
      await boxes.nth(0).fill("demo-hospital"); await boxes.nth(1).fill(user); await boxes.nth(2).fill(password);
      await page.keyboard.press("Enter");
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
      await page.waitForTimeout(2500);
      out.landing = new URL(page.url()).pathname;
      const nav = await page.locator("aside a").evaluateAll((as) => as.map((a) => [a.textContent.trim(), a.getAttribute("href")]));
      out.nav = nav.map((n) => n[0]);
      const visit = async (href) => {
        const before = consoleErrors.length + serverErrors.length;
        await page.goto(BASE + href); await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1200);
        const body = await page.locator("body").innerText().catch(() => "");
        const main = await page.locator("main").innerText().catch(() => body);
        const shot = path.join(outDir, `${user}${href.replace(/\//g, "_")}.png`);
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
        const crash = /Application error|client-side exception|Unhandled Runtime Error/.test(body);
        const denied = /You do not have access to this page|not enabled for your facility/.test(main);
        const errBanner = (/(Something went wrong|Request failed|Internal server error)[^\n]*/i.exec(main) || [""])[0];
        const newErrs = [...consoleErrors, ...serverErrors].slice(before);
        return { href, at: new URL(page.url()).pathname, crash, denied, errBanner, newErrs, head: main.replace(/\s+/g, " ").slice(0, 70) };
      };
      for (const [, href] of nav) { if (href && href.startsWith("/")) out.pages.push(await visit(href)); }
      for (const href of PROBE.filter((p) => !nav.some((n) => n[1] === p))) out.blocked.push(await visit(href));
    } catch (e) { out.error = String(e.message).slice(0, 300); }
    out.consoleErrors = [...new Set(consoleErrors)]; out.serverErrors = [...new Set(serverErrors)];
    results.push(out);
    const s = (p) => `${p.href}${p.crash ? " CRASH" : p.denied ? " denied" : p.errBanner ? " ERR(" + p.errBanner + ")" : " ok"}${p.at !== p.href ? "→" + p.at : ""}`;
    console.log(`\n== ${user} (lands ${out.landing}) ${out.error ? "ERROR " + out.error : ""}`);
    console.log("  menu:", (out.nav || []).join(", "));
    console.log("  pages:", out.pages.map(s).join(" | "));
    console.log("  not in menu:", out.blocked.map((p) => `${p.href}:${p.crash ? "CRASH" : p.denied ? "refused" : "OPEN(" + p.head.slice(0, 30) + ")"}`).join(" | "));
    if (out.serverErrors.length) console.log("  SERVER 5xx:", out.serverErrors.join(" ; "));
    if (out.consoleErrors.length) console.log("  console errors:", out.consoleErrors.slice(0, 5).join(" ; "));
    await ctx.close();
  }
  fs.writeFileSync(path.join(outDir, "role-sweep.json"), JSON.stringify(results, null, 1));
  await browser.close();
})();
