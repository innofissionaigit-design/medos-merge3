import { Injectable } from "@nestjs/common";
import { Decimal } from "@medos/shared";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { localDateStr, startOfLocalDay } from "../../common/time";
import { fmt } from "../billing/billing.domain";
import { EmergencyService } from "../emergency/emergency.service";
import { IcuService } from "../icu/icu.service";
import { ChargesService } from "../ipd/charges.service";

const LEVELS = ["RED", "ORANGE", "YELLOW", "GREEN", "BLUE"] as const;
const minutesSince = (at: Date, now: Date): number => Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));

/**
 * The hospital manager's status overview (docs/manager-overview.md): what is happening now in the emergency ward, the ICU and billing. It only reads, and it reuses the same
 * services the working screens use, so the numbers are the ones the nurses, doctors and cashiers see. It changes nothing.
 */
@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService, private readonly emergency: EmergencyService, private readonly icu: IcuService, private readonly charges: ChargesService) {}

  async get(ctx: RequestContext) {
    const now = new Date();
    const tz = (await this.prisma.facility.findFirst({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } }))?.timezone ?? "Asia/Kolkata";
    const dayStart = startOfLocalDay(localDateStr(now, tz), tz);
    const [cases, beds, arrivals, decisions, stays, equipment, unbilled, invoicedToday, collected, open] = await Promise.all([
      this.emergency.list(ctx, { view: "active", page: 1, pageSize: 100 }),
      this.emergency.beds(ctx),
      this.prisma.emergencyCase.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, arrivedAt: { gte: dayStart }, status: { not: "CANCELLED" } } }),
      this.prisma.emergencyCase.groupBy({ by: ["disposition"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, dispositionAt: { gte: dayStart } }, _count: { _all: true } }),
      this.icu.stays(ctx, { page: 1, pageSize: 100 }),
      this.prisma.icuEquipmentUse.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, stoppedAt: null, admission: { status: "ADMITTED" } } }),
      this.charges.unbilled(ctx),
      this.prisma.invoice.aggregate({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, issuedAt: { gte: dayStart }, status: { notIn: ["DRAFT", "CANCELLED"] } }, _sum: { total: true }, _count: { _all: true } }),
      this.prisma.payment.groupBy({ by: ["method"], where: { tenantId: ctx.tenantId, advanceUseId: null, receipt: { is: { facilityId: ctx.facilityId, receivedAt: { gte: dayStart } } } }, _sum: { amount: true } }),
      this.prisma.invoice.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, select: { kind: true, total: true, creditedTotal: true, paidTotal: true, refundedTotal: true }, take: 5000 }),
    ]);

    const byLevel = Object.fromEntries(LEVELS.map((l) => [l, cases.items.filter((c) => c.triageLevel === l).length]));
    const waitingForDoctor = cases.items.filter((c) => !c.doctorAccepted);
    const unbilledBy = new Map(unbilled.map((g) => [g.admissionId, g.pendingTotal]));
    const outstanding = new Map<string, { total: Decimal; count: number }>();
    for (const i of open) {
      const due = Decimal.max(0, new Decimal(i.total.toString()).minus(i.creditedTotal.toString()).minus(new Decimal(i.paidTotal.toString()).minus(i.refundedTotal.toString())));
      if (due.lte(0)) continue;
      const o = outstanding.get(i.kind) ?? { total: new Decimal(0), count: 0 };
      outstanding.set(i.kind, { total: o.total.plus(due), count: o.count + 1 });
    }
    const outstandingTotal = [...outstanding.values()].reduce((a, o) => a.plus(o.total), new Decimal(0));
    const icuStays = stays.items;
    const emergencyBeds = beds.ER;
    const icuBeds = beds.ICU;
    return {
      asOf: now,
      emergency: {
        inWard: cases.items.length, notTriaged: cases.items.filter((c) => c.needsTriage).length, waitingForDoctor: waitingForDoctor.length,
        longestWaitMinutes: waitingForDoctor.reduce((m, c) => Math.max(m, minutesSince(c.arrivedAt, now)), 0),
        byLevel, arrivalsToday: arrivals,
        decisionsToday: { OT: decisions.find((d) => d.disposition === "OT")?._count._all ?? 0, ICU: decisions.find((d) => d.disposition === "ICU")?._count._all ?? 0, DISCHARGE: decisions.find((d) => d.disposition === "DISCHARGE")?._count._all ?? 0 },
        beds: { total: emergencyBeds.length, free: emergencyBeds.filter((b) => b.free).length, withoutBed: cases.items.filter((c) => c.bed === null).length },
        billDue: fmt(cases.items.reduce((a, c) => a.plus(c.bill.due), new Decimal(0))),
        cases: cases.items.map((c) => ({ id: c.id, caseNumber: c.caseNumber, patientName: c.patient?.name ?? null, triageLevel: c.triageLevel, status: c.status, doctorName: c.doctorName, bed: c.bed?.code ?? null, minutesInWard: minutesSince(c.arrivedAt, now), doctorAccepted: c.doctorAccepted, billDue: c.bill.due })),
      },
      icu: {
        patients: icuStays.length, beds: { total: icuBeds.length, free: icuBeds.filter((b) => b.free).length },
        vitalsOverdue: icuStays.filter((s) => s.schedule.overdue).length, urgentInstructionsOpen: icuStays.reduce((n, s) => n + s.urgentInstructions, 0), pendingTests: icuStays.reduce((n, s) => n + s.pendingTests, 0), equipmentInUse: equipment,
        chargesSoFar: fmt(icuStays.reduce((a, s) => a.plus(unbilledBy.get(s.id) ?? "0"), new Decimal(0))),
        stays: icuStays.map((s) => ({ id: s.id, admissionNumber: s.admissionNumber, patientName: s.patient.name, bed: s.bed, doctorName: s.doctorName, since: s.inIcuSince, vitalsOverdue: s.schedule.overdue, minutesLate: s.schedule.minutesLate, openInstructions: s.openInstructions, pendingTests: s.pendingTests, chargesSoFar: unbilledBy.get(s.id) ?? "0.00" })),
      },
      billing: {
        invoicedToday: { count: invoicedToday._count._all, total: fmt(new Decimal((invoicedToday._sum.total ?? 0).toString())) },
        collectedToday: { total: fmt(collected.reduce((a, p) => a.plus((p._sum.amount ?? 0).toString()), new Decimal(0))), byMethod: collected.map((p) => ({ method: p.method, amount: fmt(new Decimal((p._sum.amount ?? 0).toString())) })) },
        outstanding: { total: fmt(outstandingTotal), count: [...outstanding.values()].reduce((n, o) => n + o.count, 0), byKind: [...outstanding.entries()].map(([kind, o]) => ({ kind, count: o.count, total: fmt(o.total) })).sort((a, b) => Number(b.total) - Number(a.total)) },
        admittedChargesNotBilled: { patients: unbilled.length, total: fmt(unbilled.reduce((a, g) => a.plus(g.pendingTotal), new Decimal(0))) },
      },
    };
  }
}
