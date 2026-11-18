import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly, endOfLocalDay, localDateStr, startOfLocalDay } from "../../common/time";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(dateOnly(d).getTime()) && dateOnly(d).toISOString().slice(0, 10) === d, "Invalid date");
export const opdLedgerSchema = z.object({ date: ymd.optional() }).strict();
export type OpdBillStatus = "NOT_BILLED" | "UNPAID" | "PART_PAID" | "PAID";

/**
 * The cashier's ledger of OPD visits (docs/opd-ledger.md): every OPD visit reception took on the day, with where its bill stands. Reception starts the visit without
 * taking money; the cashier is told, makes the bill and collects the payment, and this list shows what is still to be billed or collected.
 */
@Injectable()
export class OpdLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async day(ctx: RequestContext, q: z.infer<typeof opdLedgerSchema>) {
    const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const date = q.date ?? localDateStr(new Date(), tz);
    const encounters = await this.prisma.encounter.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "OPD", status: { not: "CANCELLED" }, startedAt: { gte: startOfLocalDay(date, tz), lte: endOfLocalDay(date, tz) } },
      select: {
        id: true, encounterNumber: true, startedAt: true, patientId: true,
        patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true }, take: 1 } } },
        practitioner: { select: { displayName: true } }, queueEntry: { select: { tokenNumber: true } },
      },
      orderBy: { startedAt: "desc" }, take: 500,
    });
    const invoices = encounters.length === 0 ? [] : await this.prisma.invoice.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: { in: encounters.map((e) => e.id) }, kind: "OPD", status: { notIn: ["CANCELLED", "DRAFT"] } },
      select: { id: true, invoiceNumber: true, encounterId: true, status: true, total: true, paidTotal: true, refundedTotal: true }, orderBy: { createdAt: "asc" },
    });
    const draftOnly = encounters.length === 0 ? [] : await this.prisma.invoice.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: { in: encounters.map((e) => e.id) }, kind: "OPD", status: "DRAFT" }, select: { id: true, encounterId: true },
    });
    const rows = encounters.map((e) => {
      const mine = invoices.filter((i) => i.encounterId === e.id);
      const total = mine.reduce((n, i) => n + Number(i.total), 0);
      const paid = mine.reduce((n, i) => n + Number(i.paidTotal) - Number(i.refundedTotal), 0);
      const due = Math.max(0, Math.round((total - paid) * 100) / 100);
      const status: OpdBillStatus = mine.length === 0 ? "NOT_BILLED" : due <= 0 ? "PAID" : paid > 0 ? "PART_PAID" : "UNPAID";
      return {
        encounterId: e.id, visitNumber: e.encounterNumber, token: e.queueEntry?.tokenNumber ?? null, takenAt: e.startedAt, patientId: e.patientId,
        patientName: [e.patient.firstName, e.patient.lastName].filter(Boolean).join(" "), mrn: e.patient.identifiers[0]?.value ?? null, doctor: e.practitioner?.displayName ?? null,
        status, total: total.toFixed(2), paid: paid.toFixed(2), due: due.toFixed(2), invoiceId: (mine.find((i) => Number(i.total) - Number(i.paidTotal) + Number(i.refundedTotal) > 0) ?? mine[0])?.id ?? draftOnly.find((d) => d.encounterId === e.id)?.id ?? null,
      };
    });
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
    return {
      date, rows,
      totals: { visits: rows.length, notBilled: rows.filter((r) => r.status === "NOT_BILLED").length, toCollect: rows.filter((r) => r.status === "UNPAID" || r.status === "PART_PAID").length, billed: sum((r) => Number(r.total)).toFixed(2), collected: sum((r) => Number(r.paid)).toFixed(2), outstanding: sum((r) => Number(r.due)).toFixed(2) },
    };
  }
}
