import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { visitScope } from "../../common/data-scope";
import { dateOnly, localDateStr } from "../../common/time";
import { AppointmentsService, toAppointmentView, VIEW } from "../appointments/appointments.service";

export const scheduleFollowUpSchema = z.object({
  startAt: z.string().datetime({ offset: true }).transform((s) => new Date(s)),
  durationMinutes: z.number().int().min(5).max(240).optional(),
  /** Defaults to the doctor who saw the patient; another doctor at the facility may be chosen (e.g. a specialist). */
  practitionerId: z.string().uuid().optional(),
  notes: z.string().trim().max(500).optional(),
}).strict();

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(dateOnly(d).getTime()) && dateOnly(d).toISOString().slice(0, 10) === d, "Invalid date");
/** The window of expected follow-up dates; by default from today for 30 days. */
export const expectedFollowUpsSchema = z.object({ from: ymd.optional(), to: ymd.optional(), practitionerId: z.string().uuid().optional() }).strict();
const DAY = 86_400_000;

/**
 * Follow-ups are ordinary FOLLOW_UP appointments linked to the consultation that ordered them, so booking, conflict
 * detection, schedules, rescheduling, cancellation, statuses and reminders all go through AppointmentsService.
 */
@Injectable()
export class FollowUpsService {
  constructor(private readonly prisma: PrismaService, private readonly appointments: AppointmentsService) {}

  /** Only the doctor who saw the patient in this consultation may order its follow-up; the patient comes from the consultation. */
  async schedule(ctx: RequestContext, encounterId: string, input: z.infer<typeof scheduleFollowUpSchema>) {
    const enc = await this.prisma.encounter.findFirst({
      where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      select: { id: true, patientId: true, practitionerId: true, type: true, status: true, practitioner: { select: { userId: true } } },
    });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (enc.type !== "OPD") throw new DomainError("VALIDATION_FAILED", "Follow-ups are scheduled from OPD consultations", 400);
    if (enc.status === "CANCELLED") throw new DomainError("APPOINTMENT_INVALID_STATE", "This visit was cancelled", 409);
    if (!enc.practitionerId || !enc.practitioner || enc.practitioner.userId !== ctx.userId) {
      throw new DomainError("FORBIDDEN", "Only the doctor who saw the patient in this consultation can schedule its follow-up", 403);
    }
    return this.appointments.create(ctx, {
      patientId: enc.patientId, practitionerId: input.practitionerId ?? enc.practitionerId, startAt: input.startAt,
      ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}), type: "FOLLOW_UP", ...(input.notes ? { notes: input.notes } : {}),
    }, { followUpOfEncounterId: enc.id });
  }

  async listForEncounter(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.appointment.findMany({ where: { tenantId: ctx.tenantId, followUpOfEncounterId: enc.id }, select: VIEW, orderBy: [{ startAt: "asc" }, { id: "asc" }] });
    return rows.map(toAppointmentView);
  }

  /**
   * The reception's "expected follow-ups": patients whose doctor asked them to come back, with the date worked out from what the doctor signed (the date they gave, or the
   * days they wrote counted from the day of the consultation). Shows whether a follow-up appointment is already booked. Only signed consultations count.
   */
  async expected(ctx: RequestContext, q: z.infer<typeof expectedFollowUpsSchema>) {
    const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const today = localDateStr(new Date(), tz);
    const from = q.from ?? today;
    const to = q.to ?? new Date(dateOnly(from).getTime() + 30 * DAY).toISOString().slice(0, 10);
    if (to < from) throw new DomainError("VALIDATION_FAILED", "The end date is before the start date", 400);
    if (dateOnly(to).getTime() - dateOnly(from).getTime() > 400 * DAY) throw new DomainError("VALIDATION_FAILED", "Choose a period of at most 400 days", 400);
    const docs = await this.prisma.clinicalDocument.findMany({
      where: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, kind: "CONSULTATION", status: { not: "DRAFT" }, signedAt: { not: null, gte: new Date(dateOnly(from).getTime() - 366 * DAY) },
        encounter: { AND: [visitScope(ctx)], ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}) },
      },
      select: { id: true, encounterId: true, patientId: true, currentVersion: true, signedAt: true, patient: { select: { firstName: true, lastName: true, mobile: true, mergedIntoId: true, identifiers: { where: { type: "MRN" }, select: { value: true }, take: 1 } } }, encounter: { select: { encounterNumber: true, practitioner: { select: { displayName: true } } } } },
      orderBy: { signedAt: "desc" }, take: 3000,
    });
    if (docs.length === 0) return [];
    const versions = await this.prisma.clinicalDocumentVersion.findMany({ where: { tenantId: ctx.tenantId, documentId: { in: docs.map((d) => d.id) } }, select: { documentId: true, version: true, content: true } });
    const content = new Map(versions.map((v) => [`${v.documentId}:${v.version}`, v.content as { followUp?: { afterDays?: number; date?: string; notes?: string } } | null]));
    const due = docs.flatMap((d) => {
      const f = content.get(`${d.id}:${d.currentVersion}`)?.followUp;
      if (!f || !d.signedAt || d.patient.mergedIntoId) return [];
      const date = f.date ?? (f.afterDays ? localDateStr(new Date(dateOnly(localDateStr(d.signedAt, tz)).getTime() + f.afterDays * DAY), "UTC") : null);
      return date && date >= from && date <= to ? [{ d, date, notes: f.notes ?? null }] : [];
    });
    if (due.length === 0) return [];
    const booked = await this.prisma.appointment.findMany({
      where: { tenantId: ctx.tenantId, followUpOfEncounterId: { in: due.map((x) => x.d.encounterId) }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
      select: { followUpOfEncounterId: true, startAt: true, status: true }, orderBy: { startAt: "asc" },
    });
    const bookedBy = new Map<string, { startAt: Date; status: string }>();
    for (const b of booked) if (b.followUpOfEncounterId && !bookedBy.has(b.followUpOfEncounterId)) bookedBy.set(b.followUpOfEncounterId, { startAt: b.startAt, status: b.status });
    const showMobile = ctx.permissions.has("PATIENT_READ");
    return due
      .sort((a, b) => a.date.localeCompare(b.date) || (a.d.patient.firstName).localeCompare(b.d.patient.firstName))
      .slice(0, 500)
      .map(({ d, date, notes }) => ({
        encounterId: d.encounterId, visitNumber: d.encounter.encounterNumber, patientId: d.patientId, patientName: [d.patient.firstName, d.patient.lastName].filter(Boolean).join(" "),
        mrn: d.patient.identifiers[0]?.value ?? null, mobile: showMobile ? d.patient.mobile : null, doctor: d.encounter.practitioner?.displayName ?? null,
        seenOn: localDateStr(d.signedAt as Date, tz), expectedDate: date, overdue: date < today, notes,
        booked: bookedBy.get(d.encounterId) ? { startAt: bookedBy.get(d.encounterId)!.startAt, status: bookedBy.get(d.encounterId)!.status } : null,
      }));
  }
}
