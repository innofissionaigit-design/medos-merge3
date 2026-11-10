import { test } from "node:test";
import assert from "node:assert/strict";
// The web app does not depend on the shared package; the role table is read from its source so the test always sees the real roles.
import { SYSTEM_ROLES } from "../../../../packages/shared/src/permissions";
import { homeFor, visibleNav } from "./nav";

const ON = { PHARMACY_ENABLED: true, IPD_ENABLED: true, NURSING_ENABLED: true };
const nav = (role: string) => visibleNav(new Set<string>(SYSTEM_ROLES[role] ?? []), ON, [role]).map((n) => n.href);

test("the emergency desk lands on the emergency board and sees nothing of the outpatient desk", () => {
  const items = nav("EMERGENCY_RECEPTIONIST");
  assert.equal(items[0], "/emergency");
  for (const other of ["/appointments", "/queue", "/ipd", "/pharmacy", "/lims"]) assert.ok(!items.includes(other), `the emergency desk does not see ${other}`);
  assert.ok(items.includes("/patients") && items.includes("/billing"));
});

test("the emergency nurse lands on the emergency board and keeps every nurse screen", () => {
  const items = nav("EMERGENCY_NURSE");
  assert.equal(items[0], "/emergency");
  for (const nurse of nav("NURSE")) assert.ok(items.includes(nurse), `an emergency nurse also sees ${nurse}`);
  // Every permission of an ordinary nurse is also an emergency nurse's: the only addition is emergency work.
  const extra = (SYSTEM_ROLES["EMERGENCY_NURSE"] ?? []).filter((p) => !(SYSTEM_ROLES["NURSE"] ?? []).includes(p));
  assert.deepEqual([...extra].sort(), ["ER_READ", "ER_TRIAGE"]);
  assert.deepEqual((SYSTEM_ROLES["NURSE"] ?? []).filter((p) => !(SYSTEM_ROLES["EMERGENCY_NURSE"] ?? []).includes(p)), []);
});

test("the doctor and the oversight roles see the emergency board; other desks do not", () => {
  for (const role of ["DOCTOR", "ADMINISTRATOR", "MANAGER"]) assert.ok(nav(role).includes("/emergency"), `${role} sees the emergency board`);
  for (const role of ["RECEPTIONIST", "NURSE", "CASHIER", "PHARMACIST", "LIMS_MANAGER"]) assert.ok(!nav(role).includes("/emergency"), `${role} does not`);
  assert.equal(homeFor(visibleNav(new Set<string>(SYSTEM_ROLES["EMERGENCY_NURSE"] ?? []), ON, ["EMERGENCY_NURSE"])), "/emergency");
});

test("each emergency permission belongs to the role whose job it is", () => {
  const holders = (p: string) => Object.entries(SYSTEM_ROLES).filter(([, perms]) => perms.includes(p as never)).map(([r]) => r).sort();
  assert.deepEqual(holders("ER_REGISTER"), ["EMERGENCY_RECEPTIONIST"]);
  assert.deepEqual(holders("ER_TRIAGE"), ["EMERGENCY_NURSE"]);
  assert.deepEqual(holders("ER_TREAT"), ["DOCTOR"]);
  assert.deepEqual(holders("ER_BILL"), ["EMERGENCY_RECEPTIONIST"]);
});
