"use client";
import clsx from "clsx";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useMe } from "@/lib/me";
import { useI18n } from "@/lib/i18n";
import { api, type Query } from "@/lib/api";
import { Icon, TONE } from "./dashboard-kit";
import { type Req, useRequests } from "./lims-common";
import type { DeskTab } from "./lims-desk-dashboard";
import { Field, Input, Select, useDebounced } from "./ui";

/**
 * Reception's lab queue: lab registrations only (tests booked at the lab desk), one row per test. Status filters with live counts, search, department and
 * date filters, sorting, a list or card view, and pages. Every filter is applied by the server; the counts follow the search and filters.
 */

const OPEN = "PENDING_COLLECTION,COLLECTED,IN_PROCESS,PENDING_REVIEW,PASSED";
// "All" keeps a test in view until its report is handed over, so the "Report arrived" column shows when it came; there is no separate chip for ready reports
// (they are handed over under "Reports to hand over").
const CHIPS = {
  all: { label: "All", query: { status: `${OPEN},ISSUED` }, tone: "brand" },
  urgent: { label: "Urgent / STAT", query: { status: `${OPEN},ISSUED`, urgent: true }, tone: "rose" },
  awaitingPatient: { label: "Awaiting Patient", query: { arrived: false }, tone: "sky" },
  awaitingSample: { label: "Awaiting Sample", query: { arrived: true }, tone: "amber" },
  collected: { label: "Sample Collected", query: { status: "COLLECTED" }, tone: "brand" },
  inProcess: { label: "In Process", query: { status: "IN_PROCESS,PENDING_REVIEW,PASSED" }, tone: "emerald" },
  overdue: { label: "Overdue", query: { overdue: true }, tone: "rose" },
} as const satisfies Record<string, { label: string; query: Query; tone: keyof typeof TONE }>;
type Chip = keyof typeof CHIPS;
const CHIP_IDS = Object.keys(CHIPS) as Chip[];
const ACTIVE: Record<keyof typeof TONE, string> = { brand: "bg-brand-600 text-white", rose: "bg-rose-600 text-white", sky: "bg-sky-600 text-white", amber: "bg-amber-500 text-white", emerald: "bg-emerald-600 text-white", violet: "bg-violet-600 text-white" };

const SORTS = { priority: "Priority first", due: "Due time (earliest)", dueDesc: "Due time (latest)", newest: "Newest first" } as const;
type Sort = keyof typeof SORTS;
const PAGE_SIZE = 10;

const PRIORITY = { ROUTINE: { label: "Normal", cls: TONE.brand.pill }, URGENT: { label: "Urgent", cls: TONE.rose.pill }, EMERGENCY: { label: "STAT", cls: "bg-rose-600 text-white" } } as const;

/** What the front desk needs to know about the sample (or, for imaging, the patient), in its words. */
function sampleStatus(r: Req): { label: string; cls: string } | null {
  const rad = r.department === "RADIOLOGY";
  switch (r.status) {
    case "PENDING_COLLECTION":
      if (r.needsRecollection) return { label: "New sample needed", cls: TONE.rose.pill };
      return r.arrivedAt ? { label: rad ? "Awaiting scan" : "Awaiting sample", cls: TONE.amber.pill } : null;
    case "COLLECTED": return { label: rad ? "Patient ready" : "Sample collected", cls: TONE.brand.pill };
    case "IN_PROCESS": return { label: "In process", cls: TONE.emerald.pill };
    case "PENDING_REVIEW": return { label: "Under review", cls: TONE.violet.pill };
    case "PASSED": return { label: "Ready to issue", cls: TONE.emerald.pill };
    case "ISSUED": return { label: "Report ready", cls: TONE.violet.pill };
    case "HANDED_OVER": return { label: "Handed over", cls: "bg-slate-100 text-slate-600" };
    case "CANCELLED": return { label: "Cancelled", cls: "bg-slate-100 text-slate-500" };
    default: return null;
  }
}

const pill = "inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium";

/** Whether the report has come back from the lab: arrived (issued, with the time), passed and about to be issued, or still pending. */
function ReportArrived({ r }: { r: Req }) {
  const { dateTime } = useMe();
  const { t } = useI18n();
  if (r.status === "CANCELLED") return <span className="text-slate-400">—</span>;
  if (r.stamps.issuedAt) return <span className={clsx(pill, TONE.emerald.pill)} title={dateTime(r.stamps.issuedAt)}>{t("Arrived")} · {dateTime(r.stamps.issuedAt)}</span>;
  if (r.status === "PASSED") return <span className={clsx(pill, TONE.sky.pill)}>{t("Passed, being issued")}</span>;
  return <span className={clsx(pill, "bg-slate-100 text-slate-500")}>{t("Not yet")}</span>;
}

/** The pages to offer: the first, the last, and two either side of the current one, with gaps shown as "…". */
function pageList(page: number, pages: number): (number | "gap")[] {
  const keep = new Set([1, pages, page - 1, page, page + 1, ...(page <= 3 ? [2, 3, 4] : []), ...(page >= pages - 2 ? [pages - 3, pages - 2, pages - 1] : [])]);
  const nums = [...keep].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  nums.forEach((n, i) => { if (i > 0 && n - nums[i - 1]! > 1) out.push("gap"); out.push(n); });
  return out;
}

function RowMenu({ r, onTab }: { r: Req; onTab: (t: DeskTab) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const item = "block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50";
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={t("More actions")} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="grid h-7 w-7 place-items-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"><Icon name="chevronDown" className="h-4 w-4" /></button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          <Link role="menuitem" href={`/patients/${r.patient.id}`} className={item}>{t("Open patient profile")}</Link>
          {r.status === "PENDING_COLLECTION" && !r.arrivedAt && <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onTab("today"); }}>{t("Patient arrived & payment")}</button>}
          {r.status === "ISSUED" && <a role="menuitem" href={`/api/proxy/lims/requests/${r.id}/report`} target="_blank" rel="noreferrer" className={item}>{t("Print report")}</a>}
          {r.status === "ISSUED" && <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onTab("handover"); }}>{t("Hand over report")}</button>}
        </div>
      )}
    </div>
  );
}

export function LimsDeskQueue({ onOpen, onTab }: { onOpen: (r: Req) => void; onTab: (t: DeskTab) => void }) {
  const { dateTime } = useMe();
  const { t } = useI18n();
  const [chip, setChip] = useState<Chip>("all");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [showFilters, setShowFilters] = useState(false);
  const [department, setDepartment] = useState<"" | "PATHOLOGY" | "RADIOLOGY">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<Sort>("priority");
  const [view, setView] = useState<"list" | "grid">("list");
  const [page, setPage] = useState(1);
  // Any change of filter, search or order starts again at page 1.
  useEffect(() => { setPage(1); }, [chip, q, department, from, to, sort]);

  const base: Query = { origin: "OPD", labOnly: true, ...(q.length >= 2 ? { q } : {}), ...(department ? { department } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const list = useRequests({ ...base, ...CHIPS[chip].query, sort, page, pageSize: PAGE_SIZE }, { every: 15_000 });
  const countQs = useQueries({ queries: CHIP_IDS.map((id) => {
    const query: Query = { ...base, ...CHIPS[id].query, pageSize: 1 };
    return { queryKey: ["lims-requests", "count", query], queryFn: () => api.get<{ total: number }>("/lims/requests", query), refetchInterval: 30_000 };
  }) });
  const counts = Object.fromEntries(CHIP_IDS.map((id, i) => [id, countQs[i]?.data?.total])) as Record<Chip, number | undefined>;
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtersOn = (department ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0);
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, page * PAGE_SIZE);
  const due = (r: Req) => {
    const late = r.delayed && !["ISSUED", "HANDED_OVER", "CANCELLED"].includes(r.status);
    return <span className={clsx("whitespace-nowrap", late ? "font-medium text-rose-600" : "text-slate-700")}>{dateTime(r.dueAt)}{late && <span className="block text-xs">({t("late")})</span>}</span>;
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="space-y-3 p-4">
        <h2 className="text-lg font-semibold text-slate-900">{t("Lab Queue (Registrations)")}</h2>

        {/* Status filters, each with its count */}
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("Queue filters")}>
          {CHIP_IDS.map((id) => {
            const c = CHIPS[id];
            return (
              <button key={id} type="button" role="tab" aria-selected={chip === id} onClick={() => setChip(id)}
                className={clsx("rounded-full px-3 py-1 text-sm font-medium transition", chip === id ? ACTIVE[c.tone] : clsx(TONE[c.tone].pill, "hover:brightness-95"))}>
                {t(c.label)}{counts[id] !== undefined ? ` (${counts[id]})` : ""}
              </button>
            );
          })}
        </div>

        {/* Search, filters, sort and view */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[16rem] flex-1">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search by patient name, MRN, registration no. or test…")} aria-label={t("Search the lab queue")}
              className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
          </label>
          <button type="button" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}
            className={clsx("flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium", filtersOn ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50")}>
            <Icon name="filter" className="h-4 w-4" />{t("Filters")}{filtersOn ? ` (${filtersOn})` : ""}
          </button>
          <label className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-600">
            <span className="whitespace-nowrap">{t("Sort by:")}</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t("Sort by")} className="border-0 bg-transparent py-1.5 pr-6 text-sm font-medium text-slate-800 focus:outline-none focus:ring-0">
              {(Object.keys(SORTS) as Sort[]).map((s) => <option key={s} value={s}>{t(SORTS[s])}</option>)}
            </select>
          </label>
          <div className="flex overflow-hidden rounded-md border border-slate-300" role="group" aria-label={t("View")}>
            <button type="button" aria-label={t("List view")} aria-pressed={view === "list"} onClick={() => setView("list")} className={clsx("grid h-8 w-9 place-items-center", view === "list" ? "bg-brand-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50")}><Icon name="list" className="h-4 w-4" /></button>
            <button type="button" aria-label={t("Card view")} aria-pressed={view === "grid"} onClick={() => setView("grid")} className={clsx("grid h-8 w-9 place-items-center border-l border-slate-300", view === "grid" ? "bg-brand-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50")}><Icon name="grid" className="h-4 w-4" /></button>
          </div>
        </div>
        {showFilters && (
          <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-4">
            <Field label="Department"><Select value={department} onChange={(e) => setDepartment(e.target.value as typeof department)}><option value="">All</option><option value="PATHOLOGY">Pathology (laboratory)</option><option value="RADIOLOGY">Radiology (imaging)</option></Select></Field>
            <Field label="Booked from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="Booked to"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <div className="flex items-end"><button type="button" disabled={!filtersOn} onClick={() => { setDepartment(""); setFrom(""); setTo(""); }} className="rounded-md px-3 py-1.5 text-sm font-medium text-brand-700 hover:underline disabled:text-slate-400 disabled:no-underline">{t("Clear filters")}</button></div>
          </div>
        )}
      </div>

      {/* The rows */}
      {rows.length === 0 ? (
        <p className="border-t border-slate-100 px-4 py-10 text-center text-sm text-slate-500">{list.isLoading ? t("Loading…") : t("No lab registrations match.")}</p>
      ) : view === "list" ? (
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
              <tr>
                <th className="px-4 py-2">#</th><th className="px-2 py-2">{t("Reg. No.")}</th><th className="px-2 py-2">{t("Patient (MRN)")}</th><th className="px-2 py-2">{t("Tests")}</th>
                <th className="px-2 py-2">{t("Priority")}</th><th className="px-2 py-2">{t("Attendance")}</th><th className="px-2 py-2">{t("Sample Status")}</th><th className="px-2 py-2">{t("Report Arrived")}</th>
                <th className="px-2 py-2"><button type="button" onClick={() => setSort(sort === "due" ? "dueDesc" : "due")} className="inline-flex items-center gap-1 font-medium hover:text-slate-800">{t("Due Time")}{sort === "due" ? <Icon name="arrowUp" className="h-3.5 w-3.5" /> : sort === "dueDesc" ? <Icon name="arrowDown" className="h-3.5 w-3.5" /> : null}</button></th>
                <th className="px-4 py-2 text-right">{t("Actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => {
                const s = sampleStatus(r);
                return (
                  <tr key={r.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-2.5 text-slate-500">{first + i}</td>
                    <td className="px-2 py-2.5"><button type="button" onClick={() => onOpen(r)} className="whitespace-nowrap font-medium text-brand-600 hover:underline">{r.requestNumber}</button></td>
                    <td className="px-2 py-2.5"><span className="font-medium text-slate-900">{r.patient.name}</span><span className="block text-xs text-slate-500">{r.patient.mrn}</span></td>
                    <td className="px-2 py-2.5 text-slate-700">{r.test}</td>
                    <td className="px-2 py-2.5"><span className={clsx(pill, PRIORITY[r.priority].cls)}>{t(PRIORITY[r.priority].label)}</span></td>
                    <td className="px-2 py-2.5"><span className={clsx(pill, r.arrivedAt ? TONE.emerald.pill : "bg-slate-100 text-slate-600")}>{r.arrivedAt ? t("Arrived") : t("Not arrived")}</span></td>
                    <td className="px-2 py-2.5">{s ? <span className={clsx(pill, s.cls)}>{t(s.label)}</span> : <span className="text-slate-400">—</span>}</td>
                    <td className="px-2 py-2.5"><ReportArrived r={r} /></td>
                    <td className="px-2 py-2.5">{due(r)}</td>
                    <td className="px-4 py-2.5"><div className="flex items-center justify-end gap-1.5"><button type="button" onClick={() => onOpen(r)} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50">{t("View")}</button><RowMenu r={r} onTab={onTab} /></div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-3 border-t border-slate-100 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((r) => {
            const s = sampleStatus(r);
            return (
              <div key={r.id} className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
                <div className="flex items-start justify-between gap-2">
                  <button type="button" onClick={() => onOpen(r)} className="text-sm font-medium text-brand-600 hover:underline">{r.requestNumber}</button>
                  <span className={clsx(pill, PRIORITY[r.priority].cls)}>{t(PRIORITY[r.priority].label)}</span>
                </div>
                <div><p className="font-medium text-slate-900">{r.patient.name}</p><p className="text-xs text-slate-500">{r.patient.mrn} · {r.test}</p></div>
                <div className="flex flex-wrap gap-1.5">
                  <span className={clsx(pill, r.arrivedAt ? TONE.emerald.pill : "bg-slate-100 text-slate-600")}>{r.arrivedAt ? t("Arrived") : t("Not arrived")}</span>
                  {s && <span className={clsx(pill, s.cls)}>{t(s.label)}</span>}
                  <ReportArrived r={r} />
                </div>
                <div className="text-xs text-slate-500">{t("Due")}: {due(r)}</div>
                <div className="mt-auto flex items-center justify-end gap-1.5 pt-1"><button type="button" onClick={() => onOpen(r)} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50">{t("View")}</button><RowMenu r={r} onTab={onTab} /></div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pages */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm">
        <span className="text-slate-600">{t("Showing")} {first} – {last} {t("of")} {total} {t("tests")}</span>
        {pages > 1 && (
          <nav className="flex items-center gap-1" aria-label={t("Pages")}>
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-slate-700 hover:bg-slate-50 disabled:text-slate-300"><Icon name="chevronLeft" className="h-4 w-4" />{t("Prev")}</button>
            {pageList(page, pages).map((p, i) => p === "gap"
              ? <span key={`gap${i}`} className="px-1.5 text-slate-400">…</span>
              : <button key={p} type="button" aria-current={p === page ? "page" : undefined} onClick={() => setPage(p)} className={clsx("min-w-[2rem] rounded-md px-2 py-1 font-medium", p === page ? "bg-brand-600 text-white" : "border border-slate-200 text-slate-700 hover:bg-slate-50")}>{p}</button>)}
            <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)} className="flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-slate-700 hover:bg-slate-50 disabled:text-slate-300">{t("Next")}<Icon name="chevronRight" className="h-4 w-4" /></button>
          </nav>
        )}
      </div>
    </section>
  );
}
