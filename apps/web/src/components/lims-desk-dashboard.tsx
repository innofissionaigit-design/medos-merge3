"use client";
import clsx from "clsx";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { localeFor, useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { Empty, Icon, Panel, StatTile, TONE, td, th, useFitToScreen, type IconName, type Tone } from "./dashboard-kit";
import { type Req, useRequests } from "./lims-common";
import { useCatalogue } from "./lims-picker";
import { hrefOf, kindOf, type NotificationRow } from "./notifications";

/**
 * The lab desk's dashboard for reception: today's lab registrations and where they stand, the lab queue, reports ready to hand over, and the common
 * actions. It shows lab registrations only (tests booked at the lab desk); every number comes from the laboratory's own records, scoped by the user's
 * permissions on the server.
 */

export type DeskTab = "dashboard" | "advised" | "book" | "today" | "queue" | "handover";

const IN_PROCESS = "COLLECTED,IN_PROCESS,PENDING_REVIEW,PASSED";
const QUEUE_FILTERS = {
  all: { label: "All", status: `PENDING_COLLECTION,${IN_PROCESS},ISSUED` },
  collect: { label: "To collect", status: "PENDING_COLLECTION" },
  process: { label: "In process", status: IN_PROCESS },
  ready: { label: "Ready", status: "ISSUED" },
} as const;
type QueueFilter = keyof typeof QUEUE_FILTERS;

/** One registration: the tests booked together for a patient (one booking), shown as one row. */
interface Registration { batchId: string; number: string; patient: Req["patient"]; tests: string[]; first: Req; createdAt: string; stage: "collect" | "process" | "ready" | "done" }

function stageOf(rows: Req[]): Registration["stage"] {
  const open = rows.filter((r) => r.status !== "CANCELLED");
  if (open.some((r) => r.status === "PENDING_COLLECTION")) return "collect";
  if (open.some((r) => IN_PROCESS.split(",").includes(r.status))) return "process";
  if (open.some((r) => r.status === "ISSUED")) return "ready";
  return "done";
}
function group(rows: Req[]): Registration[] {
  const by = new Map<string, Req[]>();
  for (const r of rows) by.set(r.batchId, [...(by.get(r.batchId) ?? []), r]);
  return [...by.values()].map((rs) => {
    const sorted = [...rs].sort((a, b) => a.requestNumber.localeCompare(b.requestNumber));
    const first = sorted[0]!;
    return { batchId: first.batchId, number: first.requestNumber, patient: first.patient, tests: sorted.map((r) => r.test), first, createdAt: first.createdAt, stage: stageOf(sorted) };
  });
}
const STAGE = { collect: { label: "To collect", tone: TONE.amber.pill }, process: { label: "In process", tone: TONE.brand.pill }, ready: { label: "Ready", tone: TONE.emerald.pill }, done: { label: "Handed over", tone: "bg-slate-100 text-slate-600" } } as const;
function StageChip({ stage }: { stage: Registration["stage"] }) {
  const { t } = useI18n();
  return <span className={clsx("whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium", STAGE[stage].tone)}>{t(STAGE[stage].label)}</span>;
}

/** A count of lab registrations matching a filter (the list is asked for one row; the total is what matters). */
function useCount(query: Record<string, string | boolean>, every = 30_000) {
  const q = useRequests({ origin: "OPD", labOnly: true, pageSize: 1, ...query }, { every });
  return q.data?.total;
}

function Donut({ done, total }: { done: number; total: number }) {
  const { t } = useI18n();
  const pct = total ? Math.round((done / total) * 100) : 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-28 w-28 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="11" className="stroke-slate-100" />
        {pct > 0 && <circle cx="50" cy="50" r={r} fill="none" strokeWidth="11" strokeLinecap="round" className="stroke-brand-600 transition-all" strokeDasharray={`${(pct / 100) * c} ${c}`} />}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center"><span><span className="block text-xl font-semibold text-slate-900">{pct}%</span><span className="block text-[11px] text-slate-500">{t("Collected")}</span></span></div>
    </div>
  );
}

export function LimsDeskDashboard({ onTab, onRegister, onQuickAdd, onOpen }: { onTab: (t: DeskTab) => void; onRegister: () => void; onQuickAdd: (serviceId: string) => void; onOpen: (r: Req) => void }) {
  const { me, can } = useMe();
  const { lang, t } = useI18n();
  const fit = useFitToScreen<HTMLDivElement>();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const locale = localeFor(lang);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(id); }, []);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const time = (v: string) => new Intl.DateTimeFormat(locale, { timeZone: tz, timeStyle: "short" }).format(new Date(v));
  const ago = (v: string) => {
    const m = Math.max(0, Math.round((now.getTime() - new Date(v).getTime()) / 60_000));
    if (m < 1) return t("Now");
    if (m < 60) return `${m} ${t("min ago")}`;
    if (m < 60 * 24) return `${Math.round(m / 60)} ${t("h ago")}`;
    return new Intl.DateTimeFormat(locale, { timeZone: tz, day: "numeric", month: "short" }).format(new Date(v));
  };

  // Today's registrations (booked today), and the open work whatever day it was booked.
  const todays = useRequests({ origin: "OPD", labOnly: true, from: today, to: today, pageSize: 100 }, { every: 20_000 });
  const pending = useCount({ status: "PENDING_COLLECTION" });
  const inProcess = useCount({ status: IN_PROCESS });
  const ready = useRequests({ origin: "OPD", labOnly: true, status: "ISSUED", pageSize: 50 }, { every: 20_000 });
  const delayed = useCount({ overdue: true });
  const [filter, setFilter] = useState<QueueFilter>("all");
  const queue = useRequests({ origin: "OPD", labOnly: true, status: QUEUE_FILTERS[filter].status, pageSize: 100 }, { every: 15_000 });
  const cat = useCatalogue();
  const notes = useQuery({ queryKey: ["lims-desk-notes"], queryFn: () => api.page<NotificationRow>("/notifications", { pageSize: 30 }), refetchInterval: 30_000 });

  const todayRows = (todays.data?.items ?? []).filter((r) => r.status !== "CANCELLED");
  const collected = todayRows.filter((r) => r.status !== "PENDING_COLLECTION").length;
  const recent = group(todayRows).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const queueRows = group(queue.data?.items ?? []);
  const counts: Record<QueueFilter, number | undefined> = { all: pending !== undefined && inProcess !== undefined && ready.data ? pending + inProcess + ready.data.total : undefined, collect: pending, process: inProcess, ready: ready.data?.total };
  const labNotes = (notes.data?.data ?? []).filter((n) => n.type.startsWith("LIMS_") || n.type.startsWith("CRITICAL_")).slice(0, 4);
  const common = (cat.data ?? []).filter((c) => c.department === "PATHOLOGY").concat((cat.data ?? []).filter((c) => c.department === "RADIOLOGY")).slice(0, 10);

  const actions: { label: string; icon: IconName; tone: Tone; run: () => void; show: boolean }[] = [
    { label: "Register test for new patient", icon: "userPlus", tone: "brand", run: onRegister, show: can("PATIENT_CREATE") },
    { label: "Book tests for a patient", icon: "plus", tone: "violet", run: () => onTab("book"), show: true },
    { label: "Patient arrived & payment", icon: "receipt", tone: "emerald", run: () => onTab("today"), show: can("PAYMENT_CREATE") },
    { label: "Lab queue", icon: "list", tone: "sky", run: () => onTab("queue"), show: true },
    { label: "Hand over reports", icon: "handover", tone: "amber", run: () => onTab("handover"), show: true },
  ];

  return (
    <div ref={fit.ref} style={fit.height ? { height: fit.height } : undefined} className="flex flex-col gap-3">
      <p className="flex shrink-0 items-center gap-2 text-sm text-slate-600">
        <Icon name="calendar" className="h-4 w-4 text-slate-500" />
        <span>{new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(now)}</span>
        <span className="text-slate-500">|</span>
        <span>{new Intl.DateTimeFormat(locale, { timeZone: tz, timeStyle: "short" }).format(now)}</span>
      </p>

      {/* Today's numbers */}
      <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile icon="tube" tone="brand" value={todays.data?.total} label={t("Tests registered today")} onClick={() => onTab("queue")} />
        <StatTile icon="clipboard" tone="violet" value={todays.data ? collected : undefined} label={t("Samples collected")} note={todays.data && todayRows.length ? `${Math.round((collected / todayRows.length) * 100)}%` : undefined} noteTone="violet" onClick={() => onTab("queue")} />
        <StatTile icon="hourglass" tone="amber" value={pending} label={t("Pending collection")} onClick={() => setFilter("collect")} />
        <StatTile icon="flask" tone="sky" value={inProcess} label={t("In process")} onClick={() => setFilter("process")} />
        <StatTile icon="check" tone="emerald" value={ready.data?.total} label={t("Reports ready")} onClick={() => onTab("handover")} />
        <StatTile icon="alarm" tone="rose" value={delayed} label={t("TAT delayed")} note={delayed ? t("late") : undefined} noteTone="rose" onClick={() => onTab("queue")} />
      </div>

      <div className="grid gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex min-w-0 flex-col gap-3 xl:min-h-0">
          <div className="grid gap-3 lg:grid-cols-[15rem_minmax(0,1fr)] xl:min-h-0 xl:flex-[3]">
            {/* Quick actions */}
            <Panel title={t("Quick Actions")}>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-1">
                {actions.filter((a) => a.show).map((a) => (
                  <button key={a.label} type="button" onClick={a.run} className={clsx("flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm font-medium transition", TONE[a.tone].tile)}>
                    <Icon name={a.icon} className="h-[18px] w-[18px] shrink-0" /><span className="leading-tight">{t(a.label)}</span>
                  </button>
                ))}
              </div>
            </Panel>

            {/* Today's lab queue (lab registrations only) */}
            <Panel title={t("Lab Queue (Registrations)")} onViewAll={() => onTab("queue")} viewAll={t("View All")}
              actions={<div className="flex flex-wrap gap-1">{(Object.keys(QUEUE_FILTERS) as QueueFilter[]).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)} className={clsx("rounded-md px-2 py-0.5 text-xs font-medium transition", filter === f ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200")}>{t(QUEUE_FILTERS[f].label)}{counts[f] !== undefined ? ` (${counts[f]})` : ""}</button>
              ))}</div>}>
              {queueRows.length === 0 ? <Empty>{queue.isLoading ? t("Loading…") : t("No lab registrations here.")}</Empty> : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 border-b border-slate-100 bg-white"><tr><th className={th}>#</th><th className={th}>{t("Registration no.")}</th><th className={th}>{t("Patient")}</th><th className={th}>{t("Tests")}</th><th className={th}>{t("Status")}</th><th className={th} /></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {queueRows.map((g, i) => (
                      <tr key={g.batchId}>
                        <td className={clsx(td, "text-slate-500")}>{i + 1}</td>
                        <td className={clsx(td, "whitespace-nowrap font-medium text-brand-600")}>{g.number}</td>
                        <td className={td}><span className="font-medium text-slate-900">{g.patient.name}</span><span className="block text-xs text-slate-500">{g.patient.mrn}</span></td>
                        <td className={clsx(td, "text-slate-700")}>{g.tests.join(", ")}</td>
                        <td className={td}><StageChip stage={g.stage} /></td>
                        <td className={clsx(td, "text-right")}><button type="button" onClick={() => onOpen(g.first)} className="rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-50">{t("View")}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>

          <div className="grid gap-3 lg:grid-cols-2 xl:min-h-0 xl:flex-[2]">
            {/* Today's registrations, newest first */}
            <Panel title={t("Recent Registrations")} onViewAll={() => onTab("queue")} viewAll={t("View All")}>
              {recent.length === 0 ? <Empty>{todays.isLoading ? t("Loading…") : t("No lab registrations today yet.")}</Empty> : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 border-b border-slate-100 bg-white"><tr><th className={th}>{t("Time")}</th><th className={th}>{t("Patient")}</th><th className={th}>{t("Tests")}</th><th className={th}>{t("Status")}</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {recent.map((g) => (
                      <tr key={g.batchId} className="cursor-pointer hover:bg-slate-50" onClick={() => onOpen(g.first)}>
                        <td className={clsx(td, "whitespace-nowrap text-slate-600")}>{time(g.createdAt)}</td>
                        <td className={td}><span className="font-medium text-slate-900">{g.patient.name}</span><span className="block text-xs text-slate-500">{g.number}</span></td>
                        <td className={clsx(td, "text-slate-700")}>{g.tests.join(", ")}</td>
                        <td className={td}><StageChip stage={g.stage} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            {/* Reports issued and waiting at reception */}
            <Panel title={`${t("Reports Ready")}${ready.data ? ` (${ready.data.total})` : ""}`} onViewAll={() => onTab("handover")} viewAll={t("View All")}>
              {(ready.data?.items.length ?? 0) === 0 ? <Empty>{ready.isLoading ? t("Loading…") : t("No reports are waiting at reception.")}</Empty> : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 border-b border-slate-100 bg-white"><tr><th className={th}>{t("Request no.")}</th><th className={th}>{t("Patient")}</th><th className={th}>{t("Test")}</th><th className={th} /></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {ready.data?.items.map((r) => (
                      <tr key={r.id}>
                        <td className={clsx(td, "whitespace-nowrap text-slate-600")}>{r.requestNumber}</td>
                        <td className={clsx(td, "font-medium text-slate-900")}>{r.patient.name}</td>
                        <td className={clsx(td, "text-slate-700")}>{r.test}</td>
                        <td className={clsx(td, "text-right")}><a href={`/api/proxy/lims/requests/${r.id}/report`} target="_blank" rel="noreferrer" title={t("Print report")} aria-label={t("Print report")} className="inline-grid h-7 w-7 place-items-center rounded-md text-brand-600 hover:bg-brand-50"><Icon name="download" className="h-4 w-4" /></a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
        </div>

        {/* Right column */}
        <aside className="grid min-w-0 content-start gap-3 sm:grid-cols-2 xl:flex xl:min-h-0 xl:flex-col">
          <Panel title={t("Sample Collection Status")} className="shrink-0">
            <div className="flex items-center gap-4">
              <Donut done={collected} total={todayRows.length} />
              <ul className="min-w-0 flex-1 space-y-1.5 text-sm">
                <li className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-slate-600"><span className="h-2.5 w-2.5 rounded-full bg-brand-600" />{t("Collected")}</span><span className="font-semibold text-slate-900">{collected}</span></li>
                <li className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-slate-600"><span className="h-2.5 w-2.5 rounded-full bg-slate-200" />{t("Pending")}</span><span className="font-semibold text-slate-900">{todayRows.length - collected}</span></li>
                <li className="flex items-center justify-between gap-2 border-t border-slate-100 pt-1.5"><span className="text-slate-600">{t("Total today")}</span><span className="font-semibold text-slate-900">{todayRows.length}</span></li>
              </ul>
            </div>
          </Panel>

          <Panel title={t("Common Tests (Quick Add)")} className="shrink-0" onViewAll={() => onTab("book")} viewAll={t("More")}>
            {common.length === 0 ? <Empty>{cat.isLoading ? t("Loading…") : t("No tests on the list yet.")}</Empty> : (
              <div className="flex flex-wrap gap-1.5">
                {common.map((c) => <button key={c.serviceId} type="button" title={c.name} onClick={() => onQuickAdd(c.serviceId)} className="max-w-[9rem] truncate rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700">{c.code || c.name}</button>)}
              </div>
            )}
          </Panel>

          <Panel title={t("Lab Notifications")} className="sm:col-span-2 xl:min-h-0 xl:flex-1">
            {labNotes.length === 0 ? <Empty>{notes.isLoading ? t("Loading…") : t("No laboratory notifications.")}</Empty> : (
              <ul className="space-y-2.5">
                {labNotes.map((n) => {
                  const k = kindOf(n.type);
                  return (
                    <li key={n.id}>
                      <Link href={hrefOf(n)} className="flex items-start gap-2.5 text-sm hover:text-brand-600">
                        <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", k.critical ? "bg-rose-500" : n.readAt ? "bg-slate-300" : "bg-brand-500")} />
                        <span className="min-w-0 flex-1 text-slate-700">{t(k.text)}</span>
                        <span className="shrink-0 text-xs text-slate-500">{ago(n.createdAt)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
