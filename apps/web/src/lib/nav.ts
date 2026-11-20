/** Navigation is derived from permissions and facility feature flags (never from role names); role only influences order. */

/** `desk` marks a screen that belongs to one reception desk only (OPD or IPD); a receptionist at the other desk does not see it. */
export interface NavItem { href: string; label: string; anyOf?: string[]; /** Hidden for people who hold any of these (the page they replace). */ hideWith?: string[]; feature?: "PHARMACY_ENABLED" | "IPD_ENABLED" | "NURSING_ENABLED"; desk?: "OPD" | "IPD" }

/** REPORT_READ opens every report; each REPORT_<AREA> opens that area's reports (the API enforces the same rule). */
export const REPORT_PERMISSIONS = ["REPORT_READ", "REPORT_OPD", "REPORT_FINANCE", "REPORT_IPD", "REPORT_PHARMACY", "REPORT_MY_PRACTICE"];

/** Whoever holds one of these has the laboratory portal. */
const LIMS_NAV = ["LIMS_MANAGE", "LIMS_REPORTS", "LIMS_DEPARTMENTS", "LIMS_ISSUE", "LAB_VERIFY", "RAD_REPORT", "LIMS_COLLECT", "LIMS_REQUEST"];

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  // The emergency ward (docs/emergency.md): the desk, the emergency nurse and the doctor who was called work from one board.
  // The manager's read-only status of the emergency ward, the ICU and billing (docs/manager-overview.md).
  { href: "/overview", label: "Hospital status", anyOf: ["OVERVIEW_READ"] },
  { href: "/emergency", label: "Emergency", anyOf: ["ER_READ"] },
  // The intensive care unit (docs/icu.md): the ICU doctor and the ICU nurse work from one board.
  { href: "/icu", label: "ICU", anyOf: ["ICU_READ"] },
  { href: "/patients", label: "Patients", anyOf: ["PATIENT_READ"] },
  { href: "/appointments", label: "Appointments", anyOf: ["APPOINTMENT_READ"], desk: "OPD" },
  { href: "/queue", label: "OPD queue", anyOf: ["QUEUE_READ"], desk: "OPD" },
  { href: "/billing", label: "Billing", anyOf: ["INVOICE_READ"] },
  { href: "/missed-billing", label: "Missed billing", anyOf: ["MISSED_BILLING_READ"] },
  { href: "/pharmacy", label: "Pharmacy", anyOf: ["PHARMACY_READ"], feature: "PHARMACY_ENABLED" },
  { href: "/procurement", label: "Procurement", anyOf: ["STORES_INDENT", "PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ", "STOCK_CONSUME", "STOCK_COUNT", "STOCK_COUNT_APPROVE", "SUPPLIER_PAY"], feature: "PHARMACY_ENABLED" },
  { href: "/teleconsult", label: "Video consultations", anyOf: ["TELE_READ"], desk: "OPD" },
  { href: "/payroll", label: "Payroll", anyOf: ["PAYROLL_READ"] },
  { href: "/claims", label: "Insurance claims", anyOf: ["CLAIM_MANAGE", "CLAIM_SETTLE", "CLAIM_MASTERS"] },
  { href: "/insurance-money", label: "Insurance money", anyOf: ["CLAIM_READ"], desk: "IPD" },
  { href: "/estimate", label: "Estimate", anyOf: ["CLAIM_READ"], desk: "IPD" },
  // The laboratory portal (docs/lims-portal.md): one place for the LIMS manager, the technicians, the pathologist and radiologist, the nurse who takes samples, and reception.
  { href: "/lims", label: "Laboratory (LIMS)", anyOf: LIMS_NAV },
  // The earlier two-branch laboratory page stays for people who work in it but are not part of the portal.
  { href: "/lis", label: "LIS", anyOf: ["LAB_COLLECT", "LAB_RESULT", "LAB_VERIFY", "LAB_MASTERS", "RAD_PERFORM", "RAD_REPORT"], hideWith: LIMS_NAV },
  // Ward rounds (docs/ward-rounds.md): the ward coordinator's board of every ward, and the doctor's own rounds.
  { href: "/wards", label: "Ward board", anyOf: ["WARD_BOARD_READ"], feature: "IPD_ENABLED" },
  { href: "/rounds", label: "My rounds", anyOf: ["ROUND_DO"], feature: "IPD_ENABLED" },
  // Planned admission (docs/planned-admission.md): the request queue for reception, the doctor, the admission desk, billing, insurance and bed management.
  { href: "/planned", label: "Planned admissions", anyOf: ["PLANNED_READ"], feature: "IPD_ENABLED", desk: "IPD" },
  // The ICU doctor and nurse reach an admission from the ICU board, so they do not also get the general admissions list; the ICU doctor does not get the nursing worklist.
  { href: "/ipd", label: "Admissions", anyOf: ["ADMISSION_READ"], hideWith: ["ICU_DOCTOR", "ICU_NURSE"], feature: "IPD_ENABLED", desk: "IPD" },
  { href: "/discharge-board", label: "Going home", anyOf: ["ADMISSION_READ"], hideWith: ["ICU_DOCTOR", "ICU_NURSE"], feature: "IPD_ENABLED", desk: "IPD" },
  { href: "/nursing", label: "Nursing", anyOf: ["NURSING_READ"], hideWith: ["ICU_DOCTOR"], feature: "NURSING_ENABLED", desk: "IPD" },
  { href: "/housekeeping", label: "Housekeeping", anyOf: ["BED_HOUSEKEEPING", "HOUSEKEEPING_REQUEST", "HOUSEKEEPING_MANAGE"], feature: "IPD_ENABLED", desk: "IPD" },
  { href: "/aftercare", label: "After discharge", anyOf: ["AFTERCARE_MANAGE", "COMPLAINT_READ", "COMPLAINT_MANAGE"], desk: "IPD" },
  { href: "/post-discharge", label: "Post-discharge", anyOf: ["MRD_RECORD_COMPLETE", "CLAIM_READ", "REPORT_FINANCE", "MRD_RETENTION"], feature: "IPD_ENABLED", desk: "IPD" },
  { href: "/reports", label: "Reports", anyOf: REPORT_PERMISSIONS },
  { href: "/admin", label: "Administration", anyOf: ["ADMIN_USERS", "ADMIN_MASTERS", "ADMIN_SETTINGS"] },
  { href: "/audit", label: "Audit", anyOf: ["AUDIT_READ"] },
];

/** CLAUDE.md §24: what each role sees first. */
const ROLE_ORDER: Record<string, string[]> = {
  RECEPTIONIST: ["/dashboard", "/patients", "/appointments", "/queue", "/planned", "/lims", "/ipd", "/billing"],
  ADMISSION_DESK: ["/planned", "/ipd", "/patients", "/appointments", "/dashboard"],
  BED_MANAGER: ["/planned", "/ipd", "/dashboard"],
  WARD_COORDINATOR: ["/wards", "/ipd", "/nursing", "/planned", "/patients", "/dashboard"],
  DOCTOR: ["/queue", "/rounds", "/planned", "/emergency", "/patients", "/appointments", "/ipd", "/dashboard"],
  EMERGENCY_RECEPTIONIST: ["/emergency", "/patients", "/billing", "/dashboard"],
  EMERGENCY_DOCTOR: ["/emergency", "/patients", "/dashboard"],
  ICU_DOCTOR: ["/icu", "/patients", "/dashboard"],
  ICU_NURSE: ["/icu", "/nursing", "/lims", "/patients", "/dashboard"],
  EMERGENCY_NURSE: ["/emergency", "/lims", "/patients", "/dashboard"],
  NURSE: ["/dashboard", "/nursing", "/lims", "/ipd", "/patients"],
  PHARMACIST: ["/pharmacy", "/billing", "/procurement", "/patients", "/dashboard"],
  PAYROLL_OFFICER: ["/payroll", "/patients", "/dashboard"],
  CLAIMS_OFFICER: ["/claims", "/planned", "/billing", "/ipd", "/patients", "/dashboard"],
  RMO: ["/ipd", "/patients", "/nursing", "/dashboard"],
  OT_COORDINATOR: ["/ipd", "/patients", "/dashboard"],
  PATIENT_TRANSPORT: ["/ipd", "/dashboard"],
  HOUSEKEEPING: ["/housekeeping", "/dashboard"],
  CARE_COORDINATOR: ["/aftercare", "/patients", "/appointments", "/dashboard"],
  PATIENT_RELATIONS: ["/aftercare", "/patients", "/dashboard"],
  MEDICAL_RECORDS: ["/post-discharge", "/ipd", "/patients", "/dashboard"],
  PROCUREMENT: ["/procurement", "/pharmacy", "/reports", "/dashboard"],
  LAB_TECHNICIAN: ["/lis", "/patients", "/dashboard"],
  PATHOLOGIST: ["/dashboard", "/lims", "/lis", "/patients"],
  RADIOGRAPHER: ["/lis", "/patients", "/dashboard"],
  RADIOLOGIST: ["/dashboard", "/lims", "/lis", "/patients"],
  LIMS_MANAGER: ["/lims", "/patients", "/dashboard"],
  P_LAB_TECH: ["/dashboard", "/lims", "/patients"],
  R_LAB_TECH: ["/dashboard", "/lims", "/patients"],
  BILLING: ["/billing", "/missed-billing", "/ipd", "/claims", "/patients", "/dashboard"],
  CASHIER: ["/billing", "/planned", "/dashboard", "/patients"],
  ADMINISTRATOR: ["/dashboard", "/overview", "/reports", "/admin", "/audit"],
  MANAGER: ["/overview", "/wards", "/dashboard", "/reports", "/billing", "/missed-billing", "/audit"],
};

/** `desk` is the reception desk the person chose (null for everyone else): a screen that belongs to the other desk is left out. */
export function visibleNav(permissions: ReadonlySet<string>, features: Record<string, boolean>, roles: string[], desk: "OPD" | "IPD" | null = null): NavItem[] {
  const items = NAV.filter((n) => (!n.anyOf || n.anyOf.some((p) => permissions.has(p))) && !(n.hideWith?.some((p) => permissions.has(p))) && (!n.feature || features[n.feature] !== false) && (!desk || !n.desk || n.desk === desk));
  const order = roles.flatMap((r) => ROLE_ORDER[r] ?? []);
  const rank = (href: string) => { const i = order.indexOf(href); return i === -1 ? 1000 + NAV.findIndex((n) => n.href === href) : i; };
  return [...items].sort((a, b) => rank(a.href) - rank(b.href));
}

/** Where to land after login. */
export const homeFor = (items: NavItem[]): string => items[0]?.href ?? "/dashboard";

/** The sidebar groups a long menu by the part of the hospital each screen belongs to. A short menu stays a plain list. */
export const NAV_SECTION: Record<string, string> = {
  "/dashboard": "Overview", "/overview": "Overview",
  "/patients": "Front desk and OPD", "/appointments": "Front desk and OPD", "/queue": "Front desk and OPD", "/teleconsult": "Front desk and OPD",
  "/emergency": "Emergency and critical care", "/icu": "Emergency and critical care",
  "/planned": "Inpatient", "/ipd": "Inpatient", "/rounds": "Inpatient", "/wards": "Inpatient", "/nursing": "Inpatient", "/discharge-board": "Inpatient", "/housekeeping": "Inpatient", "/aftercare": "Inpatient", "/post-discharge": "Inpatient",
  "/lims": "Laboratory", "/lis": "Laboratory",
  "/billing": "Billing and insurance", "/missed-billing": "Billing and insurance", "/claims": "Billing and insurance", "/insurance-money": "Billing and insurance", "/estimate": "Billing and insurance", "/payroll": "Billing and insurance",
  "/pharmacy": "Pharmacy and stores", "/procurement": "Pharmacy and stores",
  "/reports": "Management", "/admin": "Management", "/audit": "Management",
};
/** Menus with more entries than this are shown in sections. */
export const GROUP_NAV_ABOVE = 7;

/** Icon names (from the dashboard kit) for each screen. */
export const NAV_ICON: Record<string, string> = {
  "/dashboard": "grid", "/overview": "pulse", "/patients": "user", "/appointments": "calendar", "/queue": "hourglass", "/teleconsult": "userPlus",
  "/emergency": "siren", "/icu": "pulse", "/planned": "calendarPlus", "/ipd": "bed", "/rounds": "clipboard", "/wards": "hospital", "/nursing": "handover", "/discharge-board": "check",
  "/housekeeping": "list", "/aftercare": "bell", "/post-discharge": "clipboard", "/lims": "flask", "/lis": "tube", "/billing": "receipt", "/missed-billing": "alarm", "/claims": "clipboard",
  "/insurance-money": "percent", "/estimate": "receipt", "/payroll": "receipt", "/pharmacy": "plus", "/procurement": "download", "/reports": "list", "/admin": "filter", "/audit": "search",
};

/** One quiet colour per section: the chip behind each icon and the dot beside the section heading. Shared by the side menu and the "Go to" panel. */
export const SECTION_TONE: Record<string, { chip: string; dot: string }> = {
  Overview: { chip: "bg-brand-50 text-brand-600", dot: "bg-brand-500" },
  "Front desk and OPD": { chip: "bg-sky-50 text-sky-600", dot: "bg-sky-500" },
  "Emergency and critical care": { chip: "bg-rose-50 text-rose-600", dot: "bg-rose-500" },
  Inpatient: { chip: "bg-violet-50 text-violet-600", dot: "bg-violet-500" },
  Laboratory: { chip: "bg-emerald-50 text-emerald-600", dot: "bg-emerald-500" },
  "Billing and insurance": { chip: "bg-amber-50 text-amber-600", dot: "bg-amber-500" },
  "Pharmacy and stores": { chip: "bg-teal-50 text-teal-600", dot: "bg-teal-500" },
  Management: { chip: "bg-slate-100 text-slate-600", dot: "bg-slate-500" },
};
