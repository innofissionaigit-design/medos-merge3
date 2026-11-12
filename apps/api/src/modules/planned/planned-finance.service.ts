import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { AdvancesService, takeAdvanceSchema } from "../billing/advances.service";
import { fmt } from "../billing/billing.domain";
import { amount, quantity } from "../billing/money.schema";
import { ClaimsService } from "../claims/claims.service";
import { PlannedCore } from "./planned.core";
import { estimateTotal, type EstimateLine } from "./planned.domain";

const uuid = z.string().uuid();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const estimateSchema = z.object({
  lines: z.array(z.object({ description: text(2, 120), quantity, unitPrice: amount() }).strict()).min(1).max(30),
}).strict();
export const payerSchema = z.discriminatedUnion("payer", [
  z.object({ payer: z.literal("SELF_PAY"), note: text(3, 300).optional() }).strict(),
  z.object({ payer: z.literal("INSURED"), policyId: uuid, preauthRequired: z.boolean(), eligibilityNote: text(3, 300) }).strict(),
]);
export const preauthSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("REQUEST"), requestedAmount: amount({ positive: true }), note: text(3, 500).optional() }).strict(),
  z.object({ action: z.literal("APPROVE"), amount: amount({ positive: true }), reason: text(3, 300).optional() }).strict(),
  z.object({ action: z.literal("REJECT"), reason: text(5, 300) }).strict(),
  z.object({ action: z.literal("SELF_PAY"), reason: text(5, 300) }).strict(),
]);
export const requiredDepositSchema = z.object({ amount: amount() }).strict();
export const waiveSchema = z.object({ reason: text(10, 300) }).strict();

/** Claim statuses in which the insurer's pre-authorisation stands. */
const APPROVED_CLAIM = ["PREAUTH_APPROVED", "SUBMITTED", "QUERY", "APPROVED", "SETTLED"];
const OPEN_CLAIM = ["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED"];

/**
 * The money steps of a planned admission (docs/planned-admission.md): billing's estimate, the payer and the policy check, the insurer's pre-authorisation, and the deposit or the approval in its place.
 * Insurance work uses the ordinary claim (docs/claims.md), started and moved in the same transaction as the request; a deposit is an ordinary advance payment (docs/advance-payments.md) marked
 * as taken for the request, so it appears in the patient's advances, the cashier's shift and the day's collections like any other.
 */
@Injectable()
export class PlannedFinanceService {
  constructor(private readonly prisma: PrismaService, private readonly core: PlannedCore, private readonly claims: ClaimsService, private readonly advances: AdvancesService) {}

  private async run(ctx: RequestContext, fn: (tx: Db) => Promise<void>, id: string) {
    return this.prisma.$transaction(async (tx) => { await fn(tx); return this.core.view(tx, ctx, id); });
  }

  // ───── estimate ─────

  /** Billing's estimate of the charges: the lines are replaced as a set while the request is in billing, insurance or deposit; the total is worked out here. */
  async saveEstimate(ctx: RequestContext, id: string, input: z.infer<typeof estimateSchema>) {
    return this.run(ctx, async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      if (!["TARIFF_PAYER", "PREAUTH", "DEPOSIT"].includes(plan.status)) throw new DomainError("INVALID_STATE", "The estimate cannot be changed at this step", 409);
      const lines: EstimateLine[] = input.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice }));
      const total = estimateTotal(lines);
      if (total.gt(99_999_999)) throw new DomainError("VALIDATION_FAILED", "The estimate is too large", 400, [{ path: "lines", message: "Too large" }]);
      await tx.plannedEstimateLine.deleteMany({ where: { tenantId: ctx.tenantId, plannedId: id } });
      await tx.plannedEstimateLine.createMany({ data: lines.map((l, n) => ({ tenantId: ctx.tenantId, plannedId: id, lineNo: n + 1, description: l.description, quantity: l.quantity.toFixed(3), unitPrice: l.unitPrice.toFixed(2) })) });
      const res = await tx.plannedAdmission.updateMany({ where: { id, tenantId: ctx.tenantId, status: plan.status }, data: { estimateTotal: total.toFixed(2), version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The request was changed by someone else", 409);
      await this.core.record(tx, ctx, plan, "ESTIMATE_SAVED", `${lines.length} lines, total ${fmt(total)}`, { total: fmt(total), lines: lines.length });
    }, id);
  }

  // ───── payer ─────

  /** Closes a claim that was only started, because the patient will pay himself or herself or the policy changed. A claim the insurer has gone further with is never touched. */
  private async dropClaim(tx: Db, ctx: RequestContext, claimId: string | null, why: string): Promise<void> {
    if (!claimId) return;
    const c = await tx.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId }, select: { status: true } });
    if (c && OPEN_CLAIM.includes(c.status)) await this.claims.close(ctx, claimId, { reason: why }, tx);
  }

  /** The payer: self-pay (billing or insurance), or insured: the insurance team checks the policy and starts the cashless claim that pre-authorisation and the later bill belong to. */
  async setPayer(ctx: RequestContext, id: string, input: z.infer<typeof payerSchema>) {
    return this.run(ctx, async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      if (input.payer === "SELF_PAY") {
        if (!["TARIFF_PAYER", "PREAUTH"].includes(plan.status)) throw new DomainError("INVALID_STATE", "The payer cannot be changed at this step", 409);
        await this.dropClaim(tx, ctx, plan.claimId, `Planned admission ${plan.requestNumber}: the patient will pay`);
        const res = await tx.plannedAdmission.updateMany({ where: { id, tenantId: ctx.tenantId, status: plan.status }, data: { payer: "SELF_PAY", policyId: null, claimId: null, preauthRequired: false, eligibilityNote: input.note ?? null, version: { increment: 1 } } });
        if (res.count !== 1) throw new DomainError("INVALID_STATE", "The request was changed by someone else", 409);
        if (plan.status === "PREAUTH") await this.core.move(tx, ctx, plan, "PREAUTH_DONE", undefined, {}, "PAYER_CHANGED_SELF_PAY", input.note ?? "The patient will pay himself or herself");
        else await this.core.record(tx, ctx, plan, "PAYER_SET", "Self-pay", { payer: "SELF_PAY" });
        return;
      }
      if (!ctx.permissions.has("PLANNED_INSURANCE")) throw new DomainError("FORBIDDEN", "Only the insurance team can set an insured payer", 403);
      if (plan.status !== "TARIFF_PAYER") throw new DomainError("INVALID_STATE", "The insurance details can be set only while billing and insurance work on the request", 409);
      const policy = await tx.patientPolicy.findFirst({ where: { id: input.policyId, tenantId: ctx.tenantId, patientId: plan.patientId }, select: { id: true, status: true, validFrom: true, validTo: true, insurer: { select: { name: true, status: true } } } });
      if (!policy) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (policy.status !== "ACTIVE" || policy.insurer.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This policy or its insurer is not active", 409);
      const asOf = plan.proposedDate ?? new Date();
      if (policy.validFrom > asOf || policy.validTo < asOf) throw new DomainError("INVALID_STATE", "The policy is not valid on the admission day", 409, { validFrom: policy.validFrom.toISOString().slice(0, 10), validTo: policy.validTo.toISOString().slice(0, 10) });
      let claimId = plan.claimId;
      if (claimId) {
        const existing = await tx.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId }, select: { status: true, policyId: true } });
        if (existing && existing.status !== "DRAFT") throw new DomainError("INVALID_STATE", "The insurer has already been asked for this claim, so the policy cannot be changed", 409);
        if (existing && existing.policyId !== input.policyId) { await this.dropClaim(tx, ctx, claimId, `Planned admission ${plan.requestNumber}: another policy was chosen`); claimId = null; }
      }
      if (!claimId) claimId = (await this.claims.create(ctx, { patientId: plan.patientId, policyId: input.policyId, type: "CASHLESS", ...(plan.diagnosis ? { diagnosis: plan.diagnosis } : {}) }, tx)).id;
      const res = await tx.plannedAdmission.updateMany({ where: { id, tenantId: ctx.tenantId, status: "TARIFF_PAYER" }, data: { payer: "INSURED", policyId: input.policyId, claimId, preauthRequired: input.preauthRequired, eligibilityNote: input.eligibilityNote, version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The request was changed by someone else", 409);
      await this.core.record(tx, ctx, plan, "PAYER_SET", `Insured with ${policy.insurer.name}. ${input.eligibilityNote}`, { payer: "INSURED", preauthRequired: input.preauthRequired, claimId });
    }, id);
  }

  /** Billing and insurance are done: the estimate is made and the payer known. Next is the insurer's pre-authorisation where it is needed, otherwise the deposit. */
  async tariffDone(ctx: RequestContext, id: string) {
    return this.run(ctx, async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      if (plan.status !== "TARIFF_PAYER") throw new DomainError("INVALID_STATE", "This step is not possible now", 409);
      if (new Decimal(plan.estimateTotal.toString()).lte(0)) throw new DomainError("INVALID_STATE", "Make the estimate first", 409);
      if (!plan.payer) throw new DomainError("INVALID_STATE", "Choose the payer first", 409);
      const to = plan.payer === "INSURED" && plan.preauthRequired ? "PREAUTH" : "DEPOSIT";
      await this.core.move(tx, ctx, plan, "TARIFF_DONE", to, {}, "TARIFF_DONE", null, { payer: plan.payer, next: to });
    }, id);
  }

  // ───── pre-authorisation ─────

  /** The insurer's pre-authorisation is asked for and answered through the claim; an approval moves the request on to the deposit. */
  async preauth(ctx: RequestContext, id: string, input: z.infer<typeof preauthSchema>) {
    return this.run(ctx, async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      if (plan.status !== "PREAUTH") throw new DomainError("INVALID_STATE", "This request is not waiting for pre-authorisation", 409);
      if (input.action === "SELF_PAY") {
        await this.dropClaim(tx, ctx, plan.claimId, `Planned admission ${plan.requestNumber}: ${input.reason}`);
        const res = await tx.plannedAdmission.updateMany({ where: { id, tenantId: ctx.tenantId, status: "PREAUTH" }, data: { payer: "SELF_PAY", policyId: null, claimId: null, preauthRequired: false, eligibilityNote: input.reason } });
        if (res.count !== 1) throw new DomainError("INVALID_STATE", "The request was changed by someone else", 409);
        await this.core.move(tx, ctx, plan, "PREAUTH_DONE", undefined, {}, "PAYER_CHANGED_SELF_PAY", input.reason);
        return;
      }
      if (!plan.claimId) throw new DomainError("INVALID_STATE", "There is no insurance claim for this request", 409);
      if (input.action === "REQUEST") {
        await this.claims.requestPreauth(ctx, plan.claimId, { requestedAmount: input.requestedAmount, ...(input.note ? { note: input.note } : {}) }, tx);
        await this.core.record(tx, ctx, plan, "PREAUTH_REQUESTED", `Asked the insurer for ${fmt(input.requestedAmount)}`, { amount: fmt(input.requestedAmount) });
      } else if (input.action === "APPROVE") {
        await this.claims.decidePreauth(ctx, plan.claimId, { decision: "APPROVE", amount: input.amount, ...(input.reason ? { reason: input.reason } : {}) }, tx);
        await this.core.move(tx, ctx, plan, "PREAUTH_DONE", undefined, {}, "PREAUTH_APPROVED", `The insurer approved ${fmt(input.amount)}`, { amount: fmt(input.amount) });
      } else {
        await this.claims.decidePreauth(ctx, plan.claimId, { decision: "REJECT", reason: input.reason }, tx);
        await this.core.record(tx, ctx, plan, "PREAUTH_REJECTED", input.reason, {});
      }
    }, id);
  }

  // ───── deposit and approval ─────

  /**
   * Clears the money step when it is satisfied: nothing is required (the insurer covers the estimate), or the deposits taken for the request reach what was asked for.
   * Returns whether the request moved on to bed allocation.
   */
  private async settle(tx: Db, ctx: RequestContext, id: string): Promise<boolean> {
    const plan = await this.core.lock(tx, ctx, id);
    if (plan.status !== "DEPOSIT" || plan.requiredDeposit === null) return false;
    const required = new Decimal(plan.requiredDeposit.toString());
    const held = await this.core.depositHeld(tx, ctx, id);
    const claim = plan.claimId ? await tx.claim.findFirst({ where: { id: plan.claimId, tenantId: ctx.tenantId }, select: { status: true } }) : null;
    const insured = plan.payer === "INSURED" && !!claim && APPROVED_CLAIM.includes(claim.status);
    let basis: "DEPOSIT_PAID" | "INSURANCE_APPROVED" | "NOT_REQUIRED";
    if (required.eq(0)) basis = insured ? "INSURANCE_APPROVED" : "NOT_REQUIRED";
    else if (held.gte(required)) basis = "DEPOSIT_PAID";
    else return false;
    await this.core.move(tx, ctx, plan, "FINANCIAL_CLEARED", undefined, { financialBasis: basis, financialClearedAt: new Date(), financialClearedById: ctx.userId }, "FINANCIAL_CLEARED", null, { basis, required: fmt(required), held: fmt(held) });
    return true;
  }

  /** Billing says how much deposit to ask for. Zero is accepted only when the insurer's approval covers the whole estimate; otherwise a manager may waive it. */
  async setRequiredDeposit(ctx: RequestContext, id: string, input: z.infer<typeof requiredDepositSchema>) {
    return this.run(ctx, async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      if (plan.status !== "DEPOSIT") throw new DomainError("INVALID_STATE", "The deposit is set when the request reaches the deposit step", 409);
      if (input.amount.eq(0)) {
        const claim = plan.claimId ? await tx.claim.findFirst({ where: { id: plan.claimId, tenantId: ctx.tenantId }, select: { status: true, preauthApproved: true } }) : null;
        const covered = plan.payer === "INSURED" && !!claim && APPROVED_CLAIM.includes(claim.status) && !!claim.preauthApproved && new Decimal(claim.preauthApproved.toString()).gte(plan.estimateTotal.toString());
        if (!covered) throw new DomainError("VALIDATION_FAILED", "A deposit is needed. Only a manager can waive it, or the insurer's approval must cover the whole estimate.", 400, [{ path: "amount", message: "Enter the deposit to ask for" }]);
      }
      const res = await tx.plannedAdmission.updateMany({ where: { id, tenantId: ctx.tenantId, status: "DEPOSIT" }, data: { requiredDeposit: input.amount.toFixed(2), version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The request was changed by someone else", 409);
      await this.core.record(tx, ctx, plan, "DEPOSIT_REQUIRED_SET", `Deposit asked: ${fmt(input.amount)}`, { amount: fmt(input.amount) });
      await this.settle(tx, ctx, id);
    }, id);
  }

  /** The deposit is taken as an ordinary advance payment (cash, UPI, card, bank transfer, or a split of them) marked as taken for this request; when it reaches the amount asked, the request moves on. */
  async takeDeposit(ctx: RequestContext, id: string, input: z.infer<typeof takeAdvanceSchema>, key: string | undefined) {
    const seen = await this.prisma.plannedAdmission.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { patientId: true, status: true } });
    if (!seen) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (seen.status !== "DEPOSIT") throw new DomainError("INVALID_STATE", "A deposit is taken when the request is at the deposit step", 409);
    const { replayed } = await this.advances.take(ctx, seen.patientId, input, key, undefined, {
      id,
      inside: async (tx) => {
        const plan = await this.core.lock(tx, ctx, id);
        if (plan.status !== "DEPOSIT") throw new DomainError("INVALID_STATE", "A deposit is taken when the request is at the deposit step", 409);
        const total = input.tenders.reduce((a, t) => a.plus(t.amount), new Decimal(0));
        await this.core.record(tx, ctx, plan, "DEPOSIT_TAKEN", `Deposit received: ${fmt(total)}`, { amount: fmt(total) });
        await this.settle(tx, ctx, id);
      },
    });
    return { result: await this.core.view(this.prisma, ctx, id), replayed };
  }

  /** A manager waives the deposit, with a written reason; the request then moves on to bed allocation. */
  async waive(ctx: RequestContext, id: string, input: z.infer<typeof waiveSchema>) {
    return this.run(ctx, async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      const held = await this.core.depositHeld(tx, ctx, id);
      await this.core.move(tx, ctx, plan, "FINANCIAL_CLEARED", undefined, { financialBasis: "WAIVED", financialNote: input.reason, financialClearedAt: new Date(), financialClearedById: ctx.userId }, "DEPOSIT_WAIVED", input.reason,
        { required: plan.requiredDeposit === null ? "" : fmt(plan.requiredDeposit), held: fmt(held) });
    }, id);
  }

  /** Re-checks the deposit (for example after a deposit was taken at the cashier's desk) and moves the request on if it is satisfied. */
  async financialCheck(ctx: RequestContext, id: string) {
    return this.run(ctx, async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      if (plan.status !== "DEPOSIT") throw new DomainError("INVALID_STATE", "This step is not possible now", 409);
      if (plan.requiredDeposit === null) throw new DomainError("INVALID_STATE", "Set the deposit to ask for first", 409);
      if (!(await this.settle(tx, ctx, id))) throw new DomainError("INVALID_STATE", "The deposit asked for has not been received yet", 409);
    }, id);
  }
}
