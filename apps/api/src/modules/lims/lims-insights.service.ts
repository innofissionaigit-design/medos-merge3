import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { isRestricted, visitScope } from "../../common/data-scope";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { endOfLocalDay, localDateStr, startOfLocalDay } from "../../common/time";
import { fmt } from "../billing/billing.domain";
import { chargeAmounts } from "../ipd/charges.service";
import { average, DEPARTMENT_PERMISSIONS, isDelayed, OPEN_STATUSES, percentile, turnaroundMinutes, type DepartmentKind, type LimsStatus } from "./lims.domain";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const rangeSchema = z.object({ from: day.optional(), to: day.optional(), department: z.enum(["PATHOLOGY", "RADIOLOGY"]).optional() }).strict();
const MAX_ROWS = 5000;

/** Counts and turnaround figures for the LIMS manager, the administrator and the manager (docs/lims-portal.md). Read only. */
@Injectable()
export class LimsInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  private kinds(ctx: RequestContext, only?: DepartmentKind): DepartmentKind[] {
    return (["PATHOLOGY", "RADIOLOGY"] as const).filter((k) => ctx.permissions.has(DEPARTMENT_PERMISSIONS[k].read) && (!only || k === only));
  }

  private scope(ctx: RequestContext): Prisma.LimsRequestWhereInput {
    return isRestricted(ctx) ? { encounter: { AND: [visitScope(ctx)] } } : {};
  }

  private async timezone(ctx: RequestContext): Promise<string> {
    return (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
  }

  /** The control-room figures: where every department's work stands right now, and today's sample collection, acceptance and rejection. */
  async dashboard(ctx: RequestContext) {
    const tz = await this.timezone(ctx);
    const now = new Date();
    const todayStart = startOfLocalDay(localDateStr(now, tz), tz);
    const kinds = this.kinds(ctx);
    const base: Prisma.LimsRequestWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, department: { kind: { in: kinds } }, ...this.scope(ctx) };
    const [depts, byStatus, overdue, emergency, issuedToday, events, waitingRecollect] = await Promise.all([
      this.prisma.limsDepartment.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, kind: { in: kinds } }, orderBy: { kind: "asc" } }),
      this.prisma.limsRequest.groupBy({ by: ["departmentId", "status"], where: base, _count: { _all: true } }),
      this.prisma.limsRequest.groupBy({ by: ["departmentId"], where: { ...base, status: { in: [...OPEN_STATUSES] }, dueAt: { lt: now } }, _count: { _all: true } }),
      this.prisma.limsRequest.groupBy({ by: ["departmentId"], where: { ...base, status: { in: [...OPEN_STATUSES] }, priority: "EMERGENCY" }, _count: { _all: true } }),
      this.prisma.limsRequest.findMany({ where: { ...base, issuedAt: { gte: todayStart } }, select: { departmentId: true, createdAt: true, issuedAt: true, dueAt: true }, take: MAX_ROWS }),
      this.prisma.limsRequestEvent.findMany({ where: { tenantId: ctx.tenantId, at: { gte: todayStart }, kind: { in: ["COLLECTED", "ACCEPTED", "PERFORMED", "SAMPLE_REJECTED", "SENT_BACK"] }, request: { is: { facilityId: ctx.facilityId, department: { kind: { in: kinds } } } } }, select: { kind: true, request: { select: { departmentId: true } } }, take: MAX_ROWS }),
      this.prisma.limsRequest.groupBy({ by: ["departmentId"], where: { ...base, status: "PENDING_COLLECTION", needsRecollection: true }, _count: { _all: true } }),
    ]);
    const n = (rows: { departmentId: string; _count: { _all: number } }[], id: string) => rows.find((r) => r.departmentId === id)?._count._all ?? 0;
    const count = (id: string, s: LimsStatus) => byStatus.find((r) => r.departmentId === id && r.status === s)?._count._all ?? 0;
    const ev = (id: string, ...kindsOf: string[]) => events.filter((e) => e.request.departmentId === id && kindsOf.includes(e.kind)).length;
    return {
      asOf: now,
      departments: depts.map((d) => {
        const tats = issuedToday.filter((r) => r.departmentId === d.id && r.issuedAt).map((r) => turnaroundMinutes(r.createdAt, r.issuedAt as Date));
        return {
          kind: d.kind, name: d.name,
          pendingCollection: count(d.id, "PENDING_COLLECTION"), collected: count(d.id, "COLLECTED"), inProcess: count(d.id, "IN_PROCESS"), pendingReview: count(d.id, "PENDING_REVIEW"), toIssue: count(d.id, "PASSED"),
          awaitingHandover: count(d.id, "ISSUED"), issuedToday: issuedToday.filter((r) => r.departmentId === d.id).length, overdue: n(overdue, d.id), emergencyOpen: n(emergency, d.id),
          lateToday: issuedToday.filter((r) => r.departmentId === d.id && r.issuedAt && isDelayed({ status: "ISSUED", dueAt: r.dueAt, issuedAt: r.issuedAt }, now)).length,
          collectedToday: ev(d.id, "COLLECTED"), acceptedToday: ev(d.id, "ACCEPTED", "PERFORMED"), rejectedToday: ev(d.id, "SAMPLE_REJECTED", "SENT_BACK"), waitingRecollection: n(waitingRecollect, d.id),
          avgTatTodayMinutes: average(tats),
        };
      }),
    };
  }

  private async window(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const tz = await this.timezone(ctx);
    const today = localDateStr(new Date(), tz);
    const to = q.to ?? today;
    const from = q.from ?? localDateStr(new Date(Date.now() - 29 * 86_400_000), tz);
    if (from > to) throw new DomainError("VALIDATION_FAILED", "The start date is after the end date", 400);
    if (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime() > 366 * 86_400_000) throw new DomainError("VALIDATION_FAILED", "Choose a period of at most one year", 400);
    return { tz, from, to, gte: startOfLocalDay(from, tz), lte: endOfLocalDay(to, tz) };
  }

  /** Performance, workload and turnaround for a period: totals, per department, per day and per technician. */
  async performance(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const w = await this.window(ctx, q);
    const kinds = this.kinds(ctx, q.department);
    const rows = await this.prisma.limsRequest.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, department: { kind: { in: kinds } }, createdAt: { gte: w.gte, lte: w.lte }, ...this.scope(ctx) },
      select: {
        status: true, priority: true, origin: true, createdAt: true, dueAt: true, collectedAt: true, acceptedAt: true, submittedAt: true, passedAt: true, issuedAt: true, issuedById: true, acceptedById: true,
        recollectCount: true, returnedCount: true, department: { select: { kind: true, name: true } },
      },
      take: MAX_ROWS + 1,
    });
    if (rows.length > MAX_ROWS) throw new DomainError("VALIDATION_FAILED", `That period has more than ${MAX_ROWS} requests. Choose a shorter period`, 400);
    const now = new Date();
    const minutes = (a: Date | null, b: Date | null) => (a && b ? Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000)) : null);
    const stat = (vals: (number | null)[]) => average(vals.filter((x): x is number => x !== null));
    const per = (kind: DepartmentKind, name: string) => {
      const r = rows.filter((x) => x.department.kind === kind);
      const issued = r.filter((x) => x.issuedAt);
      const tats = issued.map((x) => turnaroundMinutes(x.createdAt, x.issuedAt as Date));
      const withinTarget = issued.filter((x) => (x.issuedAt as Date).getTime() <= x.dueAt.getTime()).length;
      const collectedEver = r.filter((x) => x.collectedAt).length;
      const rejected = r.reduce((a, x) => a + x.recollectCount, 0);
      return {
        kind, name, ordered: r.length, performed: r.filter((x) => x.acceptedAt).length, reported: r.filter((x) => x.passedAt).length, issued: issued.length,
        open: r.filter((x) => (OPEN_STATUSES as readonly string[]).includes(x.status)).length, cancelled: r.filter((x) => x.status === "CANCELLED").length,
        overdueOpen: r.filter((x) => (OPEN_STATUSES as readonly string[]).includes(x.status) && x.dueAt.getTime() < now.getTime()).length, lateIssued: issued.length - withinTarget,
        tat: { averageMinutes: average(tats), medianMinutes: percentile(tats, 50), p90Minutes: percentile(tats, 90), withinTargetPercent: issued.length ? Math.round((withinTarget / issued.length) * 100) : null },
        stages: {
          queueToCollectedMinutes: stat(r.map((x) => minutes(x.createdAt, x.collectedAt))), collectedToAcceptedMinutes: stat(r.map((x) => minutes(x.collectedAt, x.acceptedAt))),
          acceptedToSubmittedMinutes: stat(r.map((x) => minutes(x.acceptedAt, x.submittedAt))), submittedToPassedMinutes: stat(r.map((x) => minutes(x.submittedAt, x.passedAt))), passedToIssuedMinutes: stat(r.map((x) => minutes(x.passedAt, x.issuedAt))),
        },
        samples: { collected: collectedEver + rejected, rejected, rejectionPercent: collectedEver + rejected > 0 ? Math.round((rejected / (collectedEver + rejected)) * 1000) / 10 : null },
        returnedForCorrection: r.reduce((a, x) => a + x.returnedCount, 0),
        priority: { emergency: r.filter((x) => x.priority === "EMERGENCY").length, urgent: r.filter((x) => x.priority === "URGENT").length, routine: r.filter((x) => x.priority === "ROUTINE").length },
        origin: { opd: r.filter((x) => x.origin === "OPD").length, ipd: r.filter((x) => x.origin === "IPD").length, emergency: r.filter((x) => x.origin === "EMERGENCY").length },
      };
    };
    const names = new Map(rows.map((r) => [r.department.kind, r.department.name]));
    const departments = kinds.map((k) => per(k, names.get(k) ?? (k === "PATHOLOGY" ? "Pathology" : "Radiology")));
    const days = new Map<string, { date: string; ordered: number; issued: number }>();
    for (const r of rows) {
      const d = days.get(localDateStr(r.createdAt, w.tz)) ?? { date: localDateStr(r.createdAt, w.tz), ordered: 0, issued: 0 };
      d.ordered++;
      days.set(d.date, d);
      if (r.issuedAt) { const k = localDateStr(r.issuedAt, w.tz); const di = days.get(k) ?? { date: k, ordered: 0, issued: 0 }; di.issued++; days.set(k, di); }
    }
    const techIds = [...new Set(rows.flatMap((r) => [r.issuedById, r.acceptedById]).filter((x): x is string => !!x))];
    const users = new Map((techIds.length ? await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: techIds } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    const technicians = techIds.map((id) => ({ id, name: users.get(id) ?? "—", accepted: rows.filter((r) => r.acceptedById === id).length, issued: rows.filter((r) => r.issuedById === id).length })).sort((a, b) => b.issued + b.accepted - (a.issued + a.accepted));
    return {
      from: w.from, to: w.to,
      totals: { ordered: rows.length, issued: departments.reduce((a, d) => a + d.issued, 0), open: departments.reduce((a, d) => a + d.open, 0), pendingReview: rows.filter((r) => r.status === "PENDING_REVIEW").length, cancelled: departments.reduce((a, d) => a + d.cancelled, 0) },
      departments, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), technicians,
    };
  }

  /**
   * What the laboratory has earned, read from billing, and what has been done but not billed. Read only: the billing itself is done at the Cashier (docs/lims-portal.md, "Billing").
   */
  async billing(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    // The LIMS manager follows what the laboratory has billed and charged; everyone else needs to be allowed to see bills.
    if (!ctx.permissions.has("INVOICE_READ") && !ctx.permissions.has("LIMS_MANAGE")) throw new DomainError("FORBIDDEN", "You do not have permission to see billing", 403);
    const w = await this.window(ctx, q);
    const kinds = this.kinds(ctx, q.department);
    const rows = await this.prisma.limsRequest.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, department: { kind: { in: kinds } }, createdAt: { gte: w.gte, lte: w.lte }, status: { not: "CANCELLED" } },
      select: { id: true, status: true, origin: true, requestNumber: true, testOrderId: true, department: { select: { kind: true, name: true } }, testOrder: { select: { name: true, status: true, invoiceId: true } }, patient: { select: { firstName: true, lastName: true } }, encounter: { select: { admission: { select: { admissionNumber: true } } } } },
      take: MAX_ROWS + 1,
    });
    if (rows.length > MAX_ROWS) throw new DomainError("VALIDATION_FAILED", `That period has more than ${MAX_ROWS} requests. Choose a shorter period`, 400);
    const billedIds = rows.filter((r) => r.testOrder.status === "BILLED").map((r) => r.testOrderId);
    const [direct, lines] = await Promise.all([
      billedIds.length ? this.prisma.invoiceLine.findMany({ where: { tenantId: ctx.tenantId, sourceType: "TEST_ORDER", sourceId: { in: billedIds } }, select: { sourceId: true, lineTotal: true } }) : [],
      billedIds.length ? this.prisma.testBillingLine.findMany({ where: { tenantId: ctx.tenantId, testOrderId: { in: billedIds }, status: "BILLED" }, select: { id: true, testOrderId: true } }) : [],
    ]);
    const viaLines = lines.length ? await this.prisma.invoiceLine.findMany({ where: { tenantId: ctx.tenantId, sourceType: "TEST_BILLING_LINE", sourceId: { in: lines.map((l) => l.id) } }, select: { sourceId: true, lineTotal: true } }) : [];
    // An admitted patient's test is charged to the admission when its report is issued: that charge is what has been "billed" for it.
    const admitted = rows.filter((r) => r.origin === "IPD");
    const charges = admitted.length ? await this.prisma.charge.findMany({ where: { tenantId: ctx.tenantId, sourceKey: { in: admitted.map((r) => `LIMS:${r.id}`) }, status: { not: "VOIDED" } }, select: { sourceKey: true, status: true, quantity: true, unitPrice: true, taxPercent: true } }) : [];
    const chargeOf = new Map(charges.map((c) => [c.sourceKey as string, c]));
    // An emergency patient's test is a line on the emergency bill (source LIMS, the request): that line is what has been billed for it.
    const emergency = rows.filter((r) => r.origin === "EMERGENCY");
    const erLines = emergency.length ? await this.prisma.invoiceLine.findMany({ where: { tenantId: ctx.tenantId, sourceType: "LIMS", sourceId: { in: emergency.map((r) => r.id) } }, select: { sourceId: true, lineTotal: true } }) : [];
    const erAmount = new Map(erLines.map((l) => [l.sourceId as string, new Decimal(l.lineTotal.toString())]));
    const chargedAmount = (id: string) => { const c = chargeOf.get(`LIMS:${id}`); return c ? chargeAmounts(c).total : erAmount.get(id) ?? null; };
    const orderOfLine = new Map(lines.map((l) => [l.id, l.testOrderId as string]));
    const amountOf = new Map<string, Decimal>();
    for (const l of direct) if (l.sourceId) amountOf.set(l.sourceId, (amountOf.get(l.sourceId) ?? new Decimal(0)).plus(new Decimal(l.lineTotal.toString())));
    for (const l of viaLines) { const o = l.sourceId ? orderOfLine.get(l.sourceId) : undefined; if (o) amountOf.set(o, (amountOf.get(o) ?? new Decimal(0)).plus(new Decimal(l.lineTotal.toString()))); }
    const departments = kinds.map((k) => {
      const r = rows.filter((x) => x.department.kind === k);
      const billed = r.filter((x) => x.testOrder.status === "BILLED" || chargeOf.has(`LIMS:${x.id}`) || erAmount.has(x.id));
      const total = billed.reduce((a, x) => a.plus(chargedAmount(x.id) ?? amountOf.get(x.testOrderId) ?? new Decimal(0)), new Decimal(0));
      const done = r.filter((x) => x.status === "ISSUED" || x.status === "HANDED_OVER");
      return {
        kind: k, name: r[0]?.department.name ?? (k === "PATHOLOGY" ? "Pathology" : "Radiology"), tests: r.length, billed: billed.length, notBilled: r.length - billed.length,
        billedAmount: total.toFixed(2), reportsIssued: done.length, issuedNotBilled: done.filter((x) => x.testOrder.status !== "BILLED" && !chargeOf.has(`LIMS:${x.id}`) && !erAmount.has(x.id)).length,
        chargedToAdmissions: r.filter((x) => chargeOf.has(`LIMS:${x.id}`)).length, chargedToEmergency: r.filter((x) => erAmount.has(x.id)).length,
      };
    });
    // The charges added to admitted patients' bills, newest first, so the manager and the administrator can follow them.
    const admittedCharges = admitted.filter((r) => chargeOf.has(`LIMS:${r.id}`)).slice(0, 100).map((r) => ({
      requestNumber: r.requestNumber, test: r.testOrder.name, department: r.department.kind, patient: [r.patient.firstName, r.patient.lastName].filter(Boolean).join(" "),
      admissionNumber: r.encounter.admission?.admissionNumber ?? null, status: (chargeOf.get(`LIMS:${r.id}`) as { status: string }).status, amount: fmt(chargedAmount(r.id) ?? new Decimal(0)),
    }));
    return { from: w.from, to: w.to, departments, admittedCharges, totals: { tests: rows.length, billed: departments.reduce((a, d) => a + d.billed, 0), notBilled: departments.reduce((a, d) => a + d.notBilled, 0), issuedNotBilled: departments.reduce((a, d) => a + d.issuedNotBilled, 0), billedAmount: departments.reduce((a, d) => a.plus(new Decimal(d.billedAmount)), new Decimal(0)).toFixed(2) } };
  }
}
