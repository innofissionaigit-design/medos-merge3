import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { assertEncounterVisible } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly } from "../../common/time";
import { AppointmentsService } from "../appointments/appointments.service";
import { ClaimsService } from "../claims/claims.service";
import { AdmissionsService } from "../ipd/admissions.service";
import { NumberingService } from "../numbering/numbering.service";
import { SettingsService } from "../settings/settings.service";
import { PlannedCore, PLANNED_ROW, plannedScope, toRow } from "./planned.core";
import { isOpen, NURSING_ASSESSMENT_TITLE, type PlannedStatus } from "./planned.domain";

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-20");
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const stay = z.number().int().min(1).max(365);
const STATUSES = ["ADVISED", "DOCTOR_REVIEW", "AWAITING_PATIENT", "DESK_REVIEW", "TARIFF_PAYER", "PREAUTH", "DEPOSIT", "BED_ALLOCATION", "READY", "ADMITTED", "CLOSED"] as const;

/** Reception raises a request for a patient who comes from outside: arranged with a consultant of this hospital, or walking in with an outside doctor's papers. */
export const raiseSchema = z.object({
  patientId: uuid, source: z.enum(["OUTSIDE_ARRANGED", "OUTSIDE_DIRECT"]), consultantId: uuid, details: text(5, 2000),
  diagnosis: text(2, 300).optional(), plannedProcedure: text(2, 300).optional(), proposedDate: day.optional(), expectedStayDays: stay.optional(),
}).strict();
/** The OPD doctor ticks "needs admission". */
export const adviseSchema = z.object({
  details: text(3, 2000), diagnosis: text(2, 300).optional(), plannedProcedure: text(2, 300).optional(), proposedDate: day.optional(), expectedStayDays: stay.optional(), wardId: uuid.optional(), roomNote: text(2, 200).optional(),
}).strict();
export const consentSchema = z.object({ consented: z.boolean(), note: text(3, 300).optional() }).strict();
export const doctorSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ASK"), mode: z.enum(["CHAMBER", "REPORTS", "INVESTIGATIONS"]), note: text(3, 500) }).strict(),
  z.object({ action: z.literal("ACCEPT"), diagnosis: text(2, 300), plannedProcedure: text(2, 300).optional(), proposedDate: day, expectedStayDays: stay, wardId: uuid.optional(), roomNote: text(2, 200).optional(), note: text(3, 500).optional() }).strict(),
  z.object({ action: z.literal("OTHER_TREATMENT"), note: text(5, 500) }).strict(),
  z.object({ action: z.literal("DECLINE"), reason: text(5, 500) }).strict(),
]);
export const patientReadySchema = z.object({ note: text(3, 500).optional(), sendToQueue: z.boolean().default(true) }).strict();
export const verifySchema = z.object({ consultantId: uuid.optional(), diagnosis: text(2, 300), plannedProcedure: text(2, 300).optional(), proposedDate: day, expectedStayDays: stay, wardId: uuid, roomNote: text(2, 200).optional() }).strict();
export const rescheduleSchema = z.object({ proposedDate: day, reason: text(3, 300) }).strict();
export const bedSchema = z.object({ bedId: uuid }).strict();
export const cancelSchema = z.object({ reason: text(5, 300), kind: z.enum(["CANCELLED", "NO_SHOW"]).default("CANCELLED") }).strict();
export const listPlannedSchema = z.object({
  status: z.enum([...STATUSES, "OPEN"]).optional(), q: z.string().trim().min(2).max(60).optional(), consultantId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

type Raise = z.infer<typeof raiseSchema>;

/**
 * Planned admission (docs/planned-admission.md): a patient who is to be admitted on a chosen day. This service holds the request and its people steps (the request, the doctor's review, the
 * patient's consent, the admission desk, the bed, the admission on the day, and cancelling). The money steps are in PlannedFinanceService. Every step goes through PlannedCore, which keeps the
 * allowed order, the timeline, the audit and the notifications; the admission itself is made by the same code as any other admission.
 */
@Injectable()
export class PlannedService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService, private readonly core: PlannedCore,
    private readonly admissions: AdmissionsService, private readonly appointments: AppointmentsService, private readonly claims: ClaimsService, private readonly settings: SettingsService,
  ) {}

  // ───── making a request ─────

  private async assertDate(tx: Db, ctx: RequestContext, date: string, path: string): Promise<void> {
    if (date < (await this.core.today(tx, ctx))) throw new DomainError("VALIDATION_FAILED", "The admission day cannot be in the past", 400, [{ path, message: "Choose today or a later day" }]);
  }

  private async assertWard(tx: Db, ctx: RequestContext, wardId: string): Promise<void> {
    const w = await tx.ward.findFirst({ where: { id: wardId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, code: true } });
    if (!w) throw new DomainError("VALIDATION_FAILED", "Ward not found or switched off", 400, [{ path: "wardId", message: "Unknown ward" }]);
    if (w.code === (await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "EMERGENCY_WARD_CODE"))) throw new DomainError("VALIDATION_FAILED", "The emergency ward is for emergency patients, not planned admissions", 400, [{ path: "wardId", message: "Choose another ward" }]);
  }

  /** The consultant of a request must be a doctor with a login who may review planned admissions, or the request would wait for nobody. */
  private async assertCanReview(tx: Db, ctx: RequestContext, userId: string | null): Promise<void> {
    const n = userId ? await tx.user.count({ where: { id: userId, tenantId: ctx.tenantId, status: "ACTIVE", roles: { some: { role: { permissions: { some: { permission: "PLANNED_DOCTOR" } } } } } } }) : 0;
    if (n === 0) throw new DomainError("VALIDATION_FAILED", "This doctor cannot review planned admissions (no login, or not allowed to)", 400, [{ path: "consultantId", message: "Choose another doctor" }]);
  }

  /** A patient has one planned admission open at a time, and is not planned for admission while already admitted. */
  private async assertNoOpen(tx: Db, ctx: RequestContext, patientId: string): Promise<void> {
    const open = await tx.plannedAdmission.findFirst({ where: { tenantId: ctx.tenantId, patientId, status: { notIn: ["ADMITTED", "CLOSED"] } }, select: { requestNumber: true } });
    if (open) throw new DomainError("CONFLICT", `This patient already has an open planned admission (${open.requestNumber})`, 409);
    const adm = await tx.admission.findFirst({ where: { tenantId: ctx.tenantId, patientId, status: "ADMITTED" }, select: { admissionNumber: true } });
    if (adm) throw new DomainError("CONFLICT", `This patient is already admitted (${adm.admissionNumber})`, 409);
  }

  private async activePatient(tx: Db, ctx: RequestContext, patientId: string): Promise<void> {
    const p = await tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { status: true, mergedIntoId: true } });
    if (!p) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    if (p.mergedIntoId) throw new DomainError("PATIENT_MERGED", "This patient record was merged into another. Use the real patient.", 409, { mergedIntoId: p.mergedIntoId });
    if (p.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This patient record is inactive", 409);
  }

  /** Reception: the patient comes from outside. The request goes to the consultant, who reviews it from their own screen. */
  async raise(ctx: RequestContext, input: Raise) {
    return this.prisma.$transaction(async (tx) => {
      await this.activePatient(tx, ctx, input.patientId);
      const consultant = await tx.practitioner.findFirst({ where: { id: input.consultantId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, userId: true } });
      if (!consultant) throw new DomainError("VALIDATION_FAILED", "Doctor not found or inactive at this facility", 400, [{ path: "consultantId", message: "Unknown doctor" }]);
      await this.assertCanReview(tx, ctx, consultant.userId);
      await this.assertNoOpen(tx, ctx, input.patientId);
      if (input.proposedDate) await this.assertDate(tx, ctx, input.proposedDate, "proposedDate");
      const requestNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "PLANNED_ADMISSION");
      const plan = await tx.plannedAdmission.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, requestNumber, source: input.source, status: "DOCTOR_REVIEW", consultantId: consultant.id, details: input.details,
          diagnosis: input.diagnosis ?? null, plannedProcedure: input.plannedProcedure ?? null, proposedDate: input.proposedDate ? dateOnly(input.proposedDate) : null, expectedStayDays: input.expectedStayDays ?? null, createdById: ctx.userId,
        },
        select: { id: true },
      });
      await this.begin(tx, ctx, { id: plan.id, requestNumber, consultant }, "DOCTOR_REVIEW", "REQUESTED", { source: input.source });
      return this.core.view(tx, ctx, plan.id);
    });
  }

  /** The OPD doctor ticks "needs admission" in a visit. Reception then asks the patient. */
  async advise(ctx: RequestContext, encounterId: string, input: z.infer<typeof adviseSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await assertEncounterVisible(tx, ctx, encounterId);
      const enc = await tx.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "OPD" }, select: { patientId: true, status: true, practitioner: { select: { id: true, userId: true } } } });
      if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (enc.status === "CANCELLED") throw new DomainError("INVALID_STATE", "This visit was cancelled", 409);
      if (!enc.practitioner || enc.practitioner.userId !== ctx.userId) throw new DomainError("FORBIDDEN", "Only the doctor of this visit can advise admission", 403);
      await this.activePatient(tx, ctx, enc.patientId);
      await this.assertNoOpen(tx, ctx, enc.patientId);
      if (input.proposedDate) await this.assertDate(tx, ctx, input.proposedDate, "proposedDate");
      if (input.wardId) await this.assertWard(tx, ctx, input.wardId);
      const requestNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "PLANNED_ADMISSION");
      const plan = await tx.plannedAdmission.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, requestNumber, source: "OPD_ADVISED", status: "ADVISED", consultantId: enc.practitioner.id, sourceEncounterId: encounterId, details: input.details,
          diagnosis: input.diagnosis ?? null, plannedProcedure: input.plannedProcedure ?? null, proposedDate: input.proposedDate ? dateOnly(input.proposedDate) : null, expectedStayDays: input.expectedStayDays ?? null,
          wardId: input.wardId ?? null, roomNote: input.roomNote ?? null, createdById: ctx.userId,
        },
        select: { id: true },
      });
      await this.begin(tx, ctx, { id: plan.id, requestNumber, consultant: { userId: ctx.userId } }, "ADVISED", "ADVISED", { encounterId });
      return this.core.view(tx, ctx, plan.id);
    });
  }

  /** The first timeline entry, the audit event and the people told. */
  private async begin(tx: Db, ctx: RequestContext, plan: { id: string; requestNumber: string; consultant: { userId: string | null } }, status: PlannedStatus, action: string, meta: Record<string, string>): Promise<void> {
    const ev = await tx.plannedAdmissionEvent.create({ data: { tenantId: ctx.tenantId, plannedId: plan.id, fromStatus: null, toStatus: status, action, actorId: ctx.userId }, select: { id: true } });
    await this.audit.record(tx, actorOf(ctx), { action: `PLANNED_ADMISSION_${action}`, entityType: "PlannedAdmission", entityId: plan.id, metadata: { requestNumber: plan.requestNumber, to: status, ...meta } });
    await this.core.tell(tx, ctx, plan, status, ev.id);
  }

  /** The request a visit gave rise to (the doctor's tick box), or nothing. */
  async forEncounter(ctx: RequestContext, encounterId: string) {
    await assertEncounterVisible(this.prisma, ctx, encounterId);
    if (!(await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } }))) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const row = await this.prisma.plannedAdmission.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, sourceEncounterId: encounterId, AND: [plannedScope(ctx)] }, orderBy: { createdAt: "desc" }, select: PLANNED_ROW });
    return row ? toRow(row) : null;
  }

  // ───── the patient and the doctor ─────

  /** Reception asks the patient: consent starts the admission procedure; a refusal closes the request. */
  async consent(ctx: RequestContext, id: string, input: z.infer<typeof consentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      const now = new Date();
      if (input.consented) {
        await this.core.move(tx, ctx, plan, "CONSENT", undefined, { consentAt: now, consentById: ctx.userId, consentNote: input.note ?? null }, "CONSENT_GIVEN", input.note);
      } else {
        if (!input.note) throw new DomainError("VALIDATION_FAILED", "Write why the patient does not want to be admitted", 400, [{ path: "note", message: "Required" }]);
        await this.core.move(tx, ctx, plan, "PATIENT_DECLINE", undefined, { consentAt: now, consentById: ctx.userId, consentNote: input.note, closeReason: "PATIENT_DECLINED", closeNote: input.note, closedAt: now, closedById: ctx.userId }, "PATIENT_DECLINED", input.note);
      }
      return this.core.view(tx, ctx, id);
    });
  }

  /** The consultant's review: ask the patient for something, accept the admission, recommend other treatment, or decline. */
  async decide(ctx: RequestContext, id: string, input: z.infer<typeof doctorSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      this.core.assertConsultant(ctx, plan);
      const now = new Date();
      const close = (reason: "OTHER_TREATMENT" | "DOCTOR_DECLINED", note: string) => ({ closeReason: reason, closeNote: note, closedAt: now, closedById: ctx.userId } as const);
      if (input.action === "ASK") {
        await this.core.move(tx, ctx, plan, "ASK_PATIENT", undefined, { askMode: input.mode, askNote: input.note }, "DOCTOR_ASKED_PATIENT", input.note, { mode: input.mode });
      } else if (input.action === "ACCEPT") {
        await this.assertDate(tx, ctx, input.proposedDate, "proposedDate");
        if (input.wardId) await this.assertWard(tx, ctx, input.wardId);
        await this.core.move(tx, ctx, plan, "ACCEPT", undefined, {
          diagnosis: input.diagnosis, plannedProcedure: input.plannedProcedure ?? null, proposedDate: dateOnly(input.proposedDate), expectedStayDays: input.expectedStayDays, wardId: input.wardId ?? null, roomNote: input.roomNote ?? null,
        }, "DOCTOR_ACCEPTED", input.note, { proposedDate: input.proposedDate });
      } else if (input.action === "OTHER_TREATMENT") {
        await this.core.move(tx, ctx, plan, "OTHER_TREATMENT", undefined, close("OTHER_TREATMENT", input.note), "DOCTOR_OTHER_TREATMENT", input.note);
      } else {
        await this.core.move(tx, ctx, plan, "DOCTOR_DECLINE", undefined, close("DOCTOR_DECLINED", input.reason), "DOCTOR_DECLINED", input.reason);
      }
      return this.core.view(tx, ctx, id);
    });
  }

  /**
   * Reception: the patient came or sent what the doctor asked for. For a chamber visit the patient is put in the doctor's OPD queue now (unless reception says the patient is
   * already booked); the request then goes back to the doctor.
   */
  async patientReady(ctx: RequestContext, id: string, input: z.infer<typeof patientReadySchema>) {
    const seen = await this.prisma.plannedAdmission.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [plannedScope(ctx)] }, select: { id: true, status: true, askMode: true, patientId: true, consultantId: true, version: true, requestNumber: true, askNote: true } });
    if (!seen) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (seen.status !== "AWAITING_PATIENT") throw new DomainError("INVALID_STATE", "This request is not waiting for the patient", 409);
    let token: string | null = null;
    if (seen.askMode === "CHAMBER" && input.sendToQueue) {
      if (!ctx.permissions.has("APPOINTMENT_CREATE")) throw new DomainError("FORBIDDEN", "You do not have permission to add a patient to the doctor's queue", 403);
      // A fixed key per request and round: pressing the button twice, or retrying after an error further on, never puts the patient in the queue twice.
      const { result } = await this.appointments.walkIn(ctx, { patientId: seen.patientId, practitionerId: seen.consultantId, type: "CONSULTATION", priority: "NORMAL", notes: `Planned admission ${seen.requestNumber}: ${seen.askNote ?? "doctor's visit"}`.slice(0, 500) }, `PLANNED-${seen.id}-v${seen.version}`);
      token = String(result.queueEntry.tokenNumber);
    }
    return this.prisma.$transaction(async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      const note = [input.note, token ? `Sent to the doctor's queue, token ${token}` : null].filter(Boolean).join(". ") || null;
      await this.core.move(tx, ctx, plan, "PATIENT_READY", undefined, {}, "PATIENT_READY", note, { mode: seen.askMode ?? "", queued: token !== null });
      return this.core.view(tx, ctx, id);
    });
  }

  // ───── the admission desk ─────

  /** The desk checks the admitting consultant, diagnosis, planned procedure, day, expected stay and room category; it may correct them. */
  async verify(ctx: RequestContext, id: string, input: z.infer<typeof verifySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      await this.assertDate(tx, ctx, input.proposedDate, "proposedDate");
      await this.assertWard(tx, ctx, input.wardId);
      let consultantId = plan.consultantId;
      if (input.consultantId && input.consultantId !== plan.consultantId) {
        const c = await tx.practitioner.findFirst({ where: { id: input.consultantId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, userId: true } });
        if (!c) throw new DomainError("VALIDATION_FAILED", "Doctor not found or inactive at this facility", 400, [{ path: "consultantId", message: "Unknown doctor" }]);
        await this.assertCanReview(tx, ctx, c.userId);
        consultantId = c.id;
      }
      const changed = consultantId !== plan.consultantId;
      await this.core.move(tx, ctx, plan, "VERIFY", undefined, {
        consultantId, diagnosis: input.diagnosis, plannedProcedure: input.plannedProcedure ?? null, proposedDate: dateOnly(input.proposedDate), expectedStayDays: input.expectedStayDays, wardId: input.wardId,
        roomNote: input.roomNote ?? null, deskVerifiedAt: new Date(), deskVerifiedById: ctx.userId,
      }, "DESK_VERIFIED", null, { consultantChanged: changed, proposedDate: input.proposedDate });
      return this.core.view(tx, ctx, id);
    });
  }

  /** The planned day changes (the patient asks, or no bed is free): the day moves and the reason is kept. */
  async reschedule(ctx: RequestContext, id: string, input: z.infer<typeof rescheduleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      if (!["DESK_REVIEW", "TARIFF_PAYER", "PREAUTH", "DEPOSIT", "BED_ALLOCATION", "READY"].includes(plan.status)) throw new DomainError("INVALID_STATE", "The day cannot be changed at this step", 409);
      await this.assertDate(tx, ctx, input.proposedDate, "proposedDate");
      const before = plan.proposedDate ? plan.proposedDate.toISOString().slice(0, 10) : null;
      const res = await tx.plannedAdmission.updateMany({ where: { id, tenantId: ctx.tenantId, status: plan.status }, data: { proposedDate: dateOnly(input.proposedDate), version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The request was changed by someone else", 409);
      await this.core.record(tx, ctx, plan, "RESCHEDULED", `${before ?? "no day"} to ${input.proposedDate}: ${input.reason}`, { from: before ?? "", to: input.proposedDate });
      return this.core.view(tx, ctx, id);
    });
  }

  // ───── the bed ─────

  private async lockBed(tx: Db, ctx: RequestContext, bedId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Bed" WHERE id = ${bedId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.bed.findFirstOrThrow({ where: { id: bedId, tenantId: ctx.tenantId }, include: { ward: { select: { status: true } }, room: { select: { status: true } } } });
  }

  /**
   * Bed management holds a bed for the patient (the bed shows as reserved), or changes the bed while the request is ready. The bed row is locked, so two requests cannot hold the same bed,
   * and nobody can free a held bed by hand (the database refuses it).
   */
  async allocateBed(ctx: RequestContext, id: string, input: z.infer<typeof bedSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      if (plan.status !== "BED_ALLOCATION" && plan.status !== "READY") throw new DomainError("INVALID_STATE", "A bed can be held only once the money is cleared", 409);
      if (plan.bedId === input.bedId) throw new DomainError("VALIDATION_FAILED", "The patient already has this bed", 400);
      // Both beds are locked in a fixed order so two changes cannot deadlock.
      const ids = [plan.bedId, input.bedId].filter((x): x is string => !!x).sort();
      for (const b of ids) await this.lockBed(tx, ctx, b);
      const bed = await tx.bed.findFirstOrThrow({ where: { id: input.bedId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { ward: { select: { status: true, id: true, code: true } }, room: { select: { status: true } } } });
      if (bed.ward.code === (await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "EMERGENCY_WARD_CODE"))) throw new DomainError("BED_NOT_AVAILABLE", "Emergency ward beds are for emergency patients", 409);
      if (bed.active !== "ACTIVE" || bed.ward.status !== "ACTIVE" || bed.room.status !== "ACTIVE") throw new DomainError("BED_NOT_AVAILABLE", `Bed ${bed.code} is not in service`, 409);
      if (bed.status !== "AVAILABLE") throw new DomainError("BED_NOT_AVAILABLE", `Bed ${bed.code} is ${bed.status.toLowerCase()} and cannot be held`, 409, { status: bed.status });
      const now = new Date();
      const differs = !!plan.wardId && plan.wardId !== bed.ward.id;
      if (plan.status === "BED_ALLOCATION") {
        await this.core.move(tx, ctx, plan, "BED_ALLOCATED", undefined, { bedId: bed.id, bedAllocatedAt: now, bedAllocatedById: ctx.userId }, "BED_ALLOCATED", null, { bedId: bed.id, differentWard: differs });
      } else {
        const res = await tx.plannedAdmission.updateMany({ where: { id, tenantId: ctx.tenantId, status: "READY" }, data: { bedId: bed.id, bedAllocatedAt: now, bedAllocatedById: ctx.userId, version: { increment: 1 } } });
        if (res.count !== 1) throw new DomainError("INVALID_STATE", "The request was changed by someone else", 409);
        await this.core.record(tx, ctx, plan, "BED_CHANGED", `Bed ${bed.code}`, { fromBedId: plan.bedId ?? "", toBedId: bed.id, differentWard: differs });
        if (plan.bedId) await tx.bed.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: plan.bedId } }, data: { status: "AVAILABLE", version: { increment: 1 } } });
      }
      await tx.bed.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: bed.id } }, data: { status: "RESERVED", version: { increment: 1 } } });
      await this.audit.record(tx, actorOf(ctx), { action: "BED_STATUS_CHANGED", entityType: "Bed", entityId: bed.id, metadata: { from: "AVAILABLE", to: "RESERVED", reason: `Held for planned admission ${plan.requestNumber}` } });
      return this.core.view(tx, ctx, id);
    });
  }

  // ───── the day ─────

  /** The patient arrives: the admission is made like any other (same numbering, encounter, bed assignment), on the bed held, and the nursing admission assessment is put on the nurses' list. */
  async admit(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      if (plan.status !== "READY" || !plan.bedId) throw new DomainError("INVALID_STATE", "Only a request that is ready can be admitted", 409);
      const adm = await this.admissions.admitFromPlanned(tx, ctx, { patientId: plan.patientId, consultantId: plan.consultantId, bedId: plan.bedId, reason: (plan.plannedProcedure ?? plan.diagnosis ?? "Planned admission").slice(0, 300) });
      await tx.nursingTask.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: plan.patientId, admissionId: adm.id, type: "OTHER", title: NURSING_ASSESSMENT_TITLE, dueAt: new Date(Date.now() + 60 * 60_000), createdById: ctx.userId } });
      await this.core.move(tx, ctx, plan, "ADMIT", undefined, { admissionId: adm.id, admittedAt: new Date() }, "ADMITTED", `${adm.admissionNumber}, bed ${adm.bedCode}`, { admissionId: adm.id, admissionNumber: adm.admissionNumber });
      return this.core.view(tx, ctx, id);
    });
  }

  // ───── ending without an admission ─────

  /**
   * Cancels the request (or records that the patient did not come). A held bed goes back to the available list; an insurance claim that was only started is closed.
   * A deposit already taken stays the patient's advance, to be given back or used from the patient's advance payments.
   */
  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof cancelSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await this.core.lock(tx, ctx, id);
      const desk = ctx.permissions.has("PLANNED_DESK"), reception = ctx.permissions.has("PLANNED_REQUEST");
      const ownDoctor = ctx.permissions.has("PLANNED_DOCTOR") && !!plan.consultant.userId && plan.consultant.userId === ctx.userId && ["ADVISED", "DOCTOR_REVIEW", "AWAITING_PATIENT"].includes(plan.status);
      if (!desk && !reception && !ownDoctor) throw new DomainError("FORBIDDEN", "You do not have permission to cancel this request", 403);
      if (input.kind === "NO_SHOW" && !desk) throw new DomainError("FORBIDDEN", "Only the admission desk records that the patient did not come", 403);
      if (!isOpen(plan.status as PlannedStatus)) throw new DomainError("INVALID_STATE", `This request is already ${plan.status === "ADMITTED" ? "admitted" : "closed"}`, 409);
      const now = new Date();
      const bedId = plan.status === "READY" ? plan.bedId : null;
      await this.core.move(tx, ctx, plan, input.kind === "NO_SHOW" ? "NO_SHOW" : "CANCEL", undefined, { closeReason: input.kind, closeNote: input.reason, closedAt: now, closedById: ctx.userId }, input.kind === "NO_SHOW" ? "NO_SHOW" : "CANCELLED", input.reason, { held: !!bedId });
      // The request is closed first: the database does not let a held bed be freed while a ready request holds it.
      if (bedId) {
        const bed = await this.lockBed(tx, ctx, bedId);
        if (bed.status === "RESERVED") {
          await tx.bed.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: bedId } }, data: { status: "AVAILABLE", version: { increment: 1 } } });
          await this.audit.record(tx, actorOf(ctx), { action: "BED_STATUS_CHANGED", entityType: "Bed", entityId: bedId, metadata: { from: "RESERVED", to: "AVAILABLE", reason: `Planned admission ${plan.requestNumber} ended` } });
        }
      }
      if (plan.claimId) {
        const c = await tx.claim.findFirst({ where: { id: plan.claimId, tenantId: ctx.tenantId }, select: { status: true } });
        if (c && ["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED"].includes(c.status)) await this.claims.close(ctx, plan.claimId, { reason: `Planned admission ${plan.requestNumber} ended: ${input.reason}`.slice(0, 300) }, tx);
      }
      return this.core.view(tx, ctx, id);
    });
  }

  async get(ctx: RequestContext, id: string) { return this.core.view(this.prisma, ctx, id); }
}
