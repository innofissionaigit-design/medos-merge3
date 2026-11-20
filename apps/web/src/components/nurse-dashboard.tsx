"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { LabWorkTiles } from "@/components/lab-work-tiles";
import { ErrorNote, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Row {
  admissionId: string; admissionNumber: string; patientName: string; mrn: string | null; gender: string; bed: string | null; ward: string | null; doctor: string; admittedAt: string;
  hasAllergies: boolean; pendingTasks: number; overdueTasks: number; tasks: { id: string; title: string; dueAt: string }[];
  medicationDue: number; medicationOverdue: number; nextMedicationAt: string | null; vitalsDue: boolean; newMedicineOrders?: number;
}
type Filter = "MEDS" | "VITALS" | "TASKS" | "ASSESS" | null;

/** The title of the task made when a planned admission is admitted; it is the nursing admission assessment (docs/planned-admission.md). */
const ASSESSMENT_TITLE = "Nursing admission assessment";
const assessmentDue = (r: Row): boolean => r.tasks.some((t) => t.title === ASSESSMENT_TITLE);

const matches = (f: Filter, r: Row): boolean => f === null || (f === "MEDS" && (r.medicationDue > 0 || r.medicationOverdue > 0)) || (f === "VITALS" && r.vitalsDue) || (f === "TASKS" && r.pendingTasks > 0) || (f === "ASSESS" && assessmentDue(r));

function Icon({ name }: { name: "users" | "pill" | "heart" | "list" | "clipboard" }) {
  const d: Record<string, ReactNode> = {
    users: <><circle cx="9" cy="8" r="3.2" /><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 6.5a3 3 0 0 1 0 5.5M18 14c2 .6 3 2.2 3 5" /></>,
    pill: <><rect x="3" y="9" width="18" height="7" rx="3.5" transform="rotate(-35 12 12)" /><path d="m9 15 6-6" /></>,
    heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.4A4 4 0 0 1 19 10c0 5.600-7 10-7 10zM6 12h3l1.5-2.500 2 4L14 12h4" />,
    list: <path d="M9 6h11M9 12h11M9 18h11M4.500 6h.01M4.500 12h.01M4.500 18h.01" />,
    clipboard: <><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4h6v3H9zM9 12h6M9 16h4" /></>,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d[name]}</svg>;
}

function Tile({ id, label, value, sub, icon, tone, hot, active, onSelect }: { id: Exclude<Filter, null> | "ALL"; label: string; value: number | undefined; sub: string; icon: "users" | "pill" | "heart" | "list" | "clipboard"; tone: string; hot?: boolean; active: boolean; onSelect: (f: Exclude<Filter, null> | "ALL") => void }) {
  const t = useT();
  return (
    <button type="button" onClick={() => onSelect(id)} aria-pressed={active} className={clsx("group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200")}>
      <span className={clsx("absolute inset-x-0 top-0 h-1", tone)} aria-hidden />
      <span className="flex items-center justify-between text-slate-500"><span className="text-xs font-medium uppercase tracking-wide">{t(label)}</span><span className={clsx("flex h-8 w-8 items-center justify-center rounded-lg", hot ? "bg-red-50 text-red-600" : active ? "bg-brand-50 text-brand-700" : "bg-slate-50 group-hover:bg-slate-100")}><Icon name={icon} /></span></span>
      <span className={clsx("mt-2 block text-3xl font-semibold tracking-tight", hot ? "text-red-600" : "text-slate-900")}>{value ?? <span className="text-slate-400">…</span>}</span>
      <span className="mt-0.5 block text-xs text-slate-500">{t(sub)}</span>
    </button>
  );
}

const ago = (iso: string): string => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function Chip({ tone, children }: { tone: "red" | "amber" | "blue" | "green" | "gray"; children: ReactNode }) {
  const c = { red: "bg-red-50 text-red-700 ring-red-200", amber: "bg-amber-50 text-amber-800 ring-amber-200", blue: "bg-brand-50 text-brand-700 ring-brand-200", green: "bg-emerald-50 text-emerald-700 ring-emerald-200", gray: "bg-slate-50 text-slate-600 ring-slate-200" }[tone];
  return <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1", c)}>{children}</span>;
}

/**
 * The ward nurse's own start screen: how many patients she looks after, what is due (medicines, vitals, tasks, the admission assessment of a newly admitted planned patient),
 * and a card per patient with exactly that. The tiles filter the cards in place, so a click stays in nursing work. Everything is read from the ward worklist; giving medicines,
 * recording vitals and signing assessments is done on the patient's own pages, with all their checks.
 */
export function NurseDashboard() {
  const t = useT();
  const { me, can, dateTime } = useMe();
  const [filter, setFilter] = useState<Filter>(null);
  const [ward, setWard] = useState("");
  const [find, setFind] = useState("");
  const list = useQuery({ queryKey: ["worklist"], queryFn: () => api.get<Row[]>("/nursing/worklist"), refetchInterval: 30_000 });
  const all = list.data ?? [];
  const wards = [...new Set(all.map((r) => r.ward).filter((w): w is string => !!w))].sort();
  const inWard = all.filter((r) => !ward || r.ward === ward);
  const shown = inWard.filter((r) => matches(filter, r) && (find.trim().length < 2 || `${r.patientName} ${r.mrn ?? ""} ${r.bed ?? ""}`.toLowerCase().includes(find.trim().toLowerCase())));
  const dosesDue = inWard.reduce((n, r) => n + r.medicationDue + r.medicationOverdue, 0);
  const dosesLate = inWard.reduce((n, r) => n + r.medicationOverdue, 0);
  const medsN = inWard.filter((r) => matches("MEDS", r)).length;
  const vitalsN = inWard.filter((r) => r.vitalsDue).length;
  const tasksN = inWard.filter((r) => r.pendingTasks > 0).length;
  const overdueTasks = inWard.reduce((n, r) => n + r.overdueTasks, 0);
  const assessN = inWard.filter(assessmentDue).length;
  const hour = new Date().getHours();
  const shift = hour >= 6 && hour < 14 ? "Morning shift" : hour >= 14 && hour < 22 ? "Evening shift" : "Night shift";
  const pick = (f: Exclude<Filter, null> | "ALL") => setFilter((cur) => (f === "ALL" || cur === f ? null : f));

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{`${t("Welcome")}, ${me.fullName}`}</h1>
          <p className="text-sm text-slate-500">{`${me.tenant.name} · ${t(shift)} · ${dateTime(new Date().toISOString())}`}</p>
        </div>
        {can("NURSING_READ") && <Link className="whitespace-nowrap rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700" href="/nursing">{t("Full ward worklist")}</Link>}
      </div>
      <ErrorNote error={list.error} />

      {dosesLate > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900" role="alert">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600"><Icon name="pill" /></span>
          <span><b>{dosesLate === 1 ? "1 medicine dose is overdue." : `${dosesLate} medicine doses are overdue.`}</b>{" "}{t("Open the filter below to see which patients.")}</span>
          <button type="button" className="ml-auto whitespace-nowrap rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50" onClick={() => setFilter("MEDS")}>{t("Show medicines due")}</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile id="ALL" label="My patients" value={list.data ? inWard.length : undefined} sub="Admitted on the ward" icon="users" tone="bg-slate-500" active={filter === null} onSelect={pick} />
        <Tile id="MEDS" label="Medicines due" value={list.data ? medsN : undefined} sub={dosesDue > 0 ? `${dosesDue} doses · ${dosesLate} overdue` : "Nothing due"} icon="pill" tone="bg-amber-400" hot={dosesLate > 0} active={filter === "MEDS"} onSelect={pick} />
        <Tile id="VITALS" label="Vitals due" value={list.data ? vitalsN : undefined} sub="Not recorded for 4 hours" icon="heart" tone="bg-rose-400" active={filter === "VITALS"} onSelect={pick} />
        <Tile id="TASKS" label="Tasks" value={list.data ? tasksN : undefined} sub={overdueTasks > 0 ? `${overdueTasks} overdue` : "None overdue"} icon="list" tone="bg-brand-500" hot={overdueTasks > 0} active={filter === "TASKS"} onSelect={pick} />
        <Tile id="ASSESS" label="Admission assessment" value={list.data ? assessN : undefined} sub="New patients to assess" icon="clipboard" tone="bg-emerald-500" hot={assessN > 0} active={filter === "ASSESS"} onSelect={pick} />
      </div>

      <section className="mt-5" aria-label={t("Patients")}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-base font-semibold text-slate-900">{filter === null ? t("My patients") : filter === "MEDS" ? t("Medicines due") : filter === "VITALS" ? t("Vitals due") : filter === "TASKS" ? t("Tasks") : t("Admission assessment")}<span className="ml-2 text-sm font-normal text-slate-500">{shown.length}</span></h2>
          {wards.length > 1 && [["", t("All wards")], ...wards.map((w): [string, string] => [w, w])].map(([id, label]) => (
            <button key={id} type="button" aria-pressed={ward === id} onClick={() => setWard(id!)} className={clsx("rounded-full px-3 py-1 text-xs ring-1", ward === id ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50")}>{label}</button>
          ))}
          <input aria-label={t("Search patients on the ward")} value={find} onChange={(e) => setFind(e.target.value)} placeholder={t("Bed, patient or ID")} className="ml-auto w-44 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
        </div>
        {list.isLoading ? <Spinner /> : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">{filter === null ? t("No admitted patients on this ward.") : t("Nothing here. You're all caught up.")}</div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((r) => {
              const urgent = r.medicationOverdue > 0 || r.overdueTasks > 0;
              return (
                <li key={r.admissionId}>
                  <Link href={`/ipd/${r.admissionId}`} className={clsx("block h-full rounded-xl border bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md", urgent ? "border-red-200" : "border-slate-200")}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-slate-900">{r.patientName}</div>
                        <div className="text-xs text-slate-500">{[r.mrn, r.gender ? r.gender.charAt(0) + r.gender.slice(1).toLowerCase() : null].filter(Boolean).join(" · ")}</div>
                      </div>
                      <span className="shrink-0 rounded-lg bg-slate-900 px-2.5 py-1 text-sm font-semibold text-white" title={r.ward ?? undefined}>{r.bed ?? "—"}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {r.hasAllergies && <Chip tone="red">{t("Allergy")}</Chip>}
                      {assessmentDue(r) && <Chip tone="green">{t("Admission assessment due")}</Chip>}
                      {r.medicationOverdue > 0 ? <Chip tone="red">{`${r.medicationOverdue} ${t("dose overdue")}`}</Chip> : r.medicationDue > 0 ? <Chip tone="amber">{`${r.medicationDue} ${t("dose due")}`}</Chip> : null}
                      {r.vitalsDue && <Chip tone="amber">{t("Vitals due")}</Chip>}
                      {r.overdueTasks > 0 ? <Chip tone="red">{`${r.overdueTasks} ${t("task overdue")}`}</Chip> : r.pendingTasks > 0 ? <Chip tone="blue">{`${r.pendingTasks} ${r.pendingTasks === 1 ? t("task") : t("tasks")}`}</Chip> : null}
                      {(r.newMedicineOrders ?? 0) > 0 && <Chip tone="blue">{t("New medicine order")}</Chip>}
                      {!urgent && !r.hasAllergies && r.medicationDue === 0 && !r.vitalsDue && r.pendingTasks === 0 && !assessmentDue(r) && <Chip tone="gray">{t("Nothing due")}</Chip>}
                    </div>
                    <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                      <span className="truncate">{`${r.ward ?? ""}${r.ward ? " · " : ""}${r.doctor}`}</span>
                      <span className="shrink-0">{`${t("Admitted")} ${ago(r.admittedAt)}`}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-6" aria-label={t("Laboratory work")}>
        <h2 className="mb-2 text-base font-semibold text-slate-900">{t("Laboratory work")}</h2>
        <LabWorkTiles />
      </section>
    </>
  );
}
