"use client";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { localeFor, useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { Icon, TONE } from "./dashboard-kit";
import { type Req, useRequests } from "./lims-common";
import { ArriveModal } from "./lims-today";

/**
 * Reception's arrival desk for the lab: the patients asked to come today (or earlier and not yet seen), laid out as a day schedule by the time they were
 * given. Reception searches for the patient standing at the desk, marks them arrived (which bills the tests, uses any advance and takes the rest), and
 * sees who is already with the nurse. One row per booking.
 */

interface Visit { batchId: string; patient: Req["patient"]; rows: Req[]; at: string | null; arrived: boolean; arrivedAt: string | null; billed: boolean; priority: Req["priority"]; nurses: string[] }

function visits(rows: Req[]): Visit[] {
  const by = new Map<string, Visit>();
  for (const r of rows) {
    const v = by.get(r.batchId) ?? { batchId: r.batchId, patient: r.patient, rows: [], at: null, arrived: true, arrivedAt: null, billed: true, priority: "ROUTINE" as Req["priority"], nurses: [] };
    v.rows.push(r);
    if (r.scheduledFor && (!v.at || r.scheduledFor < v.at)) v.at = r.scheduledFor;
    if (!r.arrivedAt) v.arrived = false; else if (!v.arrivedAt || r.arrivedAt > v.arrivedAt) v.arrivedAt = r.arrivedAt;
    if (!r.billed) v.billed = false;
    if (r.priority === "EMERGENCY" || (r.priority === "URGENT" && v.priority === "ROUTINE")) v.priority = r.priority;
    const n = r.assignedNurse?.name; if (n && !v.nurses.includes(n)) v.nurses.push(n);
    by.set(r.batchId, v);
  }
  return [...by.values()];
}

/** Where an arrived patient's booking stands now: the least advanced of its tests. */
function whereNow(v: Visit): { label: string; cls: string } {
  const st = v.rows.map((r) => r.status);
  if (st.includes("PENDING_COLLECTION")) return { label: "With the nurse", cls: TONE.amber.pill };
  // Inside the lab, the least advanced test decides what reception is told.
  if (st.includes("COLLECTED")) return { label: "Sample with the lab", cls: TONE.sky.pill };
  if (st.includes("IN_PROCESS")) return { label: "In progress", cls: TONE.sky.pill };
  if (st.includes("PENDING_REVIEW")) return { label: "With the specialist", cls: TONE.sky.pill };
  if (st.includes("PASSED")) return { label: "Report being issued", cls: TONE.sky.pill };
  if (st.includes("ISSUED")) return { label: "Report ready", cls: TONE.violet.pill };
  return { label: "Report handed over", cls: "bg-slate-100 text-slate-600" };
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
const pill = "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium";
type Show = "all" | "waiting" | "arrived";

export function LimsDeskToday({ onOpen }: { onOpen: (r: Req) => void }) {
  const { me, dateTime } = useMe();
  const { lang, t } = useI18n();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const locale = localeFor(lang);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(id); }, []);
  // Today's patients: those still expected (not yet arrived, or arrived and waiting for the sample), and those who arrived today and have moved on since
  // (sample taken, in the lab, report ready), so a patient stays on today's list all day.
  const expected = useRequests({ expected: true, pageSize: 100 }, { every: 15_000 });
  const arrivedToday = useRequests({ arrivedToday: true, pageSize: 100 }, { every: 15_000 });
  const merged = new Map<string, Req>();
  for (const r of [...(expected.data?.items ?? []), ...(arrivedToday.data?.items ?? [])]) if (r.status !== "CANCELLED") merged.set(r.id, r);
  const list = { data: expected.data && arrivedToday.data ? { items: [...merged.values()] } : undefined, isLoading: expected.isLoading || arrivedToday.isLoading };
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [arriving, setArriving] = useState<{ batchId: string; name: string } | null>(null);

  const all = visits(list.data?.items ?? []);
  const isLate = (v: Visit) => !v.arrived && !!v.at && new Date(v.at).getTime() < now;
  const lateBy = (v: Visit) => {
    const m = Math.round((now - new Date(v.at!).getTime()) / 60_000);
    if (m >= 1440) { const d = Math.floor(m / 1440); return `${d} ${d === 1 ? t("day") : t("days")}`; }
    return m >= 120 ? `${Math.floor(m / 60)} h` : `${m} min`;
  };
  const stats = { expected: all.length, arrived: all.filter((v) => v.arrived).length, waiting: all.filter((v) => !v.arrived).length, late: all.filter(isLate).length };

  // Search the patients on today's list: name, MRN, registration number or test.
  const term = search.trim().toLowerCase();
  const shown = all
    .filter((v) => show === "all" || (show === "arrived" ? v.arrived : !v.arrived))
    .filter((v) => !term || [v.patient.name, v.patient.mrn ?? "", ...v.rows.map((r) => r.requestNumber), ...v.rows.map((r) => r.test)].some((s) => s.toLowerCase().includes(term)));

  // The day schedule: one block per hour the patients were given; "Come now" first, then the latest time first. Inside a block, patients still to come first.
  const hourOf = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "");
  const slots = new Map<string, Visit[]>();
  for (const v of [...shown].sort((a, b) => (b.at ?? "9999").localeCompare(a.at ?? "9999") || Number(a.arrived) - Number(b.arrived))) {
    const k = hourOf(v.at);
    slots.set(k, [...(slots.get(k) ?? []), v]);
  }
  const slotLabel = (k: string, first: Visit) => {
    if (!k || !first.at) return { time: t("Come now"), day: "" };
    const d = new Date(first.at);
    const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d) === new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now));
    return { time: new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "numeric" }).format(d), day: sameDay ? t("Today") : new Intl.DateTimeFormat(locale, { timeZone: tz, day: "numeric", month: "short" }).format(d) };
  };

  const Stat = ({ label, value, tone, icon }: { label: string; value: number; tone: keyof typeof TONE; icon: "calendar" | "check" | "hourglass" | "alarm" }) => (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
      <span className={clsx("grid h-9 w-9 place-items-center rounded-lg", TONE[tone].chip)}><Icon name={icon} className="h-[18px] w-[18px]" /></span>
      <span><span className="block text-lg font-semibold leading-tight text-slate-900">{list.data ? value : "…"}</span><span className="block text-xs text-slate-500">{label}</span></span>
    </div>
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="space-y-3 border-b border-slate-100 p-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{t("Today's Patients")}</h2>
            <p className="text-sm text-slate-500">{t("Patients asked to come for their tests today. Mark them arrived when they reach the desk.")}</p>
          </div>
          <span className="text-sm text-slate-500">{new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(now))}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label={t("Expected today")} value={stats.expected} tone="brand" icon="calendar" />
          <Stat label={t("Arrived")} value={stats.arrived} tone="emerald" icon="check" />
          <Stat label={t("Yet to arrive")} value={stats.waiting} tone="amber" icon="hourglass" />
          <Stat label={t("Running late")} value={stats.late} tone="rose" icon="alarm" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[16rem] flex-1">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Find the patient at the desk: name, MRN, registration no. or test")} aria-label={t("Search today's patients")}
              className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-9 pr-8 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
            {search && <button type="button" aria-label={t("Clear search")} onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-slate-400 hover:text-slate-700">✕</button>}
          </label>
          <div className="flex rounded-md border border-slate-300 p-0.5 text-sm" role="tablist" aria-label={t("Show")}>
            {([["all", "All"], ["waiting", "Yet to arrive"], ["arrived", "Arrived"]] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={show === id} onClick={() => setShow(id)} className={clsx("rounded px-3 py-1 font-medium", show === id ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50")}>{t(label)}</button>
            ))}
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-12 text-center text-sm text-slate-500">{list.isLoading ? t("Loading…") : term ? t("No patient on today's list matches. Check the spelling, or book the test under \"Book a test\".") : t("Nobody is expected for a laboratory or imaging test today.")}</p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {[...slots.entries()].map(([k, vs]) => {
            const label = slotLabel(k, vs[0]!);
            return (
              <li key={k || "now"} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 px-4 py-3">
                {/* The time the patients in this block were given */}
                <div className="pt-1 text-right">
                  <p className="text-sm font-semibold text-slate-900">{label.time}</p>
                  {label.day && <p className="text-xs text-slate-500">{label.day}</p>}
                </div>
                <ul className="space-y-2 border-l-2 border-slate-100 pl-3">
                  {vs.map((v) => {
                    const late = isLate(v);
                    return (
                      <li key={v.batchId} className={clsx("flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5", v.arrived ? "border-emerald-200 bg-emerald-50/40" : late ? "border-rose-200 bg-white" : "border-slate-200 bg-white")}>
                        <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold", v.arrived ? "bg-emerald-100 text-emerald-700" : "bg-brand-50 text-brand-700")}>{initials(v.patient.name)}</span>
                        <div className="min-w-[12rem] flex-1">
                          <p className="text-sm"><span className="font-medium text-slate-900">{v.patient.name}</span> <span className="text-slate-500">· {v.patient.mrn}</span></p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {v.rows.map((r) => <button key={r.id} type="button" onClick={() => onOpen(r)} title={r.requestNumber} className={clsx(pill, r.department === "RADIOLOGY" ? TONE.violet.pill : TONE.sky.pill, "hover:brightness-95")}>{r.test}</button>)}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {v.priority !== "ROUTINE" && <span className={clsx(pill, v.priority === "EMERGENCY" ? "bg-rose-600 text-white" : TONE.rose.pill)}>{v.priority === "EMERGENCY" ? "STAT" : t("Urgent")}</span>}
                          <span className={clsx(pill, v.billed ? TONE.emerald.pill : TONE.amber.pill)}>{v.billed ? t("Paid") : t("Payment at arrival")}</span>
                          {v.arrived
                            ? <span className={clsx(pill, TONE.emerald.pill)}><Icon name="check" className="h-3.5 w-3.5" />{t("Arrived")}{v.arrivedAt ? ` ${new Intl.DateTimeFormat(locale, { timeZone: tz, timeStyle: "short" }).format(new Date(v.arrivedAt))}` : ""}</span>
                            : late ? <span className={clsx(pill, TONE.rose.pill)} title={v.at ? dateTime(v.at) : undefined}>{t("Late")} {lateBy(v)}</span>
                            : <span className={clsx(pill, "bg-slate-100 text-slate-600")}>{t("Expected")}</span>}
                          {v.arrived && (() => { const s = whereNow(v); return <span className={clsx(pill, s.cls)}>{t(s.label)}{s.label === "With the nurse" && v.nurses.length ? ` · ${v.nurses.join(", ")}` : ""}</span>; })()}
                        </div>
                        <div className="ml-auto">
                          {v.arrived
                            ? <button type="button" onClick={() => onOpen(v.rows[0]!)} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50">{t("View")}</button>
                            : <button type="button" onClick={() => setArriving({ batchId: v.batchId, name: v.patient.name })} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">{t("Mark arrived")}</button>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
      {arriving && <ArriveModal batchId={arriving.batchId} name={arriving.name} onClose={() => setArriving(null)} />}
    </section>
  );
}
