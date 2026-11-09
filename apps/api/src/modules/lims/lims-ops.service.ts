import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { NotificationsService } from "../notifications/notifications.service";
import { LimsCoreService } from "./lims-core.service";
import { LimsService } from "./lims.service";
import { addMinutes, DEPARTMENT_PERMISSIONS, OPEN_STATUSES, qcResultFrom, type DepartmentKind } from "./lims.domain";

const uuid = z.string().uuid();
const kind = z.enum(["PATHOLOGY", "RADIOLOGY"]);
const dec = z.number().min(-999_999).max(999_999).multipleOf(0.001);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(`${s}T00:00:00+05:30`));

export const departmentSchema = z.object({
  name: z.string().trim().min(2).max(80),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  routineTatMinutes: z.number().int().min(5).max(43_200),
  urgentTatMinutes: z.number().int().min(5).max(43_200),
  emergencyTatMinutes: z.number().int().min(5).max(43_200),
  defaultInstructions: z.string().trim().max(600).nullish(),
}).strict().refine((d) => d.emergencyTatMinutes <= d.urgentTatMinutes && d.urgentTatMinutes <= d.routineTatMinutes, "Targets must get shorter from routine to urgent to emergency");

export const instrumentSchema = z.object({
  department: kind,
  name: z.string().trim().min(2).max(80),
  model: z.string().trim().max(80).optional(),
  serialNumber: z.string().trim().max(80).optional(),
  lastCalibratedAt: day.optional(),
  nextCalibrationDue: day.optional(),
}).strict();
export const instrumentUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  model: z.string().trim().max(80).nullish(),
  serialNumber: z.string().trim().max(80).nullish(),
  status: z.enum(["ACTIVE", "MAINTENANCE", "OUT_OF_SERVICE"]).optional(),
  lastCalibratedAt: day.nullish(),
  nextCalibrationDue: day.nullish(),
}).strict();

export const qcSchema = z.object({
  department: kind,
  instrumentId: uuid.optional(),
  subject: z.string().trim().min(2).max(120),
  level: z.string().trim().max(40).optional(),
  unit: z.string().trim().max(20).optional(),
  expected: dec.optional(), observed: dec.optional(), lowLimit: dec.optional(), highLimit: dec.optional(),
  /** Needed when there are no numbers to work it out from (for example a daily image-quality check). */
  result: z.enum(["PASS", "FAIL"]).optional(),
  note: z.string().trim().max(400).optional(),
}).strict().refine((q) => q.lowLimit === undefined || q.highLimit === undefined || q.lowLimit <= q.highLimit, "The lower limit is above the upper limit");
export const qcReviewSchema = z.object({ actionRequired: z.boolean(), note: z.string().trim().min(3).max(400) }).strict();
export const qcListSchema = z.object({ department: kind.optional(), result: z.enum(["PASS", "FAIL"]).optional(), unreviewed: z.enum(["true", "false"]).transform((v) => v === "true").optional(), instrumentId: uuid.optional() }).strict();

export const exceptionSchema = z.object({ requestId: uuid, kind: z.enum(["QUEUE_JUMP", "COMPROMISED_SAMPLE", "DELAYED_REPORT", "OTHER"]), reason: z.string().trim().min(5).max(400) }).strict();
export const exceptionDecisionSchema = z.object({ decision: z.enum(["APPROVED", "DENIED"]), note: z.string().trim().min(3).max(400) }).strict();
export const exceptionListSchema = z.object({ status: z.enum(["PENDING", "APPROVED", "DENIED"]).optional() }).strict();

const CALIBRATION_WARN_DAYS = 14;

/** Departments, instruments, quality control and exceptions: the LIMS manager's controls (docs/lims-portal.md). */
@Injectable()
export class LimsOpsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly lims: LimsService, private readonly core: LimsCoreService, private readonly notifications: NotificationsService) {}

  private readable(ctx: RequestContext): DepartmentKind[] { return this.lims.readableKinds(ctx); }

  private async dept(db: PrismaService | Prisma.TransactionClient, ctx: RequestContext, k: DepartmentKind) {
    const d = (await this.lims.ensureDepartments(db, ctx.tenantId, ctx.facilityId)).find((x) => x.kind === k);
    if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return d;
  }

  // ───── departments (administrator) ─────

  async saveDepartment(ctx: RequestContext, k: DepartmentKind, input: z.infer<typeof departmentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const d = await this.dept(tx, ctx, k);
      if (input.status === "INACTIVE" && d.status === "ACTIVE") {
        const open = await tx.limsRequest.count({ where: { tenantId: ctx.tenantId, departmentId: d.id, status: { in: [...OPEN_STATUSES] } } });
        if (open > 0) throw new DomainError("INVALID_STATE", `${open} request(s) are still open in this department. Finish or cancel them first`, 409);
      }
      const row = await tx.limsDepartment.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: d.id } },
        data: { name: input.name, status: input.status, routineTatMinutes: input.routineTatMinutes, urgentTatMinutes: input.urgentTatMinutes, emergencyTatMinutes: input.emergencyTatMinutes, defaultInstructions: input.defaultInstructions ?? null },
      });
      await this.audit.record(tx, actorOf(ctx), {
        action: "LIMS_DEPARTMENT_CHANGED", entityType: "LimsDepartment", entityId: d.id,
        metadata: { kind: k, name: input.name, status: input.status, routine: input.routineTatMinutes, urgent: input.urgentTatMinutes, emergency: input.emergencyTatMinutes, statusFrom: d.status },
      });
      return { id: row.id, kind: row.kind, name: row.name, status: row.status };
    });
  }

  // ───── instruments ─────

  async instruments(ctx: RequestContext) {
    const kinds = this.readable(ctx);
    const rows = await this.prisma.limsInstrument.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, department: { kind: { in: kinds } } }, orderBy: [{ name: "asc" }], include: { department: { select: { kind: true, name: true } } }, take: 200 });
    const since = new Date(Date.now() - 30 * 86_400_000);
    const qc = rows.length ? await this.prisma.limsQcRecord.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, instrumentId: { in: rows.map((r) => r.id) }, recordedAt: { gte: since } }, select: { instrumentId: true, result: true, recordedAt: true, reviewedAt: true }, orderBy: { recordedAt: "desc" }, take: 5000 }) : [];
    const now = Date.now();
    return rows.map((r) => {
      const mine = qc.filter((x) => x.instrumentId === r.id);
      const failed = mine.filter((x) => x.result === "FAIL");
      return {
        id: r.id, name: r.name, model: r.model, serialNumber: r.serialNumber, status: r.status, department: r.department.kind, departmentName: r.department.name,
        lastCalibratedAt: r.lastCalibratedAt, nextCalibrationDue: r.nextCalibrationDue,
        calibrationOverdue: r.nextCalibrationDue ? r.nextCalibrationDue.getTime() < now : false, calibrationSoon: r.nextCalibrationDue ? r.nextCalibrationDue.getTime() >= now && r.nextCalibrationDue.getTime() < now + CALIBRATION_WARN_DAYS * 86_400_000 : false,
        qc30: { runs: mine.length, failed: failed.length, passPercent: mine.length ? Math.round(((mine.length - failed.length) / mine.length) * 100) : null, unreviewedFailures: failed.filter((x) => !x.reviewedAt).length, lastRunAt: mine[0]?.recordedAt ?? null },
      };
    });
  }

  async createInstrument(ctx: RequestContext, input: z.infer<typeof instrumentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const d = await this.dept(tx, ctx, input.department);
      const row = await tx.limsInstrument.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, departmentId: d.id, name: input.name, model: input.model ?? null, serialNumber: input.serialNumber ?? null, lastCalibratedAt: input.lastCalibratedAt ?? null, nextCalibrationDue: input.nextCalibrationDue ?? null, createdById: ctx.userId },
        select: { id: true, name: true },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_INSTRUMENT_ADDED", entityType: "LimsInstrument", entityId: row.id, metadata: { name: row.name, department: input.department } });
      return row;
    });
  }

  async updateInstrument(ctx: RequestContext, id: string, input: z.infer<typeof instrumentUpdateSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.limsInstrument.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, name: true, status: true } });
      if (!cur) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const data: Prisma.LimsInstrumentUncheckedUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.model !== undefined) data.model = input.model;
      if (input.serialNumber !== undefined) data.serialNumber = input.serialNumber;
      if (input.status !== undefined) data.status = input.status;
      if (input.lastCalibratedAt !== undefined) data.lastCalibratedAt = input.lastCalibratedAt;
      if (input.nextCalibrationDue !== undefined) data.nextCalibrationDue = input.nextCalibrationDue;
      await tx.limsInstrument.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_INSTRUMENT_CHANGED", entityType: "LimsInstrument", entityId: id, metadata: { name: cur.name, ...(input.status && input.status !== cur.status ? { statusFrom: cur.status, statusTo: input.status } : {}), fields: Object.keys(data).join(",") } });
      return { id, ok: true };
    });
  }

  // ───── quality control ─────

  async qcList(ctx: RequestContext, q: z.infer<typeof qcListSchema>) {
    const kinds = this.readable(ctx).filter((k) => !q.department || k === q.department);
    const rows = await this.prisma.limsQcRecord.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, department: { kind: { in: kinds } }, ...(q.result ? { result: q.result } : {}), ...(q.unreviewed ? { reviewedAt: null, result: "FAIL" } : {}), ...(q.instrumentId ? { instrumentId: q.instrumentId } : {}) },
      orderBy: [{ recordedAt: "desc" }, { id: "asc" }], take: 100,
      include: { department: { select: { kind: true } }, instrument: { select: { name: true } } },
    });
    const ids = [...new Set(rows.flatMap((r) => [r.recordedById, r.reviewedById]).filter((x): x is string => !!x))];
    const names = new Map((ids.length ? await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    const s = (v: { toString(): string } | null) => (v === null ? null : new Decimal(v.toString()).toString());
    return rows.map((r) => ({
      id: r.id, department: r.department.kind, instrumentId: r.instrumentId, instrument: r.instrument?.name ?? null, subject: r.subject, level: r.level, unit: r.unit,
      expected: s(r.expected), observed: s(r.observed), lowLimit: s(r.lowLimit), highLimit: s(r.highLimit), result: r.result, note: r.note,
      recordedAt: r.recordedAt, recordedBy: names.get(r.recordedById) ?? null, reviewedAt: r.reviewedAt, reviewedBy: r.reviewedById ? names.get(r.reviewedById) ?? null : null, reviewNote: r.reviewNote, actionRequired: r.actionRequired,
    }));
  }

  /** A technician (or the manager) records a quality-control run. The result is worked out from the numbers when there are any. */
  async recordQc(ctx: RequestContext, input: z.infer<typeof qcSchema>) {
    if (!ctx.permissions.has(DEPARTMENT_PERMISSIONS[input.department].work) && !ctx.permissions.has("LIMS_MANAGE")) throw new DomainError("FORBIDDEN", "You do not have permission for this department's work", 403);
    const computed = qcResultFrom(input.observed ?? null, input.lowLimit ?? null, input.highLimit ?? null);
    if (computed && input.result && input.result !== computed) throw new DomainError("VALIDATION_FAILED", "The result you chose does not match the numbers", 400);
    const result = computed ?? input.result;
    if (!result) throw new DomainError("VALIDATION_FAILED", "Enter the measured value with its limits, or say whether the check passed", 400);
    return this.prisma.$transaction(async (tx) => {
      const d = await this.dept(tx, ctx, input.department);
      if (input.instrumentId) {
        const ins = await tx.limsInstrument.findFirst({ where: { id: input.instrumentId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, departmentId: d.id }, select: { id: true } });
        if (!ins) throw new DomainError("VALIDATION_FAILED", "That instrument does not belong to this department", 400);
      }
      const row = await tx.limsQcRecord.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, departmentId: d.id, instrumentId: input.instrumentId ?? null, subject: input.subject, level: input.level ?? null, unit: input.unit ?? null,
          expected: input.expected ?? null, observed: input.observed ?? null, lowLimit: input.lowLimit ?? null, highLimit: input.highLimit ?? null, result, note: input.note ?? null, recordedById: ctx.userId,
        },
        select: { id: true, result: true },
      });
      await this.audit.record(tx, actorOf(ctx), { action: result === "FAIL" ? "LIMS_QC_FAILED" : "LIMS_QC_RECORDED", entityType: "LimsQcRecord", entityId: row.id, metadata: { department: input.department, subject: input.subject, result } });
      if (result === "FAIL") {
        const managers = await this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, ["LIMS_MANAGE"]);
        await this.notifications.notify(tx, managers, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "LIMS_EXCEPTION_RAISED", entityType: "LimsQcRecord", entityId: row.id, dedupeKey: `LIMS_QC_FAILED:${row.id}` });
      }
      return row;
    });
  }

  /** The LIMS manager reviews a quality-control record. A failure that needs action puts its instrument into maintenance until the manager sets it back to active. */
  async reviewQc(ctx: RequestContext, id: string, input: z.infer<typeof qcReviewSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.limsQcRecord.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, result: true, reviewedAt: true, instrumentId: true, recordedById: true } });
      if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (r.reviewedAt) throw new DomainError("INVALID_STATE", "This record has already been reviewed", 409);
      if (r.recordedById === ctx.userId) throw new DomainError("SELF_MODIFICATION_FORBIDDEN", "A quality-control record is reviewed by someone other than the person who recorded it", 403);
      if (input.actionRequired && r.result !== "FAIL") throw new DomainError("VALIDATION_FAILED", "Only a failed check can need action", 400);
      await tx.limsQcRecord.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { reviewedById: ctx.userId, reviewedAt: new Date(), reviewNote: input.note, actionRequired: input.actionRequired } });
      if (input.actionRequired && r.instrumentId) await tx.limsInstrument.updateMany({ where: { id: r.instrumentId, tenantId: ctx.tenantId, status: "ACTIVE" }, data: { status: "MAINTENANCE" } });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_QC_REVIEWED", entityType: "LimsQcRecord", entityId: id, metadata: { result: r.result, actionRequired: input.actionRequired } });
      return { id, reviewed: true, actionRequired: input.actionRequired };
    });
  }

  // ───── exceptions ─────

  async raiseException(ctx: RequestContext, input: z.infer<typeof exceptionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const req = await tx.limsRequest.findFirst({ where: { id: input.requestId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, department: { kind: { in: this.readable(ctx) } } }, select: { id: true, requestNumber: true, status: true } });
      if (!req) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!OPEN_STATUSES.includes(req.status)) throw new DomainError("INVALID_STATE", "Exceptions are only raised for work that is still open", 409);
      if (await tx.limsException.count({ where: { tenantId: ctx.tenantId, requestId: req.id, kind: input.kind, status: "PENDING" } }) > 0) throw new DomainError("CONFLICT", "This exception has already been raised and is waiting for the manager", 409);
      const row = await tx.limsException.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, requestId: req.id, kind: input.kind, reason: input.reason, raisedById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_EXCEPTION_RAISED", entityType: "LimsException", entityId: row.id, metadata: { requestNumber: req.requestNumber, kind: input.kind } });
      const managers = await this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, ["LIMS_MANAGE"]);
      await this.notifications.notify(tx, managers.filter((m) => m !== ctx.userId), { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "LIMS_EXCEPTION_RAISED", entityType: "LimsException", entityId: row.id, dedupeKey: `LIMS_EXCEPTION_RAISED:${row.id}` });
      return { id: row.id, status: "PENDING" as const };
    });
  }

  async exceptions(ctx: RequestContext, q: z.infer<typeof exceptionListSchema>) {
    const manager = ctx.permissions.has("LIMS_MANAGE");
    const rows = await this.prisma.limsException.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, request: { is: { department: { kind: { in: this.readable(ctx) } } } }, ...(q.status ? { status: q.status } : {}), ...(manager ? {} : { raisedById: ctx.userId }) },
      orderBy: [{ raisedAt: "desc" }, { id: "asc" }], take: 100,
      include: { request: { select: { id: true, requestNumber: true, status: true, priority: true, department: { select: { kind: true } }, testOrder: { select: { name: true } } } } },
    });
    const ids = [...new Set(rows.flatMap((r) => [r.raisedById, r.decidedById]).filter((x): x is string => !!x))];
    const names = new Map((ids.length ? await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id, kind: r.kind, reason: r.reason, status: r.status, raisedAt: r.raisedAt, raisedBy: names.get(r.raisedById) ?? null, decidedAt: r.decidedAt, decidedBy: r.decidedById ? names.get(r.decidedById) ?? null : null, decisionNote: r.decisionNote,
      request: { id: r.request.id, requestNumber: r.request.requestNumber, test: r.request.testOrder.name, status: r.request.status, priority: r.request.priority, department: r.request.department.kind },
    }));
  }

  /**
   * The LIMS manager decides an exception under the hospital's policy, never their own. Approving a queue jump makes the request urgent; approving a compromised sample records
   * that the sample was accepted by exception (the technician and the specialist see it).
   */
  async decideException(ctx: RequestContext, id: string, input: z.infer<typeof exceptionDecisionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ex = await tx.limsException.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, kind: true, status: true, raisedById: true, requestId: true } });
      if (!ex) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (ex.status !== "PENDING") throw new DomainError("INVALID_STATE", "This exception has already been decided", 409);
      if (ex.raisedById === ctx.userId) throw new DomainError("SELF_MODIFICATION_FORBIDDEN", "You cannot decide an exception you raised yourself", 403);
      await tx.limsException.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: input.decision, decidedById: ctx.userId, decidedAt: new Date(), decisionNote: input.note } });
      if (input.decision === "APPROVED") {
        const req = await tx.limsRequest.findFirstOrThrow({ where: { id: ex.requestId, tenantId: ctx.tenantId }, select: { id: true, priority: true, dueAt: true, version: true, status: true, department: { select: { urgentTatMinutes: true } } } });
        if (ex.kind === "COMPROMISED_SAMPLE") await tx.limsRequest.updateMany({ where: { id: req.id, tenantId: ctx.tenantId }, data: { compromisedSampleApproved: true, version: { increment: 1 } } });
        if (ex.kind === "QUEUE_JUMP" && req.priority === "ROUTINE" && OPEN_STATUSES.includes(req.status)) {
          const due = new Date(Math.min(req.dueAt.getTime(), addMinutes(new Date(), req.department.urgentTatMinutes).getTime()));
          await tx.limsRequest.updateMany({ where: { id: req.id, tenantId: ctx.tenantId }, data: { priority: "URGENT", dueAt: due, version: { increment: 1 } } });
        }
        await this.core.event(tx, ctx.tenantId, req.id, "EXCEPTION_APPROVED", ctx.userId, { note: `${ex.kind.toLowerCase().replace(/_/g, " ")}: ${input.note}` });
      }
      await this.audit.record(tx, actorOf(ctx), { action: input.decision === "APPROVED" ? "LIMS_EXCEPTION_APPROVED" : "LIMS_EXCEPTION_DENIED", entityType: "LimsException", entityId: id, metadata: { kind: ex.kind, note: input.note } });
      return { id, status: input.decision };
    });
  }
}
