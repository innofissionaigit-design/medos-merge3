"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Badge, Card, ErrorNote, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Patient {
  admissionId: string; admissionNumber: string; patientName: string; mrn: string | null; doctor: string; reason: string | null; bed: string | null; wardId: string; days: number;
  discharge: { cleared: number; steps: number }; vitals: { late: boolean; at: string | null };
  medicines: { dueNow: number; overdue: number }; tasks: { pending: number; overdue: number }; tests: { open: number }; seenThisRound: boolean; charges: { pendingCount: number };
}
interface Ward { id: string; name: string; code: string; beds: number; occupied: number; available: number; other: number; attention: number; patients: Patient[] }
interface Board { totals: { admitted: number; vitalsLate: number; doseOverdue: number; tasksOverdue: number; notSeenToday: number; pendingCharges: number }; wards: Ward[]; rounds: { status: string; doctor: string | null }[] }
type View = "ALL" | "ATTENTION" | "VITALS" | "MEDICINE" | "ROUND";

const TILES: { id: View; label: string; sub: string; bar: string; empty: string }[] = [
  { id: "ALL", label: "Admitted", sub: "On the wards now", bar: "bg-brand-500", empty: "No patient is admitted." },
  { id: "ATTENTION", label: "Needs attention", sub: "Late vitals, doses or tasks", bar: "bg-amber-500", empty: "Nothing needs attention right now." },
  { id: "VITALS", label: "Vitals running late", sub: "Not recorded on time", bar: "bg-violet-500", empty: "Every patient's vitals are up to date." },
  { id: "MEDICINE", label: "Doses overdue", sub: "Medicines past their time", bar: "bg-red-500", empty: "No medicine dose is overdue." },
  { id: "ROUND", label: "Not seen this round", sub: "Doctor has not rounded yet", bar: "bg-emerald-500", empty: "Every patient has been seen this round." },
];

const flags = (p: Patient) => ({
  vitals: p.vitals.late, dose: p.medicines.overdue > 0, task: p.tasks.overdue > 0, round: !p.seenThisRound,
});
const needsAttention = (p: Patient) => { const f = flags(p); return f.vitals || f.dose || f.task; };
const inView = (p: Patient, v: View) => v === "ALL" ? true : v === "ATTENTION" ? needsAttention(p) : v === "VITALS" ? p.vitals.late : v === "MEDICINE" ? p.medicines.overdue > 0 : !p.seenThisRound;

/**
 * The ward coordinator's start screen: how full each ward is, which patients need attention (late vitals, overdue doses or tasks), and who the doctor has not seen this round.
 * Every figure comes from the ward board; the work itself (rounds, medicines, tasks) is done on the board and on each admission.
 */
export function WardCoordinatorDashboard() {
  const t = useT();
  const { me, dateTime } = useMe();
  const [view, setView] = useState<View>("ATTENTION");
  const [ward, setWard] = useState("");
  const q = useQuery({ queryKey: ["wc-board"], queryFn: () => api.get<Board>("/ward-board"), refetchInterval: 30_000 });
  const b = q.data;
  const all = (b?.wards ?? []).flatMap((w) => w.patients.map((p) => ({ ...p, ward: w.name })));
  const scoped = all.filter((p) => !ward || p.wardId === ward);
  const shown = scoped.filter((p) => inView(p, view)).sort((a, c) => Number(needsAttention(c)) - Number(needsAttention(a)) || c.medicines.overdue - a.medicines.overdue);
  const tile = TILES.find((x) => x.id === view)!;
  const count = (v: View) => scoped.filter((p) => inView(p, v)).length;
  const attention = count("ATTENTION");
  const wardsWithPatients = (b?.wards ?? []).filter((w) => w.beds > 0);
  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{`${t("Welcome")}, ${me.fullName}`}</h1>
          <p className="text-sm text-slate-500">{`${me.tenant.name} · ${t("Ward coordination")} · ${dateTime(new Date().toISOString())}`}</p>
        </div>
        <Link className="whitespace-nowrap rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700" href="/wards">{t("Open the ward board")}</Link>
      </div>
      <ErrorNote error={q.error} />

      {attention > 0 && view !== "ATTENTION" && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
          <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" /></span>
          <span><b>{attention === 1 ? "1 patient needs attention." : `${attention} patients need attention.`}</b></span>
          <button type="button" className="ml-auto whitespace-nowrap rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50" onClick={() => setView("ATTENTION")}>{t("Show them")}</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {TILES.map((c) => {
          const active = view === c.id;
          return (
            <button key={c.id} type="button" onClick={() => setView(c.id)} aria-pressed={active} className={clsx("group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200")}>
              <span className={clsx("absolute inset-x-0 top-0 h-1", c.bar)} aria-hidden />
              <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">{t(c.label)}</span>
              <span className="mt-2 block text-3xl font-semibold tracking-tight tabular-nums text-slate-900">{q.isLoading ? <span className="text-slate-400">…</span> : count(c.id)}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{t(c.sub)}</span>
            </button>
          );
        })}
      </div>

      {wardsWithPatients.length > 0 && (
        <Card title={t("Wards")} className="mt-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {wardsWithPatients.map((w) => {
              const pct = w.beds ? Math.round((w.occupied / w.beds) * 100) : 0;
              const on = ward === w.id;
              return (
                <button key={w.id} type="button" onClick={() => setWard(on ? "" : w.id)} aria-pressed={on} className={clsx("rounded-lg border p-3 text-left transition hover:shadow-sm", on ? "border-brand-500 bg-brand-50/40 ring-1 ring-brand-500/30" : "border-slate-200 bg-white")}>
                  <div className="flex items-baseline justify-between"><span className="text-sm font-semibold text-slate-800">{w.name}</span>{w.attention > 0 && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">{`${w.attention} ${t("need attention")}`}</span>}</div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${w.name}: ${w.occupied} of ${w.beds} beds occupied`}><span className={clsx("block h-full rounded-full", pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-brand-500")} style={{ width: `${Math.max(pct, w.occupied > 0 ? 3 : 0)}%` }} /></div>
                  <div className="mt-1.5 text-xs tabular-nums text-slate-500"><b className="text-slate-800">{w.occupied}</b> of {w.beds} {t("beds occupied")} · {w.available} {t("free")}</div>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      <Card title={`${t(tile.label)}${b ? ` · ${shown.length}` : ""}${ward ? ` · ${b?.wards.find((w) => w.id === ward)?.name ?? ""}` : ""}`} className="mt-4">
        {q.isLoading ? <Spinner /> : (
          <Table head={["Patient", "Bed", "Doctor", "Stay", "To do", "Discharge", ""]} {...(shown.length === 0 ? { empty: tile.empty } : {})}>
            {shown.map((p) => {
              const f = flags(p);
              return (
                <tr key={p.admissionId} className="align-top hover:bg-slate-50">
                  <Td><span className="font-medium text-slate-900">{p.patientName}</span><div className="text-xs text-slate-500">{`${p.mrn ?? ""} · ${p.admissionNumber}`}</div></Td>
                  <Td className="text-sm">{p.bed ?? "—"}<div className="text-xs text-slate-500">{p.ward}</div></Td>
                  <Td className="text-sm">{p.doctor}</Td>
                  <Td className="whitespace-nowrap text-sm">{`${p.days} ${p.days === 1 ? t("day") : t("days")}`}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {f.dose && <Badge tone="red">{`${p.medicines.overdue} ${t("dose overdue")}`}</Badge>}
                      {f.vitals && <Badge tone="amber">{t("Vitals late")}</Badge>}
                      {f.task && <Badge tone="amber">{`${p.tasks.overdue} ${t("task overdue")}`}</Badge>}
                      {f.round && <Badge tone="gray">{t("Not seen this round")}</Badge>}
                      {!f.dose && !f.vitals && !f.task && !f.round && <Badge tone="green">{t("All up to date")}</Badge>}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-slate-600">{`${p.discharge.cleared} of ${p.discharge.steps} ${t("steps")}`}</Td>
                  <Td><Link className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50" href={`/ipd/${p.admissionId}`}>{t("Open")}</Link></Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
