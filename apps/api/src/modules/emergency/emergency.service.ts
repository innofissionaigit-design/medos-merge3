import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { visitScope } from "../../common/data-scope";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "../billing/billing.domain";
import { EmergencyBillService } from "../billing/emergency-bill.service";
import { amount, quantity } from "../billing/money.schema";
import { EncountersService } from "../encounters/encounters.service";
import { AdmissionsService } from "../ipd/admissions.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NumberingService } from "../numbering/numbering.service";
import { currentAge } from "../patients/patient.domain";
import { SettingsService } from "../settings/settings.service";

const uuid = z.string().uuid();

export const registerEmergencySchema = z.object({
  patientId: uuid, doctorId: uuid,
  chiefComplaint: z.string().trim().min(3).max(300),
  arrivalMode: z.enum(["WALK_IN", "AMBULANCE", "POLICE", "REFERRED", "OTHER"]).default("WALK_IN"),
  broughtBy: z.string().trim().min(2).max(100).optional(),
}).strict();

export const triageSchema = z.object({
  level: z.enum(["RED", "ORANGE", "YELLOW", "GREEN", "BLUE"]),
  consciousness: z.enum(["ALERT", "VOICE", "PAIN", "UNRESPONSIVE"]),
  airwayClear: z.boolean(), breathingOk: z.boolean(), circulationOk: z.boolean(),
  painScore: z.number().int().min(0).max(10).optional(),
  complaint: z.string().trim().min(3).max(300).optional(),
  note: z.string().trim().min(1).max(1000).optional(),
}).strict();

export const emergencyNoteSchema = z.object({
  kind: z.enum(["ASSESSMENT", "PROGRESS"]).default("ASSESSMENT"),
  text: z.string().trim().min(3).max(4000),
  diagnosis: z.string().trim().min(2).max(300).optional(),
}).strict();

export const decisionSchema = z.object({
  disposition: z.enum(["OT", "ICU", "DISCHARGE"]),
  bedId: uuid.optional(),
  /** The doctor in charge after the move; by default the emergency doctor. */
  consultantId: uuid.optional(),
  note: z.string().trim().min(3).max(500),
}).strict().superRefine((v, c) => {
  if (v.disposition === "DISCHARGE" && (v.bedId || v.consultantId)) c.addIssue({ code: "custom", path: ["bedId"], message: "A patient who goes home needs no bed" });
  if (v.disposition !== "DISCHARGE" && !v.bedId) c.addIssue({ code: "custom", path: ["bedId"], message: "Choose the bed the patient goes to" });
});

export const cancelEmergencySchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();

export const addChargeSchema = z.union([
  z.object({ serviceId: uuid, quantity: quantity.default(new Decimal(1)) }).strict(),
  z.object({ description: z.string().trim().min(2).max(200), unitPrice: amount({ positive: true }), quantity: quantity.default(new Decimal(1)) }).strict(),
]);

export const listEmergencySchema = z.object({
  view: z.enum(["active", "closed"]).default("active"),
  q: z.string().trim().min(2).max(60).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const OPEN = ["ARRIVED", "TRIAGED", "IN_TREATMENT"] as const;

const CASE = {
  id: true, caseNumber: true, status: true, arrivalMode: true, chiefComplaint: true, broughtBy: true, arrivedAt: true, triageLevel: true, doctorAcceptedAt: true,
  disposition: true, dispositionNote: true, dispositionAt: true, cancelReason: true, encounterId: true, patientId: true, doctorId: true, admissionId: true, version: true,
  patient: { select: { firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true, ageRecordedOn: true, bloodGroup: true, mobile: true, emergencyContactName: true, emergencyContactMobile: true, identifiers: { where: { type: "MRN" as const }, select: { value: true } } } },
  doctor: { select: { displayName: true, userId: true } },
  admission: { select: { admissionNumber: true, assignments: { where: { releasedAt: null }, select: { bed: { select: { code: true, ward: { select: { name: true } } } } }, take: 1 } } },
} satisfies Prisma.EmergencyCaseSelect;
type CaseRow = Prisma.EmergencyCaseGetPayload<{ select: typeof CASE }>;

const nameOf = (p: { firstName: string; lastName: string | null }): string => [p.firstName, p.lastName].filter(Boolean).join(" ");

/**
 * The emergency ward (docs/emergency.md). The desk registers an arriving patient and calls a doctor; the emergency nurse keeps the triage record and the vitals; the doctor
 * assesses, orders medicines and tests through the usual screens, and decides where the patient goes: the operation theatre, the ICU, or home. Everything the patient is charged
 * goes on one emergency bill that opens at registration.
 */
@Injectable()
export class EmergencyService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService, private readonly encounters: EncountersService,
    private readonly idempotency: IdempotencyService, private readonly notifications: NotificationsService, private readonly bill: EmergencyBillService, private readonly admissions: AdmissionsService,
    private readonly settings: SettingsService,
  ) {}

  // ───── reading ─────

  private scope(ctx: RequestContext): Prisma.EmergencyCaseWhereInput {
    // A doctor keeps the cases called to them after the patient has moved on (the visit then belongs to the ICU doctor).
    const s = ctx.dataScope;
    const own: Prisma.EmergencyCaseWhereInput = { encounter: { is: { ...visitScope(ctx) } } };
    return { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(s.kind === "DOCTOR" ? { OR: [{ doctorId: { in: [...s.practitionerIds] } }, own] } : own) };
  }

  private summaryOf(c: CaseRow, ctx: RequestContext) {
    const bed = c.admission?.assignments[0]?.bed;
    const seesPatient = ctx.permissions.has("PATIENT_READ");
    return {
      id: c.id, caseNumber: c.caseNumber, status: c.status, arrivalMode: c.arrivalMode, chiefComplaint: c.chiefComplaint, broughtBy: c.broughtBy, arrivedAt: c.arrivedAt, triageLevel: c.triageLevel,
      needsTriage: c.triageLevel === null && (OPEN as readonly string[]).includes(c.status), doctorAccepted: c.doctorAcceptedAt !== null, doctorAcceptedAt: c.doctorAcceptedAt,
      encounterId: c.encounterId, patientId: c.patientId, doctorName: c.doctor.displayName, calledByMe: c.doctor.userId === ctx.userId, version: c.version,
      disposition: c.disposition, dispositionNote: c.dispositionNote, dispositionAt: c.dispositionAt, cancelReason: c.cancelReason,
      patient: seesPatient ? {
        id: c.patientId, name: nameOf(c.patient), mrn: c.patient.identifiers[0]?.value ?? null, gender: c.patient.gender, age: currentAge(c.patient), bloodGroup: c.patient.bloodGroup,
        mobile: c.patient.mobile, emergencyContactName: c.patient.emergencyContactName, emergencyContactMobile: c.patient.emergencyContactMobile,
      } : null,
      admission: c.admissionId ? { id: c.admissionId, admissionNumber: c.admission?.admissionNumber ?? null, bed: bed ? `${bed.ward.name} ${bed.code}` : null } : null,
    };
  }

  async list(ctx: RequestContext, q: z.infer<typeof listEmergencySchema>) {
    const text = q.q?.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
    const where: Prisma.EmergencyCaseWhereInput = {
      ...this.scope(ctx), status: q.view === "active" ? { in: [...OPEN] } : { notIn: [...OPEN] },
      ...(text ? { OR: [{ caseNumber: { contains: q.q!, mode: "insensitive" } }, { patient: { searchName: { contains: text } } }, { patient: { identifiers: { some: { type: "MRN" as const, value: { contains: q.q!, mode: "insensitive" as const } } } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.emergencyCase.findMany({
        where, select: CASE, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        orderBy: q.view === "active" ? [{ triageLevel: { sort: "asc", nulls: "first" } }, { arrivedAt: "asc" }] : [{ arrivedAt: "desc" }],
      }),
      this.prisma.emergencyCase.count({ where }),
    ]);
    const bills = await this.billTotals(this.prisma, ctx, rows.map((r) => r.encounterId));
    return { items: rows.map((r) => ({ ...this.summaryOf(r, ctx), bill: bills.get(r.encounterId) ?? { open: "0.00", billed: "0.00", paid: "0.00", due: "0.00" } })), total };
  }

  private async billTotals(db: Db, ctx: RequestContext, encounterIds: string[]) {
    const out = new Map<string, { open: string; billed: string; paid: string; due: string }>();
    if (encounterIds.length === 0) return out;
    const inv = await db.invoice.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: { in: encounterIds }, status: { notIn: ["CANCELLED", "REFUNDED"] }, kind: { not: "REGISTRATION" } },
      select: { encounterId: true, status: true, total: true, paidTotal: true, refundedTotal: true, creditedTotal: true },
    });
    const sums = new Map<string, { open: Decimal; billed: Decimal; paid: Decimal; due: Decimal }>();
    for (const i of inv) {
      const s = sums.get(i.encounterId as string) ?? { open: new Decimal(0), billed: new Decimal(0), paid: new Decimal(0), due: new Decimal(0) };
      if (i.status === "DRAFT") s.open = s.open.plus(i.total.toString());
      else {
        const eff = new Decimal(i.total.toString()).minus(i.creditedTotal.toString());
        const net = new Decimal(i.paidTotal.toString()).minus(i.refundedTotal.toString());
        s.billed = s.billed.plus(i.total.toString()); s.paid = s.paid.plus(net); s.due = s.due.plus(Decimal.max(0, eff.minus(net)));
      }
      sums.set(i.encounterId as string, s);
    }
    for (const [k, s] of sums) out.set(k, { open: fmt(s.open), billed: fmt(s.billed), paid: fmt(s.paid), due: fmt(s.due) });
    return out;
  }

  /** What this person has to act on now (the red alert): triage for the emergency nurses, accepting the patient for the doctor who was called. */
  async alerts(ctx: RequestContext) {
    const or: Prisma.EmergencyCaseWhereInput[] = [];
    if (ctx.permissions.has("ER_TRIAGE")) or.push({ triageLevel: null });
    if (ctx.permissions.has("ER_TREAT")) or.push({ doctorAcceptedAt: null, doctor: { is: { userId: ctx.userId } } });
    if (or.length === 0) return [];
    const rows = await this.prisma.emergencyCase.findMany({ where: { ...this.scope(ctx), status: { in: [...OPEN] }, OR: or }, select: CASE, orderBy: { arrivedAt: "asc" }, take: 20 });
    return rows.map((r) => {
      const forDoctor = ctx.permissions.has("ER_TREAT") && r.doctor.userId === ctx.userId && r.doctorAcceptedAt === null;
      return { id: r.id, caseNumber: r.caseNumber, patientName: ctx.permissions.has("PATIENT_READ") ? nameOf(r.patient) : null, chiefComplaint: r.chiefComplaint, triageLevel: r.triageLevel, arrivedAt: r.arrivedAt, action: forDoctor ? ("ACCEPT" as const) : ("TRIAGE" as const) };
    });
  }

  /** The doctors the desk can call, the emergency department's first, with how many emergency patients each has now. */
  async doctors(ctx: RequestContext) {
    const docs = await this.prisma.practitioner.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", userId: { not: null } },
      select: { id: true, displayName: true, specialty: true, department: { select: { name: true, code: true } } }, take: 200,
    });
    const load = await this.prisma.emergencyCase.groupBy({ by: ["doctorId"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { in: [...OPEN] } }, _count: { _all: true } });
    const busy = new Map(load.map((l) => [l.doctorId, l._count._all]));
    return docs
      .map((d) => ({ id: d.id, name: d.displayName, specialty: d.specialty, department: d.department?.name ?? null, emergencyDoctor: d.department?.code === "EM", activeCases: busy.get(d.id) ?? 0 }))
      .sort((a, b) => Number(b.emergencyDoctor) - Number(a.emergencyDoctor) || a.activeCases - b.activeCases || a.name.localeCompare(b.name));
  }

  /** The ICU doctors the emergency doctor can hand a patient over to, with how many ICU patients each has now. */
  async icuDoctors(ctx: RequestContext) {
    const users = await this.notifications.recipientsWith(this.prisma, ctx.tenantId, ctx.facilityId, ["ICU_DOCTOR"]);
    const docs = await this.prisma.practitioner.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", userId: { in: users } }, select: { id: true, displayName: true, specialty: true }, take: 100 });
    const load = await this.prisma.admission.groupBy({ by: ["consultantId"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ADMITTED", consultantId: { in: docs.map((d) => d.id) } }, _count: { _all: true } });
    const busy = new Map(load.map((l) => [l.consultantId, l._count._all]));
    return docs.map((d) => ({ id: d.id, name: d.displayName, specialty: d.specialty, patients: busy.get(d.id) ?? 0 })).sort((a, b) => a.patients - b.patients || a.name.localeCompare(b.name));
  }

  /** The operation theatre and the ICU: each room's bed, and whether it is free now. */
  async beds(ctx: RequestContext) {
    const [otCode, icuCode] = await Promise.all([
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "EMERGENCY_OT_WARD_CODE"), this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "EMERGENCY_ICU_WARD_CODE"),
    ]);
    const rows = await this.prisma.bed.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, active: "ACTIVE", ward: { code: { in: [otCode, icuCode] }, status: "ACTIVE" }, room: { status: "ACTIVE" } },
      select: { id: true, code: true, status: true, dailyRate: true, room: { select: { name: true } }, ward: { select: { code: true, name: true } } }, orderBy: [{ code: "asc" }],
    });
    const shape = (code: string) => rows.filter((b) => b.ward.code === code).map((b) => ({ id: b.id, code: b.code, room: b.room.name, ward: b.ward.name, status: b.status, free: b.status === "AVAILABLE", dailyRate: fmt(b.dailyRate) }));
    return { OT: shape(otCode), ICU: shape(icuCode) };
  }

  async get(ctx: RequestContext, id: string) {
    const c = await this.prisma.emergencyCase.findFirst({ where: { id, ...this.scope(ctx) }, select: CASE });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.detail(this.prisma, ctx, c);
  }

  private async detail(db: Db, ctx: RequestContext, c: CaseRow) {
    const [triages, notes, allergies, lims, orders, bill] = await Promise.all([
      db.emergencyTriage.findMany({ where: { tenantId: ctx.tenantId, caseId: c.id }, orderBy: { triagedAt: "desc" }, take: 50 }),
      db.emergencyNote.findMany({ where: { tenantId: ctx.tenantId, caseId: c.id }, orderBy: { createdAt: "desc" }, take: 100 }),
      ctx.permissions.has("PATIENT_READ") ? db.allergy.findMany({ where: { tenantId: ctx.tenantId, patientId: c.patientId, status: "ACTIVE" }, select: { allergen: true, severity: true, reaction: true }, take: 20 }) : Promise.resolve([]),
      db.limsRequest.findMany({ where: { tenantId: ctx.tenantId, encounterId: c.encounterId, status: { not: "CANCELLED" } }, select: { status: true, priority: true } }),
      db.medicationOrder.findMany({ where: { tenantId: ctx.tenantId, encounterId: c.encounterId, status: "SIGNED" }, select: { items: { where: { status: "ACTIVE" }, select: { quantity: true, dispensedQuantity: true } } } }),
      this.bill.summary(db, ctx, c.encounterId),
    ]);
    const people = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set([...triages.map((t) => t.triagedById), ...notes.map((n) => n.authorId)])] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    // The latest reading of each kind (the nurse's vitals are read straight from the visit, so the doctor sees them here).
    // Whoever may follow the case (ER_READ) sees the latest vitals in it, the manager and the administrator included.
    const readings = ctx.permissions.has("ER_READ")
      ? await db.observation.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: c.encounterId, status: "FINAL" }, orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }], take: 80, select: { type: true, value: true, unit: true, recordedAt: true, recordedById: true } })
      : null;
    const latest = new Map<string, NonNullable<typeof readings>[number]>();
    for (const r of readings ?? []) if (!latest.has(r.type)) latest.set(r.type, r);
    const readers = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set([...latest.values()].map((r) => r.recordedById))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const items = orders.flatMap((o) => o.items);
    return {
      ...this.summaryOf(c, ctx),
      triages: triages.map((t) => ({ id: t.id, level: t.level, consciousness: t.consciousness, airwayClear: t.airwayClear, breathingOk: t.breathingOk, circulationOk: t.circulationOk, painScore: t.painScore, complaint: t.complaint, note: t.note, triagedAt: t.triagedAt, triagedBy: people.get(t.triagedById) ?? null })),
      notes: notes.map((n) => ({ id: n.id, kind: n.kind, text: n.text, diagnosis: n.diagnosis, createdAt: n.createdAt, author: people.get(n.authorId) ?? null })),
      allergies,
      vitals: readings ? [...latest.values()].map((o) => ({ type: o.type, value: o.value.toString(), unit: o.unit, recordedAt: o.recordedAt, recordedBy: readers.get(o.recordedById) ?? null })) : null,
      tests: { total: lims.length, issued: lims.filter((r) => ["ISSUED", "HANDED_OVER"].includes(r.status)).length, pending: lims.filter((r) => !["ISSUED", "HANDED_OVER"].includes(r.status)).length },
      medicines: { prescribed: items.length, pendingAtPharmacy: items.filter((i) => i.quantity === null ? i.dispensedQuantity === 0 : i.dispensedQuantity < i.quantity).length },
      bill,
    };
  }

  // ───── the desk: register ─────

  async register(ctx: RequestContext, input: z.infer<typeof registerEmergencySchema>, key: string | undefined) {
    return this.idempotency.run(ctx.tenantId, "ER_REGISTER", key, input, async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: ctx.tenantId, status: "ACTIVE", mergedIntoId: null }, select: { id: true } });
      if (!patient) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
      // One registration of this patient at a time, so two desks (or a double click with two keys) cannot both put the patient in the ward.
      await tx.$queryRaw`SELECT id FROM "Patient" WHERE id = ${patient.id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid FOR UPDATE`;
      const already = await tx.emergencyCase.findFirst({ where: { tenantId: ctx.tenantId, patientId: patient.id, status: { in: [...OPEN] } }, select: { caseNumber: true } });
      if (already) throw new DomainError("CONFLICT", `This patient is already in the emergency ward (${already.caseNumber})`, 409);
      const admitted = await tx.admission.findFirst({ where: { tenantId: ctx.tenantId, patientId: patient.id, status: "ADMITTED" }, select: { admissionNumber: true } });
      if (admitted) throw new DomainError("CONFLICT", `This patient is already admitted (${admitted.admissionNumber})`, 409);
      const doctor = await tx.practitioner.findFirst({ where: { id: input.doctorId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, userId: true, departmentId: true } });
      if (!doctor) throw new DomainError("VALIDATION_FAILED", "Doctor not found or inactive at this facility", 400, [{ path: "doctorId", message: "Unknown doctor" }]);
      if (!doctor.userId) throw new DomainError("VALIDATION_FAILED", "This doctor has no login, so cannot be called", 400, [{ path: "doctorId", message: "Doctor has no login" }]);
      const emergencyDept = await tx.department.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, code: "EM", status: "ACTIVE" }, select: { id: true } });

      const caseNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "EMERGENCY");
      const enc = await this.encounters.openEmergency(tx, ctx, { patientId: patient.id, practitionerId: doctor.id, departmentId: emergencyDept?.id ?? doctor.departmentId, encounterNumber: caseNumber });
      const made = await tx.emergencyCase.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: patient.id, encounterId: enc.id, caseNumber, arrivalMode: input.arrivalMode, chiefComplaint: input.chiefComplaint,
          broughtBy: input.broughtBy ?? null, doctorId: doctor.id, registeredById: ctx.userId,
        },
        select: { id: true },
      });
      // The emergency bill opens now, with the registration and doctor's fee when the hospital has set one.
      const fee = new Decimal(await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "EMERGENCY_FEE_AMOUNT"));
      if (fee.gt(0)) await this.bill.addLines(tx, ctx, { id: enc.id, patientId: patient.id }, [{ description: "Emergency registration and doctor's fee", quantity: new Decimal(1), unitPrice: fee, taxPercent: new Decimal(0), sourceType: "ER_FEE", sourceId: made.id }]);
      else await this.bill.addLines(tx, ctx, { id: enc.id, patientId: patient.id }, []);
      await this.audit.record(tx, actorOf(ctx), { action: "EMERGENCY_REGISTERED", entityType: "EmergencyCase", entityId: made.id, metadata: { caseNumber, arrivalMode: input.arrivalMode, doctorId: doctor.id, patientId: patient.id } });
      // The red alert: every emergency nurse and the doctor who was called.
      const nurses = await this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, ["ER_TRIAGE"]);
      await this.notifications.notify(tx, [...nurses, doctor.userId], { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "EMERGENCY_ARRIVAL", entityType: "EmergencyCase", entityId: made.id, dedupeKey: `EMERGENCY_ARRIVAL:${made.id}` });
      return this.detail(tx, ctx, await this.row(tx, ctx, made.id));
    });
  }

  // ───── the emergency nurse: the triage record ─────

  async triage(ctx: RequestContext, caseId: string, input: z.infer<typeof triageSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lockOpen(tx, ctx, caseId);
      const row = await tx.emergencyTriage.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, caseId, level: input.level, consciousness: input.consciousness, airwayClear: input.airwayClear, breathingOk: input.breathingOk,
          circulationOk: input.circulationOk, painScore: input.painScore ?? null, complaint: input.complaint ?? c.chiefComplaint, note: input.note ?? null, triagedById: ctx.userId,
        },
        select: { id: true },
      });
      const res = await tx.emergencyCase.updateMany({
        where: { id: caseId, tenantId: ctx.tenantId, status: { in: [...OPEN] } },
        data: { triageLevel: input.level, ...(c.status === "ARRIVED" ? { status: "TRIAGED" as const } : {}), version: { increment: 1 } },
      });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This emergency case was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "EMERGENCY_TRIAGED", entityType: "EmergencyCase", entityId: caseId, metadata: { level: input.level, consciousness: input.consciousness, triageId: row.id } });
      const doctorUser = await tx.practitioner.findFirst({ where: { id: c.doctorId, tenantId: ctx.tenantId }, select: { userId: true } });
      if (doctorUser?.userId) await this.notifications.notify(tx, [doctorUser.userId], { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "EMERGENCY_TRIAGED", entityType: "EmergencyCase", entityId: caseId, dedupeKey: `EMERGENCY_TRIAGED:${row.id}` });
      return this.detail(tx, ctx, await this.row(tx, ctx, caseId));
    });
  }

  // ───── the doctor ─────

  async accept(ctx: RequestContext, caseId: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lockOpen(tx, ctx, caseId);
      await this.assertCalledDoctor(tx, ctx, c.doctorId);
      await this.markAccepted(tx, ctx, c);
      return this.detail(tx, ctx, await this.row(tx, ctx, caseId));
    });
  }

  async addNote(ctx: RequestContext, caseId: string, input: z.infer<typeof emergencyNoteSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lockOpen(tx, ctx, caseId);
      await this.assertCalledDoctor(tx, ctx, c.doctorId);
      await this.markAccepted(tx, ctx, c); // writing the first assessment is also accepting the patient
      const n = await tx.emergencyNote.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, caseId, kind: input.kind, text: input.text, diagnosis: input.diagnosis ?? null, authorId: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "EMERGENCY_NOTE_ADDED", entityType: "EmergencyCase", entityId: caseId, metadata: { noteId: n.id, kind: input.kind, hasDiagnosis: input.diagnosis !== undefined } });
      return this.detail(tx, ctx, await this.row(tx, ctx, caseId));
    });
  }

  /** The doctor's decision: the operation theatre, the ICU (the patient is admitted to that bed at once) or home. */
  async decide(ctx: RequestContext, caseId: string, input: z.infer<typeof decisionSchema>, key: string | undefined) {
    return this.idempotency.run(ctx.tenantId, `ER_DECIDE:${caseId}`, key, input, async (tx) => {
      const c = await this.lockOpen(tx, ctx, caseId);
      await this.assertCalledDoctor(tx, ctx, c.doctorId);
      const now = new Date();
      let admissionId: string | null = null;
      let admissionNumber: string | null = null;
      if (input.disposition === "DISCHARGE") {
        await this.encounters.transition(tx, ctx, c.encounterId, "COMPLETED");
      } else {
        const wardCode = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, input.disposition === "OT" ? "EMERGENCY_OT_WARD_CODE" : "EMERGENCY_ICU_WARD_CODE");
        const bed = await tx.bed.findFirst({ where: { id: input.bedId as string, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ward: { code: wardCode } }, select: { id: true } });
        if (!bed) throw new DomainError("VALIDATION_FAILED", `Choose a bed of the ${input.disposition === "OT" ? "operation theatre" : "ICU"}`, 400, [{ path: "bedId", message: "Not a bed of that ward" }]);
        // The doctor who takes over in the ICU must be an ICU doctor.
        let icuDoctorUser: string | null = null;
        if (input.disposition === "ICU" && input.consultantId) {
          const p = await tx.practitioner.findFirst({ where: { id: input.consultantId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { userId: true } });
          const icuDoctors = await this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, ["ICU_DOCTOR"]);
          if (!p?.userId || !icuDoctors.includes(p.userId)) throw new DomainError("VALIDATION_FAILED", "Choose an ICU doctor to take over the patient", 400, [{ path: "consultantId", message: "Not an ICU doctor" }]);
          icuDoctorUser = p.userId;
        }
        const adm = await this.admissions.admitFromEmergency(tx, ctx, { encounterId: c.encounterId, patientId: c.patientId, consultantId: input.consultantId ?? c.doctorId, bedId: bed.id, reason: `From the emergency ward (${c.caseNumber}): ${input.note}`.slice(0, 300) });
        admissionId = adm.id; admissionNumber = adm.admissionNumber;
        // The handover: the ICU nurses and the ICU doctor are told, and find the whole emergency record on the patient's ICU page.
        if (input.disposition === "ICU") {
          const icuNurses = await this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, ["ICU_NURSE"]);
          await this.notifications.notify(tx, [...icuNurses, ...(icuDoctorUser ? [icuDoctorUser] : [])], { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "ICU_ADMITTED", entityType: "Admission", entityId: adm.id, dedupeKey: `ICU_ADMITTED:${adm.id}` });
        }
      }
      // What was charged during the emergency is frozen on an issued bill, to be paid at the emergency desk; later charges belong to the admission.
      const issued = await this.bill.issueOpen(tx, ctx, c.encounterId);
      if (!issued) await this.bill.closeEmpty(tx, ctx, c.encounterId);
      const res = await tx.emergencyCase.updateMany({
        where: { id: caseId, tenantId: ctx.tenantId, status: { in: [...OPEN] } },
        data: {
          status: input.disposition === "DISCHARGE" ? "DISCHARGED" : "HANDED_OVER", disposition: input.disposition, dispositionNote: input.note, dispositionAt: now, dispositionById: ctx.userId, admissionId,
          ...(c.doctorAcceptedAt === null ? { doctorAcceptedAt: now, doctorAcceptedById: ctx.userId } : {}), version: { increment: 1 },
        },
      });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This emergency case was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "EMERGENCY_DECISION", entityType: "EmergencyCase", entityId: caseId, metadata: { disposition: input.disposition, admissionId, admissionNumber, billIssued: issued?.invoiceNumber ?? null } });
      const tell = await this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, ["ER_TRIAGE", "ER_REGISTER"]);
      await this.notifications.notify(tx, tell, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "EMERGENCY_DECISION", entityType: "EmergencyCase", entityId: caseId, dedupeKey: `EMERGENCY_DECISION:${caseId}` });
      return this.detail(tx, ctx, await this.row(tx, ctx, caseId));
    });
  }

  // ───── the desk: the bill, and a patient registered by mistake ─────

  async addCharge(ctx: RequestContext, caseId: string, input: z.infer<typeof addChargeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lockOpen(tx, ctx, caseId);
      let line: { description: string; quantity: Decimal; unitPrice: Decimal; taxPercent: Decimal; serviceId: string | null; hsnSac: string | null };
      if ("serviceId" in input) {
        const s = await tx.service.findFirst({ where: { id: input.serviceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } });
        if (!s) throw new DomainError("VALIDATION_FAILED", "A selected service does not exist or is inactive", 400, [{ path: "serviceId", message: "Unknown or inactive service" }]);
        line = { description: s.name, quantity: input.quantity, unitPrice: new Decimal(s.price.toString()), taxPercent: new Decimal(s.taxPercent.toString()), serviceId: s.id, hsnSac: s.sacCode };
      } else {
        line = { description: input.description, quantity: input.quantity, unitPrice: input.unitPrice, taxPercent: new Decimal(0), serviceId: null, hsnSac: null };
      }
      await this.bill.addLines(tx, ctx, { id: c.encounterId, patientId: c.patientId }, [{ ...line, sourceType: "ER_CHARGE", sourceId: randomUUID() }]);
      await this.audit.record(tx, actorOf(ctx), { action: "EMERGENCY_CHARGE_ADDED", entityType: "EmergencyCase", entityId: caseId, metadata: { description: line.description, serviceId: line.serviceId } });
      return this.detail(tx, ctx, await this.row(tx, ctx, caseId));
    });
  }

  /** Issues the open emergency bill so it can be paid. Allowed after the doctor has decided, too (the bill is issued automatically then if it has charges). */
  async issueBill(ctx: RequestContext, caseId: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.emergencyCase.findFirst({ where: { id: caseId, ...this.scope(ctx) }, select: { id: true, encounterId: true } });
      if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const issued = await this.bill.issueOpen(tx, ctx, c.encounterId);
      if (!issued) throw new DomainError("INVALID_STATE", "There is nothing to issue: the open bill has no charges yet", 409);
      return this.detail(tx, ctx, await this.row(tx, ctx, caseId));
    });
  }

  /** A patient registered by mistake: allowed only while nothing has been done for them. */
  async cancel(ctx: RequestContext, caseId: string, input: z.infer<typeof cancelEmergencySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lockOpen(tx, ctx, caseId);
      if (c.status !== "ARRIVED") throw new DomainError("INVALID_STATE", "Only a patient who has not been triaged or seen yet can be cancelled", 409);
      const done = await Promise.all([
        tx.emergencyTriage.count({ where: { tenantId: ctx.tenantId, caseId } }), tx.emergencyNote.count({ where: { tenantId: ctx.tenantId, caseId } }),
        tx.observation.count({ where: { tenantId: ctx.tenantId, encounterId: c.encounterId } }), tx.medicationOrder.count({ where: { tenantId: ctx.tenantId, encounterId: c.encounterId } }),
        tx.testOrder.count({ where: { tenantId: ctx.tenantId, encounterId: c.encounterId } }), tx.invoice.count({ where: { tenantId: ctx.tenantId, encounterId: c.encounterId, status: { not: "DRAFT" } } }),
      ]);
      if (done.some((n) => n > 0)) throw new DomainError("INVALID_STATE", "Work has already been done for this patient, so the registration cannot be cancelled", 409);
      await tx.invoice.updateMany({ where: { tenantId: ctx.tenantId, encounterId: c.encounterId, kind: "EMERGENCY", status: "DRAFT" }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: ctx.userId, cancelReason: input.reason, version: { increment: 1 } } });
      await this.encounters.transition(tx, ctx, c.encounterId, "CANCELLED", input.reason);
      const res = await tx.emergencyCase.updateMany({ where: { id: caseId, tenantId: ctx.tenantId, status: "ARRIVED" }, data: { status: "CANCELLED", cancelReason: input.reason, version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This emergency case was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "EMERGENCY_CANCELLED", entityType: "EmergencyCase", entityId: caseId, metadata: { reason: input.reason } });
      return this.detail(tx, ctx, await this.row(tx, ctx, caseId));
    });
  }

  // ───── internals ─────

  private async row(db: Db, ctx: RequestContext, id: string): Promise<CaseRow> {
    return db.emergencyCase.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: CASE });
  }

  /** Locks the case for this transaction and checks it is still open. Someone outside the caller's data scope sees "not found". */
  private async lockOpen(tx: Db, ctx: RequestContext, caseId: string): Promise<CaseRow> {
    const visible = await tx.emergencyCase.findFirst({ where: { id: caseId, ...this.scope(ctx) }, select: { id: true } });
    const locked = visible ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "EmergencyCase" WHERE id = ${caseId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE` : [];
    if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const c = await this.row(tx, ctx, caseId);
    if (!(OPEN as readonly string[]).includes(c.status)) throw new DomainError("INVALID_STATE", "This emergency case is closed", 409);
    return c;
  }

  private async assertCalledDoctor(tx: Db, ctx: RequestContext, doctorId: string): Promise<void> {
    const d = await tx.practitioner.findFirst({ where: { id: doctorId, tenantId: ctx.tenantId }, select: { userId: true } });
    if (!d || d.userId !== ctx.userId) throw new DomainError("FORBIDDEN", "This patient was called to another doctor", 403);
  }

  private async markAccepted(tx: Db, ctx: RequestContext, c: CaseRow): Promise<void> {
    if (c.doctorAcceptedAt !== null) return;
    const res = await tx.emergencyCase.updateMany({ where: { id: c.id, tenantId: ctx.tenantId, doctorAcceptedAt: null, status: { in: [...OPEN] } }, data: { doctorAcceptedAt: new Date(), doctorAcceptedById: ctx.userId, status: "IN_TREATMENT", version: { increment: 1 } } });
    if (res.count === 1) await this.audit.record(tx, actorOf(ctx), { action: "EMERGENCY_ACCEPTED", entityType: "EmergencyCase", entityId: c.id, metadata: { caseNumber: c.caseNumber } });
  }
}
