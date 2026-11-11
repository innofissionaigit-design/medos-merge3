import { test } from "node:test";
import assert from "node:assert/strict";
// The web app does not depend on the shared package; the role table is read from its source so the test always sees the real roles.
import { SYSTEM_ROLES } from "../../../../packages/shared/src/permissions";
import { homeFor, visibleNav } from "./nav";

const ON = { PHARMACY_ENABLED: true, IPD_ENABLED: true, NURSING_ENABLED: true };
const nav = (role: string) => visibleNav(new Set<string>(SYSTEM_ROLES[role] ?? []), ON, [role]).map((n) => n.href);
const perms = (r: string): string[] => [...(SYSTEM_ROLES[r] ?? [])];
const holders = (p: string) => Object.entries(SYSTEM_ROLES).filter(([, ps]) => ps.includes(p as never)).map(([r]) => r).sort();

test("the emergency desk lands on the emergency board and sees nothing of the outpatient desk", () => {
  const items = nav("EMERGENCY_RECEPTIONIST");
  assert.equal(items[0], "/emergency");
  for (const other of ["/appointments", "/queue", "/ipd", "/pharmacy", "/lims"]) assert.ok(!items.includes(other), `the emergency desk does not see ${other}`);
  assert.ok(items.includes("/patients") && items.includes("/billing"));
});

test("the four emergency and ICU roles see only their own work: no OPD queue, appointments, video consultations, reports or admissions list", () => {
  const forbidden = ["/queue", "/appointments", "/teleconsult", "/reports", "/billing", "/pharmacy", "/admin", "/audit", "/payroll", "/claims", "/overview"];
  for (const role of ["EMERGENCY_DOCTOR", "EMERGENCY_NURSE", "ICU_DOCTOR", "ICU_NURSE"]) {
    const items = nav(role);
    for (const other of forbidden) assert.ok(!items.includes(other), `${role} does not see ${other}`);
    assert.ok(!items.includes("/ipd"), `${role} reaches an admission from the ward board, not from the general admissions list`);
  }
  assert.deepEqual(nav("EMERGENCY_DOCTOR"), ["/emergency", "/patients", "/dashboard"]);
  assert.deepEqual(nav("ICU_DOCTOR"), ["/icu", "/patients", "/dashboard"]);
  assert.deepEqual(nav("EMERGENCY_NURSE"), ["/emergency", "/lims", "/patients", "/dashboard"]);
  assert.deepEqual(nav("ICU_NURSE"), ["/icu", "/nursing", "/lims", "/patients", "/dashboard"]);
  assert.ok(!nav("ICU_DOCTOR").includes("/nursing"), "the ICU doctor does not get the nursing worklist");
  for (const role of ["EMERGENCY_DOCTOR", "EMERGENCY_NURSE", "ICU_DOCTOR", "ICU_NURSE"]) assert.equal(homeFor(visibleNav(new Set<string>(perms(role)), ON, [role])), role.startsWith("ICU") ? "/icu" : "/emergency");
});

test("the doctor who is not in the ward still sees the emergency board, and so do the oversight roles; other desks do not", () => {
  for (const role of ["DOCTOR", "EMERGENCY_DOCTOR", "ADMINISTRATOR", "MANAGER"]) assert.ok(nav(role).includes("/emergency"), `${role} sees the emergency board`);
  for (const role of ["RECEPTIONIST", "NURSE", "CASHIER", "PHARMACIST", "LIMS_MANAGER", "ICU_DOCTOR", "ICU_NURSE"]) assert.ok(!nav(role).includes("/emergency"), `${role} does not`);
});

test("each emergency permission belongs to the role whose job it is", () => {
  assert.deepEqual(holders("ER_REGISTER"), ["EMERGENCY_RECEPTIONIST"]);
  assert.deepEqual(holders("ER_TRIAGE"), ["EMERGENCY_NURSE"]);
  assert.deepEqual(holders("ER_TREAT"), ["DOCTOR", "EMERGENCY_DOCTOR"]);
  assert.deepEqual(holders("ER_BILL"), ["EMERGENCY_RECEPTIONIST"]);
});

test("the emergency doctor and the ICU doctor can do their own work: see the patient, order tests, prescribe and sign; the ICU doctor also discharges and signs the summary", () => {
  for (const role of ["EMERGENCY_DOCTOR", "ICU_DOCTOR"]) for (const p of ["PATIENT_READ", "VITALS_READ", "PRESCRIPTION_CREATE", "PRESCRIPTION_SIGN", "LIMS_ORDER", "LIMS_PRIORITY", "LIMS_READ", "LAB_READ", "RAD_READ", "ALLERGY_WRITE"]) assert.ok(perms(role).includes(p), `${role} has ${p}`);
  for (const p of ["ADMISSION_READ", "ADMISSION_DISCHARGE", "CONSULTATION_CREATE", "CONSULTATION_SIGN", "CHARGE_CREATE", "ICU_READ", "ICU_DOCTOR"]) assert.ok(perms("ICU_DOCTOR").includes(p), `the ICU doctor has ${p}`);
  for (const p of ["QUEUE_READ", "APPOINTMENT_READ", "TELE_READ", "TELE_CONDUCT", "AI_USE", "REPORT_OPD", "REPORT_MY_PRACTICE", "ADMISSION_DISCHARGE", "NURSING_READ"]) assert.ok(!perms("EMERGENCY_DOCTOR").includes(p), `the emergency doctor does not have ${p}`);
  for (const p of ["QUEUE_READ", "APPOINTMENT_READ", "TELE_READ", "AI_USE", "REPORT_OPD", "REPORT_MY_PRACTICE"]) assert.ok(!perms("ICU_DOCTOR").includes(p), `the ICU doctor does not have ${p}`);
});

test("the nurses can do their own work and nothing of the outpatient desk", () => {
  for (const role of ["EMERGENCY_NURSE", "ICU_NURSE"]) {
    for (const p of ["PATIENT_READ", "VITALS_CREATE", "VITALS_READ", "LIMS_COLLECT", "ALLERGY_WRITE", "ORDER_REQUEST"]) assert.ok(perms(role).includes(p), `${role} has ${p}`);
    for (const p of ["QUEUE_READ", "QUEUE_MANAGE", "APPOINTMENT_READ", "REPORT_IPD", "PRESCRIPTION_CREATE", "PRESCRIPTION_SIGN", "LIMS_ORDER", "ER_TREAT", "ICU_DOCTOR", "INVOICE_READ"]) assert.ok(!perms(role).includes(p), `${role} does not have ${p}`);
  }
  for (const p of ["NURSING_READ", "NURSING_DOCUMENT", "NURSING_MEDICATION_ADMINISTER", "CHARGE_CREATE", "ICU_NURSE", "ICU_READ"]) assert.ok(perms("ICU_NURSE").includes(p), `the ICU nurse has ${p}`);
  assert.deepEqual(holders("ORDER_REQUEST"), ["EMERGENCY_NURSE", "ICU_NURSE"], "only the two ward nurses raise requests; doctors decide them");
  assert.deepEqual(holders("ICU_DOCTOR"), ["ICU_DOCTOR"]);
  assert.deepEqual(holders("ICU_NURSE"), ["ICU_NURSE"]);
  assert.deepEqual(holders("ICU_READ"), ["ADMINISTRATOR", "ICU_DOCTOR", "ICU_NURSE", "MANAGER"]);
  for (const role of ["NURSE", "DOCTOR", "EMERGENCY_NURSE", "EMERGENCY_DOCTOR", "CASHIER", "PHARMACIST"]) assert.ok(!nav(role).includes("/icu"), `${role} has no ICU board`);
  for (const role of ["ADMINISTRATOR", "MANAGER"]) assert.ok(nav(role).includes("/icu"), `${role} can follow the ICU`);
});

test("the manager follows the emergency ward, the ICU and billing from one status page and can change none of it", () => {
  assert.equal(nav("MANAGER")[0], "/overview");
  assert.ok(nav("ADMINISTRATOR").includes("/overview"));
  assert.deepEqual(holders("OVERVIEW_READ"), ["ADMINISTRATOR", "MANAGER"]);
  const mgr = perms("MANAGER");
  for (const p of ["ER_READ", "ICU_READ", "INVOICE_READ", "OVERVIEW_READ"]) assert.ok(mgr.includes(p), `the manager has ${p}`);
  // Nothing that acts on a patient in the ward: no registering, triage, deciding, instructing, requesting, nursing, dispensing or taking payment.
  for (const p of ["ER_REGISTER", "ER_TRIAGE", "ER_TREAT", "ER_BILL", "ICU_DOCTOR", "ICU_NURSE", "ORDER_REQUEST", "VITALS_CREATE", "PRESCRIPTION_SIGN", "PRESCRIPTION_CREATE", "LIMS_ORDER", "ADMISSION_CREATE", "ADMISSION_DISCHARGE", "ADMISSION_TRANSFER", "CHARGE_CREATE", "PAYMENT_CREATE", "PHARMACY_DISPENSE", "NURSING_DOCUMENT"]) assert.ok(!mgr.includes(p), `the manager does not have ${p}`);
});
