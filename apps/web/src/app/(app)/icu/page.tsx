"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { intervalText, vital, type IcuRow } from "@/components/icu";
import { Badge, Card, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { ageText } from "@/lib/format";
import { useMe } from "@/lib/me";

/** The ICU board: every patient in an ICU bed, their latest vitals, when the next vitals are due, and what is waiting. */
export default function IcuBoard() {
  const { dateTime } = useMe();
  const list = useQuery({ queryKey: ["icu-stays"], queryFn: () => api.page<IcuRow>("/icu/stays", { pageSize: 100 }), refetchInterval: 10_000 });
  const rows = list.data?.data ?? [];
  const late = rows.filter((r) => r.schedule.overdue).length;
  return (
    <Gate anyOf={["ICU_READ"]}>
      <PageHeader title="Intensive care unit" subtitle="Patients in an ICU bed now. This board refreshes by itself." />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm"><span className="text-slate-600">{rows.length} in the ICU</span>{late > 0 && <Badge tone="red">{late} with vitals due</Badge>}</div>
      <Card>
        {list.isLoading ? <Spinner /> : (
          <Table head={["Patient", "Bed", "Doctor", "Latest vitals", "Vitals", "Waiting", ""]} {...(rows.length === 0 ? { empty: "No patient in the ICU." } : {})}>
            {rows.map((r) => (
              <tr key={r.id} className={r.schedule.overdue ? "bg-red-50" : ""}>
                <Td><div className="font-medium">{r.patient.name}</div><div className="text-xs text-slate-500">{r.patient.mrn} · {r.patient.gender.toLowerCase()}{ageText(r.patient.age) ? `, ${ageText(r.patient.age)}` : ""}{r.fromEmergency ? ` · from emergency ${r.fromEmergency}` : ""}</div></Td>
                <Td><div>{r.bed}</div><div className="text-xs text-slate-500">since {dateTime(r.inIcuSince)}</div></Td>
                <Td>{r.doctorName}</Td>
                <Td className="text-xs"><div>HR {vital(r.latest, "PULSE")} · BP {vital(r.latest, "SYSTOLIC_BP")}/{vital(r.latest, "DIASTOLIC_BP")}</div><div>SpO₂ {vital(r.latest, "SPO2")} · T {vital(r.latest, "TEMPERATURE")} · RR {vital(r.latest, "RESPIRATORY_RATE")}</div></Td>
                <Td>
                  <div>{intervalText(r.schedule.intervalMinutes)}</div>
                  {r.schedule.intervalMinutes !== null && (r.schedule.overdue ? <div className="text-xs font-semibold text-red-700">{r.schedule.minutesLate} min late</div> : <div className="text-xs text-slate-500">next {dateTime(r.schedule.nextDueAt)}</div>)}
                </Td>
                <Td className="text-xs">{r.openInstructions > 0 && <div className={r.urgentInstructions > 0 ? "font-semibold text-amber-700" : ""}>{r.openInstructions} instruction(s) open</div>}{r.pendingTests > 0 && <div>{r.pendingTests} test(s) pending</div>}{r.openInstructions === 0 && r.pendingTests === 0 && <span className="text-slate-500">—</span>}</Td>
                <Td><Link href={`/icu/${r.id}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-slate-50">Open</Link></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Gate>
  );
}
