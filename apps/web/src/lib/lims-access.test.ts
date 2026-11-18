import { test } from "node:test";
import assert from "node:assert/strict";
// The web app does not depend on the shared package; the role table is read from its source so the test always sees the real roles.
import { SYSTEM_ROLES } from "../../../../packages/shared/src/permissions";
import { desksFor, LIMS_PORTAL_PERMISSIONS, portalTitle } from "./lims-access";
import { homeFor, visibleNav } from "./nav";

const can = (role: string) => { const set = new Set<string>(SYSTEM_ROLES[role] ?? []); return (...p: string[]) => p.some((x) => set.has(x)); };
const ON = { PHARMACY_ENABLED: true, IPD_ENABLED: true, NURSING_ENABLED: true };
const nav = (role: string) => visibleNav(new Set<string>(SYSTEM_ROLES[role] ?? []), ON, [role]).map((n) => n.href);

test("each laboratory role opens the desk its job needs, and nobody else gets the portal", () => {
  assert.deepEqual(desksFor(can("LIMS_MANAGER")).desks, ["control"]);
  assert.deepEqual(desksFor(can("P_LAB_TECH")).desks, ["technician"]);
  assert.deepEqual(desksFor(can("R_LAB_TECH")).desks, ["technician"]);
  assert.deepEqual(desksFor(can("PATHOLOGIST")).desks, ["review"]);
  assert.deepEqual(desksFor(can("RADIOLOGIST")).desks, ["review"]);
  assert.deepEqual(desksFor(can("NURSE")).desks, ["collection"]);
  assert.deepEqual(desksFor(can("RECEPTIONIST")).desks, ["reception"]);
  // The administrator and the manager watch from the control room.
  assert.deepEqual(desksFor(can("ADMINISTRATOR")).desks, ["control"]);
  assert.deepEqual(desksFor(can("MANAGER")).desks, ["control"]);
  // Doctors work from the patient's visit and admission pages; cashiers and pharmacists have nothing here.
  for (const role of ["DOCTOR", "CASHIER", "PHARMACIST", "PAYROLL_OFFICER", "CLAIMS_OFFICER"]) assert.deepEqual(desksFor(can(role)).desks, [], role);
});

test("the portal's sign-in permissions match the desks", () => {
  for (const role of Object.keys(SYSTEM_ROLES)) {
    const inPortal = desksFor(can(role)).desks.length > 0;
    const byPermission = (SYSTEM_ROLES[role] ?? []).some((p) => LIMS_PORTAL_PERMISSIONS.includes(p));
    // The legacy technician roles hold LAB_RESULT or RAD_PERFORM, which also let them in (they see the technician-only parts through the API's own checks).
    if (inPortal) assert.ok(byPermission, role);
  }
});

test("the portal title says whose portal it is", () => {
  assert.equal(portalTitle(can("LIMS_MANAGER")), "LIMS manager");
  assert.equal(portalTitle(can("P_LAB_TECH")), "Pathology technician");
  assert.equal(portalTitle(can("R_LAB_TECH")), "Radiology technician");
  assert.equal(portalTitle(can("PATHOLOGIST")), "Pathologist");
  assert.equal(portalTitle(can("RADIOLOGIST")), "Radiologist");
  assert.equal(portalTitle(can("NURSE")), "Nurse");
  assert.equal(portalTitle(can("MANAGER")), "Monitoring");
});

test("the laboratory staff land on the portal, and the earlier LIS page is kept only for people outside it", () => {
  for (const role of ["LIMS_MANAGER", "P_LAB_TECH", "R_LAB_TECH", "PATHOLOGIST", "RADIOLOGIST"]) {
    const items = visibleNav(new Set<string>(SYSTEM_ROLES[role] ?? []), ON, [role]);
    // The manager lands in the control room; the technicians, pathologist and radiologist land on their own laboratory dashboard, with the portal next in the menu.
    assert.equal(homeFor(items), role === "LIMS_MANAGER" ? "/lims" : "/dashboard", role);
    assert.ok(items.some((n) => n.href === "/lims"), `${role} has the portal in the menu`);
    assert.ok(!items.some((n) => n.href === "/lis"), `${role} sees the portal, not the earlier LIS page`);
  }
  // The earlier technician roles do not have the portal and keep the LIS page.
  assert.ok(nav("LAB_TECHNICIAN").includes("/lis") && !nav("LAB_TECHNICIAN").includes("/lims"));
  assert.ok(nav("RADIOGRAPHER").includes("/lis") && !nav("RADIOGRAPHER").includes("/lims"));
  // The administrator and the manager can open it; the doctor and the cashier cannot.
  assert.ok(nav("ADMINISTRATOR").includes("/lims") && nav("MANAGER").includes("/lims"));
  assert.ok(!nav("DOCTOR").includes("/lims") && !nav("CASHIER").includes("/lims"));
  assert.ok(nav("NURSE").includes("/lims") && nav("RECEPTIONIST").includes("/lims"));
});
