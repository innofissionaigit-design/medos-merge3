import { Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/request-context";
import { PrismaService } from "../../common/prisma.service";
import { patientSnapshots } from "./round-snapshots";
import { RoundsService } from "./rounds.service";

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");

export interface ActivityItem { at: Date; kind: string; text: string; admissionId: string | null; patient: string | null; by: string | null }

/**
 * The ward coordinator's view (docs/ward-rounds.md): every ward, its beds and patients, and what is going on with each patient (vitals, doses, tasks, tests, the doctor's last note, what is
 * charged but not yet billed), today's doctor rounds, and a running list of what people have just done. Read only: nothing here changes a patient's care.
 */
@Injectable()
export class WardBoardService {
  constructor(private readonly prisma: PrismaService, private readonly rounds: RoundsService) {}

  async overview(ctx: RequestContext, now = new Date()) {
    const todays = await this.rounds.todaysRounds(ctx, now);
    const [wards, adms] = await Promise.all([
      this.prisma.ward.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true, beds: { where: { active: "ACTIVE" }, select: { id: true, status: true } } } }),
      this.prisma.admission.findMany({
        where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ADMITTED" }, orderBy: { admittedAt: "asc" }, take: 400,
        select: {
          id: true, admissionNumber: true, admittedAt: true, reason: true, encounterId: true, patientId: true,
          patient: { select: { firstName: true, lastName: true, gender: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, consultant: { select: { displayName: true } },
          assignments: { where: { releasedAt: null }, select: { bed: { select: { code: true, wardId: true } } } },
          clearances: { select: { step: true, status: true } },
        },
      }),
    ]);
    const snaps = await patientSnapshots(this.prisma, ctx, adms, now);
    const dayMs = 86_400_000;
    const patients = adms.map((a) => {
      const bed = a.assignments[0]?.bed;
      const cleared = a.clearances.filter((c) => c.status === "CLEARED" || c.status === "WAIVED").length;
      return {
        admissionId: a.id, admissionNumber: a.admissionNumber, patientName: nameOf(a.patient), gender: a.patient.gender, mrn: a.patient.identifiers[0]?.value ?? null, doctor: a.consultant.displayName, reason: a.reason,
        bed: bed?.code ?? null, wardId: bed?.wardId ?? null, admittedAt: a.admittedAt, days: Math.max(0, Math.floor((now.getTime() - a.admittedAt.getTime()) / dayMs)),
        discharge: { cleared, steps: 5 }, ...snaps.get(a.id)!,
      };
    });
    const wardRows = wards.map((w) => {
      const mine = patients.filter((p) => p.wardId === w.id).sort((x, y) => (x.bed ?? "").localeCompare(y.bed ?? ""));
      const occupied = w.beds.filter((b) => b.status === "OCCUPIED").length;
      return {
        id: w.id, name: w.name, code: w.code, beds: w.beds.length, occupied, available: w.beds.filter((b) => b.status === "AVAILABLE").length, other: w.beds.length - occupied - w.beds.filter((b) => b.status === "AVAILABLE").length,
        attention: mine.filter((p) => p.medicines.overdue > 0 || p.tasks.overdue > 0 || p.vitals.late || p.lastNote?.condition === "WORSENING" || p.lastNote?.condition === "CRITICAL").length,
        patients: mine,
      };
    }).filter((w) => w.beds > 0 || w.patients.length > 0);
    const slots = await this.rounds.slots(ctx);
    return {
      generatedAt: now, rounds: todays, timings: slots,
      totals: {
        admitted: patients.length, vitalsLate: patients.filter((p) => p.vitals.late).length, doseOverdue: patients.filter((p) => p.medicines.overdue > 0).length, tasksOverdue: patients.filter((p) => p.tasks.overdue > 0).length,
        notSeenToday: patients.filter((p) => !p.lastNote || now.getTime() - p.lastNote.at.getTime() > dayMs).length, pendingCharges: patients.reduce((n, p) => n + p.charges.pendingCount, 0),
      },
      wards: wardRows,
    };
  }

  /** What has just happened across the wards, newest first: notes, orders, doses, tasks, tests, procedures and admissions. */
  async activity(ctx: RequestContext, limit = 40): Promise<ActivityItem[]> {
    const t = ctx.tenantId, f = ctx.facilityId;
    const since = new Date(Date.now() - 3 * 86_400_000);
    const who = (a: { patient: { firstName: string; lastName: string | null } }) => nameOf(a.patient);
    const pat = { select: { firstName: true, lastName: true } } as const;
    const [notes, orders, doses, tasks, nurseNotes, tests, procs, admitted, discharged, rounds] = await Promise.all([
      this.prisma.roundNote.findMany({ where: { tenantId: t, facilityId: f, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: limit, select: { createdAt: true, admissionId: true, condition: true, authorId: true, patient: pat, instructions: true } }),
      this.prisma.medicationOrder.findMany({ where: { tenantId: t, facilityId: f, status: "SIGNED", signedAt: { gte: since }, encounter: { type: "IPD" } }, orderBy: { signedAt: "desc" }, take: limit, select: { signedAt: true, orderedById: true, orderNumber: true, patient: pat, encounter: { select: { admission: { select: { id: true } } } }, _count: { select: { items: true } } } }),
      this.prisma.medicationAdministration.findMany({ where: { tenantId: t, facilityId: f, status: { not: "DUE" }, administeredAt: { gte: since } }, orderBy: { administeredAt: "desc" }, take: limit, select: { administeredAt: true, administeredById: true, status: true, admissionId: true, patient: pat, item: { select: { genericName: true } } } }),
      this.prisma.nursingTask.findMany({ where: { tenantId: t, facilityId: f, status: "DONE", completedAt: { gte: since } }, orderBy: { completedAt: "desc" }, take: limit, select: { completedAt: true, completedById: true, title: true, admissionId: true, patient: pat } }),
      this.prisma.nursingNote.findMany({ where: { tenantId: t, facilityId: f, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: limit, select: { createdAt: true, authorId: true, admissionId: true, patient: pat } }),
      this.prisma.limsRequest.findMany({ where: { tenantId: t, facilityId: f, origin: "IPD", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: limit, select: { createdAt: true, requestedById: true, requestNumber: true, status: true, encounterId: true, patient: pat } }),
      this.prisma.procedureRecord.findMany({ where: { tenantId: t, facilityId: f, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: limit, select: { createdAt: true, performedById: true, name: true, admissionId: true, patient: pat } }),
      this.prisma.admission.findMany({ where: { tenantId: t, facilityId: f, admittedAt: { gte: since } }, orderBy: { admittedAt: "desc" }, take: limit, select: { id: true, admittedAt: true, createdById: true, admissionNumber: true, patient: pat } }),
      this.prisma.admission.findMany({ where: { tenantId: t, facilityId: f, status: "DISCHARGED", dischargedAt: { gte: since } }, orderBy: { dischargedAt: "desc" }, take: limit, select: { id: true, dischargedAt: true, createdById: true, admissionNumber: true, patient: pat } }),
      this.prisma.wardRound.findMany({ where: { tenantId: t, facilityId: f, startedAt: { gte: since } }, orderBy: { startedAt: "desc" }, take: limit, select: { id: true, startedAt: true, completedAt: true, label: true, status: true, patientsSeen: true, patientsTotal: true, practitioner: { select: { displayName: true, userId: true } } } }),
    ]);
    const encAdm = tests.length ? await this.prisma.admission.findMany({ where: { tenantId: t, encounterId: { in: tests.map((x) => x.encounterId) } }, select: { id: true, encounterId: true } }) : [];
    const items: (ActivityItem & { userId: string | null })[] = [];
    for (const n of notes) items.push({ at: n.createdAt, kind: "ROUND_NOTE", text: `Doctor's round note${n.condition ? ` (${n.condition.toLowerCase()})` : ""}${Array.isArray(n.instructions) && n.instructions.length ? `, ${n.instructions.length} instruction(s) for the nurses` : ""}`, admissionId: n.admissionId, patient: who(n), userId: n.authorId, by: null });
    for (const o of orders) if (o.signedAt) items.push({ at: o.signedAt, kind: "ORDER", text: `Medicine order ${o.orderNumber ?? ""} signed (${o._count.items} item(s))`.replace("  ", " "), admissionId: o.encounter.admission?.id ?? null, patient: who(o), userId: o.orderedById, by: null });
    for (const d of doses) if (d.administeredAt) items.push({ at: d.administeredAt, kind: "DOSE", text: `${d.item.genericName}: ${d.status.toLowerCase()}`, admissionId: d.admissionId, patient: who(d), userId: d.administeredById, by: null });
    for (const k of tasks) if (k.completedAt) items.push({ at: k.completedAt, kind: "TASK", text: `Nursing task done: ${k.title}`, admissionId: k.admissionId, patient: who(k), userId: k.completedById, by: null });
    for (const n of nurseNotes) items.push({ at: n.createdAt, kind: "NURSE_NOTE", text: "Nursing note", admissionId: n.admissionId, patient: who(n), userId: n.authorId, by: null });
    for (const x of tests) items.push({ at: x.createdAt, kind: "TEST", text: `Test ${x.requestNumber} ordered (${x.status.replace(/_/g, " ").toLowerCase()})`, admissionId: encAdm.find((e) => e.encounterId === x.encounterId)?.id ?? null, patient: who(x), userId: x.requestedById, by: null });
    for (const p of procs) items.push({ at: p.createdAt, kind: "PROCEDURE", text: `Procedure: ${p.name}`, admissionId: p.admissionId, patient: who(p), userId: p.performedById, by: null });
    for (const a of admitted) items.push({ at: a.admittedAt, kind: "ADMITTED", text: `Admitted ${a.admissionNumber}`, admissionId: a.id, patient: who(a), userId: a.createdById, by: null });
    for (const a of discharged) if (a.dischargedAt) items.push({ at: a.dischargedAt, kind: "DISCHARGED", text: `Discharged ${a.admissionNumber}`, admissionId: a.id, patient: who(a), userId: null, by: null });
    for (const r of rounds) if (r.startedAt) items.push({ at: r.completedAt ?? r.startedAt, kind: "ROUND", text: `${r.label}: ${r.status === "COMPLETED" ? `finished, ${r.patientsSeen ?? 0} of ${r.patientsTotal ?? 0} patients seen` : "started"}`, admissionId: null, patient: null, userId: r.practitioner.userId, by: r.practitioner.displayName });
    items.sort((x, y) => y.at.getTime() - x.at.getTime());
    const top = items.slice(0, limit);
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: t, id: { in: [...new Set(top.flatMap((i) => (i.userId ? [i.userId] : [])))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return top.map(({ userId, ...i }) => ({ ...i, by: i.by ?? (userId ? users.get(userId) ?? null : null) }));
  }
}
