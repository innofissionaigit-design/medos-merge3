import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { localDateStr } from "../../common/time";
import { fmt } from "../billing/billing.domain";
import { NotificationsService } from "../notifications/notifications.service";
import { isOpen, nextStatus, NURSING_ASSESSMENT_TITLE, suggestedDeposit, WAITING_FOR, type PlannedStatus, type PlannedStep } from "./planned.domain";

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Who may see which planned admissions: the same rule as admissions (a doctor sees their own, department staff their department's). */
export function plannedScope(ctx: RequestContext): Prisma.PlannedAdmissionWhereInput {
  const s = ctx.dataScope;
  if (s.kind === "ALL") return {};
  if (s.kind === "DOCTOR") return { consultantId: { in: [...s.practitionerIds] } };
  const d = [...s.departmentIds];
  return { consultant: { departmentId: { in: d } } };
}

/** The columns of a list row. */
const ROW = {
  id: true, requestNumber: true, status: true, source: true, diagnosis: true, plannedProcedure: true, proposedDate: true, expectedStayDays: true, createdAt: true, updatedAt: true, closeReason: true,
  patient: { select: { id: true, firstName: true, lastName: true, identifiers: { where: { type: "MRN" as const }, select: { value: true } } } },
  consultant: { select: { id: true, displayName: true } },
  ward: { select: { name: true } },
  bed: { select: { code: true } },
} satisfies Prisma.PlannedAdmissionSelect;
type RowShape = Prisma.PlannedAdmissionGetPayload<{ select: typeof ROW }>;
export const PLANNED_ROW = ROW;

export function toRow(r: RowShape) {
  return {
    id: r.id, requestNumber: r.requestNumber, status: r.status as PlannedStatus, waitingFor: WAITING_FOR[r.status as PlannedStatus], source: r.source,
    patient: { id: r.patient.id, name: nameOf(r.patient), mrn: r.patient.identifiers[0]?.value ?? null },
    consultant: { id: r.consultant.id, name: r.consultant.displayName },
    diagnosis: r.diagnosis, plannedProcedure: r.plannedProcedure, proposedDate: day(r.proposedDate), expectedStayDays: r.expectedStayDays, ward: r.ward?.name ?? null, bed: r.bed?.code ?? null,
    closeReason: r.closeReason, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

/**
 * The shared machinery of a planned admission (docs/planned-admission.md): locking, the allowed steps, the timeline, the notifications and the full view with what the caller may do next.
 * The three services that change a request (the request and desk steps, the money steps, the bed) all go through here, so the order of steps is kept in one place.
 */
@Injectable()
export class PlannedCore {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notifications: NotificationsService) {}

  async today(db: Db, ctx: RequestContext): Promise<string> {
    const f = await db.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    return localDateStr(new Date(), f.timezone);
  }

  /** Locks the request (this tenant, this facility, inside the caller's scope) and returns it, or "not found". */
  async lock(tx: Db, ctx: RequestContext, id: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PlannedAdmission" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    const plan = locked.length ? await tx.plannedAdmission.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [plannedScope(ctx)] }, include: { consultant: { select: { userId: true, displayName: true } } } }) : null;
    if (!plan) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return plan;
  }

  /** The consultant of the request must be the signed-in doctor. */
  assertConsultant(ctx: RequestContext, plan: { consultant: { userId: string | null } }): void {
    if (!plan.consultant.userId || plan.consultant.userId !== ctx.userId) throw new DomainError("FORBIDDEN", "This request is for another doctor", 403);
  }

  /** Moves the request one step. The step must be allowed from where it stands; the change, its timeline entry, its audit event and the people told all commit together. */
  async move(
    tx: Db, ctx: RequestContext, plan: { id: string; status: string; requestNumber: string; consultant: { userId: string | null } },
    step: PlannedStep, to: PlannedStatus | undefined, data: Prisma.PlannedAdmissionUncheckedUpdateManyInput, action: string, note?: string | null, meta: Prisma.InputJsonObject = {},
  ): Promise<PlannedStatus> {
    const from = plan.status as PlannedStatus;
    const next = nextStatus(from, step, to);
    if (!next) throw new DomainError("INVALID_STATE", `This step is not possible while the request is "${WAITING_FOR[from].toLowerCase()}"`, 409);
    const res = await tx.plannedAdmission.updateMany({ where: { id: plan.id, tenantId: ctx.tenantId, status: from }, data: { ...data, status: next, version: { increment: 1 } } });
    if (res.count !== 1) throw new DomainError("INVALID_STATE", "The request was changed by someone else", 409);
    const ev = await tx.plannedAdmissionEvent.create({ data: { tenantId: ctx.tenantId, plannedId: plan.id, fromStatus: from, toStatus: next, action, note: note ?? null, actorId: ctx.userId }, select: { id: true } });
    await this.audit.record(tx, actorOf(ctx), { action: `PLANNED_ADMISSION_${action}`, entityType: "PlannedAdmission", entityId: plan.id, metadata: { requestNumber: plan.requestNumber, from, to: next, ...meta } });
    await this.tell(tx, ctx, plan, next, ev.id);
    return next;
  }

  /** A change that does not move the request (a new estimate, a rescheduled day, a changed bed): the timeline entry and the audit event. */
  async record(tx: Db, ctx: RequestContext, plan: { id: string; status: string; requestNumber: string }, action: string, note?: string | null, meta: Prisma.InputJsonObject = {}): Promise<void> {
    const s = plan.status as PlannedStatus;
    await tx.plannedAdmissionEvent.create({ data: { tenantId: ctx.tenantId, plannedId: plan.id, fromStatus: s, toStatus: s, action, note: note ?? null, actorId: ctx.userId } });
    await this.audit.record(tx, actorOf(ctx), { action: `PLANNED_ADMISSION_${action}`, entityType: "PlannedAdmission", entityId: plan.id, metadata: { requestNumber: plan.requestNumber, status: s, ...meta } });
  }

  /** Tells the people whose turn it now is (never the person who just acted). */
  async tell(tx: Db, ctx: RequestContext, plan: { id: string; consultant: { userId: string | null } }, status: PlannedStatus, eventId: string): Promise<void> {
    const to = async (perms: Parameters<NotificationsService["recipientsWith"]>[3]) => this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, perms);
    let users: string[] = [];
    let type: "PLANNED_ADMISSION_ADVISED" | "PLANNED_ADMISSION_REQUEST" | "PLANNED_ADMISSION_DECIDED" | "PLANNED_ADMISSION_STEP" = "PLANNED_ADMISSION_STEP";
    switch (status) {
      case "ADVISED": users = await to(["PLANNED_REQUEST"]); type = "PLANNED_ADMISSION_ADVISED"; break;
      case "DOCTOR_REVIEW": users = plan.consultant.userId ? [plan.consultant.userId] : []; type = "PLANNED_ADMISSION_REQUEST"; break;
      case "AWAITING_PATIENT": case "CLOSED": users = await to(["PLANNED_REQUEST"]); type = "PLANNED_ADMISSION_DECIDED"; break;
      case "DESK_REVIEW": case "READY": users = await to(["PLANNED_DESK"]); break;
      case "TARIFF_PAYER": users = [...(await to(["PLANNED_BILLING"])), ...(await to(["PLANNED_INSURANCE"]))]; break;
      case "PREAUTH": users = await to(["PLANNED_INSURANCE"]); break;
      case "DEPOSIT": users = await to(["PLANNED_BILLING"]); break;
      case "BED_ALLOCATION": users = await to(["PLANNED_BED"]); break;
      case "ADMITTED": users = await to(["NURSING_DOCUMENT"]); break;
      default: break;
    }
    users = users.filter((u) => u !== ctx.userId);
    if (users.length > 0) await this.notifications.notify(tx, users, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type, entityType: "PlannedAdmission", entityId: plan.id, dedupeKey: `PLANNED:${eventId}` });
  }

  // ───── reads ─────

  /** What a deposit holds for this request: money taken for it, less what was given back. */
  async depositHeld(db: Db, ctx: RequestContext, plannedId: string): Promise<Decimal> {
    const rows = await db.advanceDeposit.findMany({ where: { tenantId: ctx.tenantId, plannedAdmissionId: plannedId }, select: { amount: true, refunds: { select: { amount: true } } } });
    return rows.reduce((a, d) => a.plus(d.amount.toString()).minus(d.refunds.reduce((x, r) => x.plus(r.amount.toString()), new Decimal(0))), new Decimal(0));
  }

  async view(db: Db, ctx: RequestContext, id: string) {
    const p = await db.plannedAdmission.findFirst({
      where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [plannedScope(ctx)] },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, gender: true, mobile: true, dateOfBirth: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } },
        consultant: { select: { id: true, displayName: true, userId: true, department: { select: { name: true } } } },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, code: true, dailyRate: true, ward: { select: { name: true } }, room: { select: { name: true } } } },
        claim: { select: { id: true, claimNumber: true, status: true, preauthRequested: true, preauthApproved: true, closeReason: true } },
        estimateLines: { orderBy: { lineNo: "asc" } },
        events: { orderBy: { createdAt: "asc" } },
        deposits: { orderBy: { receivedAt: "asc" }, select: { id: true, receiptNumber: true, amount: true, receivedAt: true, refunds: { select: { amount: true } } } },
        admission: { select: { id: true, admissionNumber: true, admittedAt: true, status: true } },
      },
    });
    if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const status = p.status as PlannedStatus;
    const userIds = [...new Set([...p.events.map((e) => e.actorId), ...(p.consentById ? [p.consentById] : [])])];
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: userIds } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const policy = p.policyId ? await db.patientPolicy.findFirst({ where: { id: p.policyId, tenantId: ctx.tenantId }, select: { id: true, policyNumber: true, validTo: true, insurer: { select: { name: true } } } }) : null;
    const task = p.admissionId ? await db.nursingTask.findFirst({ where: { tenantId: ctx.tenantId, admissionId: p.admissionId, title: NURSING_ASSESSMENT_TITLE }, select: { id: true, status: true, completedAt: true, closeNote: true } }) : null;

    const lines = p.estimateLines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), unitPrice: fmt(l.unitPrice), amount: fmt(new Decimal(l.quantity.toString()).times(l.unitPrice.toString()).toDecimalPlaces(2)) }));
    const held = p.deposits.reduce((a, d) => a.plus(d.amount.toString()).minus(d.refunds.reduce((x, r) => x.plus(r.amount.toString()), new Decimal(0))), new Decimal(0));
    // A suggested bed line for the estimate: the days of stay times the average daily rate of the beds in the ward asked for.
    let bedLine: { description: string; quantity: string; unitPrice: string } | null = null;
    if (p.wardId && p.expectedStayDays) {
      const beds = await db.bed.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, wardId: p.wardId, active: "ACTIVE" }, select: { dailyRate: true }, take: 200 });
      if (beds.length > 0) {
        const avg = beds.reduce((a, b) => a.plus(b.dailyRate.toString()), new Decimal(0)).div(beds.length).toDecimalPlaces(2);
        bedLine = { description: `Bed in ${p.ward?.name ?? "the ward"} (${p.expectedStayDays} days)`, quantity: String(p.expectedStayDays), unitPrice: fmt(avg) };
      }
    }
    const approved = p.claim?.preauthApproved ? new Decimal(p.claim.preauthApproved.toString()) : null;

    return {
      id: p.id, requestNumber: p.requestNumber, status, waitingFor: WAITING_FOR[status], source: p.source, version: p.version,
      patient: { id: p.patient.id, name: nameOf(p.patient), mrn: p.patient.identifiers[0]?.value ?? null, gender: p.patient.gender, mobile: p.patient.mobile, dateOfBirth: day(p.patient.dateOfBirth) },
      consultant: { id: p.consultant.id, name: p.consultant.displayName, department: p.consultant.department?.name ?? null },
      details: p.details, askMode: p.askMode, askNote: p.askNote,
      diagnosis: p.diagnosis, plannedProcedure: p.plannedProcedure, proposedDate: day(p.proposedDate), expectedStayDays: p.expectedStayDays, ward: p.ward, roomNote: p.roomNote,
      deskVerifiedAt: p.deskVerifiedAt,
      consent: p.consentAt ? { at: p.consentAt, note: p.consentNote, by: p.consentById ? users.get(p.consentById) ?? null : null } : null,
      payer: p.payer, preauthRequired: p.preauthRequired, eligibilityNote: p.eligibilityNote,
      policy: policy ? { id: policy.id, policyNumber: policy.policyNumber, validTo: day(policy.validTo), insurer: policy.insurer.name } : null,
      claim: p.claim ? { id: p.claim.id, claimNumber: p.claim.claimNumber, status: p.claim.status, preauthRequested: p.claim.preauthRequested ? fmt(p.claim.preauthRequested) : null, preauthApproved: p.claim.preauthApproved ? fmt(p.claim.preauthApproved) : null, closeReason: p.claim.closeReason } : null,
      estimate: { total: fmt(p.estimateTotal), lines, suggestedBedLine: bedLine },
      deposit: {
        required: p.requiredDeposit === null ? null : fmt(p.requiredDeposit), held: fmt(held), basis: p.financialBasis, note: p.financialNote, clearedAt: p.financialClearedAt,
        suggested: fmt(suggestedDeposit(new Decimal(p.estimateTotal.toString()), approved)),
        items: p.deposits.map((d) => ({ id: d.id, receiptNumber: d.receiptNumber, amount: fmt(d.amount), receivedAt: d.receivedAt })),
      },
      bed: p.bed ? { id: p.bed.id, code: p.bed.code, ward: p.bed.ward.name, room: p.bed.room.name, dailyRate: fmt(p.bed.dailyRate), allocatedAt: p.bedAllocatedAt } : null,
      admission: p.admission ? { id: p.admission.id, admissionNumber: p.admission.admissionNumber, admittedAt: p.admission.admittedAt, status: p.admission.status } : null,
      nursingAssessment: task ? { status: task.status, completedAt: task.completedAt, note: task.closeNote } : null,
      close: p.closeReason ? { reason: p.closeReason, note: p.closeNote, at: p.closedAt } : null,
      events: p.events.map((e) => ({ at: e.createdAt, action: e.action, from: e.fromStatus, to: e.toStatus, note: e.note, by: users.get(e.actorId) ?? null })),
      can: this.can(ctx, status, { consultantUserId: p.consultant.userId, estimateTotal: new Decimal(p.estimateTotal.toString()), payer: p.payer, claimStatus: p.claim?.status ?? null, hasBed: !!p.bedId }),
      createdAt: p.createdAt, updatedAt: p.updatedAt,
    };
  }

  /** What the caller may do next, worked out the same way the services check it (the screen only shows what the server would accept). */
  can(ctx: RequestContext, status: PlannedStatus, f: { consultantUserId: string | null; estimateTotal: Decimal; payer: string | null; claimStatus: string | null; hasBed: boolean }) {
    const has = (p: Parameters<RequestContext["permissions"]["has"]>[0]) => ctx.permissions.has(p);
    const open = isOpen(status);
    const mine = !!f.consultantUserId && f.consultantUserId === ctx.userId;
    const doctor = has("PLANNED_DOCTOR") && mine;
    return {
      consent: status === "ADVISED" && has("PLANNED_REQUEST"),
      ask: status === "DOCTOR_REVIEW" && doctor,
      accept: status === "DOCTOR_REVIEW" && doctor,
      patientReady: status === "AWAITING_PATIENT" && (has("PLANNED_REQUEST") || has("PLANNED_DESK")),
      verify: status === "DESK_REVIEW" && has("PLANNED_DESK"),
      reschedule: ["DESK_REVIEW", "TARIFF_PAYER", "PREAUTH", "DEPOSIT", "BED_ALLOCATION", "READY"].includes(status) && has("PLANNED_DESK"),
      estimate: ["TARIFF_PAYER", "PREAUTH", "DEPOSIT"].includes(status) && has("PLANNED_BILLING"),
      payerSelf: ["TARIFF_PAYER", "PREAUTH"].includes(status) && (has("PLANNED_BILLING") || has("PLANNED_INSURANCE")),
      payerInsured: status === "TARIFF_PAYER" && has("PLANNED_INSURANCE"),
      tariffDone: status === "TARIFF_PAYER" && (has("PLANNED_BILLING") || has("PLANNED_INSURANCE")) && f.estimateTotal.gt(0) && f.payer !== null,
      preauth: status === "PREAUTH" && has("PLANNED_INSURANCE"),
      depositRequired: status === "DEPOSIT" && has("PLANNED_BILLING"),
      takeDeposit: status === "DEPOSIT" && has("PLANNED_BILLING") && has("PAYMENT_CREATE"),
      waive: status === "DEPOSIT" && has("PLANNED_APPROVE"),
      bed: (status === "BED_ALLOCATION" || status === "READY") && has("PLANNED_BED"),
      admit: status === "READY" && has("PLANNED_DESK") && has("ADMISSION_CREATE"),
      noShow: status === "READY" && has("PLANNED_DESK"),
      cancel: open && (has("PLANNED_DESK") || has("PLANNED_REQUEST") || (doctor && ["ADVISED", "DOCTOR_REVIEW", "AWAITING_PATIENT"].includes(status))),
    };
  }

  async list(ctx: RequestContext, q: { status?: PlannedStatus | "OPEN" | undefined; q?: string | undefined; consultantId?: string | undefined; page: number; pageSize: number }) {
    const where: Prisma.PlannedAdmissionWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [plannedScope(ctx)],
      ...(q.status === "OPEN" ? { status: { notIn: ["ADMITTED", "CLOSED"] } } : q.status ? { status: q.status } : {}),
      ...(q.consultantId ? { consultantId: q.consultantId } : {}),
      ...(q.q ? { OR: [{ requestNumber: { contains: q.q, mode: "insensitive" } }, { patient: { searchName: { contains: q.q.toLowerCase() } } }, { patient: { identifiers: { some: { value: { contains: q.q, mode: "insensitive" } } } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.plannedAdmission.findMany({ where, select: ROW, orderBy: [{ updatedAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.plannedAdmission.count({ where }),
    ]);
    return { items: rows.map(toRow), total };
  }

  /** How many requests are in each status, for the tabs of the queue. */
  async summary(ctx: RequestContext) {
    const rows = await this.prisma.plannedAdmission.groupBy({ by: ["status"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [plannedScope(ctx)] }, _count: { _all: true } });
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = r._count._all;
    const open = Object.entries(counts).filter(([s]) => s !== "ADMITTED" && s !== "CLOSED").reduce((a, [, n]) => a + n, 0);
    return { open, counts };
  }
}
