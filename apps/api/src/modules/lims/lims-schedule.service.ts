import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { localDateStr } from "../../common/time";
import { dayLoads, earliestSlot, type DayLoad, type DeptLoad, type Suggestion } from "./lims-schedule";
import type { DepartmentKind, LimsPriority } from "./lims.domain";

const count = z.coerce.number().int().min(0).max(20).default(0);
export const availabilitySchema = z.object({ pathology: count, radiology: count, priority: z.enum(["EMERGENCY", "URGENT", "ROUTINE"]).default("ROUTINE") }).strict();
export const pressureSchema = z.object({ days: z.coerce.number().int().min(1).max(14).default(7) }).strict();
const HORIZON_DAYS = 14;

/**
 * Lab load and the outpatient's date (docs/lims-portal.md). Reads how busy each department is (work waiting with no time, and tests booked for a time) and works out the
 * first time with room. Used to give an outpatient their date when reception does not choose one, and to show the LIMS manager the pressure on each lab.
 */
@Injectable()
export class LimsScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  /** What each active department can take, and what is already waiting or booked in it. */
  async loads(db: Db | PrismaService, ctx: RequestContext, now = new Date()): Promise<{ tz: string; names: Map<DepartmentKind, string>; loads: DeptLoad[] }> {
    const [facility, depts] = await Promise.all([
      db.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } }),
      db.limsDepartment.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, kind: true, name: true, capacityPerHour: true, openMinute: true, closeMinute: true } }),
    ]);
    const stale = new Date(now.getTime() - 3_600_000);
    const pending = await db.limsRequest.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "PENDING_COLLECTION", OR: [{ scheduledFor: null }, { scheduledFor: { lt: stale } }, { scheduledFor: { gte: stale, lte: new Date(now.getTime() + (HORIZON_DAYS + 1) * 86_400_000) } }] },
      select: { departmentId: true, scheduledFor: true }, take: 20_000,
    });
    const loads: DeptLoad[] = depts.map((d) => {
      const mine = pending.filter((p) => p.departmentId === d.id);
      return {
        kind: d.kind, capacityPerHour: d.capacityPerHour, openMinute: d.openMinute, closeMinute: d.closeMinute,
        backlog: mine.filter((p) => p.scheduledFor === null || p.scheduledFor < stale).length,
        booked: mine.filter((p) => p.scheduledFor !== null && p.scheduledFor >= stale).map((p) => p.scheduledFor as Date),
      };
    });
    return { tz: facility.timezone, names: new Map(depts.map((d) => [d.kind, d.name])), loads };
  }

  /** The time an outpatient is asked to come: now for an emergency, otherwise the first hour in which every department needed has room. */
  async suggest(db: Db | PrismaService, ctx: RequestContext, need: Partial<Record<DepartmentKind, number>>, priority: LimsPriority, now = new Date()): Promise<Suggestion & { immediate: boolean }> {
    if (priority === "EMERGENCY") return { at: now, byDepartment: [], immediate: true };
    const { tz, loads } = await this.loads(db, ctx, now);
    const s = earliestSlot(now, tz, loads, need, HORIZON_DAYS);
    if (!s) throw new DomainError("INVALID_STATE", `The laboratory is fully booked for the next ${HORIZON_DAYS} days. Choose a time by hand or ask the LIMS manager to raise the capacity`, 409);
    return { ...s, immediate: false };
  }

  /** For reception's screen: the date the patient would be given, and how busy each lab is today. */
  async availability(ctx: RequestContext, q: z.infer<typeof availabilitySchema>) {
    const now = new Date();
    const need = { PATHOLOGY: q.pathology, RADIOLOGY: q.radiology };
    const s = await this.suggest(this.prisma, ctx, need, q.priority, now);
    const { tz, names, loads } = await this.loads(this.prisma, ctx, now);
    return {
      suggestedAt: s.at, immediate: s.immediate,
      departments: loads.map((l) => {
        const today = dayLoads(now, tz, l, 1)[0];
        return { kind: l.kind, name: names.get(l.kind) ?? l.kind, capacityPerHour: l.capacityPerHour, waiting: l.backlog, todayPercent: today?.percent ?? 100, needed: need[l.kind] ?? 0 };
      }),
    };
  }

  /** For the LIMS manager: how full each lab is, day by day. */
  async pressure(ctx: RequestContext, q: z.infer<typeof pressureSchema>) {
    const now = new Date();
    const { tz, names, loads } = await this.loads(this.prisma, ctx, now);
    const open = await this.prisma.limsRequest.groupBy({ by: ["departmentId", "status"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { in: ["PENDING_COLLECTION", "COLLECTED", "IN_PROCESS", "PENDING_REVIEW", "PASSED"] } }, _count: { _all: true } });
    const depts = await this.prisma.limsDepartment.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, kind: true } });
    const kindOf = new Map(depts.map((d) => [d.id, d.kind]));
    return {
      today: localDateStr(now, tz),
      departments: loads.map((l) => {
        const days: DayLoad[] = dayLoads(now, tz, l, q.days);
        const mine = open.filter((o) => kindOf.get(o.departmentId) === l.kind);
        const n = (s: string) => mine.find((o) => o.status === s)?._count._all ?? 0;
        return {
          kind: l.kind, name: names.get(l.kind) ?? l.kind, capacityPerHour: l.capacityPerHour, openMinute: l.openMinute, closeMinute: l.closeMinute, waitingNow: l.backlog,
          open: { waitingForSample: n("PENDING_COLLECTION"), inLab: n("COLLECTED") + n("IN_PROCESS"), withSpecialist: n("PENDING_REVIEW"), toIssue: n("PASSED") }, days,
          nextFreeAt: earliestSlot(now, tz, [l], { [l.kind]: 1 }, HORIZON_DAYS)?.at ?? null,
        };
      }),
    };
  }
}
