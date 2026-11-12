import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { admissionScope } from "../../common/data-scope";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const procedureSchema = z.object({
  name: text(3, 160), serviceId: z.string().uuid().optional(), performedAt: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(), outcome: text(3, 1000),
}).strict();
export const procedureErrorSchema = z.object({ reason: text(3, 240) }).strict();

const VIEW = { id: true, name: true, performedAt: true, performedById: true, outcome: true, status: true, errorReason: true, serviceId: true, chargeId: true, createdAt: true, charge: { select: { quantity: true, unitPrice: true, status: true } } } as const;

/**
 * Procedures done on an admitted patient (docs/ward-rounds.md). A procedure is recorded once (what was done and found, who did it, when). When it names a service of the price list,
 * its charge is added to the admission in the same step, so the bill grows as the treatment goes on. A wrong entry is marked "entered in error"; its charge is taken off the bill
 * if it has not been billed yet.
 */
@Injectable()
export class ProcedureRecordsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(ctx: RequestContext, admissionId: string) {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { id: true } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.procedureRecord.findMany({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: { performedAt: "desc" }, select: VIEW, take: 200 });
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.performedById))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map(({ charge, ...r }) => ({ ...r, performedByName: users.get(r.performedById) ?? null, charged: charge ? { quantity: charge.quantity.toString(), unitPrice: charge.unitPrice.toFixed(2), status: charge.status } : null }));
  }

  async record(ctx: RequestContext, admissionId: string, input: z.infer<typeof procedureSchema>) {
    const id = await this.prisma.$transaction(async (tx) => {
      const adm = await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { id: true, status: true, patientId: true, encounterId: true, admittedAt: true, finalInvoiceId: true } });
      if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "A procedure is recorded for a patient who is admitted", 409);
      const performedAt = input.performedAt ?? new Date();
      if (performedAt.getTime() > Date.now() + 5 * 60_000) throw new DomainError("VALIDATION_FAILED", "The procedure cannot be in the future", 400, [{ path: "performedAt", message: "In the future" }]);
      if (performedAt < adm.admittedAt) throw new DomainError("VALIDATION_FAILED", "The procedure is before the patient was admitted", 400, [{ path: "performedAt", message: "Before the admission" }]);
      const rid = randomUUID();
      let chargeId: string | null = null;
      if (input.serviceId) {
        if (adm.finalInvoiceId) throw new DomainError("INVALID_STATE", "The final bill has already been issued, so no charge can be added", 409);
        const s = await tx.service.findFirst({ where: { id: input.serviceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } });
        if (!s) throw new DomainError("VALIDATION_FAILED", "The selected service does not exist or is inactive", 400, [{ path: "serviceId", message: "Unknown or inactive service" }]);
        const c = await tx.charge.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId, type: "PROCEDURE", serviceId: s.id, description: s.name, quantity: "1", unitPrice: s.price.toString(), taxPercent: s.taxPercent.toString(), sourceKey: `PROC:${rid}`, chargedById: ctx.userId }, select: { id: true } });
        chargeId = c.id;
        await this.audit.record(tx, actorOf(ctx), { action: "CHARGE_POSTED", entityType: "Charge", entityId: c.id, metadata: { admissionId, type: "PROCEDURE", procedure: rid } });
      }
      await tx.procedureRecord.create({ data: { id: rid, tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, patientId: adm.patientId, encounterId: adm.encounterId, serviceId: input.serviceId ?? null, name: input.name, performedAt, performedById: ctx.userId, outcome: input.outcome, chargeId } });
      await this.audit.record(tx, actorOf(ctx), { action: "PROCEDURE_RECORDED", entityType: "ProcedureRecord", entityId: rid, metadata: { admissionId, charged: !!chargeId } });
      return rid;
    });
    return (await this.list(ctx, (await this.prisma.procedureRecord.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: { admissionId: true } })).admissionId)).find((p) => p.id === id);
  }

  async enterInError(ctx: RequestContext, id: string, input: z.infer<typeof procedureErrorSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.procedureRecord.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, admission: admissionScope(ctx) }, include: { charge: { select: { id: true, status: true } } } });
      if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (p.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This entry is already marked as entered in error", 409);
      if (p.performedById !== ctx.userId && !ctx.permissions.has("INVOICE_CREATE")) throw new DomainError("FORBIDDEN", "Only the person who recorded the procedure can mark it", 403);
      if (p.charge?.status === "BILLED") throw new DomainError("INVALID_STATE", "The charge is already on a bill. Ask billing for a credit note.", 409);
      if (p.charge && p.charge.status === "PENDING") {
        await tx.charge.updateMany({ where: { id: p.charge.id, tenantId: ctx.tenantId, status: "PENDING" }, data: { status: "VOIDED", voidReason: `Procedure entered in error: ${input.reason}`.slice(0, 240), voidedById: ctx.userId, voidedAt: new Date() } });
        await this.audit.record(tx, actorOf(ctx), { action: "CHARGE_VOIDED", entityType: "Charge", entityId: p.charge.id, metadata: { admissionId: p.admissionId, reason: input.reason } });
      }
      const res = await tx.procedureRecord.updateMany({ where: { id, tenantId: ctx.tenantId, status: "ACTIVE" }, data: { status: "ENTERED_IN_ERROR", errorReason: input.reason, errorById: ctx.userId, errorAt: new Date() } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The entry was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "PROCEDURE_ENTERED_IN_ERROR", entityType: "ProcedureRecord", entityId: id, metadata: { admissionId: p.admissionId, reason: input.reason } });
    });
    return { ok: true };
  }
}
