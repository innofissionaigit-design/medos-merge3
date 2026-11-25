import { Body, Controller, Get, HttpCode, Injectable, Param, Post, Query } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { PasswordService } from "../auth/password.service";
import { AdvancesService } from "../billing/advances.service";
import { setPasswordSchema } from "./portal.service";

/**
 * The hospital's side of the patient app: who has an app login, who is locked out, and the money patients paid online (docs/patient-app.md).
 * Staff see the username and the last four digits of the mobile number, never a password, and only an administrator (ADMIN_USERS) can reach any of it.
 */
export const listAccountsSchema = z.object({
  search: z.string().trim().max(60).optional(), status: z.enum(["ALL", "LOCKED"]).default("ALL"),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const resetAppPasswordSchema = setPasswordSchema.pick({ password: true }).strict();
export const listOnlinePaymentsSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();

const ONLINE_USER = "svc-online-payments";
const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");
const masked = (mobile: string) => `${"•".repeat(Math.max(0, mobile.length - 4))}${mobile.slice(-4)}`;
const money = (d: Prisma.Decimal | Decimal | null | undefined) => new Decimal(d?.toString() ?? "0").toFixed(2);

@Injectable()
export class PortalAdminService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly passwords: PasswordService, private readonly advances: AdvancesService) {}

  /** The people with a patient-app login, newest first: their username, the patients on the number, whether the account is locked, and the last time they signed in. */
  async accounts(ctx: RequestContext, q: z.infer<typeof listAccountsSchema>) {
    const now = new Date();
    const search = q.search?.trim();
    const digits = search?.replace(/\D/g, "") ?? "";
    let nameMobiles: string[] = [];
    if (search && search.length >= 2) {
      const byName = await this.prisma.patient.findMany({
        where: { tenantId: ctx.tenantId, mobile: { not: null }, OR: [{ firstName: { contains: search, mode: "insensitive" } }, { lastName: { contains: search, mode: "insensitive" } }] },
        select: { mobile: true }, take: 50,
      });
      nameMobiles = byName.flatMap((p) => (p.mobile ? [p.mobile] : []));
    }
    const where: Prisma.PatientCredentialWhereInput = {
      tenantId: ctx.tenantId,
      ...(q.status === "LOCKED" ? { lockedUntil: { gt: now } } : {}),
      ...(search ? { OR: [{ username: { contains: search.toLowerCase() } }, ...(digits.length >= 4 ? [{ mobile: { endsWith: digits } }] : []), ...(nameMobiles.length > 0 ? [{ mobile: { in: nameMobiles } }] : [])] } : {}),
    };
    const [total, locked, rows] = await Promise.all([
      this.prisma.patientCredential.count({ where }),
      this.prisma.patientCredential.count({ where: { tenantId: ctx.tenantId, lockedUntil: { gt: now } } }),
      this.prisma.patientCredential.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, mobile: true, username: true, failedAttempts: true, lockedUntil: true, createdAt: true } }),
    ]);
    const mobiles = rows.map((r) => r.mobile);
    const [patients, sessions] = await Promise.all([
      this.prisma.patient.findMany({ where: { tenantId: ctx.tenantId, mobile: { in: mobiles }, status: "ACTIVE", mergedIntoId: null }, orderBy: { createdAt: "asc" }, select: { id: true, mobile: true, firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }),
      this.prisma.patientSession.groupBy({ by: ["mobile"], where: { tenantId: ctx.tenantId, mobile: { in: mobiles } }, _max: { createdAt: true } }),
    ]);
    const lastSeen = new Map(sessions.map((s) => [s.mobile, s._max.createdAt]));
    return {
      total, locked,
      rows: rows.map((r) => ({
        id: r.id, username: r.username, mobile: masked(r.mobile), failedAttempts: r.failedAttempts, createdAt: r.createdAt,
        locked: r.lockedUntil !== null && r.lockedUntil > now, lockedUntil: r.lockedUntil !== null && r.lockedUntil > now ? r.lockedUntil : null,
        lastSignInAt: lastSeen.get(r.mobile) ?? null,
        patients: patients.filter((p) => p.mobile === r.mobile).map((p) => ({ id: p.id, name: nameOf(p), mrn: p.identifiers[0]?.value ?? null })),
      })),
    };
  }

  /** Lets a locked-out patient in at once instead of waiting for the lock to run out. The password is not touched. */
  async unlock(ctx: RequestContext, credentialId: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.patientCredential.findFirst({ where: { id: credentialId, tenantId: ctx.tenantId }, select: { id: true, mobile: true, failedAttempts: true, lockedUntil: true } });
      if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const wasLocked = c.lockedUntil !== null && c.lockedUntil > new Date();
      await tx.patientCredential.updateMany({ where: { id: c.id, tenantId: ctx.tenantId }, data: { failedAttempts: 0, lockedUntil: null } });
      await this.audit.record(tx, actorOf(ctx), { action: "PATIENT_APP_ACCOUNT_UNLOCKED", entityType: "PatientCredential", entityId: c.id, metadata: { wasLocked, failedTries: c.failedAttempts, mobileEnding: c.mobile.slice(-4) } });
      return { id: c.id, unlocked: true as const, wasLocked };
    });
  }

  /**
   * Gives a patient a new temporary password when they have forgotten theirs. Every session the patient has open is ended, the lock is cleared, and the audit trail
   * records who did it. The new password is never stored or logged in clear: only its hash is kept.
   */
  async resetPassword(ctx: RequestContext, credentialId: string, input: z.infer<typeof resetAppPasswordSchema>) {
    const passwordHash = await this.passwords.hash(input.password);
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.patientCredential.findFirst({ where: { id: credentialId, tenantId: ctx.tenantId }, select: { id: true, mobile: true } });
      if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const now = new Date();
      await tx.patientCredential.updateMany({ where: { id: c.id, tenantId: ctx.tenantId }, data: { passwordHash, failedAttempts: 0, lockedUntil: null, updatedAt: now } });
      const ended = await tx.patientSession.updateMany({ where: { tenantId: ctx.tenantId, mobile: c.mobile, revokedAt: null }, data: { revokedAt: now } });
      await this.audit.record(tx, actorOf(ctx), { action: "PATIENT_APP_PASSWORD_RESET", entityType: "PatientCredential", entityId: c.id, metadata: { sessionsEnded: ended.count, mobileEnding: c.mobile.slice(-4) } });
      return { id: c.id, reset: true as const, sessionsEnded: ended.count };
    });
  }

  /**
   * What patients paid by UPI or card in the app: their own bills, and the video-consultation and booking fees, newest first. These are recorded under the hidden
   * online-payments user, so that user's receipts and advances are exactly the online money. A refund is still made at the counter, so what has been refunded is shown.
   */
  async payments(ctx: RequestContext, q: z.infer<typeof listOnlinePaymentsSchema>) {
    const svc = await this.prisma.user.findFirst({ where: { tenantId: ctx.tenantId, username: ONLINE_USER }, select: { id: true } });
    if (!svc) return { summary: { count: 0, collected: "0.00", refunded: "0.00" }, total: 0, rows: [] };
    const take = q.page * q.pageSize;
    const receiptWhere = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, receivedById: svc.id };
    const [receipts, deposits, receiptSum, depositSum, refundSum] = await Promise.all([
      this.prisma.receipt.findMany({ where: receiptWhere, orderBy: { receivedAt: "desc" }, take, select: { id: true, receiptNumber: true, total: true, receivedAt: true, invoiceId: true, invoice: { select: { patientId: true, invoiceNumber: true, paidTotal: true, refundedTotal: true } }, payments: { select: { method: true, reference: true } } } }),
      this.prisma.advanceDeposit.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, receivedById: svc.id }, orderBy: { receivedAt: "desc" }, take, select: { id: true, receiptNumber: true, amount: true, note: true, receivedAt: true, patientId: true, tenders: { select: { method: true, reference: true } }, refunds: { select: { amount: true } } } }),
      this.prisma.receipt.aggregate({ where: receiptWhere, _sum: { total: true }, _count: true }),
      this.prisma.advanceDeposit.aggregate({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, receivedById: svc.id }, _sum: { amount: true }, _count: true }),
      this.prisma.advanceRefund.aggregate({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, deposit: { receivedById: svc.id } }, _sum: { amount: true } }),
    ]);
    const left = await this.advances.balances(ctx, deposits.map((d) => d.id));
    const patientIds = [...new Set([...receipts.map((r) => r.invoice.patientId), ...deposits.map((d) => d.patientId)])];
    const people = await this.prisma.patient.findMany({ where: { tenantId: ctx.tenantId, id: { in: patientIds } }, select: { id: true, firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } });
    const who = new Map(people.map((p) => [p.id, { name: nameOf(p), mrn: p.identifiers[0]?.value ?? null }]));
    const rows = [
      ...receipts.map((r) => ({ kind: "BILL" as const, receiptNumber: r.receiptNumber, what: r.invoice.invoiceNumber ? `Bill ${r.invoice.invoiceNumber}` : "Bill", amount: money(r.total), refunded: "0.00", method: r.payments[0]?.method ?? null, reference: r.payments[0]?.reference ?? null, at: r.receivedAt, patientId: r.invoice.patientId,
        refund: { kind: "INVOICE" as const, id: r.invoiceId, refundable: money(Decimal.max(new Decimal(0), Decimal.min(new Decimal(r.total.toString()), new Decimal(r.invoice.paidTotal.toString()).minus(r.invoice.refundedTotal.toString())))) } })),
      ...deposits.map((d) => ({ kind: "FEE" as const, receiptNumber: d.receiptNumber, what: d.note ?? "Fee paid in the app", amount: money(d.amount), refunded: money(d.refunds.reduce((a, x) => a.plus(x.amount.toString()), new Decimal(0))), method: d.tenders[0]?.method ?? null, reference: d.tenders[0]?.reference ?? null, at: d.receivedAt, patientId: d.patientId,
        refund: { kind: "ADVANCE" as const, id: d.id, refundable: money(left.get(d.id) ?? new Decimal(0)) } })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    return {
      total: receiptSum._count + depositSum._count,
      summary: { count: receiptSum._count + depositSum._count, collected: money(new Decimal(receiptSum._sum.total?.toString() ?? "0").plus(depositSum._sum.amount?.toString() ?? "0")), refunded: money(refundSum._sum.amount) },
      rows: rows.map(({ patientId, ...r }) => ({ ...r, patient: who.get(patientId) ?? { name: "Unknown", mrn: null } })),
    };
  }
}

@Controller("patient-app")
export class PatientAppAdminController {
  constructor(private readonly admin: PortalAdminService) {}

  @RequirePermissions("ADMIN_USERS")
  @Get("accounts")
  async accounts(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.admin.accounts(ctx, parse(listAccountsSchema, query)) }; }

  @RequirePermissions("ADMIN_USERS")
  @Post("accounts/:id/unlock")
  @HttpCode(200)
  async unlock(@Ctx() ctx: RequestContext, @Param("id") credentialId: string) { return { data: await this.admin.unlock(ctx, id(credentialId)) }; }

  @RequirePermissions("ADMIN_USERS")
  @Post("accounts/:id/reset-password")
  @HttpCode(200)
  async reset(@Ctx() ctx: RequestContext, @Param("id") credentialId: string, @Body() body: unknown) { return { data: await this.admin.resetPassword(ctx, id(credentialId), parse(resetAppPasswordSchema, body)) }; }

  @RequirePermissions("ADMIN_USERS")
  @Get("payments")
  async payments(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.admin.payments(ctx, parse(listOnlinePaymentsSchema, query)) }; }
}
