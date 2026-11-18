"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { Icon, type IconName, PANEL } from "@/components/desk-ui";
import { Badge, Input, PageHeader, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Row {
  admissionId: string; admissionNumber: string; patientName: string; mrn: string | null; gender: string; bed: string | null; ward: string | null; doctor: string;
  admittedAt: string; hasAllergies: boolean; pendingTasks: number; overdueTasks: number; tasks: { id: string; title: string; dueAt: string }[]; medicationDue: number; medicationOverdue: number; nextMedicationAt: string | null; vitalsDue: boolean;
}

export default function NursingPage() {
  const { dateTime } = useMe();
  const t = useT();
  const list = useQuery({ queryKey: ["worklist"], queryFn: () => api.get<Row[]>("/nursing/worklist"), refetchInterval: 30_000 });
  const [filter, setFilter] = useState("");
  const [ward, setWard] = useState("");
  const [find, setFind] = useState("");
  const all = list.data ?? [];
  const needle = find.trim().toLowerCase();
  const wards = [...new Set(all.map((r) => r.ward).filter((w): w is string => !!w))].sort();
  const attention = (r: Row): boolean => r.medicationOverdue > 0 || r.overdueTasks > 0;
  const FILTERS: [string, string, (r: Row) => boolean][] = [
    ["", "All", () => true], ["ATTENTION", "Needs attention", attention], ["MEDS", "Medication due", (r) => r.medicationDue > 0 || r.medicationOverdue > 0],
    ["TASKS", "Tasks pending", (r) => r.pendingTasks > 0], ["VITALS", "Vitals due", (r) => r.vitalsDue],
  ];
  const test = FILTERS.find(([v]) => v === filter)?.[2] ?? (() => true);
  const shown = all.filter((r) => test(r) && (!ward || r.ward === ward) && (!needle || `${r.patientName} ${r.mrn ?? ""} ${r.admissionNumber} ${r.bed ?? ""} ${r.doctor}`.toLowerCase().includes(needle)));
  const tiles: { label: string; value: number; tone: string; icon: IconName }[] = [
    { label: "Admitted patients", value: all.length, tone: "bg-teal-50 text-teal-700", icon: "bed" },
    { label: "Overdue", value: all.filter(attention).length, tone: all.some(attention) ? "bg-red-50 text-red-700" : "bg-teal-50 text-teal-700", icon: "alert" },
    { label: "Medication due", value: all.filter((r) => r.medicationDue > 0 || r.medicationOverdue > 0).length, tone: "bg-amber-50 text-amber-700", icon: "pill" },
    { label: "Vitals due", value: all.filter((r) => r.vitalsDue).length, tone: "bg-blue-50 text-blue-700", icon: "clock" },
  ];
  return (
    <Gate anyOf={["NURSING_READ"]} feature="NURSING_ENABLED">
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
        <PageHeader title="Ward worklist" subtitle={list.data ? `${list.data.length} admitted patient${list.data.length === 1 ? "" : "s"} · medication and tasks due` : "Admitted patients with medication and tasks due"} />
        <div className="mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {tiles.map((x) => (
            <div key={x.label} className={`${PANEL} flex items-center gap-2.5 px-3.5 py-2`}>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${x.tone}`}><Icon name={x.icon} /></span>
              <div className="min-w-0">
                <div className="text-[10.5px] font-medium uppercase leading-tight tracking-wider text-slate-500">{t(x.label)}</div>
                <div className="text-lg font-semibold tabular-nums leading-tight text-slate-900">{list.data ? x.value : "—"}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5" role="tablist" aria-label={t("Show")}>
            {FILTERS.map(([v, label]) => <button key={v} type="button" role="tab" aria-selected={filter === v} onClick={() => setFilter(v)} className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${filter === v ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{t(label)}</button>)}
          </div>
          {wards.length > 1 && <div className="w-44"><select aria-label={t("Ward")} value={ward} onChange={(e) => setWard(e.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"><option value="">{t("All wards")}</option>{wards.map((w) => <option key={w} value={w}>{w}</option>)}</select></div>}
          <div className="ml-auto w-52"><Input aria-label="Search the worklist" placeholder="Bed, patient or ID" value={find} onChange={(e) => setFind(e.target.value)} /></div>
        </div>
        <section className={PANEL}>
          {list.isLoading ? <div className="p-4"><Spinner /></div> : shown.length === 0 ? <p className="px-4 py-8 text-center text-sm text-slate-500">{t(all.length === 0 ? "No admitted patients." : "Nobody matches.")}</p> : (
            <div className="overflow-x-auto px-4 pb-1">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400"><th className="py-2 pr-3 font-medium">{t("Bed")}</th><th className="py-2 pr-3 font-medium">{t("Patient")}</th><th className="py-2 pr-3 font-medium">{t("Doctor")}</th><th className="py-2 pr-3 font-medium">{t("Medication")}</th><th className="py-2 pr-3 font-medium">{t("Tasks")}</th><th className="py-2 font-medium">{t("Alerts")}</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {shown.map((r) => (
                    <tr key={r.admissionId} className={`align-top hover:bg-slate-50/70 ${attention(r) ? "bg-red-50/40" : ""}`}>
                      <td className="whitespace-nowrap py-2.5 pr-3"><span className="inline-flex h-8 min-w-[2.5rem] items-center justify-center rounded-lg bg-teal-50 px-2 text-sm font-semibold text-teal-700">{r.bed ?? "—"}</span><div className="mt-0.5 text-xs text-slate-400">{r.ward}</div></td>
                      <td className="py-2.5 pr-3"><Link className="font-semibold text-slate-900 hover:text-brand-700 hover:underline" href={`/ipd/${r.admissionId}`}>{r.patientName}</Link><div className="text-xs text-slate-400">{r.mrn} · {r.admissionNumber}</div></td>
                      <td className="py-2.5 pr-3 text-slate-700">{r.doctor}</td>
                      <td className="py-2.5 pr-3">{r.medicationOverdue > 0 ? <Badge tone="red">{r.medicationOverdue} overdue</Badge> : r.medicationDue > 0 ? <Badge tone="amber">{r.medicationDue} due</Badge> : <span className="text-slate-400">none due</span>}</td>
                      <td className="py-2.5 pr-3">{r.pendingTasks > 0 ? <span className="text-sm">{r.tasks.slice(0, 2).map((t) => `${t.title} (${dateTime(t.dueAt).split(", ").pop()})`).join("; ")}{r.overdueTasks > 0 ? <> <Badge tone="red">{r.overdueTasks} overdue</Badge></> : null}</span> : <span className="text-slate-500">—</span>}</td>
                      <td className="py-2.5">{r.hasAllergies ? <Badge tone="red">allergy on record</Badge> : null} {r.vitalsDue ? <Badge tone="amber">vitals due</Badge> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Gate>
  );
}
