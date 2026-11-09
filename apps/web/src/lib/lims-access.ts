/**
 * Who sees which desk in the LIMS portal. The page follows permissions, never role names; the API enforces the same permissions, so this only decides what is shown.
 * (docs/lims-portal.md)
 */
export type Desk = "control" | "technician" | "review" | "collection" | "reception";

/** Permissions that let a person into the portal at all. */
export const LIMS_PORTAL_PERMISSIONS = ["LIMS_MANAGE", "LIMS_REPORTS", "LIMS_DEPARTMENTS", "LIMS_ISSUE", "LAB_VERIFY", "RAD_REPORT", "LIMS_COLLECT", "LIMS_REQUEST", "LAB_RESULT", "RAD_PERFORM"];

/** The desks a person may open, in the order they are shown, and the one to open first. */
export function desksFor(can: (...p: string[]) => boolean): { desks: Desk[]; first: Desk | null } {
  const desks: Desk[] = [];
  if (can("LIMS_MANAGE", "LIMS_REPORTS", "LIMS_DEPARTMENTS")) desks.push("control");
  if (can("LIMS_ISSUE")) desks.push("technician");
  if (can("LAB_VERIFY", "RAD_REPORT")) desks.push("review");
  if (can("LIMS_COLLECT")) desks.push("collection");
  if (can("LIMS_REQUEST")) desks.push("reception");
  return { desks, first: desks[0] ?? null };
}

export const DESK_LABEL: Record<Desk, string> = { control: "Control room", technician: "Technician desk", review: "Review desk", collection: "Sample collection", reception: "Reception desk" };

/** A short line saying whose portal this is, from what the person can do. */
export function portalTitle(can: (...p: string[]) => boolean): string {
  if (can("LIMS_MANAGE")) return "LIMS manager";
  if (can("LAB_VERIFY") && !can("RAD_REPORT")) return "Pathologist";
  if (can("RAD_REPORT") && !can("LAB_VERIFY")) return "Radiologist";
  if (can("LIMS_ISSUE") && can("LAB_RESULT") && !can("RAD_PERFORM")) return "Pathology technician";
  if (can("LIMS_ISSUE") && can("RAD_PERFORM") && !can("LAB_RESULT")) return "Radiology technician";
  if (can("LIMS_COLLECT")) return "Nurse";
  if (can("LIMS_REQUEST")) return "Reception";
  if (can("LIMS_REPORTS")) return "Monitoring";
  return "Laboratory";
}
