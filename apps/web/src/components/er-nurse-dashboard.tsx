"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { LEVELS, TriageBadge, type CaseRow, type Level } from "@/components/emergency";
import { Badge, Card, ErrorNote, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

type View = "ALL" | "TRIAGE" | "DOCTOR" | "URGENT" | "MINE" | "NOBED" | "DUE";
export type ErRole = "NURSE" | "DOCTOR" | "DESK";

const ALL_TILES: Record<View, { label: string; sub: string; bar: string; empty: string }> = {
  ALL: { label: "In the ward now", sub: "Everyone being looked after", bar: "bg-brand-500", empty: "Nobody is in the emergency ward." },
  TRIAGE: { label: "Waiting for triage", sub: "Not yet assessed by a nurse", bar: "bg-amber-500", empty: "Everyone has been triaged." },
  DOCTOR: { label: "Doctor not accepted", sub: "Called, not yet taken over", bar: "bg-violet-500", empty: "Every patient has a doctor who accepted the case." },
  URGENT: { label: "Red and orange", sub: "Immediate or very urgent", bar: "bg-red-500", empty: "No patient is immediate or very urgent." },
  MINE: { label: "Called to me", sub: "Patients waiting for my decision", bar: "bg-emerald-500", empty: "No patient has been called to you." },
  NOBED: { label: "Without a bed", sub: "Registered, no emergency bed", bar: "bg-rose-500", empty: "Every patient has a bed." },
  DUE: { label: "Bill due", sub: "Patients with money still owing", bar: "bg-teal-500", empty: "No emergency bill is owing." },
};
const ROLE_TILES: Record<ErRole, View[]> = { NURSE: ["ALL", "TRIAGE", "DOCTOR", "URGENT"], DOCTOR: ["ALL", "MINE", "DOCTOR", "URGENT"], DESK: ["ALL", "TRIAGE", "NOBED", "DUE"] };
const ROLE_TITLE: Record<ErRole, string> = { NURSE: "Emergency ward", DOCTOR: "Emergency doctor", DESK: "Emergency desk" };
const ORDER: Level[] = ["RED", "ORANGE", "YELLOW", "GREEN", "BLUE"];
/** Untriaged patients first, then the most urgent level, then whoever has waited longest. */
const priority = (c: CaseRow) => (c.needsTriage || !c.triageLevel ? -1 : ORDER.indexOf(c.triageLevel));
const STATUS: Record<string, { tone: "amber" | "blue" | "green" | "gray"; label: string }> = { ARRIVED: { tone: "amber", label: "Arrived" }, TRIAGED: { tone: "blue", label: "Triaged" }, IN_TREATMENT: { tone: "blue", label: "In treatment" }, HANDED_OVER: { tone: "green", label: "Handed over" } };

function minutesSince(iso: string): number { return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); }
const waited = (m: number): string => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

/**
 * The emergency nurse's start screen: who is in the ward, who still has to be triaged, which cases no doctor has accepted yet, and who is red or orange. The list is sorted so the
 * most urgent patient is always first. Triage, vitals and the rest of the work are done on the case itself.
 */
export function ErDashboard({ as = "NURSE" }: { as?: ErRole }) {
  const t = useT();
  const { me, dateTime, money } = useMe();
  const [view, setView] = useState<View>("ALL");
  const TILES = ROLE_TILES[as].map((id) => ({ id, ...ALL_TILES[id] }));
  const q = useQuery({ queryKey: ["er-nurse-cases"], queryFn: () => api.get<CaseRow[]>("/emergency/cases", { view: "active", pageSize: 100 }), refetchInterval: 10_000 });
  const cases = q.data ?? [];
  const inView = (c: CaseRow, v: View) => v === "ALL" ? true : v === "TRIAGE" ? c.needsTriage : v === "DOCTOR" ? !c.doctorAccepted : v === "MINE" ? c.calledByMe : v === "NOBED" ? !c.bed : v === "DUE" ? Number(c.bill.due) > 0 : c.triageLevel === "RED" || c.triageLevel === "ORANGE";
  const shown = cases.filter((c) => inView(c, view)).sort((a, b) => priority(a) - priority(b) || new Date(a.arrivedAt).getTime() - new Date(b.arrivedAt).getTime());
  const tile = ALL_TILES[view];
  const needTriage = cases.filter((c) => c.needsTriage).length;
  const notAccepted = cases.filter((c) => !c.doctorAccepted).length;
  const urgent = cases.filter((c) => c.triageLevel === "RED" || c.triageLevel === "ORANGE").length;
  const byLevel = ORDER.map((l) => ({ l, n: cases.filter((c) => c.triageLevel === l).length })).filter((x) => x.n > 0);
  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{`${t("Welcome")}, ${me.fullName}`}</h1>
          <p className="text-sm text-slate-500">{`${me.tenant.name} · ${t(ROLE_TITLE[as])} · ${dateTime(new Date().toISOString())}`}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />{t("Live")}</span>
          <Link className="whitespace-nowrap rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700" href="/emergency">{as === "DESK" ? t("Register an arrival") : t("Open the emergency board")}</Link>
        </div>
      </div>
      <ErrorNote error={q.error} />

      {as !== "DOCTOR" && needTriage > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
          <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" /></span>
          <span><b>{needTriage === 1 ? "1 patient is waiting for triage." : `${needTriage} patients are waiting for triage.`}</b></span>
          <button type="button" className="ml-auto whitespace-nowrap rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50" onClick={() => setView("TRIAGE")}>{t("Show them")}</button>
        </div>
      )}
      {as === "DOCTOR" && notAccepted > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900" role="alert">
          <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-violet-500" /></span>
          <span><b>{notAccepted === 1 ? "1 case has not been accepted by a doctor." : `${notAccepted} cases have not been accepted by a doctor.`}</b></span>
          <button type="button" className="ml-auto whitespace-nowrap rounded-md border border-violet-300 bg-white px-3 py-1 text-xs font-medium text-violet-800 hover:bg-violet-50" onClick={() => setView("DOCTOR")}>{t("Show them")}</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TILES.map((c) => {
          const active = view === c.id;
          const n = cases.filter((x) => inView(x, c.id)).length;
          const hot = (c.id === "URGENT" && urgent > 0) || (c.id === "TRIAGE" && needTriage > 0) || (c.id === "NOBED" && n > 0);
          return (
            <button key={c.id} type="button" onClick={() => setView(c.id)} aria-pressed={active} className={clsx("group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200")}>
              <span className={clsx("absolute inset-x-0 top-0 h-1", c.bar)} aria-hidden />
              <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">{t(c.label)}</span>
              <span className={clsx("mt-2 block text-3xl font-semibold tracking-tight tabular-nums", hot ? (c.id === "URGENT" || c.id === "NOBED" ? "text-red-600" : "text-amber-600") : "text-slate-900")}>{q.isLoading ? <span className="text-slate-400">…</span> : n}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{t(c.sub)}</span>
            </button>
          );
        })}
      </div>

      {byLevel.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{t("By triage level")}</span>
          {byLevel.map(({ l, n }) => <span key={l} className={clsx("rounded-full px-2.5 py-0.5 text-xs font-semibold", LEVELS[l].chip)}>{`${LEVELS[l].label} ${n}`}</span>)}
        </div>
      )}

      <Card title={`${t(tile.label)}${q.data ? ` · ${shown.length}` : ""}`} className="mt-4">
        {q.isLoading ? <Spinner /> : (
          <Table head={["Level", "Patient", "Complaint", "Doctor", "Bed", "In the ward", as === "DESK" ? "Bill due" : "Status", ""]} {...(shown.length === 0 ? { empty: tile.empty } : {})}>
            {shown.map((c) => {
              const s = STATUS[c.status] ?? { tone: "gray" as const, label: c.status.toLowerCase().replace(/_/g, " ") };
              const m = minutesSince(c.arrivedAt);
              return (
                <tr key={c.id} className={clsx("align-top hover:bg-slate-50", c.triageLevel ? LEVELS[c.triageLevel].row : c.needsTriage ? "border-l-4 border-amber-400 bg-amber-50/40" : "")}>
                  <Td><TriageBadge level={c.triageLevel} /></Td>
                  <Td><span className="font-medium text-slate-900">{c.patient?.name ?? c.caseNumber}</span><div className="text-xs text-slate-500">{`${c.patient?.mrn ?? ""} · ${c.caseNumber}`}</div></Td>
                  <Td className="max-w-[16rem] text-sm">{c.chiefComplaint}<div className="text-xs text-slate-500">{c.arrivalMode.toLowerCase().replace(/_/g, " ")}</div></Td>
                  <Td className="text-sm">{c.doctorName}{!c.doctorAccepted && <div className="text-xs text-red-700">{t("not accepted yet")}</div>}</Td>
                  <Td className="text-sm">{c.bed ? <span className="font-medium">{c.bed.code}</span> : c.admission?.bed ? c.admission.bed : <span className="text-red-700">{t("no bed")}</span>}</Td>
                  <Td className={clsx("whitespace-nowrap text-sm tabular-nums", m >= 60 ? "font-semibold text-amber-700" : "text-slate-700")}>{waited(m)}</Td>
                  <Td>{as === "DESK" ? (Number(c.bill.due) > 0 ? <span className="text-sm font-semibold tabular-nums text-amber-700">{money(c.bill.due)}</span> : <span className="text-slate-400">—</span>) : <Badge tone={s.tone}>{t(s.label)}</Badge>}</Td>
                  <Td><Link className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50" href={`/emergency/${c.id}`}>{as === "NURSE" && c.needsTriage ? t("Triage") : as === "DOCTOR" && !c.doctorAccepted ? t("Accept") : t("Open")}</Link></Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}

/** The emergency nurse's start screen. */
export function ErNurseDashboard() { return <ErDashboard as="NURSE" />; }
