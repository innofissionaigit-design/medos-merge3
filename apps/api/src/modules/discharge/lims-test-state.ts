import type { Db } from "../../common/prisma.service";

/**
 * How a test ordered for an admitted patient stands when it went through the laboratory portal (docs/lims-portal.md) rather than the cashier (docs/test-orders.md).
 * An admitted (IPD) or emergency patient's test goes straight to the laboratory: it never waits for the cashier, so its test order stays "ORDERED".
 *  - performed: the report is issued (or handed over) once the pathologist / radiologist has passed it; the admission's charge is posted at that moment;
 *  - billed: the admission carries its charge (source key LIMS:<request>, added when the report is issued), or the emergency bill carries its line (source LIMS).
 * Used by the discharge "Laboratory / radiology" stage and the admission's test list (docs/discharge-stages.md), so both paths reconcile the same way.
 */
export interface LimsLink { id: string; status: string; origin: string }

export const LIMS_DONE = new Set(["ISSUED", "HANDED_OVER"]);

/** Whether a LIMS request is part of the admitted / emergency path that bypasses the cashier. */
export const isWardLims = (r: LimsLink | null | undefined): r is LimsLink => !!r && (r.origin === "IPD" || r.origin === "EMERGENCY");

/** The LIMS requests (of the given ones) that already have a live charge on the admission or a line on the emergency bill. */
export async function limsCharged(db: Db, tenantId: string, requests: LimsLink[]): Promise<Set<string>> {
  if (requests.length === 0) return new Set();
  const [charges, lines] = await Promise.all([
    db.charge.findMany({ where: { tenantId, sourceKey: { in: requests.map((r) => `LIMS:${r.id}`) }, status: { not: "VOIDED" } }, select: { sourceKey: true } }),
    db.invoiceLine.findMany({ where: { tenantId, sourceType: "LIMS", sourceId: { in: requests.map((r) => r.id) } }, select: { sourceId: true } }),
  ]);
  return new Set([...charges.map((c) => String(c.sourceKey).slice("LIMS:".length)), ...lines.map((l) => String(l.sourceId))]);
}
