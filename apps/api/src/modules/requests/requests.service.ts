import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { visitScope } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { NotificationsService } from "../notifications/notifications.service";
import { LimsService, testItem } from "../lims/lims.service";
import { LIMS_PRIORITIES } from "../lims/lims.domain";
import { orderItemSchema, PrescriptionsService, type OrderItemInput } from "../prescriptions/prescriptions.service";
import { SettingsService } from "../settings/settings.service";

const uuid = z.string().uuid();
const note = z.string().trim().min(3).max(300);

/** What the nurse asks for: tests (from the test list, or typed), or one medicine line exactly as the doctor's order would carry it. */
export const createRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("TEST"), encounterId: uuid, tests: z.array(testItem).min(1).max(10), priority: z.enum(LIMS_PRIORITIES).optional(), note: note.optional() }).strict(),
  z.object({ kind: z.literal("MEDICINE"), encounterId: uuid, item: orderItemSchema, note: note.optional() }).strict(),
]);
export const listRequestsSchema = z.object({ encounterId: uuid, status: z.enum(["PENDING", "ACCEPTED", "DECLINED", "CANCELLED"]).optional() }).strict();
export const decideRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ACCEPT"), note: note.optional() }).strict(),
  z.object({ action: z.literal("DECLINE"), note }).strict(),
]);

const VIEW = { id: true, kind: true, status: true, summary: true, note: true, requestedById: true, requestedAt: true, decidedById: true, decidedAt: true, decisionNote: true, encounterId: true } satisfies Prisma.OrderRequestSelect;

type VisitInfo = { patientId: string; area: "ER" | "ICU"; caseId: string | null; admissionId: string | null; doctorUserId: string | null };

/**
 * Nurse requests (docs/emergency.md, docs/icu.md). An emergency or ICU nurse asks for a test or a medicine for a patient in their ward; the doctor in charge of the visit accepts it
 * (a test is then ordered in the doctor's name; a medicine goes on the doctor's draft prescription, which the doctor still reviews and signs) or declines it with a reason.
 * A request never reaches the laboratory or the pharmacy until the doctor accepts it.
 */
@Injectable()
export class RequestsService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notifications: NotificationsService, private readonly lims: LimsService,
    private readonly prescriptions: PrescriptionsService, private readonly settings: SettingsService,
  ) {}

  /** The patient in the emergency ward or the ICU that the visit belongs to, or "not found". */
  private async visit(tx: Db, ctx: RequestContext, encounterId: string, area: "ER" | "ICU" | "ANY"): Promise<VisitInfo> {
    const enc = await tx.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { patientId: true, practitioner: { select: { userId: true } } } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const doctorUserId = enc.practitioner?.userId ?? null;
    if (area !== "ICU") {
      const c = await tx.emergencyCase.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, status: { in: ["ARRIVED", "TRIAGED", "IN_TREATMENT"] } }, select: { id: true } });
      if (c) return { patientId: enc.patientId, area: "ER", caseId: c.id, admissionId: null, doctorUserId };
    }
    if (area !== "ER") {
      const icuCode = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "EMERGENCY_ICU_WARD_CODE");
      const a = await tx.admission.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, status: "ADMITTED", assignments: { some: { releasedAt: null, bed: { ward: { code: icuCode } } } } }, select: { id: true } });
      if (a) return { patientId: enc.patientId, area: "ICU", caseId: null, admissionId: a.id, doctorUserId };
    }
    throw new DomainError("NOT_FOUND", "Resource not found", 404);
  }

  private summaryOf(input: z.infer<typeof createRequestSchema>, names: Map<string, string>): string {
    if (input.kind === "TEST") {
      const list = input.tests.map((t) => (t.serviceId ? names.get(t.serviceId) ?? "Test" : (t.name as string))).join(", ");
      return `${list}${input.priority && input.priority !== "ROUTINE" ? ` (${input.priority.toLowerCase()})` : ""}`.slice(0, 300);
    }
    const i = input.item;
    return `${i.genericName}${i.strength ? ` ${i.strength}` : ""}: ${i.dosage}, ${i.route.toLowerCase()}, ${i.frequency}${i.durationDays ? ` for ${i.durationDays} days` : ""}`.slice(0, 300);
  }

  /** A nurse raises a request. The emergency nurse may ask only for patients in the emergency ward, the ICU nurse only for patients in the ICU. */
  async create(ctx: RequestContext, input: z.infer<typeof createRequestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const area = ctx.permissions.has("ER_TRIAGE") && ctx.permissions.has("ICU_NURSE") ? "ANY" : ctx.permissions.has("ICU_NURSE") ? "ICU" : "ER";
      const v = await this.visit(tx, ctx, input.encounterId, area);
      let names = new Map<string, string>();
      if (input.kind === "TEST") {
        const ids = input.tests.flatMap((t) => (t.serviceId ? [t.serviceId] : []));
        const found = await tx.service.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", id: { in: ids } }, select: { id: true, name: true } });
        if (found.length !== new Set(ids).size) throw new DomainError("VALIDATION_FAILED", "A selected test does not exist or is inactive", 400, [{ path: "tests", message: "Unknown or inactive test" }]);
        names = new Map(found.map((s) => [s.id, s.name]));
      }
      const payload = (input.kind === "TEST" ? { tests: input.tests, ...(input.priority ? { priority: input.priority } : {}) } : { item: input.item }) as unknown as Prisma.InputJsonValue;
      const row = await tx.orderRequest.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: input.encounterId, patientId: v.patientId, kind: input.kind, summary: this.summaryOf(input, names), payload, note: input.note ?? null, requestedById: ctx.userId },
        select: { id: true },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "ORDER_REQUESTED", entityType: "OrderRequest", entityId: row.id, metadata: { kind: input.kind, area: v.area, encounterId: input.encounterId } });
      if (v.doctorUserId) {
        await this.notifications.notify(tx, [v.doctorUserId], { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "ORDER_REQUESTED", entityType: v.area === "ER" ? "EmergencyCase" : "Admission", entityId: (v.area === "ER" ? v.caseId : v.admissionId) as string, dedupeKey: `ORDER_REQUESTED:${row.id}` });
      }
      return this.view(tx, ctx, row.id);
    });
  }

  private async view(db: Db, ctx: RequestContext, id: string) {
    const r = await db.orderRequest.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: VIEW });
    return (await this.shape(db, ctx, [r]))[0] as Awaited<ReturnType<RequestsService["shape"]>>[number];
  }

  private async shape(db: Db, ctx: RequestContext, rows: Prisma.OrderRequestGetPayload<{ select: typeof VIEW }>[]) {
    const people = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, ...(r.decidedById ? [r.decidedById] : [])]))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id, kind: r.kind, status: r.status, summary: r.summary, note: r.note, encounterId: r.encounterId, requestedAt: r.requestedAt, requestedBy: people.get(r.requestedById) ?? null, mine: r.requestedById === ctx.userId,
      decidedAt: r.decidedAt, decidedBy: r.decidedById ? people.get(r.decidedById) ?? null : null, decisionNote: r.decisionNote,
    }));
  }

  /** The requests of one visit, newest first, for the nurse who asked and the doctor in charge. */
  async list(ctx: RequestContext, q: z.infer<typeof listRequestsSchema>) {
    const rows = await this.prisma.orderRequest.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: q.encounterId, ...(q.status ? { status: q.status } : {}), encounter: { is: { ...visitScope(ctx) } } },
      select: VIEW, orderBy: { requestedAt: "desc" }, take: 100,
    });
    return this.shape(this.prisma, ctx, rows);
  }

  /** The nurse withdraws a request nobody has decided yet. */
  async cancel(ctx: RequestContext, requestId: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, ctx, requestId);
      if (r.requestedById !== ctx.userId) throw new DomainError("FORBIDDEN", "Only the person who made the request can withdraw it", 403);
      await tx.orderRequest.updateMany({ where: { id: requestId, tenantId: ctx.tenantId, status: "PENDING" }, data: { status: "CANCELLED", decidedById: ctx.userId, decidedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "ORDER_REQUEST_CANCELLED", entityType: "OrderRequest", entityId: requestId, metadata: { kind: r.kind } });
      return this.view(tx, ctx, requestId);
    });
  }

  /** The doctor in charge of the visit accepts or declines. Accepting does the work in the same transaction: either the request is accepted and the order exists, or nothing changed. */
  async decide(ctx: RequestContext, requestId: string, input: z.infer<typeof decideRequestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, ctx, requestId);
      const v = await this.visit(tx, ctx, r.encounterId, "ANY");
      if (v.doctorUserId !== ctx.userId) throw new DomainError("FORBIDDEN", "This patient is under another doctor", 403);
      if (!ctx.permissions.has(v.area === "ER" ? "ER_TREAT" : "ICU_DOCTOR")) throw new DomainError("FORBIDDEN", "You may not decide this request", 403);
      let outcome: Record<string, unknown> = {};
      if (input.action === "ACCEPT") {
        if (r.kind === "TEST") {
          const p = r.payload as unknown as { tests: z.infer<typeof testItem>[]; priority?: (typeof LIMS_PRIORITIES)[number] };
          const done = await this.lims.order(ctx, { encounterId: r.encounterId, tests: p.tests, ...(p.priority ? { priority: p.priority } : {}), ...(r.note ? { clinicalNote: r.note } : {}) }, tx);
          outcome = { tests: done.tests.length };
        } else {
          const p = r.payload as unknown as { item: OrderItemInput };
          const draft = await tx.medicationOrder.findFirst({ where: { tenantId: ctx.tenantId, encounterId: r.encounterId, status: "DRAFT", source: "DIGITAL" }, select: { items: { orderBy: { lineNo: "asc" }, select: { medicineId: true, genericName: true, brandName: true, strength: true, dosage: true, route: true, frequency: true, frequencyText: true, foodRelation: true, durationDays: true, quantity: true, instructions: true } } } });
          const keep: OrderItemInput[] = (draft?.items ?? []).map((i) => ({
            ...(i.medicineId ? { medicineId: i.medicineId } : {}), genericName: i.genericName, ...(i.brandName ? { brandName: i.brandName } : {}), ...(i.strength ? { strength: i.strength } : {}), dosage: i.dosage, route: i.route, frequency: i.frequency,
            ...(i.frequencyText ? { frequencyText: i.frequencyText } : {}), ...(i.foodRelation ? { foodRelation: i.foodRelation as NonNullable<OrderItemInput["foodRelation"]> } : {}), ...(i.durationDays ? { durationDays: i.durationDays } : {}), ...(i.quantity ? { quantity: i.quantity } : {}), ...(i.instructions ? { instructions: i.instructions } : {}),
          }));
          await this.prescriptions.saveDraft(ctx, r.encounterId, { items: [...keep, p.item] }, tx);
          outcome = { addedToDraftPrescription: true };
        }
      }
      const res = await tx.orderRequest.updateMany({
        where: { id: requestId, tenantId: ctx.tenantId, status: "PENDING" },
        data: { status: input.action === "ACCEPT" ? "ACCEPTED" : "DECLINED", decidedById: ctx.userId, decidedAt: new Date(), decisionNote: input.note ?? null },
      });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This request has already been decided", 409);
      await this.audit.record(tx, actorOf(ctx), { action: input.action === "ACCEPT" ? "ORDER_REQUEST_ACCEPTED" : "ORDER_REQUEST_DECLINED", entityType: "OrderRequest", entityId: requestId, metadata: { kind: r.kind, ...outcome } });
      await this.notifications.notify(tx, [r.requestedById], { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "ORDER_REQUEST_DECIDED", entityType: v.area === "ER" ? "EmergencyCase" : "Admission", entityId: (v.area === "ER" ? v.caseId : v.admissionId) as string, dedupeKey: `ORDER_REQUEST_DECIDED:${requestId}` });
      return this.view(tx, ctx, requestId);
    });
  }

  /** Locks the request and checks it is still waiting. Someone outside the visit's data scope sees "not found". */
  private async lock(tx: Db, ctx: RequestContext, requestId: string) {
    const visible = await tx.orderRequest.findFirst({ where: { id: requestId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounter: { is: { ...visitScope(ctx) } } }, select: { id: true } });
    const locked = visible ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "OrderRequest" WHERE id = ${requestId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid FOR UPDATE` : [];
    if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const r = await tx.orderRequest.findFirstOrThrow({ where: { id: requestId, tenantId: ctx.tenantId }, select: { id: true, kind: true, status: true, encounterId: true, payload: true, note: true, requestedById: true } });
    if (r.status !== "PENDING") throw new DomainError("INVALID_STATE", "This request has already been decided", 409);
    return r;
  }
}
