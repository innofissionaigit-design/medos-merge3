import type { Permission } from "@medos/shared";

/** The steps of a request through the laboratory (docs/lims-portal.md). The database enforces the same moves (trigger lims_request_guard). */
export const LIMS_STATUSES = ["PENDING_COLLECTION", "COLLECTED", "IN_PROCESS", "PENDING_REVIEW", "PASSED", "ISSUED", "HANDED_OVER", "CANCELLED"] as const;
export type LimsStatus = (typeof LIMS_STATUSES)[number];

export const LIMS_PRIORITIES = ["EMERGENCY", "URGENT", "ROUTINE"] as const;
export type LimsPriority = (typeof LIMS_PRIORITIES)[number];
/** Lower is more urgent: an emergency sorts to the top of every queue. */
export const PRIORITY_RANK: Record<LimsPriority, number> = { EMERGENCY: 0, URGENT: 1, ROUTINE: 2 };

export type DepartmentKind = "PATHOLOGY" | "RADIOLOGY";

const MOVES: Record<LimsStatus, readonly LimsStatus[]> = {
  PENDING_COLLECTION: ["COLLECTED", "CANCELLED"],
  COLLECTED: ["IN_PROCESS", "PENDING_COLLECTION", "CANCELLED"],
  IN_PROCESS: ["PENDING_REVIEW", "PENDING_COLLECTION", "CANCELLED"],
  PENDING_REVIEW: ["PASSED", "IN_PROCESS"],
  PASSED: ["ISSUED"],
  ISSUED: ["HANDED_OVER"],
  HANDED_OVER: [],
  CANCELLED: [],
};

export const canMove = (from: LimsStatus, to: LimsStatus): boolean => MOVES[from].includes(to);

/** Statuses in which the work is still open (not yet issued to the doctor or patient, and not cancelled). */
export const OPEN_STATUSES: readonly LimsStatus[] = ["PENDING_COLLECTION", "COLLECTED", "IN_PROCESS", "PENDING_REVIEW", "PASSED"];
/** Statuses in which the doctor may see the report. */
export const RELEASED_STATUSES: readonly LimsStatus[] = ["ISSUED", "HANDED_OVER"];

export const isReleased = (s: LimsStatus): boolean => RELEASED_STATUSES.includes(s);

/** Which kind of test belongs to which department. Cardiology and other procedures are not run by the laboratory. */
export function departmentKindOf(category: string): DepartmentKind | null {
  return category === "LABORATORY" ? "PATHOLOGY" : category === "RADIOLOGY" ? "RADIOLOGY" : null;
}

/** The permissions that decide who may do what in each department. The same rules apply to the pages, the queues and the actions. */
export const DEPARTMENT_PERMISSIONS: Record<DepartmentKind, { read: Permission; work: Permission; review: Permission }> = {
  PATHOLOGY: { read: "LAB_READ", work: "LAB_RESULT", review: "LAB_VERIFY" },
  RADIOLOGY: { read: "RAD_READ", work: "RAD_PERFORM", review: "RAD_REPORT" },
};

export interface Targets { routineTatMinutes: number; urgentTatMinutes: number; emergencyTatMinutes: number }

/**
 * The turnaround target for a request, in minutes: the department's target for the priority. A test that has its own turnaround (set by the pathologist) uses it
 * for a routine request; urgent and emergency requests always use the department's shorter targets.
 */
export function targetMinutes(d: Targets, priority: LimsPriority, testTurnaroundHours?: number | null): number {
  if (priority === "EMERGENCY") return d.emergencyTatMinutes;
  if (priority === "URGENT") return Math.min(d.urgentTatMinutes, d.routineTatMinutes);
  return testTurnaroundHours && testTurnaroundHours > 0 ? testTurnaroundHours * 60 : d.routineTatMinutes;
}

export const addMinutes = (at: Date, minutes: number): Date => new Date(at.getTime() + minutes * 60_000);

/** A request is delayed while it is open past its due time, or when it was issued after it. */
export function isDelayed(r: { status: LimsStatus; dueAt: Date; issuedAt: Date | null }, now: Date): boolean {
  if (r.status === "CANCELLED") return false;
  if (r.issuedAt) return r.issuedAt.getTime() > r.dueAt.getTime();
  return now.getTime() > r.dueAt.getTime();
}

/** Minutes from the request entering the queue to the report being issued. */
export const turnaroundMinutes = (createdAt: Date, issuedAt: Date): number => Math.max(0, Math.round((issuedAt.getTime() - createdAt.getTime()) / 60_000));

/** The p-th percentile (0 to 100) of a list of numbers, by nearest rank. Null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

export const average = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length));

/** Quality-control result from numbers: inside both limits passes. With no limits the caller must say the result. */
export function qcResultFrom(observed: number | null, low: number | null, high: number | null): "PASS" | "FAIL" | null {
  if (observed === null || (low === null && high === null)) return null;
  if (low !== null && observed < low) return "FAIL";
  if (high !== null && observed > high) return "FAIL";
  return "PASS";
}

/** The events written to a request's history. */
export type LimsEventKind =
  | "CREATED" | "PRIORITY_CHANGED" | "NURSE_ASSIGNED" | "TECH_ASSIGNED" | "COLLECTED" | "SAMPLE_REJECTED" | "SENT_BACK" | "ACCEPTED" | "PERFORMED"
  | "SUBMITTED" | "RETURNED" | "PASSED" | "ISSUED" | "AMENDED_AFTER_ISSUE" | "HANDED_OVER" | "CANCELLED" | "EXCEPTION_APPROVED" | "ARRIVED" | "CHARGED" | "CHARGE_NOT_POSTED";

/** The text the patient is sent, from the facts only (never any result). Plain text with no markup; the name of the facility is the hospital's. */
export function scheduledText(i: { firstName: string; facility: string; departments: string[]; when: string | null; instructions: string | null; requestNumbers: string[] }): string {
  const when = i.when ? ` Please come on ${i.when}.` : " Please come to the hospital today.";
  const prep = i.instructions ? ` Before you come: ${i.instructions}` : "";
  return `Dear ${i.firstName}, your ${i.departments.join(" and ")} test at ${i.facility} is booked.${when}${prep} Show your number ${i.requestNumbers.join(", ")} at the lab. Your report will be ready at reception.`.replace(/\s+/g, " ").trim();
}

export function reportReadyText(i: { firstName: string; facility: string; requestNumbers: string[] }): string {
  return `Dear ${i.firstName}, your report (${i.requestNumbers.join(", ")}) is ready at ${i.facility}. Please collect it from the reception desk. For your privacy results are not sent by message.`;
}

/**
 * Which laboratory department probably runs an investigation, from the words in its name: imaging (X-ray, ultrasound, CT, MRI and so on) goes to Radiology and
 * everything else to Pathology. It is only the starting point; the administrator or the pathologist can change the grouping of any test. (The migration groups the
 * tests that already exist with the same words.)
 */
export function guessDepartment(name: string): DepartmentKind {
  return /(x[- ]?ray|radiograph|ultrasound|ultrasonograph|sonograph|sonogram|\busg\b|\bct\b|\bmri\b|mammogra|doppler|dexa|\bpet\b|\becho|fluoroscop|angiogra|barium|hsg|imaging)/i.test(name) ? "RADIOLOGY" : "PATHOLOGY";
}

/** The kind of test order a department's tests are. */
export const categoryOfDepartment = (d: DepartmentKind): "LABORATORY" | "RADIOLOGY" => (d === "RADIOLOGY" ? "RADIOLOGY" : "LABORATORY");

/** The two departments every facility starts with, and their turnaround targets (minutes). An administrator can change the names, targets and instructions. */
export const DEFAULT_DEPARTMENTS: readonly { kind: DepartmentKind; name: string; routineTatMinutes: number; urgentTatMinutes: number; emergencyTatMinutes: number; capacityPerHour: number; openMinute: number; closeMinute: number }[] = [
  { kind: "PATHOLOGY", name: "Pathology", routineTatMinutes: 1440, urgentTatMinutes: 360, emergencyTatMinutes: 120, capacityPerHour: 8, openMinute: 480, closeMinute: 1080 },
  { kind: "RADIOLOGY", name: "Radiology", routineTatMinutes: 1440, urgentTatMinutes: 360, emergencyTatMinutes: 60, capacityPerHour: 3, openMinute: 480, closeMinute: 1080 },
];

/** Where the clock for a request starts: when it entered the queue, or later when the patient was asked to come at a set time. */
export const clockStart = (r: { createdAt: Date; scheduledFor: Date | null }): Date =>
  r.scheduledFor && r.scheduledFor.getTime() > r.createdAt.getTime() ? r.scheduledFor : r.createdAt;
