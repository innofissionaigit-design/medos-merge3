/** Navigation is derived from permissions and facility feature flags (never from role names); role only influences order. */

export interface NavItem { href: string; label: string; anyOf?: string[]; /** Hidden for people who hold any of these (the page they replace). */ hideWith?: string[]; feature?: "PHARMACY_ENABLED" | "IPD_ENABLED" | "NURSING_ENABLED" }

/** REPORT_READ opens every report; each REPORT_<AREA> opens that area's reports (the API enforces the same rule). */
export const REPORT_PERMISSIONS = ["REPORT_READ", "REPORT_OPD", "REPORT_FINANCE", "REPORT_IPD", "REPORT_PHARMACY", "REPORT_MY_PRACTICE"];

/** Whoever holds one of these has the laboratory portal. */
const LIMS_NAV = ["LIMS_MANAGE", "LIMS_REPORTS", "LIMS_DEPARTMENTS", "LIMS_ISSUE", "LAB_VERIFY", "RAD_REPORT", "LIMS_COLLECT", "LIMS_REQUEST"];

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/patients", label: "Patients", anyOf: ["PATIENT_READ"] },
  { href: "/appointments", label: "Appointments", anyOf: ["APPOINTMENT_READ"] },
  { href: "/queue", label: "OPD queue", anyOf: ["QUEUE_READ"] },
  { href: "/billing", label: "Billing", anyOf: ["INVOICE_READ"] },
  { href: "/pharmacy", label: "Pharmacy", anyOf: ["PHARMACY_READ"], feature: "PHARMACY_ENABLED" },
  { href: "/teleconsult", label: "Video consultations", anyOf: ["TELE_READ"] },
  { href: "/payroll", label: "Payroll", anyOf: ["PAYROLL_READ"] },
  { href: "/claims", label: "Insurance claims", anyOf: ["CLAIM_MANAGE", "CLAIM_SETTLE", "CLAIM_MASTERS"] },
  // The laboratory portal (docs/lims-portal.md): one place for the LIMS manager, the technicians, the pathologist and radiologist, the nurse who takes samples, and reception.
  { href: "/lims", label: "Laboratory (LIMS)", anyOf: LIMS_NAV },
  // The earlier two-branch laboratory page stays for people who work in it but are not part of the portal.
  { href: "/lis", label: "LIS", anyOf: ["LAB_COLLECT", "LAB_RESULT", "LAB_VERIFY", "LAB_MASTERS", "RAD_PERFORM", "RAD_REPORT"], hideWith: LIMS_NAV },
  { href: "/ipd", label: "Admissions", anyOf: ["ADMISSION_READ"], feature: "IPD_ENABLED" },
  { href: "/nursing", label: "Nursing", anyOf: ["NURSING_READ"], feature: "NURSING_ENABLED" },
  { href: "/reports", label: "Reports", anyOf: REPORT_PERMISSIONS },
  { href: "/admin", label: "Administration", anyOf: ["ADMIN_USERS", "ADMIN_MASTERS", "ADMIN_SETTINGS"] },
  { href: "/audit", label: "Audit", anyOf: ["AUDIT_READ"] },
];

/** CLAUDE.md §24: what each role sees first. */
const ROLE_ORDER: Record<string, string[]> = {
  RECEPTIONIST: ["/dashboard", "/patients", "/appointments", "/queue", "/lims", "/ipd", "/billing"],
  DOCTOR: ["/queue", "/patients", "/appointments", "/ipd", "/dashboard"],
  NURSE: ["/nursing", "/lims", "/ipd", "/patients", "/dashboard"],
  PHARMACIST: ["/pharmacy", "/billing", "/patients", "/dashboard"],
  PAYROLL_OFFICER: ["/payroll", "/patients", "/dashboard"],
  CLAIMS_OFFICER: ["/claims", "/billing", "/patients", "/dashboard"],
  LAB_TECHNICIAN: ["/lis", "/patients", "/dashboard"],
  PATHOLOGIST: ["/lims", "/lis", "/patients", "/dashboard"],
  RADIOGRAPHER: ["/lis", "/patients", "/dashboard"],
  RADIOLOGIST: ["/lims", "/lis", "/patients", "/dashboard"],
  LIMS_MANAGER: ["/lims", "/patients", "/dashboard"],
  P_LAB_TECH: ["/lims", "/patients", "/dashboard"],
  R_LAB_TECH: ["/lims", "/patients", "/dashboard"],
  CASHIER: ["/billing", "/dashboard", "/patients"],
  ADMINISTRATOR: ["/dashboard", "/reports", "/admin", "/audit"],
  MANAGER: ["/dashboard", "/reports", "/billing", "/audit"],
};

export function visibleNav(permissions: ReadonlySet<string>, features: Record<string, boolean>, roles: string[]): NavItem[] {
  const items = NAV.filter((n) => (!n.anyOf || n.anyOf.some((p) => permissions.has(p))) && !(n.hideWith?.some((p) => permissions.has(p))) && (!n.feature || features[n.feature] !== false));
  const order = roles.flatMap((r) => ROLE_ORDER[r] ?? []);
  const rank = (href: string) => { const i = order.indexOf(href); return i === -1 ? 1000 + NAV.findIndex((n) => n.href === href) : i; };
  return [...items].sort((a, b) => rank(a.href) - rank(b.href));
}

/** Where to land after login. */
export const homeFor = (items: NavItem[]): string => items[0]?.href ?? "/dashboard";
