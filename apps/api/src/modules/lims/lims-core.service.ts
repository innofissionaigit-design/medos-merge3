import { Injectable } from "@nestjs/common";
import { DomainError, type Permission } from "@medos/shared";
import type { NotificationType, Prisma } from "@medos/database";
import { actorOf, AuditService } from "../../common/audit.service";
import type { Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { NotificationsService } from "../notifications/notifications.service";
import { DEPARTMENT_PERMISSIONS, canMove, type DepartmentKind, type LimsEventKind, type LimsStatus } from "./lims.domain";

/** Test orders the laboratory or radiology may work on: billed ones (as before) and ones the LIMS has taken in, whether or not they have been billed yet (docs/lims-portal.md). */
export const IN_LAB_ORDER: Prisma.TestOrderWhereInput = { OR: [{ status: "BILLED" }, { status: "ORDERED", limsRequest: { is: { status: { not: "CANCELLED" } } } }] };

/** A test whose report may be shown to the doctor and the patient: it is not managed by the LIMS, or the technician has issued it. */
export const RELEASED_ORDER: Prisma.TestOrderWhereInput = { OR: [{ limsRequest: { is: null } }, { limsRequest: { is: { status: { in: ["ISSUED", "HANDED_OVER"] } } } }] };

export interface RequestRow {
  id: string; tenantId: string; facilityId: string; patientId: string; encounterId: string; testOrderId: string; departmentId: string;
  requestNumber: string; status: LimsStatus; version: number; priority: "EMERGENCY" | "URGENT" | "ROUTINE"; origin: "OPD" | "IPD";
  assignedNurseId: string | null; assignedTechId: string | null; batchId: string; dueAt: Date; recollectCount: number; returnedCount: number; arrivedAt: Date | null;
  department: { kind: DepartmentKind };
}
const ROW = {
  id: true, tenantId: true, facilityId: true, patientId: true, encounterId: true, testOrderId: true, departmentId: true, requestNumber: true, status: true, version: true, priority: true,
  origin: true, assignedNurseId: true, assignedTechId: true, batchId: true, dueAt: true, recollectCount: true, returnedCount: true, arrivedAt: true, department: { select: { kind: true } },
} satisfies Prisma.LimsRequestSelect;

type Patch = Omit<Prisma.LimsRequestUncheckedUpdateManyInput, "status" | "version" | "id" | "tenantId">;

/**
 * What the laboratory and radiology services tell the LIMS while they do their own work, inside their own transaction (docs/lims-portal.md). A test that has no LIMS request
 * (an older, billed one) is not touched: every method does nothing for it, so the earlier laboratory and radiology behaviour is unchanged.
 */
@Injectable()
export class LimsCoreService {
  constructor(private readonly audit: AuditService, private readonly notifications: NotificationsService) {}

  async find(db: Db, tenantId: string, testOrderId: string): Promise<RequestRow | null> {
    return (await db.limsRequest.findFirst({ where: { tenantId, testOrderId }, select: ROW })) as RequestRow | null;
  }

  async byId(db: Db, ctx: RequestContext, id: string): Promise<RequestRow> {
    const r = (await db.limsRequest.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: ROW })) as RequestRow | null;
    if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return r;
  }

  async event(db: Db, tenantId: string, requestId: string, kind: LimsEventKind, actorUserId: string | null, o: { from?: LimsStatus; to?: LimsStatus; note?: string | undefined } = {}): Promise<void> {
    await db.limsRequestEvent.create({ data: { tenantId, requestId, kind, fromStatus: o.from ?? null, toStatus: o.to ?? null, actorUserId, note: o.note ?? null } });
  }

  /** Moves a request one step, checked against the state rules and against someone else moving it at the same moment. Writes the history entry. */
  async transition(db: Db, ctx: RequestContext, req: Pick<RequestRow, "id" | "status" | "version">, to: LimsStatus, kind: LimsEventKind, patch: Patch = {}, note?: string): Promise<void> {
    if (!canMove(req.status, to)) throw new DomainError("INVALID_STATE", `This request cannot move from ${req.status.toLowerCase().replace(/_/g, " ")} to ${to.toLowerCase().replace(/_/g, " ")}`, 409);
    const res = await db.limsRequest.updateMany({ where: { id: req.id, tenantId: ctx.tenantId, status: req.status, version: req.version }, data: { ...patch, status: to, version: { increment: 1 } } });
    if (res.count !== 1) throw new DomainError("STALE_VERSION", "This request was changed by someone else. Reload it first", 409);
    await this.event(db, ctx.tenantId, req.id, kind, ctx.userId, { from: req.status, to, note });
  }

  // ───── who to tell ─────

  private async usersWith(db: Db, ctx: { tenantId: string; facilityId: string }, p: Permission): Promise<string[]> {
    return this.notifications.recipientsWith(db, ctx.tenantId, ctx.facilityId, [p]);
  }

  /** The technicians of a department: people who do that department's hands-on work and may issue reports. */
  async techsOf(db: Db, ctx: { tenantId: string; facilityId: string }, kind: DepartmentKind): Promise<string[]> {
    const [work, issue] = await Promise.all([this.usersWith(db, ctx, DEPARTMENT_PERMISSIONS[kind].work), this.usersWith(db, ctx, "LIMS_ISSUE")]);
    const issuers = new Set(issue);
    return work.filter((u) => issuers.has(u));
  }

  /** The specialists of a department: the pathologists or radiologists who pass reports. */
  specialistsOf(db: Db, ctx: { tenantId: string; facilityId: string }, kind: DepartmentKind): Promise<string[]> {
    return this.usersWith(db, ctx, DEPARTMENT_PERMISSIONS[kind].review);
  }

  async notify(db: Db, ctx: { tenantId: string; facilityId: string }, to: readonly string[], type: NotificationType, req: { id: string }, tag = ""): Promise<void> {
    await this.notifications.notify(db, to, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type, entityType: "LimsRequest", entityId: req.id, dedupeKey: `${type}:${req.id}:${tag}` });
  }

  /** People to ask to take a sample: the assigned nurse, else every nurse who takes samples. */
  async collectors(db: Db, ctx: { tenantId: string; facilityId: string }, req: { assignedNurseId: string | null }): Promise<string[]> {
    return req.assignedNurseId ? [req.assignedNurseId] : this.usersWith(db, ctx, "LIMS_COLLECT");
  }

  // ───── what the laboratory and radiology tell us ─────

  /** The sample was taken (laboratory), or the patient was made ready (radiology): the request goes to the technician. */
  async afterSampleCollected(db: Db, ctx: RequestContext, testOrderId: string): Promise<void> {
    const req = await this.find(db, ctx.tenantId, testOrderId);
    if (!req) return;
    if (req.status !== "PENDING_COLLECTION") throw new DomainError("INVALID_STATE", "This request is not waiting for a sample", 409);
    // An outpatient is attended only after reporting at reception, where the bill is settled. (An admitted patient is already in the hospital.)
    if (req.origin === "OPD" && !req.arrivedAt) throw new DomainError("PATIENT_NOT_ARRIVED", "The patient has not reported at reception yet", 409);
    await this.transition(db, ctx, req, "COLLECTED", "COLLECTED", { collectedAt: new Date(), collectedById: ctx.userId, needsRecollection: false });
    await this.audit.record(db, actorOf(ctx), { action: "LIMS_SAMPLE_COLLECTED", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, department: req.department.kind } });
    const to = req.assignedTechId ? [req.assignedTechId] : await this.techsOf(db, ctx, req.department.kind);
    await this.notify(db, ctx, to, "LIMS_SAMPLE_READY", req, String(req.recollectCount));
  }

  /** A sample was rejected: the request goes back to the nurse to take another. */
  async afterSampleRejected(db: Db, ctx: RequestContext, testOrderId: string, reason: string): Promise<void> {
    const req = await this.find(db, ctx.tenantId, testOrderId);
    if (!req) return;
    if (req.status !== "COLLECTED" && req.status !== "IN_PROCESS") throw new DomainError("INVALID_STATE", "This request has no sample that can be rejected", 409);
    await this.transition(db, ctx, req, "PENDING_COLLECTION", "SAMPLE_REJECTED", { recollectCount: { increment: 1 }, needsRecollection: true, collectedAt: null, collectedById: null, acceptedAt: null, acceptedById: null }, reason);
    await this.audit.record(db, actorOf(ctx), { action: "LIMS_SAMPLE_REJECTED", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, department: req.department.kind, reason } });
    await this.notify(db, ctx, await this.collectors(db, ctx, req), "LIMS_COLLECTION_WAITING", req, `recollect${req.recollectCount + 1}`);
  }

  /** The technician took the sample in hand (laboratory accept) or performed the scan (radiology). */
  async afterAccepted(db: Db, ctx: RequestContext, req: RequestRow, kind: "ACCEPTED" | "PERFORMED"): Promise<void> {
    if (req.status !== "COLLECTED") throw new DomainError("INVALID_STATE", req.department.kind === "RADIOLOGY" ? "The patient has not been made ready for the scan yet" : "The sample has not been collected yet", 409);
    await this.transition(db, ctx, req, "IN_PROCESS", kind, { acceptedAt: new Date(), acceptedById: ctx.userId, assignedTechId: req.assignedTechId ?? ctx.userId });
    await this.audit.record(db, actorOf(ctx), { action: kind === "PERFORMED" ? "LIMS_SCAN_PERFORMED" : "LIMS_SAMPLE_ACCEPTED", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber } });
  }

  /** Radiology: the scan was performed through the radiology screen. */
  async afterPerformed(db: Db, ctx: RequestContext, testOrderId: string): Promise<void> {
    const req = await this.find(db, ctx.tenantId, testOrderId);
    if (req) await this.afterAccepted(db, ctx, req, "PERFORMED");
  }

  /** Results may only be typed in once the technician has accepted the sample. */
  async assertCanEnterResult(db: Db, ctx: RequestContext, testOrderId: string): Promise<void> {
    const req = await this.find(db, ctx.tenantId, testOrderId);
    if (req && req.status !== "IN_PROCESS") throw new DomainError("INVALID_STATE", req.status === "COLLECTED" ? "Accept the sample first" : "Results can only be changed while the technician is working on the test", 409);
  }

  /** A report is passed (verified or signed) only after the technician has sent it for review. */
  async assertCanReview(db: Db, ctx: RequestContext, testOrderId: string): Promise<void> {
    const req = await this.find(db, ctx.tenantId, testOrderId);
    if (req && req.status !== "PENDING_REVIEW") throw new DomainError("INVALID_STATE", "The technician has not sent this test for review yet", 409);
  }

  /** The pathologist passed the report, or the radiologist signed it: it waits for the technician to issue. Returns true when the LIMS manages this test. */
  async afterReviewed(db: Db, ctx: RequestContext, testOrderId: string): Promise<boolean> {
    const req = await this.find(db, ctx.tenantId, testOrderId);
    if (!req) return false;
    await this.transition(db, ctx, req, "PASSED", "PASSED", { passedAt: new Date(), passedById: ctx.userId });
    await this.audit.record(db, actorOf(ctx), { action: "LIMS_REPORT_PASSED", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, department: req.department.kind } });
    const to = req.assignedTechId ? [req.assignedTechId] : await this.techsOf(db, ctx, req.department.kind);
    await this.notify(db, ctx, to, "LIMS_READY_TO_ISSUE", req);
    return true;
  }

  /** Whether a request exists for this test (so the caller can leave out steps that belong to the issue step). */
  async managed(db: Db, tenantId: string, testOrderId: string): Promise<boolean> {
    return (await db.limsRequest.count({ where: { tenantId, testOrderId } })) > 0;
  }

  /** A report was amended after the technician issued it: the doctor is told again and the history says so. */
  async afterAmended(db: Db, ctx: RequestContext, testOrderId: string, version: number): Promise<void> {
    const req = await this.find(db, ctx.tenantId, testOrderId);
    if (!req || (req.status !== "ISSUED" && req.status !== "HANDED_OVER")) return;
    await this.event(db, ctx.tenantId, req.id, "AMENDED_AFTER_ISSUE", ctx.userId, { note: `version ${version}` });
    const doctor = await this.notifications.doctorOfEncounter(db, ctx.tenantId, req.encounterId);
    if (doctor) await this.notify(db, ctx, [doctor], "LIMS_REPORT_ISSUED", req, `v${version}`);
  }
}
