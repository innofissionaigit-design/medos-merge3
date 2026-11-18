import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { AdvancesService } from "../billing/advances.service";
import { balanceDue, computeLine, fmt } from "../billing/billing.domain";
import { LedgerService } from "../billing/ledger.service";
import { payInvoiceSchema } from "../billing/payments.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EmergencyBillService } from "../billing/emergency-bill.service";
import { TestOrdersService } from "../test-orders/test-orders.service";
import { LimsCoreService } from "./lims-core.service";

const ZERO = new Decimal(0);
const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? 0);

/** The patient reports at reception: what is still owed after the advance is paid now (one or several ways), then the nurse may take the sample. */
/** Nothing to pay (an advance covers it, or the Cashier already collected) is an empty list. */
export const arriveSchema = z.object({ payments: z.array(payInvoiceSchema.shape.payments.element).max(6).default([]) }).strict();

/**
 * The money side of the laboratory's outpatient and admitted-patient flows (docs/lims-portal.md, "Billing"). It adds no new way of charging: tests are billed with the
 * Cashier's own billing (a bill of type Other at the price-list price), an advance the patient paid earlier is used first, and the rest is taken as an ordinary receipt.
 * For an admitted patient a report that is issued becomes a charge on the admission, to be billed with the final bill.
 */
@Injectable()
export class LimsBillingService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly idempotency: IdempotencyService, private readonly ledger: LedgerService,
    private readonly advances: AdvancesService, private readonly tests: TestOrdersService, private readonly core: LimsCoreService, private readonly notifications: NotificationsService,
    private readonly emergencyBill: EmergencyBillService,
  ) {}

  private async batch(db: Db | PrismaService, ctx: RequestContext, batchId: string) {
    const reqs = await db.limsRequest.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, batchId, origin: "OPD", status: { not: "CANCELLED" } },
      orderBy: { requestNumber: "asc" },
      select: {
        id: true, requestNumber: true, status: true, arrivedAt: true, patientId: true, encounterId: true, testOrderId: true, assignedNurseId: true, scheduledFor: true,
        testOrder: { select: { id: true, name: true, status: true, serviceId: true, invoiceId: true } }, department: { select: { kind: true, name: true } },
      },
    });
    if (reqs.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return reqs;
  }

  /** What the visit's laboratory tests cost, what has been paid, what the patient already has in advance, and what is still to collect. */
  async view(ctx: RequestContext, batchId: string) {
    const reqs = await this.batch(this.prisma, ctx, batchId);
    const first = reqs[0] as (typeof reqs)[number];
    const serviceIds = [...new Set(reqs.flatMap((r) => (r.testOrder.serviceId ? [r.testOrder.serviceId] : [])))];
    const services = serviceIds.length ? await this.prisma.service.findMany({ where: { tenantId: ctx.tenantId, id: { in: serviceIds } }, select: { id: true, price: true, taxPercent: true } }) : [];
    const svc = new Map(services.map((s) => [s.id, s]));
    const invoiceIds = [...new Set(reqs.flatMap((r) => (r.testOrder.invoiceId ? [r.testOrder.invoiceId] : [])))];
    const invoices = invoiceIds.length ? await this.prisma.invoice.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true, status: true, total: true, paidTotal: true, refundedTotal: true, creditedTotal: true, version: true } }) : [];
    let estimate = ZERO; let unpriced = 0;
    const tests = reqs.map((r) => {
      const s = r.testOrder.serviceId ? svc.get(r.testOrder.serviceId) : undefined;
      const billed = r.testOrder.status === "BILLED";
      let amount: string | null = null;
      if (s) { const a = computeLine({ quantity: 1, unitPrice: s.price.toString(), discountAmount: 0, taxPercent: s.taxPercent.toString() }); amount = fmt(a.total); if (!billed) estimate = estimate.plus(a.total); } else if (!billed) unpriced++;
      return { requestNumber: r.requestNumber, test: r.testOrder.name, department: r.department.kind, billed, amount };
    });
    const toBillNow = reqs.some((r) => r.testOrder.status === "ORDERED");
    const invDue = invoices.reduce((a, i) => a.plus(["ISSUED", "PARTIALLY_PAID"].includes(i.status) ? balanceDue({ ...i, total: dec(i.total), paidTotal: dec(i.paidTotal), refundedTotal: dec(i.refundedTotal), creditedTotal: dec(i.creditedTotal) }) : ZERO), ZERO);
    const owed = invDue.plus(toBillNow ? estimate : ZERO);
    const advance = await this.advances.available(this.prisma, ctx, first.patientId);
    const useAdvance = Decimal.min(advance, owed);
    return {
      batchId, patientId: first.patientId, encounterId: first.encounterId, arrived: reqs.every((r) => r.arrivedAt !== null), arrivedAt: first.arrivedAt, scheduledFor: first.scheduledFor,
      tests, unpriced, owed: fmt(owed), advanceAvailable: fmt(advance), advanceToUse: fmt(useAdvance), toCollect: fmt(owed.minus(useAdvance)),
      paid: owed.lte(0) && !toBillNow && invoices.length > 0,
      invoices: invoices.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, status: i.status, total: fmt(i.total) })),
    };
  }

  /**
   * The patient is at reception. In one step: the tests not yet billed are billed at the price list, the patient's advance is used, the rest is taken, and the patient is marked as
   * reported so the nurse can take the sample. If anything is refused (an unpriced test, a missing payment) nothing is billed and nothing is taken.
   */
  async arrive(ctx: RequestContext, batchId: string, input: z.infer<typeof arriveSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for payments", 400);
    return this.idempotency.run(ctx.tenantId, `LIMS_ARRIVE:${batchId}`, key, input, async (tx) => {
      const reqs = await this.batch(tx, ctx, batchId);
      const first = reqs[0] as (typeof reqs)[number];
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Encounter" WHERE id = ${first.encounterId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const fresh = await this.batch(tx, ctx, batchId); // read again under the lock: another desk may have just done this
      if (fresh.every((r) => r.arrivedAt !== null)) throw new DomainError("INVALID_STATE", "The patient has already reported", 409);
      if (fresh.some((r) => r.status !== "PENDING_COLLECTION")) throw new DomainError("INVALID_STATE", "Some of these tests are already past the sample step", 409);

      // 1. Bill what is not billed yet, at the price list.
      const invoiceIds = new Set(fresh.flatMap((r) => (r.testOrder.invoiceId ? [r.testOrder.invoiceId] : [])));
      const unbilled = fresh.filter((r) => r.testOrder.status === "ORDERED").map((r) => r.testOrderId);
      const billed: { invoiceId: string; invoiceNumber: string | null; total: string }[] = [];
      if (unbilled.length) {
        const b = await this.tests.billOrdersInTx(tx, ctx, first.encounterId, unbilled);
        invoiceIds.add(b.invoiceId);
        billed.push({ invoiceId: b.invoiceId, invoiceNumber: b.invoiceNumber, total: b.total });
      }
      // 2. What is owed now, oldest bill first.
      const bills = [];
      for (const id of [...invoiceIds].sort()) {
        const inv = await this.ledger.lock(tx, ctx, id);
        bills.push({ inv, due: ["ISSUED", "PARTIALLY_PAID"].includes(inv.status) ? balanceDue(inv) : ZERO });
      }
      bills.sort((a, b) => a.inv.createdAt.getTime() - b.inv.createdAt.getTime() || a.inv.id.localeCompare(b.inv.id));
      const owed = bills.reduce((a, b) => a.plus(b.due), ZERO);
      // 3. The patient's advance is used first.
      let advanceLeft = Decimal.min(await this.advances.available(tx, ctx, first.patientId), owed);
      const advanceUsed = advanceLeft;
      const afterAdvance = new Map<string, Decimal>();
      for (const b of bills) {
        const take = Decimal.min(advanceLeft, b.due);
        if (take.gt(0)) { await this.advances.applyInTx(tx, ctx, b.inv.id, take); advanceLeft = advanceLeft.minus(take); }
        afterAdvance.set(b.inv.id, b.due.minus(take));
      }
      // 4. The rest is taken now, in full.
      const remaining = owed.minus(advanceUsed);
      const tendered = input.payments.reduce((a, p) => a.plus(p.amount), ZERO);
      if (tendered.gt(remaining)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `The payment of ${fmt(tendered)} is more than the ${fmt(remaining)} still to collect`, 409, { balanceDue: fmt(remaining) });
      if (tendered.lt(remaining)) throw new DomainError("PAYMENT_REQUIRED", `Collect the remaining ${fmt(remaining)} before the patient goes to the nurse`, 409, { balanceDue: fmt(remaining), owed: fmt(owed), advanceUsed: fmt(advanceUsed) });
      const pool = input.payments.map((p) => ({ method: p.method, left: new Decimal(p.amount), reference: p.reference ?? null }));
      const receipts: { invoiceNumber: string | null; receiptNumber: string; amount: string }[] = [];
      for (const b of bills) {
        let need = afterAdvance.get(b.inv.id) ?? ZERO;
        if (need.lte(0)) continue;
        const tenders: { method: (typeof pool)[number]["method"]; amount: Decimal; reference: string | null }[] = [];
        for (const t of pool) {
          if (need.lte(0)) break;
          if (t.left.lte(0)) continue;
          const take = Decimal.min(need, t.left);
          tenders.push({ method: t.method, amount: take, reference: t.reference });
          t.left = t.left.minus(take); need = need.minus(take);
        }
        const inv = await this.ledger.lock(tx, ctx, b.inv.id);
        const r = await this.ledger.receive(tx, ctx, inv, tenders);
        receipts.push({ invoiceNumber: b.inv.invoiceNumber, receiptNumber: r.receiptNumber, amount: fmt(r.total) });
      }
      // 5. Mark the patient as reported, and tell the nurse and the LIMS manager.
      const now = new Date();
      await tx.limsRequest.updateMany({ where: { tenantId: ctx.tenantId, batchId, status: "PENDING_COLLECTION", arrivedAt: null }, data: { arrivedAt: now, arrivedById: ctx.userId } });
      for (const r of fresh) await this.core.event(tx, ctx.tenantId, r.id, "ARRIVED", ctx.userId, { note: "reported at reception" });
      await this.audit.record(tx, actorOf(ctx), {
        action: "LIMS_PATIENT_ARRIVED", entityType: "Encounter", entityId: first.encounterId,
        metadata: { batchId, tests: fresh.length, billed: billed.length, owed: fmt(owed), advanceUsed: fmt(advanceUsed), collected: fmt(tendered), methods: [...new Set(input.payments.map((p) => p.method))] },
      });
      const managers = await this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, ["LIMS_ASSIGN"]);
      for (const r of fresh) {
        const nurses = await this.core.collectors(tx, ctx, { assignedNurseId: r.assignedNurseId });
        await this.core.notify(tx, ctx, [...nurses, ...(r.assignedNurseId ? [] : managers)], "LIMS_PATIENT_ARRIVED", r, "arrived");
      }
      // `invoiceIds` lets the screen open the printable bill of everything paid at this arrival.
      return { batchId, arrivedAt: now, billed, invoiceIds: bills.map((b) => b.inv.id), owed: fmt(owed), advanceUsed: fmt(advanceUsed), collected: fmt(tendered), receipts };
    });
  }

  /**
   * An emergency patient's report was issued: the test goes on the emergency bill, once. After the doctor has sent the patient to the OT or the ICU it is charged to the admission instead.
   * A test with no price on the price list is not charged here and the history says why, so the emergency desk can add the charge by hand.
   */
  async chargeEmergency(tx: Db, ctx: RequestContext, req: { id: string; requestNumber: string; encounterId: string; patientId: string; testOrderId: string }): Promise<{ posted: boolean; reason?: string }> {
    const admitted = await tx.admission.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: req.encounterId }, select: { id: true } });
    if (admitted) return this.chargeAdmitted(tx, ctx, req);
    const order = await tx.testOrder.findFirst({ where: { id: req.testOrderId, tenantId: ctx.tenantId }, select: { name: true, serviceId: true } });
    const svc = order?.serviceId ? await tx.service.findFirst({ where: { id: order.serviceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, price: true, taxPercent: true, sacCode: true } }) : null;
    if (!order || !svc) {
      const reason = "The test has no price on the price list: add its charge to the emergency bill by hand";
      await this.core.event(tx, ctx.tenantId, req.id, "CHARGE_NOT_POSTED", ctx.userId, { note: reason });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_CHARGE_NOT_POSTED", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, reason } });
      return { posted: false, reason };
    }
    const r = await this.emergencyBill.addLines(tx, ctx, { id: req.encounterId, patientId: req.patientId }, [{
      description: `${order.name} (${req.requestNumber})`, quantity: new Decimal(1), unitPrice: new Decimal(svc.price.toString()), taxPercent: new Decimal(svc.taxPercent.toString()), sourceType: "LIMS", sourceId: req.id, serviceId: svc.id, hsnSac: svc.sacCode,
    }]);
    if (r.added === 1) {
      await this.core.event(tx, ctx.tenantId, req.id, "CHARGED", ctx.userId, { note: "added to the emergency bill" });
      await this.audit.record(tx, actorOf(ctx), { action: "CHARGE_POSTED", entityType: "Invoice", entityId: r.invoiceId, metadata: { source: "LIMS", requestNumber: req.requestNumber, target: "EMERGENCY_BILL" } });
    }
    return { posted: true };
  }

  /**
   * An admitted patient's report was issued: the test becomes a charge on the admission (billed with the final bill, and visible to the Cashier, the manager and the
   * administrator). Once only, however many times it is called. A test with no price on the list, or an admission already closed, is not charged here and is said to the
   * caller so the history shows why.
   */
  async chargeAdmitted(tx: Db, ctx: RequestContext, req: { id: string; requestNumber: string; encounterId: string; patientId: string; testOrderId: string }): Promise<{ posted: boolean; reason?: string }> {
    const [adm, order] = await Promise.all([
      tx.admission.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: req.encounterId }, select: { id: true, status: true, finalInvoiceId: true } }),
      tx.testOrder.findFirst({ where: { id: req.testOrderId, tenantId: ctx.tenantId }, select: { name: true, serviceId: true } }),
    ]);
    const skip = async (reason: string) => {
      await this.core.event(tx, ctx.tenantId, req.id, "CHARGE_NOT_POSTED", ctx.userId, { note: reason });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_CHARGE_NOT_POSTED", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, reason } });
      return { posted: false, reason };
    };
    if (!adm || !order) return skip("The admission was not found");
    if (adm.status !== "ADMITTED" || adm.finalInvoiceId) return skip("The final bill is already issued: add this test to the bill by hand");
    const svc = order.serviceId ? await tx.service.findFirst({ where: { id: order.serviceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, price: true, taxPercent: true } }) : null;
    if (!svc) return skip("The test has no price on the price list: add its charge by hand");
    const made = await tx.charge.createMany({
      data: [{ tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: req.patientId, admissionId: adm.id, type: "SERVICE", serviceId: svc.id, description: `${order.name} (${req.requestNumber})`, quantity: "1", unitPrice: svc.price.toString(), taxPercent: svc.taxPercent.toString(), sourceKey: `LIMS:${req.id}`, chargedById: ctx.userId }],
      skipDuplicates: true,
    });
    if (made.count === 1) {
      await this.core.event(tx, ctx.tenantId, req.id, "CHARGED", ctx.userId, { note: "added to the admission's bill" });
      await this.audit.record(tx, actorOf(ctx), { action: "CHARGE_POSTED", entityType: "Charge", entityId: req.id, metadata: { admissionId: adm.id, type: "SERVICE", source: "LIMS", requestNumber: req.requestNumber } });
    }
    return { posted: true };
  }
}
