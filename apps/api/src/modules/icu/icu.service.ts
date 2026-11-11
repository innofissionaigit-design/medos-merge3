import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { admissionScope } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly, localDateStr, startOfLocalDay, endOfLocalDay } from "../../common/time";
import { NotificationsService } from "../notifications/notifications.service";
import { currentAge } from "../patients/patient.domain";
import { SettingsService } from "../settings/settings.service";

export const INTERVALS = [5, 15, 60, 120] as const;

export const vitalsScheduleSchema = z.object({ intervalMinutes: z.union([z.literal(5), z.literal(15), z.literal(60), z.literal(120)]), reason: z.string().trim().min(3).max(300).optional() }).strict();
export const instructionSchema = z.object({ text: z.string().trim().min(3).max(1000), urgent: z.boolean().default(false) }).strict();
export const instructionDoneSchema = z.object({ note: z.string().trim().min(1).max(500).optional() }).strict();
export const dayNoteSchema = z.object({ text: z.string().trim().min(3).max(4000), plan: z.string().trim().min(3).max(2000).optional() }).strict();
export const listStaysSchema = z.object({ q: z.string().trim().min(2).max(60).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }).strict();

const nameOf = (p: { firstName: string; lastName: string | null }): string => [p.firstName, p.lastName].filter(Boolean).join(" ");
const KEY_VITALS = ["PULSE", "SYSTOLIC_BP", "DIASTOLIC_BP", "SPO2", "TEMPERATURE", "RESPIRATORY_RATE", "BLOOD_GLUCOSE"] as const;

const STAY = {
  id: true, admissionNumber: true, status: true, admittedAt: true, reason: true, encounterId: true, patientId: true, consultantId: true,
  patient: { select: { firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true, ageRecordedOn: true, bloodGroup: true, identifiers: { where: { type: "MRN" as const }, select: { value: true } } } },
  consultant: { select: { displayName: true, userId: true } },
  assignments: { where: { releasedAt: null }, select: { assignedAt: true, bed: { select: { code: true, room: { select: { name: true } }, ward: { select: { code: true, name: true } } } } }, take: 1 },
  encounter: { select: { emergencyCase: { select: { id: true, caseNumber: true } } } },
} satisfies Prisma.AdmissionSelect;
type StayRow = Prisma.AdmissionGetPayload<{ select: typeof STAY }>;

/**
 * The intensive care unit (docs/icu.md). An ICU stay is an admission whose bed is in the ICU ward. The ICU doctor sets how often vitals are taken (every 5, 15, 60 or 120 minutes), writes
 * instructions for the nurse and keeps the day-by-day record; the ICU nurse records the vitals (the visit's ordinary observations) and marks the instructions done. Both read the same record,
 * including what was done in the emergency ward when the patient came from there.
 */
@Injectable()
export class IcuService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notifications: NotificationsService, private readonly settings: SettingsService) {}

  private icuCode(db: Db | PrismaService, ctx: RequestContext) { return this.settings.get(db, ctx.tenantId, ctx.facilityId, "EMERGENCY_ICU_WARD_CODE"); }
  private async tz(db: Db | PrismaService, ctx: RequestContext): Promise<string> {
    return (await db.facility.findFirst({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } }))?.timezone ?? "Asia/Kolkata";
  }

  /** The admissions that are in an ICU bed now, within the caller's data scope. */
  private async where(db: Db | PrismaService, ctx: RequestContext, extra: Prisma.AdmissionWhereInput = {}): Promise<Prisma.AdmissionWhereInput> {
    const code = await this.icuCode(db, ctx);
    return { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ADMITTED", assignments: { some: { releasedAt: null, bed: { ward: { code } } } }, AND: [admissionScope(ctx), extra] };
  }

  /** When the next vitals are due: one interval after the last reading taken since the interval was set, or after the interval was set when there is none yet. */
  private due(order: { intervalMinutes: number; setAt: Date } | null, lastAt: Date | null, now = new Date()) {
    if (!order) return { intervalMinutes: null, nextDueAt: null, overdue: false, minutesLate: 0 };
    const base = lastAt && lastAt.getTime() >= order.setAt.getTime() ? lastAt : order.setAt;
    const nextDueAt = new Date(base.getTime() + order.intervalMinutes * 60_000);
    const late = Math.max(0, Math.floor((now.getTime() - nextDueAt.getTime()) / 60_000));
    return { intervalMinutes: order.intervalMinutes, nextDueAt, overdue: late > 0, minutesLate: late };
  }

  private async lastReadings(db: Db | PrismaService, ctx: RequestContext, encounterIds: string[]) {
    const rows = await db.observation.findMany({
      where: { tenantId: ctx.tenantId, encounterId: { in: encounterIds }, status: "FINAL", derived: false },
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }], take: encounterIds.length * 60, select: { encounterId: true, type: true, value: true, unit: true, recordedAt: true },
    });
    const out = new Map<string, { lastAt: Date | null; latest: Record<string, { value: string; unit: string; at: Date }> }>();
    for (const id of encounterIds) out.set(id, { lastAt: null, latest: {} });
    for (const r of rows) {
      const e = out.get(r.encounterId) as { lastAt: Date | null; latest: Record<string, { value: string; unit: string; at: Date }> };
      if (!e.lastAt || r.recordedAt > e.lastAt) e.lastAt = r.recordedAt;
      if (!e.latest[r.type]) e.latest[r.type] = { value: r.value.toString(), unit: r.unit, at: r.recordedAt };
    }
    return out;
  }

  // ───── the board ─────

  async stays(ctx: RequestContext, q: z.infer<typeof listStaysSchema>) {
    const text = q.q?.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
    const where = await this.where(this.prisma, ctx, text ? { OR: [{ admissionNumber: { contains: q.q!, mode: "insensitive" } }, { patient: { searchName: { contains: text } } }, { patient: { identifiers: { some: { type: "MRN" as const, value: { contains: q.q!, mode: "insensitive" as const } } } } }] } : {});
    const [rows, total] = await Promise.all([
      this.prisma.admission.findMany({ where, select: STAY, orderBy: { admittedAt: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.admission.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const encIds = rows.map((r) => r.encounterId);
    const [orders, instr, tests, reads] = await Promise.all([
      this.prisma.icuVitalsOrder.findMany({ where: { tenantId: ctx.tenantId, admissionId: { in: ids } }, orderBy: { setAt: "desc" }, select: { admissionId: true, intervalMinutes: true, setAt: true } }),
      this.prisma.icuInstruction.groupBy({ by: ["admissionId", "urgent"], where: { tenantId: ctx.tenantId, admissionId: { in: ids }, status: "OPEN" }, _count: { _all: true } }),
      this.prisma.limsRequest.groupBy({ by: ["encounterId"], where: { tenantId: ctx.tenantId, encounterId: { in: encIds }, status: { notIn: ["ISSUED", "HANDED_OVER", "CANCELLED"] } }, _count: { _all: true } }),
      this.lastReadings(this.prisma, ctx, encIds),
    ]);
    const now = new Date();
    const items = rows.map((r) => {
      const order = orders.find((o) => o.admissionId === r.id) ?? null;
      const rd = reads.get(r.encounterId);
      const bed = r.assignments[0]?.bed;
      return {
        id: r.id, admissionNumber: r.admissionNumber, encounterId: r.encounterId,
        patient: { id: r.patientId, name: nameOf(r.patient), mrn: r.patient.identifiers[0]?.value ?? null, gender: r.patient.gender, age: currentAge(r.patient) },
        bed: bed ? `${bed.room.name} · ${bed.code}` : null, doctorName: r.consultant.displayName, calledByMe: r.consultant.userId === ctx.userId, inIcuSince: r.assignments[0]?.assignedAt ?? r.admittedAt,
        fromEmergency: r.encounter.emergencyCase?.caseNumber ?? null,
        schedule: { ...this.due(order, rd?.lastAt ?? null, now), lastVitalsAt: rd?.lastAt ?? null },
        latest: Object.fromEntries(KEY_VITALS.flatMap((k) => (rd?.latest[k] ? [[k, rd.latest[k]]] : []))),
        openInstructions: instr.filter((i) => i.admissionId === r.id).reduce((n, i) => n + i._count._all, 0), urgentInstructions: instr.filter((i) => i.admissionId === r.id && i.urgent).reduce((n, i) => n + i._count._all, 0),
        pendingTests: tests.find((t) => t.encounterId === r.encounterId)?._count._all ?? 0,
      };
    });
    return { items, total };
  }

  /** What the ICU nurse must act on now: vitals overdue, and urgent instructions still open. */
  async alerts(ctx: RequestContext) {
    if (!ctx.permissions.has("ICU_NURSE")) return [];
    const { items } = await this.stays(ctx, { page: 1, pageSize: 100 });
    return items.flatMap((s) => [
      ...(s.schedule.overdue ? [{ admissionId: s.id, patientName: s.patient.name, bed: s.bed, kind: "VITALS_OVERDUE" as const, detail: `${s.schedule.minutesLate} min late (every ${s.schedule.intervalMinutes} min)` }] : []),
      ...(s.urgentInstructions > 0 ? [{ admissionId: s.id, patientName: s.patient.name, bed: s.bed, kind: "URGENT_INSTRUCTION" as const, detail: `${s.urgentInstructions} urgent instruction(s) from the doctor` }] : []),
    ]);
  }

  // ───── one stay ─────

  private async load(db: Db | PrismaService, ctx: RequestContext, admissionId: string): Promise<StayRow> {
    const a = await db.admission.findFirst({ where: { id: admissionId, ...(await this.where(db, ctx)) }, select: STAY });
    if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return a;
  }

  async get(ctx: RequestContext, admissionId: string) {
    const a = await this.load(this.prisma, ctx, admissionId);
    const tz = await this.tz(this.prisma, ctx);
    const since = a.assignments[0]?.assignedAt ?? a.admittedAt;
    const [orders, instr, notes, obs, lims, allergies, caseRow] = await Promise.all([
      this.prisma.icuVitalsOrder.findMany({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: { setAt: "desc" }, take: 50 }),
      this.prisma.icuInstruction.findMany({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: { createdAt: "desc" }, take: 200 }),
      this.prisma.icuDayNote.findMany({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: [{ day: "desc" }, { createdAt: "desc" }], take: 300 }),
      this.prisma.observation.findMany({ where: { tenantId: ctx.tenantId, encounterId: a.encounterId, status: "FINAL", derived: false }, orderBy: { recordedAt: "desc" }, take: 600, select: { type: true, value: true, unit: true, recordedAt: true, recordedById: true } }),
      this.prisma.limsRequest.findMany({ where: { tenantId: ctx.tenantId, encounterId: a.encounterId, status: { not: "CANCELLED" } }, select: { status: true, priority: true, createdAt: true } }),
      this.prisma.allergy.findMany({ where: { tenantId: ctx.tenantId, patientId: a.patientId, status: "ACTIVE" }, select: { allergen: true, severity: true, reaction: true }, take: 20 }),
      a.encounter.emergencyCase ? this.prisma.emergencyCase.findFirst({ where: { id: a.encounter.emergencyCase.id, tenantId: ctx.tenantId }, select: { caseNumber: true, chiefComplaint: true, arrivedAt: true, arrivalMode: true, dispositionNote: true, dispositionAt: true, doctor: { select: { displayName: true } }, triages: { orderBy: { triagedAt: "desc" }, take: 20 }, notes: { orderBy: { createdAt: "asc" }, take: 50 } } }) : Promise.resolve(null),
    ]);
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set([...orders.map((o) => o.setById), ...instr.flatMap((i) => [i.createdById, ...(i.doneById ? [i.doneById] : [])]), ...notes.map((n) => n.authorId), ...obs.map((o) => o.recordedById), ...(caseRow?.triages.map((t) => t.triagedById) ?? []), ...(caseRow?.notes.map((n) => n.authorId) ?? [])])] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    // Readings grouped by the minute they were taken, in the ICU or before it (in the emergency ward).
    const groups = new Map<string, { at: Date; by: string | null; phase: "ICU" | "BEFORE"; values: Record<string, { value: string; unit: string }> }>();
    for (const o of obs) {
      const k = `${o.recordedAt.toISOString().slice(0, 16)}|${o.recordedById}`;
      const g = groups.get(k) ?? { at: o.recordedAt, by: users.get(o.recordedById) ?? null, phase: o.recordedAt >= since ? ("ICU" as const) : ("BEFORE" as const), values: {} };
      g.values[o.type] = { value: o.value.toString(), unit: o.unit };
      groups.set(k, g);
    }
    const readings = [...groups.values()].sort((x, y) => y.at.getTime() - x.at.getTime());
    const lastAt = obs[0]?.recordedAt ?? null;
    const order = orders[0] ?? null;
    const latest: Record<string, { value: string; unit: string; at: Date }> = {};
    for (const o of obs) if (!latest[o.type]) latest[o.type] = { value: o.value.toString(), unit: o.unit, at: o.recordedAt };
    // Day by day, from the day the patient came to the ICU to today (hospital time).
    const today = localDateStr(new Date(), tz);
    const first = localDateStr(since, tz);
    const notesView = notes.map((n) => ({ id: n.id, day: n.day.toISOString().slice(0, 10), text: n.text, plan: n.plan, author: users.get(n.authorId) ?? null, createdAt: n.createdAt }));
    const days: { day: string; dayNumber: number; notes: typeof notesView; vitals: { count: number; pulse: [number, number] | null; systolic: [number, number] | null; spo2: [number, number] | null }; instructionsGiven: number; instructionsDone: number; testsOrdered: number }[] = [];
    for (let d = first, n = 1; d <= today && n <= 90; n++, d = new Date(dateOnly(d).getTime() + 86_400_000).toISOString().slice(0, 10)) {
      const from = startOfLocalDay(d, tz); const to = endOfLocalDay(d, tz);
      const inDay = (t: Date) => t >= from && t <= to;
      const dayObs = obs.filter((o) => inDay(o.recordedAt));
      const range = (type: string): [number, number] | null => { const v = dayObs.filter((o) => o.type === type).map((o) => Number(o.value)); return v.length ? [Math.min(...v), Math.max(...v)] : null; };
      days.push({
        day: d, dayNumber: n, notes: notesView.filter((x) => x.day === d), vitals: { count: new Set(dayObs.map((o) => o.recordedAt.toISOString().slice(0, 16))).size, pulse: range("PULSE"), systolic: range("SYSTOLIC_BP"), spo2: range("SPO2") },
        instructionsGiven: instr.filter((i) => inDay(i.createdAt)).length, instructionsDone: instr.filter((i) => i.doneAt && inDay(i.doneAt)).length, testsOrdered: lims.filter((l) => inDay(l.createdAt)).length,
      });
    }
    days.reverse();
    return {
      id: a.id, admissionNumber: a.admissionNumber, encounterId: a.encounterId, reason: a.reason, admittedAt: a.admittedAt, inIcuSince: since,
      patient: { id: a.patientId, name: nameOf(a.patient), mrn: a.patient.identifiers[0]?.value ?? null, gender: a.patient.gender, age: currentAge(a.patient), bloodGroup: a.patient.bloodGroup },
      bed: a.assignments[0] ? `${a.assignments[0].bed.room.name} · ${a.assignments[0].bed.code}` : null, doctorName: a.consultant.displayName, calledByMe: a.consultant.userId === ctx.userId,
      schedule: { ...this.due(order, lastAt), lastVitalsAt: lastAt, setBy: order ? users.get(order.setById) ?? null : null, setAt: order?.setAt ?? null, reason: order?.reason ?? null, history: orders.map((o) => ({ intervalMinutes: o.intervalMinutes, setAt: o.setAt, setBy: users.get(o.setById) ?? null, reason: o.reason })) },
      latest, readings: readings.slice(0, 120),
      instructions: instr.map((i) => ({ id: i.id, text: i.text, urgent: i.urgent, status: i.status, createdAt: i.createdAt, createdBy: users.get(i.createdById) ?? null, doneAt: i.doneAt, doneBy: i.doneById ? users.get(i.doneById) ?? null : null, doneNote: i.doneNote })),
      days, allergies,
      tests: { total: lims.length, pending: lims.filter((l) => !["ISSUED", "HANDED_OVER"].includes(l.status)).length },
      fromEmergency: caseRow ? {
        caseId: a.encounter.emergencyCase?.id ?? null, caseNumber: caseRow.caseNumber, complaint: caseRow.chiefComplaint, arrivedAt: caseRow.arrivedAt, arrivalMode: caseRow.arrivalMode, doctor: caseRow.doctor.displayName, handoverNote: caseRow.dispositionNote, handedOverAt: caseRow.dispositionAt,
        triages: caseRow.triages.map((t) => ({ level: t.level, consciousness: t.consciousness, airwayClear: t.airwayClear, breathingOk: t.breathingOk, circulationOk: t.circulationOk, painScore: t.painScore, note: t.note, at: t.triagedAt, by: users.get(t.triagedById) ?? null })),
        notes: caseRow.notes.map((n) => ({ kind: n.kind, text: n.text, diagnosis: n.diagnosis, at: n.createdAt, by: users.get(n.authorId) ?? null })),
      } : null,
    };
  }

  // ───── the ICU doctor ─────

  private async assertCalledDoctor(tx: Db, ctx: RequestContext, a: StayRow): Promise<void> {
    if (a.consultant.userId !== ctx.userId) throw new DomainError("FORBIDDEN", "This patient is under another doctor", 403);
  }

  private async tellNurses(tx: Db, ctx: RequestContext, type: "ICU_INSTRUCTION" | "ICU_VITALS_SCHEDULE", admissionId: string, dedupe: string): Promise<void> {
    const nurses = await this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, ["ICU_NURSE"]);
    await this.notifications.notify(tx, nurses, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type, entityType: "Admission", entityId: admissionId, dedupeKey: `${type}:${dedupe}` });
  }

  async setSchedule(ctx: RequestContext, admissionId: string, input: z.infer<typeof vitalsScheduleSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const a = await this.lock(tx, ctx, admissionId);
      await this.assertCalledDoctor(tx, ctx, a);
      const row = await tx.icuVitalsOrder.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, intervalMinutes: input.intervalMinutes, reason: input.reason ?? null, setById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "ICU_VITALS_SCHEDULE_SET", entityType: "Admission", entityId: admissionId, metadata: { intervalMinutes: input.intervalMinutes, orderId: row.id } });
      await this.tellNurses(tx, ctx, "ICU_VITALS_SCHEDULE", admissionId, row.id);
    });
    return this.get(ctx, admissionId);
  }

  async addInstruction(ctx: RequestContext, admissionId: string, input: z.infer<typeof instructionSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const a = await this.lock(tx, ctx, admissionId);
      await this.assertCalledDoctor(tx, ctx, a);
      const row = await tx.icuInstruction.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, text: input.text, urgent: input.urgent, createdById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "ICU_INSTRUCTION_GIVEN", entityType: "Admission", entityId: admissionId, metadata: { instructionId: row.id, urgent: input.urgent } });
      await this.tellNurses(tx, ctx, "ICU_INSTRUCTION", admissionId, row.id);
    });
    return this.get(ctx, admissionId);
  }

  async addDayNote(ctx: RequestContext, admissionId: string, input: z.infer<typeof dayNoteSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const a = await this.lock(tx, ctx, admissionId);
      await this.assertCalledDoctor(tx, ctx, a);
      const day = dateOnly(localDateStr(new Date(), await this.tz(tx, ctx)));
      const row = await tx.icuDayNote.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, day, text: input.text, plan: input.plan ?? null, authorId: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "ICU_DAY_NOTE_ADDED", entityType: "Admission", entityId: admissionId, metadata: { noteId: row.id } });
    });
    return this.get(ctx, admissionId);
  }

  // ───── the ICU nurse ─────

  async completeInstruction(ctx: RequestContext, instructionId: string, input: z.infer<typeof instructionDoneSchema>) {
    const admissionId = await this.prisma.$transaction(async (tx) => {
      const i = await tx.icuInstruction.findFirst({ where: { id: instructionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, admissionId: true } });
      if (!i) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await this.lock(tx, ctx, i.admissionId);
      const res = await tx.icuInstruction.updateMany({ where: { id: i.id, tenantId: ctx.tenantId, status: "OPEN" }, data: { status: "DONE", doneById: ctx.userId, doneAt: new Date(), doneNote: input.note ?? null } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This instruction was already marked done", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "ICU_INSTRUCTION_DONE", entityType: "Admission", entityId: i.admissionId, metadata: { instructionId: i.id } });
      return i.admissionId;
    });
    return this.get(ctx, admissionId);
  }

  /** The stay, locked for this transaction, and still in the ICU and in the caller's scope. */
  private async lock(tx: Db, ctx: RequestContext, admissionId: string): Promise<StayRow> {
    const a = await this.load(tx, ctx, admissionId);
    await tx.$queryRaw`SELECT id FROM "Admission" WHERE id = ${admissionId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid FOR UPDATE`;
    return a;
  }
}
