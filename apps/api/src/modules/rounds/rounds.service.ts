import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { admissionScope } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { dateOnly, localDateStr, zonedToUtc } from "../../common/time";
import { NotificationsService } from "../notifications/notifications.service";
import { SettingsService } from "../settings/settings.service";
import { clock, clock12, INSTRUCTION_SOURCE, ROUND_FIRE_WINDOW_MIN } from "./rounds.domain";
import { patientSnapshots } from "./round-snapshots";

const uuid = z.string().uuid();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 07:00").transform((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));

export const slotSchema = z.object({ time: hhmm, label: text(2, 40).optional(), practitionerId: uuid.nullable().optional() }).strict();
export const slotUpdateSchema = z.object({ time: hhmm.optional(), label: text(2, 40).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }).strict()
  .refine((v) => Object.keys(v).length > 0, "No changes supplied");
export const instructionSchema = z.object({ text: text(3, 160), dueInMinutes: z.number().int().min(0).max(1440).default(60) }).strict();
export const roundNoteSchema = z.object({
  roundId: uuid.optional(), condition: z.enum(["IMPROVING", "STABLE", "WORSENING", "CRITICAL"]).optional(), note: text(3, 2000), plan: text(3, 1000).optional(),
  instructions: z.array(instructionSchema).max(10).default([]), addendumOfId: uuid.optional(),
}).strict();
export const errorSchema = z.object({ reason: text(3, 240) }).strict();

const NOTE_VIEW = { id: true, roundId: true, admissionId: true, condition: true, note: true, plan: true, instructions: true, addendumOfId: true, status: true, errorReason: true, createdAt: true, practitionerId: true, authorId: true } satisfies Prisma.RoundNoteSelect;

/**
 * Ward rounds (docs/ward-rounds.md). The ward coordinator sets the round times; this service tells each doctor who has admitted patients when a time comes, lets the doctor start the round,
 * write a note for each patient (instructions in the note become nursing tasks) and finish it, and tells the coordinator when a round was not started in time.
 */
@Injectable()
export class RoundsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notifications: NotificationsService, private readonly settings: SettingsService) {}

  // ───── round times ─────

  private async tz(db: Db, ctx: { tenantId: string; facilityId: string }): Promise<string> {
    return (await db.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
  }

  private slotView(s: { id: string; label: string; minutesOfDay: number; practitionerId: string | null; status: string; practitioner?: { displayName: string } | null }) {
    return { id: s.id, label: s.label, time: clock(s.minutesOfDay), time12: clock12(s.minutesOfDay), minutesOfDay: s.minutesOfDay, practitionerId: s.practitionerId, doctor: s.practitioner?.displayName ?? null, forAllDoctors: s.practitionerId === null, status: s.status };
  }

  async slots(ctx: RequestContext) {
    const rows = await this.prisma.roundSlot.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, orderBy: [{ status: "asc" }, { minutesOfDay: "asc" }], include: { practitioner: { select: { displayName: true } } }, take: 200 });
    return rows.map((s) => this.slotView(s));
  }

  async createSlot(ctx: RequestContext, input: z.infer<typeof slotSchema>) {
    return this.prisma.$transaction(async (tx) => {
      if (input.practitionerId) {
        const p = await tx.practitioner.findFirst({ where: { id: input.practitionerId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true } });
        if (!p) throw new DomainError("VALIDATION_FAILED", "Doctor not found or inactive at this facility", 400, [{ path: "practitionerId", message: "Unknown doctor" }]);
      }
      try {
        const s = await tx.roundSlot.create({
          data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, label: input.label ?? `Round at ${clock12(input.time)}`, minutesOfDay: input.time, practitionerId: input.practitionerId ?? null, createdById: ctx.userId },
          include: { practitioner: { select: { displayName: true } } },
        });
        await this.audit.record(tx, actorOf(ctx), { action: "ROUND_SLOT_CREATED", entityType: "RoundSlot", entityId: s.id, metadata: { time: clock(s.minutesOfDay), practitionerId: s.practitionerId ?? "" } });
        return this.slotView(s);
      } catch (e) {
        if ((e as { code?: string }).code === "P2002" || /RoundSlot_one/.test(String((e as Error).message))) throw new DomainError("CONFLICT", `A round is already set at ${clock12(input.time)}`, 409);
        throw e;
      }
    });
  }

  async updateSlot(ctx: RequestContext, id: string, input: z.infer<typeof slotUpdateSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.roundSlot.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!before) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      try {
        const s = await tx.roundSlot.update({
          where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { ...(input.time !== undefined ? { minutesOfDay: input.time } : {}), ...(input.label ? { label: input.label } : {}), ...(input.status ? { status: input.status } : {}) },
          include: { practitioner: { select: { displayName: true } } },
        });
        await this.audit.record(tx, actorOf(ctx), { action: "ROUND_SLOT_UPDATED", entityType: "RoundSlot", entityId: id, metadata: { from: clock(before.minutesOfDay), to: clock(s.minutesOfDay), status: s.status } });
        return this.slotView(s);
      } catch (e) {
        if ((e as { code?: string }).code === "P2002" || /RoundSlot_one/.test(String((e as Error).message))) throw new DomainError("CONFLICT", "Another round is already set at that time", 409);
        throw e;
      }
    });
  }

  // ───── telling the doctors ─────

  /**
   * For one facility: each active round time that has come (within the last few hours) makes a round for every doctor who has admitted patients, and tells the doctor. A round the doctor
   * did not start within the facility's allowed time is marked missed and the coordinator is told. Safe to run again and again: a round is one row per doctor, time and day.
   */
  async fireFacility(tenantId: string, facilityId: string, now = new Date()): Promise<{ created: number; missed: number }> {
    return this.prisma.$transaction(async (tx) => {
      const ctx = { tenantId, facilityId };
      const tz = await this.tz(tx, ctx);
      const today = localDateStr(now, tz);
      const slots = await tx.roundSlot.findMany({ where: { tenantId, facilityId, status: "ACTIVE" } });
      let created = 0;
      for (const slot of slots) {
        const scheduledAt = zonedToUtc(today, slot.minutesOfDay, tz);
        if (scheduledAt > now || now.getTime() - scheduledAt.getTime() > ROUND_FIRE_WINDOW_MIN * 60_000) continue;
        const doctors = await tx.practitioner.findMany({
          where: {
            tenantId, facilityId, status: "ACTIVE", userId: { not: null }, ...(slot.practitionerId ? { id: slot.practitionerId } : {}),
            user: { status: "ACTIVE", roles: { some: { role: { permissions: { some: { permission: "ROUND_DO" } } } } } },
            admissions: { some: { status: "ADMITTED", facilityId } },
          },
          select: { id: true, userId: true },
        });
        if (doctors.length === 0) continue;
        const made = await tx.wardRound.createManyAndReturn({
          data: doctors.map((d) => ({ tenantId, facilityId, practitionerId: d.id, slotId: slot.id, roundDate: dateOnly(today), scheduledAt, label: slot.label })), skipDuplicates: true,
          select: { id: true, practitionerId: true },
        });
        created += made.length;
        for (const r of made) {
          const userId = doctors.find((d) => d.id === r.practitionerId)?.userId;
          if (userId) await this.notifications.notify(tx, [userId], { tenantId, facilityId, type: "ROUND_DUE", entityType: "WardRound", entityId: r.id, dedupeKey: `ROUND_DUE:${r.id}` });
        }
      }
      const missedAfter = await this.settings.get(tx, tenantId, facilityId, "ROUND_MISSED_AFTER_MINUTES");
      const late = await tx.wardRound.findMany({ where: { tenantId, facilityId, status: "NOTIFIED", scheduledAt: { lt: new Date(now.getTime() - missedAfter * 60_000) } }, select: { id: true, label: true, practitioner: { select: { displayName: true } } } });
      let missed = 0;
      if (late.length > 0) {
        const bosses = await this.notifications.recipientsWith(tx, tenantId, facilityId, ["ROUND_MANAGE"]);
        for (const r of late) {
          const res = await tx.wardRound.updateMany({ where: { id: r.id, tenantId, status: "NOTIFIED" }, data: { status: "MISSED", missedAt: now } });
          if (res.count !== 1) continue;
          missed++;
          await this.audit.record(tx, { tenantId, facilityId, userId: null }, { action: "ROUND_MISSED", entityType: "WardRound", entityId: r.id, metadata: { label: r.label, doctor: r.practitioner.displayName } });
          await this.notifications.notify(tx, bosses, { tenantId, facilityId, type: "ROUND_MISSED", entityType: "WardRound", entityId: r.id, dedupeKey: `ROUND_MISSED:${r.id}` });
        }
      }
      return { created, missed };
    });
  }

  /** The worker: every hospital that has round times, one hospital at a time under its own scope (docs/rls.md). */
  async runDue(now = new Date()): Promise<{ created: number; missed: number }> {
    const tenants = await tenantScope.system("round worker: hospitals with round times", () => this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_round_slots()::text AS tenant_id`);
    const total = { created: 0, missed: 0 };
    for (const { tenant_id: tenantId } of tenants) {
      await tenantScope.run(tenantId, async () => {
        const facilities = await this.prisma.facility.findMany({ where: { tenantId, status: "ACTIVE" }, select: { id: true } });
        for (const f of facilities) {
          const r = await this.fireFacility(tenantId, f.id, now);
          total.created += r.created; total.missed += r.missed;
        }
      });
    }
    return total;
  }

  // ───── the doctor's side ─────

  /** The doctor of the signed-in user at this facility, or "not a doctor". */
  private async me(db: Db, ctx: RequestContext) {
    const p = await db.practitioner.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId, status: "ACTIVE" }, select: { id: true, displayName: true } });
    if (!p) throw new DomainError("FORBIDDEN", "Only a doctor with a practitioner record can make rounds", 403);
    return p;
  }

  private roundView(r: { id: string; slotId: string; label: string; scheduledAt: Date; status: string; startedAt: Date | null; completedAt: Date | null; patientsSeen: number | null; patientsTotal: number | null; practitioner?: { displayName: string } | null }) {
    return { id: r.id, slotId: r.slotId, label: r.label, scheduledAt: r.scheduledAt, status: r.status, startedAt: r.startedAt, completedAt: r.completedAt, patientsSeen: r.patientsSeen, patientsTotal: r.patientsTotal, doctor: r.practitioner?.displayName ?? null };
  }

  /** The doctor's round times (set by the ward coordinator) and today's rounds. This is what the doctor's profile shows. */
  async myRounds(ctx: RequestContext, now = new Date()) {
    const me = await this.me(this.prisma, ctx);
    const tz = await this.tz(this.prisma, ctx);
    const today = localDateStr(now, tz);
    const [slots, rounds, patients] = await Promise.all([
      this.prisma.roundSlot.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", OR: [{ practitionerId: null }, { practitionerId: me.id }] }, orderBy: { minutesOfDay: "asc" } }),
      this.prisma.wardRound.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId: me.id, roundDate: dateOnly(today) }, orderBy: { scheduledAt: "asc" } }),
      this.prisma.admission.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, consultantId: me.id, status: "ADMITTED" } }),
    ]);
    return {
      doctor: me.displayName, today, timezone: tz, admittedPatients: patients,
      timings: slots.map((s) => ({ ...this.slotView(s), scheduledAt: zonedToUtc(today, s.minutesOfDay, tz), round: rounds.find((r) => r.slotId === s.id)?.id ?? null })),
      rounds: rounds.map((r) => this.roundView(r)),
    };
  }

  /** Every round the facility has today, with the doctor and how far it has got (for the coordinator). */
  async todaysRounds(ctx: RequestContext, now = new Date()) {
    const today = localDateStr(now, await this.tz(this.prisma, ctx));
    const rows = await this.prisma.wardRound.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, roundDate: dateOnly(today) }, orderBy: [{ scheduledAt: "asc" }, { id: "asc" }], include: { practitioner: { select: { displayName: true } }, notes: { where: { status: "ACTIVE" }, select: { admissionId: true } } } });
    return rows.map((r) => ({ ...this.roundView(r), seenNow: new Set(r.notes.map((n) => n.admissionId)).size }));
  }

  private async ownRound(tx: Db, ctx: RequestContext, id: string) {
    const me = await this.me(tx, ctx);
    const r = await tx.wardRound.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId: me.id } });
    if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return { me, round: r };
  }

  /** The doctor has seen the notice and goes for the round. */
  async start(ctx: RequestContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const { round } = await this.ownRound(tx, ctx, id);
      if (round.status === "STARTED") return;
      if (round.status === "COMPLETED") throw new DomainError("INVALID_STATE", "This round is already finished", 409);
      const res = await tx.wardRound.updateMany({ where: { id, tenantId: ctx.tenantId, status: { in: ["NOTIFIED", "MISSED"] } }, data: { status: "STARTED", startedAt: new Date() } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The round was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "ROUND_STARTED", entityType: "WardRound", entityId: id, metadata: { late: round.status === "MISSED" } });
    });
    return this.round(ctx, id);
  }

  /** The doctor's patients for a round, with what is going on with each. */
  async round(ctx: RequestContext, id: string, now = new Date()) {
    const { me, round } = await this.ownRound(this.prisma, ctx, id);
    const adms = await this.prisma.admission.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, consultantId: me.id, status: "ADMITTED" }, orderBy: { admittedAt: "asc" }, take: 200,
      select: { id: true, admissionNumber: true, admittedAt: true, reason: true, encounterId: true, patientId: true, patient: { select: { firstName: true, lastName: true, gender: true, dateOfBirth: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, assignments: { where: { releasedAt: null }, select: { bed: { select: { code: true, ward: { select: { name: true } } } } } } },
    });
    const snaps = await patientSnapshots(this.prisma, ctx, adms, now, id);
    const patients = adms.map((a) => {
      const bed = a.assignments[0]?.bed;
      return {
        admissionId: a.id, admissionNumber: a.admissionNumber, patientId: a.patientId, patientName: [a.patient.firstName, a.patient.lastName].filter(Boolean).join(" "), gender: a.patient.gender, mrn: a.patient.identifiers[0]?.value ?? null,
        bed: bed?.code ?? null, ward: bed?.ward.name ?? null, reason: a.reason, admittedAt: a.admittedAt, ...snaps.get(a.id)!,
      };
    }).sort((x, y) => (x.seenThisRound === y.seenThisRound ? (x.bed ?? "").localeCompare(y.bed ?? "") : x.seenThisRound ? 1 : -1));
    return { round: this.roundView(round), doctor: me.displayName, seen: patients.filter((p) => p.seenThisRound).length, total: patients.length, patients };
  }

  /** The doctor finishes the round; how many patients were seen is kept. */
  async complete(ctx: RequestContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const { me, round } = await this.ownRound(tx, ctx, id);
      if (round.status !== "STARTED") throw new DomainError("INVALID_STATE", round.status === "COMPLETED" ? "This round is already finished" : "Start the round first", 409);
      const total = await tx.admission.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, consultantId: me.id, status: "ADMITTED" } });
      const seenRows = await tx.roundNote.findMany({ where: { tenantId: ctx.tenantId, roundId: id, status: "ACTIVE" }, select: { admissionId: true }, distinct: ["admissionId"] });
      const seen = Math.min(seenRows.length, total);
      const res = await tx.wardRound.updateMany({ where: { id, tenantId: ctx.tenantId, status: "STARTED" }, data: { status: "COMPLETED", completedAt: new Date(), patientsTotal: total, patientsSeen: seen } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The round was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "ROUND_COMPLETED", entityType: "WardRound", entityId: id, metadata: { seen, total } });
    });
    return this.round(ctx, id);
  }

  // ───── notes ─────

  /**
   * The doctor's note on one patient: how the patient is, the plan, and instructions for the nurses (each becomes a task on the nurses' list, due when the doctor says). Only the
   * doctor in charge of the patient writes it. A note is never rewritten: a correction is another note that refers to it.
   */
  async addNote(ctx: RequestContext, admissionId: string, input: z.infer<typeof roundNoteSchema>) {
    const id = await this.prisma.$transaction(async (tx) => {
      const me = await this.me(tx, ctx);
      const adm = await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { id: true, status: true, consultantId: true, encounterId: true, patientId: true } });
      if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "Notes are written for a patient who is admitted", 409);
      if (adm.consultantId !== me.id) throw new DomainError("FORBIDDEN", "This patient is under another doctor", 403);
      let roundId: string | null = null;
      if (input.roundId) {
        const r = await tx.wardRound.findFirst({ where: { id: input.roundId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId: me.id } });
        if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        if (r.status === "COMPLETED") throw new DomainError("INVALID_STATE", "This round is already finished", 409);
        if (r.status !== "STARTED") await tx.wardRound.updateMany({ where: { id: r.id, tenantId: ctx.tenantId, status: { in: ["NOTIFIED", "MISSED"] } }, data: { status: "STARTED", startedAt: new Date() } });
        roundId = r.id;
      }
      if (input.addendumOfId) {
        const orig = await tx.roundNote.findFirst({ where: { id: input.addendumOfId, tenantId: ctx.tenantId, admissionId, status: "ACTIVE" }, select: { id: true } });
        if (!orig) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      }
      const note = await tx.roundNote.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, roundId, admissionId, patientId: adm.patientId, encounterId: adm.encounterId, practitionerId: me.id, authorId: ctx.userId, condition: input.condition ?? null, note: input.note, plan: input.plan ?? null, instructions: input.instructions.length ? input.instructions.map((i) => i.text) : undefined, addendumOfId: input.addendumOfId ?? null },
        select: { id: true },
      });
      const now = Date.now();
      let n = 0;
      for (const ins of input.instructions) {
        await tx.nursingTask.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId, type: "OTHER", title: ins.text, dueAt: new Date(now + ins.dueInMinutes * 60_000), createdById: ctx.userId, sourceKey: `${INSTRUCTION_SOURCE}:${note.id}:${n++}` } });
      }
      if (n > 0) {
        const nurses = await this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, ["NURSING_DOCUMENT"]);
        await this.notifications.notify(tx, nurses.filter((u) => u !== ctx.userId), { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "NURSING_INSTRUCTION", entityType: "Admission", entityId: admissionId, dedupeKey: `ROUND_NOTE:${note.id}` });
      }
      await this.audit.record(tx, actorOf(ctx), { action: "ROUND_NOTE_ADDED", entityType: "RoundNote", entityId: note.id, metadata: { admissionId, roundId: roundId ?? "", instructions: n, addendum: !!input.addendumOfId, condition: input.condition ?? "" } });
      return note.id;
    });
    return this.prisma.roundNote.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: NOTE_VIEW });
  }

  async notes(ctx: RequestContext, admissionId: string) {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { id: true } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.roundNote.findMany({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: { createdAt: "desc" }, select: { ...NOTE_VIEW, round: { select: { label: true } } }, take: 200 });
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.authorId))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map(({ round, ...r }) => ({ ...r, round: round?.label ?? null, authorName: users.get(r.authorId) ?? null }));
  }

  /** The doctor marks a note of theirs as entered in error (the text stays, flagged). */
  async enterInError(ctx: RequestContext, noteId: string, input: z.infer<typeof errorSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const me = await this.me(tx, ctx);
      const n = await tx.roundNote.findFirst({ where: { id: noteId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!n) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (n.practitionerId !== me.id) throw new DomainError("FORBIDDEN", "Only the doctor who wrote the note can mark it", 403);
      if (n.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This note is already marked as entered in error", 409);
      const res = await tx.roundNote.updateMany({ where: { id: noteId, tenantId: ctx.tenantId, status: "ACTIVE" }, data: { status: "ENTERED_IN_ERROR", errorReason: input.reason, errorById: ctx.userId, errorAt: new Date() } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The note was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "ROUND_NOTE_ENTERED_IN_ERROR", entityType: "RoundNote", entityId: noteId, metadata: { admissionId: n.admissionId, reason: input.reason } });
    });
    return { ok: true };
  }
}
