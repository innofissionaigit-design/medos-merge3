import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { actorOf, AuditService } from "../../common/audit.service";
import type { Db } from "../../common/prisma.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { balanceDue, computeLine, computeTotals, fmt, type LineAmounts } from "./billing.domain";
import { InvoicesService } from "./invoices.service";
import { LedgerService } from "./ledger.service";

export interface EmergencyBillLine {
  description: string; quantity: Decimal; unitPrice: Decimal; taxPercent: Decimal;
  /** The record this line bills (a dispense, a laboratory request), so it can never be billed twice. */
  sourceType: string; sourceId: string; serviceId?: string | null; hsnSac?: string | null;
}

/**
 * The running bill of an emergency patient (docs/emergency.md). Everything that is charged during the emergency visit (the doctor's fee, medicines the pharmacy hands over,
 * laboratory and imaging tests, a charge the desk adds) is added to one open bill, a draft invoice of the visit. The desk issues it and collects the payment with the
 * ordinary billing. Once it is issued nothing changes in it: a later charge opens a new open bill. Every figure is worked out here, never taken from the screen.
 */
@Injectable()
export class EmergencyBillService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly invoices: InvoicesService, private readonly ledger: LedgerService) {}

  /** Adds lines to the visit's open bill, opening it if there is none. A line whose source is already billed is left out. Returns the bill and how many lines were added. */
  async addLines(tx: Db, ctx: RequestContext, enc: { id: string; patientId: string }, lines: EmergencyBillLine[]): Promise<{ invoiceId: string; added: number }> {
    // Only one change to a visit's bill at a time, so two charges arriving together cannot open two open bills.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Encounter" WHERE id = ${enc.id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const sources = lines.map((l) => l.sourceId);
    const already = sources.length ? await tx.invoiceLine.findMany({ where: { tenantId: ctx.tenantId, sourceId: { in: sources } }, select: { sourceType: true, sourceId: true } }) : [];
    const have = new Set(already.map((a) => `${a.sourceType}|${a.sourceId}`));
    const fresh = lines.filter((l) => !have.has(`${l.sourceType}|${l.sourceId}`));
    const opts = await this.invoices.invoiceOptions(tx, ctx);
    const existing = await tx.invoice.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: enc.id, kind: "EMERGENCY", status: "DRAFT" }, select: { id: true } });
    if (!existing && fresh.length === 0) return { invoiceId: await this.open(tx, ctx, enc, opts), added: 0 };
    const invoiceId = existing ? (await this.ledger.lock(tx, ctx, existing.id)).id : await this.open(tx, ctx, enc, opts);
    if (fresh.length === 0) return { invoiceId, added: 0 };
    const last = await tx.invoiceLine.aggregate({ where: { tenantId: ctx.tenantId, invoiceId }, _max: { lineNo: true } });
    const base = last._max.lineNo ?? 0;
    const amounts = fresh.map((l) => computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: 0, taxPercent: l.taxPercent }, { split: opts.taxSplit }));
    await tx.invoiceLine.createMany({
      data: fresh.map((l, i) => ({
        tenantId: ctx.tenantId, invoiceId, lineNo: base + i + 1, serviceId: l.serviceId ?? null, hsnSac: l.hsnSac ?? null, description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toFixed(2),
        discountAmount: "0.00", taxPercent: l.taxPercent.toFixed(2), taxAmount: (amounts[i] as LineAmounts).tax.toFixed(2), lineTotal: (amounts[i] as LineAmounts).total.toFixed(2), sourceType: l.sourceType, sourceId: l.sourceId,
      })),
    });
    await this.retotal(tx, ctx, invoiceId);
    await this.audit.record(tx, actorOf(ctx), { action: "EMERGENCY_BILL_CHARGED", entityType: "Invoice", entityId: invoiceId, metadata: { encounterId: enc.id, lines: fresh.length, sources: [...new Set(fresh.map((l) => l.sourceType))] } });
    return { invoiceId, added: fresh.length };
  }

  /**
   * Takes some of a returned item off the open bill (medicines the patient gave back before the bill was issued). Returns false when the line is not on an open bill any more
   * (it is on an issued bill: the pharmacy then raises a credit note as for any issued bill).
   */
  async takeOff(tx: Db, ctx: RequestContext, sourceType: string, sourceId: string, quantity: number): Promise<boolean> {
    const line = await tx.invoiceLine.findFirst({ where: { tenantId: ctx.tenantId, sourceType, sourceId }, include: { invoice: { select: { id: true, status: true, kind: true, taxSplit: true } } } });
    if (!line || line.invoice.kind !== "EMERGENCY" || line.invoice.status !== "DRAFT") return false;
    await this.ledger.lock(tx, ctx, line.invoice.id);
    const left = new Decimal(line.quantity.toString()).minus(quantity);
    if (left.lte(0)) {
      await tx.invoiceLine.deleteMany({ where: { id: line.id, tenantId: ctx.tenantId } });
    } else {
      const a = computeLine({ quantity: left, unitPrice: line.unitPrice.toString(), discountAmount: 0, taxPercent: line.taxPercent.toString() }, { split: line.invoice.taxSplit });
      await tx.invoiceLine.updateMany({ where: { id: line.id, tenantId: ctx.tenantId }, data: { quantity: left.toString(), taxAmount: a.tax.toFixed(2), lineTotal: a.total.toFixed(2) } });
    }
    await this.retotal(tx, ctx, line.invoice.id);
    await this.audit.record(tx, actorOf(ctx), { action: "EMERGENCY_BILL_LINE_REDUCED", entityType: "Invoice", entityId: line.invoice.id, metadata: { sourceType, quantity } });
    return true;
  }

  /** Issues the visit's open bill (DRAFT to ISSUED). Returns null when there is nothing to issue (no open bill, or it has no charges yet). */
  async issueOpen(tx: Db, ctx: RequestContext, encounterId: string): Promise<{ id: string; invoiceNumber: string | null; total: string } | null> {
    const draft = await tx.invoice.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, kind: "EMERGENCY", status: "DRAFT" }, select: { id: true } });
    if (!draft) return null;
    const inv = await this.ledger.lock(tx, ctx, draft.id);
    const lines = await tx.invoiceLine.count({ where: { tenantId: ctx.tenantId, invoiceId: inv.id } });
    if (lines === 0) return null;
    const issued = await this.invoices.issueInTx(tx, ctx, inv.id);
    return { id: issued.id, invoiceNumber: issued.invoiceNumber, total: issued.total };
  }

  /** The open bill has nothing on it and the visit is over: it is cancelled so no empty draft stays behind. */
  async closeEmpty(tx: Db, ctx: RequestContext, encounterId: string): Promise<void> {
    const draft = await tx.invoice.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, kind: "EMERGENCY", status: "DRAFT" }, select: { id: true } });
    if (!draft || (await tx.invoiceLine.count({ where: { tenantId: ctx.tenantId, invoiceId: draft.id } })) > 0) return;
    await tx.invoice.updateMany({ where: { id: draft.id, tenantId: ctx.tenantId, status: "DRAFT" }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: ctx.userId, cancelReason: "Nothing was charged", version: { increment: 1 } } });
    await this.audit.record(tx, actorOf(ctx), { action: "INVOICE_CANCELLED", entityType: "Invoice", entityId: draft.id, metadata: { reason: "Nothing was charged", kind: "EMERGENCY" } });
  }

  /** Everything charged to the visit so far: the open bill, the issued bills, what has been paid and what is still due. */
  async summary(db: Db, ctx: RequestContext, encounterId: string) {
    const rows = await db.invoice.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, status: { notIn: ["CANCELLED", "REFUNDED"] }, kind: { not: "REGISTRATION" } },
      orderBy: { createdAt: "asc" }, include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    let billed = new Decimal(0); let paid = new Decimal(0); let due = new Decimal(0); let open = new Decimal(0);
    const invoices = rows.map((i) => {
      const money = { total: i.total, paidTotal: i.paidTotal, refundedTotal: i.refundedTotal, creditedTotal: i.creditedTotal };
      const draft = i.status === "DRAFT";
      const owing = draft ? new Decimal(0) : balanceDue(money);
      if (draft) open = open.plus(i.total); else { billed = billed.plus(i.total); paid = paid.plus(i.paidTotal).minus(i.refundedTotal); due = due.plus(owing); }
      return {
        id: i.id, invoiceNumber: i.invoiceNumber, status: i.status, kind: i.kind, createdAt: i.createdAt, total: fmt(i.total), paidTotal: fmt(i.paidTotal), balanceDue: fmt(owing),
        lines: i.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), unitPrice: fmt(l.unitPrice), lineTotal: fmt(l.lineTotal), source: l.sourceType })),
      };
    });
    return { invoices, openTotal: fmt(open), billedTotal: fmt(billed), paidTotal: fmt(paid), dueTotal: fmt(due), hasOpenBill: rows.some((r) => r.status === "DRAFT") };
  }

  // ───── internals ─────

  private async open(tx: Db, ctx: RequestContext, enc: { id: string; patientId: string }, opts: { taxSplit: boolean; roundsToRupee: boolean }): Promise<string> {
    const inv = await tx.invoice.create({
      data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId: enc.id, kind: "EMERGENCY", notes: "Emergency bill", createdById: ctx.userId, taxSplit: opts.taxSplit, roundsToRupee: opts.roundsToRupee },
      select: { id: true },
    });
    await this.audit.record(tx, actorOf(ctx), { action: "EMERGENCY_BILL_OPENED", entityType: "Invoice", entityId: inv.id, metadata: { encounterId: enc.id } });
    return inv.id;
  }

  /** Works the totals out again from the stored lines. */
  private async retotal(tx: Db, ctx: RequestContext, invoiceId: string): Promise<void> {
    const inv = await tx.invoice.findFirstOrThrow({ where: { id: invoiceId, tenantId: ctx.tenantId }, select: { taxSplit: true, roundsToRupee: true } });
    const lines = await tx.invoiceLine.findMany({ where: { tenantId: ctx.tenantId, invoiceId } });
    const t = computeTotals(lines.map((l) => computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: l.discountAmount, taxPercent: l.taxPercent }, { split: inv.taxSplit })), { roundToRupee: inv.roundsToRupee });
    await tx.invoice.updateMany({
      where: { id: invoiceId, tenantId: ctx.tenantId, status: "DRAFT" },
      data: { subtotal: t.subtotal.toFixed(2), discountTotal: t.discountTotal.toFixed(2), taxTotal: t.taxTotal.toFixed(2), total: t.total.toFixed(2), roundOff: t.roundOff.toFixed(2), version: { increment: 1 } },
    });
  }
}
