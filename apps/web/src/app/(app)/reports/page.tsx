"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { todayIn } from "@/components/pickers";
import { Button, Card, ErrorNote, Input, PageHeader, Select, Spinner } from "@/components/ui";
import { PANEL } from "@/components/desk-ui";
import { reportToCsv } from "@/lib/csv";
import { api } from "@/lib/api";
import { needsDesk, useDesk } from "@/lib/desk";
import { useMe } from "@/lib/me";
import { REPORT_PERMISSIONS } from "@/lib/nav";

/** `perm` is the report's area: shown to holders of that permission or of REPORT_READ (the API applies the same rule). */
interface ReportDef { id: string; label: string; path: string; ranged: boolean; perm: "REPORT_OPD" | "REPORT_FINANCE" | "REPORT_IPD" | "REPORT_PHARMACY" | "REPORT_MY_PRACTICE"; feature?: "PHARMACY_ENABLED" | "IPD_ENABLED"; extra?: Record<string, string> }
const REPORTS: ReportDef[] = [
  { id: "bookings-earnings", label: "Bookings and earnings by doctor", path: "bookings/by-doctor", ranged: true, perm: "REPORT_FINANCE" },
  { id: "my-bookings", label: "My bookings and earnings", path: "bookings/my", ranged: true, perm: "REPORT_MY_PRACTICE" },
  { id: "my-payouts", label: "My payout statement", path: "earnings/my-statement", ranged: true, perm: "REPORT_MY_PRACTICE" },
  { id: "opd-daily", label: "OPD visits per day", path: "opd/daily", ranged: true, perm: "REPORT_OPD" },
  { id: "opd-doctor", label: "OPD visits by doctor", path: "opd/by-doctor", ranged: true, perm: "REPORT_OPD" },
  { id: "opd-dept", label: "OPD visits by department", path: "opd/by-department", ranged: true, perm: "REPORT_OPD" },
  { id: "collections", label: "Collections and payment modes", path: "collections", ranged: true, perm: "REPORT_FINANCE" },
  { id: "registrations", label: "Patient registrations and fees", path: "registrations", ranged: true, perm: "REPORT_FINANCE" },
  { id: "fee-skips", label: "Booking fees skipped", path: "booking-fee-skips", ranged: true, perm: "REPORT_FINANCE" },
  { id: "shifts", label: "Cashier shifts", path: "cashier-shifts", ranged: true, perm: "REPORT_FINANCE" },
  { id: "outstanding", label: "Outstanding bills", path: "outstanding-invoices", ranged: false, perm: "REPORT_FINANCE" },
  { id: "cur-adm", label: "Current admissions", path: "ipd/current-admissions", ranged: false, perm: "REPORT_IPD", feature: "IPD_ENABLED" },
  { id: "discharge-tat", label: "Discharge turnaround times", path: "ipd/discharge-turnaround", ranged: true, perm: "REPORT_IPD", feature: "IPD_ENABLED" },
  { id: "adm-dis", label: "Admissions and discharges", path: "ipd/admissions-discharges", ranged: true, perm: "REPORT_IPD", feature: "IPD_ENABLED" },
  { id: "occupancy", label: "Bed occupancy", path: "ipd/bed-occupancy", ranged: false, perm: "REPORT_IPD", feature: "IPD_ENABLED" },
  { id: "consumption-cost", label: "Stock received, used and held (at cost)", path: "pharmacy/consumption-cost", ranged: true, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
  { id: "sales", label: "Pharmacy sales", path: "pharmacy/sales", ranged: true, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
  { id: "movement", label: "Stock movement", path: "pharmacy/stock-movement", ranged: true, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
  { id: "stock", label: "Current pharmacy stock", path: "pharmacy/stock", ranged: false, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
  { id: "low", label: "Low stock", path: "pharmacy/low-stock", ranged: false, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
  { id: "expiry", label: "Near-expiry stock", path: "pharmacy/near-expiry", ranged: false, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
];

const humanize = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const isPrim = (v: unknown): v is string | number | boolean | null => v === null || ["string", "number", "boolean"].includes(typeof v);
const cell = (v: unknown): string => (v === null || v === undefined ? "—" : v instanceof Object ? "" : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? new Date(String(v)).toLocaleString("en-IN") : String(v));

/** Generic renderer: scalar fields become summary tiles, arrays of objects become tables. Reports are read-only views of server-computed data. */
const NUMERIC = /^[-+]?[\d,]*\.?\d+(%| min)?$/;
function Render({ data }: { data: Record<string, unknown> }) {
  const scalars = Object.entries(data).filter(([, v]) => isPrim(v));
  const objects = Object.entries(data).filter(([, v]) => v && !Array.isArray(v) && typeof v === "object") as [string, Record<string, unknown>][];
  const arrays = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object") as [string, Record<string, unknown>[]][];
  const emptyArrays = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length === 0);
  // Every single figure of the report, named (the "totals" group is just its figures: "Booked", not "Totals · Booked").
  const entries: [string, unknown][] = [
    ...scalars.map(([k, v]) => [humanize(k), v] as [string, unknown]),
    ...objects.flatMap(([g, o]) => Object.entries(o).filter(([, v]) => isPrim(v)).map(([k, v]) => [g === "totals" ? humanize(k) : `${humanize(g)} · ${humanize(k)}`, v] as [string, unknown])),
  ];
  const isNumber = (v: unknown): boolean => typeof v === "number" || (typeof v === "string" && NUMERIC.test(v));
  // Words and dates (the period, the doctor, a rule) read as a line of facts; numbers are the tiles. Text is never cut short.
  const facts = entries.filter(([, v]) => !isNumber(v));
  const figures = entries.filter(([, v]) => isNumber(v));
  return (
    <div className="space-y-4">
      {facts.length > 0 && (
        <dl className={`${PANEL} grid gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4`}>
          {facts.map(([label, v]) => <div key={label} className="min-w-0"><dt className="text-[10.5px] font-medium uppercase tracking-wider text-slate-500">{label}</dt><dd className="break-words text-sm font-medium text-slate-900">{cell(v)}</dd></div>)}
        </dl>
      )}
      {figures.length > 0 && (
        <dl className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4">
          {figures.map(([label, v]) => (
            <div key={label} className={`${PANEL} px-3.5 py-2.5`}>
              <div className="text-[10.5px] font-medium uppercase leading-tight tracking-wider text-slate-500">{label}</div>
              <div className="text-lg font-semibold tabular-nums leading-tight text-slate-900">{cell(v)}</div>
            </div>
          ))}
        </dl>
      )}
      {arrays.map(([name, rows]) => {
        const cols = Object.keys(rows[0] ?? {}).filter((c) => isPrim(rows[0]?.[c]) && !/(^id$|Id$)/.test(c));
        // Columns that hold numbers or amounts line up on the right, so they can be read down the page.
        const right = new Set(cols.filter((c) => rows.every((r) => r[c] === null || r[c] === undefined || NUMERIC.test(String(r[c])))));
        return (
          <section key={name} className={PANEL}>
            <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{humanize(name)}</h2><span className="text-xs text-slate-500">{rows.length} {rows.length === 1 ? "row" : "rows"}</span></header>
            <div className="overflow-x-auto px-4 pb-1">
              <table className="w-full text-sm">
                <thead><tr className="text-[11px] uppercase tracking-wider text-slate-500">{cols.map((c) => <th key={c} className={`py-2 pr-3 font-medium ${right.has(c) ? "text-right" : "text-left"}`}>{humanize(c)}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">{rows.map((r, i) => <tr key={i} className="hover:bg-slate-50/70">{cols.map((c) => <td key={c} className={`py-2 pr-3 ${right.has(c) ? "whitespace-nowrap text-right tabular-nums text-slate-800" : "text-slate-800"}`}>{cell(r[c])}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </section>
        );
      })}
      {arrays.length === 0 && emptyArrays.length > 0 && <p className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">No data for this selection.</p>}
    </div>
  );
}

function saveFile(title: string, base: string, data: Record<string, unknown>) {
  // The byte-order mark makes Excel read the file as UTF-8, so ₹ and Bengali/Hindi names are not garbled.
  const blob = new Blob(["\uFEFF", reportToCsv(title, data)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${base}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Number of table rows in a report, for the audit entry (the rows themselves are not sent). */
const rowCount = (data: Record<string, unknown>): number => Object.values(data).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);

export default function ReportsPage() {
  const { me, features, can } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  // Reception at the OPD desk sees the outpatient reports only: the inpatient (IPD) section belongs to the IPD desk.
  const { desk } = useDesk();
  const opdDesk = needsDesk(me.roles, features) && desk === "OPD";
  const available = REPORTS.filter((r) => !(opdDesk && r.perm === "REPORT_IPD") && (!r.feature || features[r.feature]) && (r.perm === "REPORT_MY_PRACTICE" ? can("REPORT_MY_PRACTICE") : can("REPORT_READ", r.perm)));
  // A cashier (finance reports, not all reports) opens on the money taken; everyone else on the first report they may see.
  const firstReport = (can("REPORT_FINANCE") && !can("REPORT_READ") ? available.find((r) => r.id === "collections") : undefined) ?? available[0];
  const [id, setId] = useState(firstReport?.id ?? "opd-daily");
  // A link such as /reports?report=expiry opens that report (only if this person may see it).
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("report");
    if (want && available.some((r) => r.id === want)) setId(want);
  }, []);
  const [from, setFrom] = useState(todayIn(tz));
  const [to, setTo] = useState(todayIn(tz));
  const [days, setDays] = useState("90");
  const def = available.find((r) => r.id === id) ?? available[0];
  // The export is written to the audit trail first; if that fails the file is not saved, so no export goes unrecorded.
  const exportCsv = useMutation({
    mutationFn: async (d: { def: ReportDef; data: Record<string, unknown> }) => {
      await api.post("/reports/export-log", { report: d.def.id, ...(d.def.ranged ? { from, to } : {}), rows: rowCount(d.data) });
      saveFile(d.def.label, d.def.ranged ? `${d.def.id}_${from}_${to}` : d.def.id, d.data);
    },
  });
  const q = useQuery({
    queryKey: ["report", def?.id, from, to, days],
    queryFn: () => api.get<Record<string, unknown>>(`/reports/${def!.path}`, def!.ranged ? { from, to } : def!.id === "expiry" ? { withinDays: days } : undefined),
    enabled: !!def,
  });
  // Date presets: one click instead of typing two dates (the report still takes any range).
  const addDays = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
  const todayStr = todayIn(tz);
  const PRESETS: [string, string, string][] = [
    ["Today", todayStr, todayStr],
    ["Yesterday", addDays(todayStr, -1), addDays(todayStr, -1)],
    ["Last 7 days", addDays(todayStr, -6), todayStr],
    ["This month", `${todayStr.slice(0, 8)}01`, todayStr],
  ];
  const AREAS: Record<string, string> = { REPORT_FINANCE: "Finance", REPORT_OPD: "OPD", REPORT_IPD: "Inpatient", REPORT_PHARMACY: "Pharmacy", REPORT_MY_PRACTICE: "My practice" };
  const groups = Object.entries(AREAS).map(([perm, label]) => [label, available.filter((r) => r.perm === perm)] as const).filter(([, rs]) => rs.length > 0);
  // Finance first for the cashier, whatever order the list is written in.
  const first = can("REPORT_FINANCE") && !can("REPORT_READ") ? "Finance" : can("REPORT_MY_PRACTICE") && !can("REPORT_READ") ? "My practice" : null;
  const ordered = first ? [...groups].sort((x, y) => (x[0] === first ? -1 : y[0] === first ? 1 : 0)) : groups;
  return (
    <Gate anyOf={REPORT_PERMISSIONS}>
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
        <PageHeader title="Reports" subtitle="Operational reports for your facility" />
        {!def ? <Card><p className="text-sm text-slate-500">No reports are available for your role at this facility.</p></Card> : (
          <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
            {/* The report list stays on screen beside the result: switching report is one click, no dropdown to open. */}
            <nav className={`${PANEL} hidden self-start p-2 lg:block`} aria-label="Reports">
              {ordered.map(([label, rs]) => (
                <div key={label} className="mb-1.5 last:mb-0">
                  <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-teal-700">{label}</div>
                  {rs.map((r) => (
                    <button key={r.id} type="button" onClick={() => setId(r.id)} aria-current={r.id === def.id ? "page" : undefined} className={`block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] leading-snug transition ${r.id === def.id ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700 hover:bg-slate-50"}`}>{r.label}</button>
                  ))}
                </div>
              ))}
            </nav>
            <div className="min-w-0 space-y-3">
              <section className={`${PANEL} px-4 py-3`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-slate-900">{def.label}</h2>
                  <Button variant="secondary" disabled={!q.data} loading={exportCsv.isPending} onClick={() => exportCsv.mutate({ def, data: q.data! })}>Download CSV</Button>
                </div>
                <div className="mt-2.5 flex flex-wrap items-end gap-2.5">
                  <div className="w-full lg:hidden"><Select aria-label="Report" value={def.id} onChange={(e) => setId(e.target.value)}>{available.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select></div>
                  {def.ranged && (
                    <>
                      <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5" role="group" aria-label="Date range">
                        {PRESETS.map(([label, f, t]) => <button key={label} type="button" onClick={() => { setFrom(f); setTo(t); }} className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${from === f && to === t ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{label}</button>)}
                      </div>
                      <div className="w-36"><Input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                      <span className="pb-2 text-slate-500">–</span>
                      <div className="w-36"><Input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} /></div>
                    </>
                  )}
                  {def.id === "expiry" && <label className="flex items-center gap-2 text-sm text-slate-600">Within <div className="w-20"><Input aria-label="Days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></div> days</label>}
                  {!def.ranged && def.id !== "expiry" && <span className="text-xs text-slate-500">Shows the position as of now</span>}
                </div>
              </section>
              {exportCsv.error ? <ErrorNote error={exportCsv.error} /> : null}
              {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : q.data ? <Render data={q.data} /> : null}
            </div>
          </div>
        )}
      </div>
    </Gate>
  );
}
