import { Decimal } from "@medos/shared";
import type { Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "../billing/billing.domain";
import { chargeAmounts } from "../ipd/charges.service";

const OVERDUE_DOSE_MIN = 30;
const VITALS_INTERVAL_MIN = 8 * 60;

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");

export interface AdmissionRef { id: string; encounterId: string; patientId: string }

/**
 * What is going on with each admitted patient, for the doctor on a round and for the ward coordinator: vitals, medicines and doses, the nurses' tasks, tests, the doctor's last note,
 * and what has been charged but not yet billed. One query per kind of thing for all the patients at once (no query per patient).
 */
export async function patientSnapshots(db: Db, ctx: RequestContext, admissions: AdmissionRef[], now = new Date(), roundId?: string) {
  const admIds = admissions.map((a) => a.id), encIds = admissions.map((a) => a.encounterId);
  if (admIds.length === 0) return new Map<string, ReturnType<typeof build>>();
  const t = ctx.tenantId;
  const [obs, orders, dueMar, overdueMar, givenToday, tasks, openTests, readyTests, notes, charges, procs] = await Promise.all([
    db.observation.findMany({ where: { tenantId: t, encounterId: { in: encIds }, status: "FINAL", type: { in: ["SYSTOLIC_BP", "DIASTOLIC_BP", "PULSE", "TEMPERATURE", "SPO2"] } }, orderBy: { recordedAt: "desc" }, select: { encounterId: true, type: true, value: true, unit: true, recordedAt: true }, take: 4000 }),
    db.medicationOrderItem.findMany({ where: { tenantId: t, status: "ACTIVE", order: { encounterId: { in: encIds }, status: "SIGNED" } }, select: { genericName: true, strength: true, dosage: true, frequency: true, order: { select: { encounterId: true } }, _count: { select: { administrations: true } } }, take: 2000 }),
    db.medicationAdministration.groupBy({ by: ["admissionId"], where: { tenantId: t, admissionId: { in: admIds }, status: "DUE", scheduledAt: { lte: new Date(now.getTime() + 60 * 60_000) }, item: { status: "ACTIVE" } }, _count: { _all: true } }),
    db.medicationAdministration.groupBy({ by: ["admissionId"], where: { tenantId: t, admissionId: { in: admIds }, status: "DUE", scheduledAt: { lt: new Date(now.getTime() - OVERDUE_DOSE_MIN * 60_000) }, item: { status: "ACTIVE" } }, _count: { _all: true } }),
    db.medicationAdministration.groupBy({ by: ["admissionId"], where: { tenantId: t, admissionId: { in: admIds }, status: "GIVEN", administeredAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } }, _count: { _all: true } }),
    db.nursingTask.findMany({ where: { tenantId: t, admissionId: { in: admIds }, status: "PENDING" }, select: { admissionId: true, dueAt: true } }),
    db.limsRequest.groupBy({ by: ["encounterId"], where: { tenantId: t, encounterId: { in: encIds }, status: { notIn: ["ISSUED", "HANDED_OVER", "CANCELLED"] } }, _count: { _all: true } }),
    db.limsRequest.groupBy({ by: ["encounterId"], where: { tenantId: t, encounterId: { in: encIds }, status: { in: ["ISSUED", "HANDED_OVER"] }, updatedAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } }, _count: { _all: true } }),
    db.roundNote.findMany({ where: { tenantId: t, admissionId: { in: admIds }, status: "ACTIVE", addendumOfId: null }, orderBy: { createdAt: "desc" }, select: { id: true, admissionId: true, roundId: true, condition: true, note: true, plan: true, createdAt: true, practitionerId: true }, take: 3000 }),
    db.charge.findMany({ where: { tenantId: t, admissionId: { in: admIds }, status: "PENDING" }, select: { admissionId: true, quantity: true, unitPrice: true, taxPercent: true, chargedAt: true } }),
    db.procedureRecord.groupBy({ by: ["admissionId"], where: { tenantId: t, admissionId: { in: admIds }, status: "ACTIVE" }, _count: { _all: true } }),
  ]);
  const build = (a: AdmissionRef) => {
    const mine = obs.filter((o) => o.encounterId === a.encounterId);
    const latest = (type: string) => mine.find((o) => o.type === type);
    const lastAt = mine[0]?.recordedAt ?? null;
    const items = orders.filter((o) => o.order.encounterId === a.encounterId);
    const myTasks = tasks.filter((x) => x.admissionId === a.id);
    const myNotes = notes.filter((n) => n.admissionId === a.id);
    const last = myNotes[0] ?? null;
    const myCharges = charges.filter((c) => c.admissionId === a.id);
    const pending = myCharges.reduce((s, c) => s.plus(chargeAmounts({ quantity: c.quantity, unitPrice: c.unitPrice, taxPercent: c.taxPercent }).total), new Decimal(0));
    const sys = latest("SYSTOLIC_BP"), dia = latest("DIASTOLIC_BP"), pulse = latest("PULSE"), temp = latest("TEMPERATURE"), spo2 = latest("SPO2");
    return {
      vitals: { at: lastAt, bp: sys && dia ? `${sys.value.toString().replace(/\.0+$/, "")}/${dia.value.toString().replace(/\.0+$/, "")}` : null, pulse: pulse ? pulse.value.toString().replace(/\.0+$/, "") : null, temperature: temp ? temp.value.toString() : null, spo2: spo2 ? spo2.value.toString().replace(/\.0+$/, "") : null, late: !lastAt || now.getTime() - lastAt.getTime() > VITALS_INTERVAL_MIN * 60_000 },
      medicines: { active: items.length, names: items.slice(0, 4).map((i) => `${i.genericName}${i.strength ? ` ${i.strength}` : ""}`), withoutSchedule: items.filter((i) => i._count.administrations === 0).length, dueNow: dueMar.find((d) => d.admissionId === a.id)?._count._all ?? 0, overdue: overdueMar.find((d) => d.admissionId === a.id)?._count._all ?? 0, givenLast24h: givenToday.find((d) => d.admissionId === a.id)?._count._all ?? 0 },
      tasks: { pending: myTasks.length, overdue: myTasks.filter((x) => x.dueAt.getTime() < now.getTime()).length },
      tests: { open: openTests.find((x) => x.encounterId === a.encounterId)?._count._all ?? 0, resultsLast24h: readyTests.find((x) => x.encounterId === a.encounterId)?._count._all ?? 0 },
      procedures: procs.find((x) => x.admissionId === a.id)?._count._all ?? 0,
      lastNote: last ? { id: last.id, at: last.createdAt, condition: last.condition, note: last.note, plan: last.plan } : null,
      seenThisRound: roundId ? myNotes.some((n) => n.roundId === roundId) : false,
      charges: { pendingCount: myCharges.length, pendingTotal: fmt(pending) },
    };
  };
  const out = new Map<string, ReturnType<typeof build>>();
  for (const a of admissions) out.set(a.id, build(a));
  return out;
}

export { nameOf };
