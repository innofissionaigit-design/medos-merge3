"use client";
import { useEffect } from "react";
import clsx from "clsx";
import { Icon, type IconName } from "@/components/dashboard-kit";
import type { Desk } from "@/lib/desk";

const DESKS: { id: Desk; title: string; tag: string; text: string; icon: IconName; chip: string; ring: string; items: string[]; key: string }[] = [
  { id: "OPD", title: "OPD", tag: "Outpatient desk", text: "Patients who come for a visit and go home the same day.", icon: "calendarPlus", chip: "bg-sky-50 text-sky-600", ring: "hover:border-sky-400 focus-visible:border-sky-500", items: ["New visit", "Appointments", "OPD queue", "OPD bills"], key: "1" },
  { id: "IPD", title: "IPD", tag: "Inpatient desk", text: "Patients who are admitted, planned for admission, or going home.", icon: "bed", chip: "bg-violet-50 text-violet-600", ring: "hover:border-violet-400 focus-visible:border-violet-500", items: ["Admissions", "Planned admissions", "Going home", "Inpatient bills"], key: "2" },
];

/** The question every receptionist is asked after signing in: which desk are they working at? (lib/desk.ts). The dashboard for each desk is ReceptionDashboard in reception-dashboard.tsx. */
export function DeskChooser({ name, onChoose, onSignOut }: { name: string; onChoose: (d: Desk) => void; onSignOut: () => void }) {
  // One key does it: 1 for the OPD desk, 2 for the IPD desk.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const d = DESKS.find((x) => x.key === e.key);
      if (d) onChoose(d.id);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onChoose]);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-slate-50 via-white to-brand-50/60 p-6">
      <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-100/50 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-violet-100/50 blur-3xl" aria-hidden />
      <div className="relative w-full max-w-3xl">
        <div className="mb-8 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-lg font-bold text-white shadow-md" aria-hidden>M</span>
          <span className="text-lg font-semibold tracking-tight text-slate-900">MedOS</span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{`${greeting}, ${name}`}</h1>
        <p className="mt-1.5 text-slate-600">Which desk are you working at today?</p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {DESKS.map((d, i) => (
            <button key={d.id} type="button" onClick={() => onChoose(d.id)} autoFocus={i === 0} className={clsx("group relative flex flex-col rounded-2xl border-2 border-slate-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100", d.ring)}>
              <span className="flex items-start justify-between">
                <span className={clsx("flex h-12 w-12 items-center justify-center rounded-xl", d.chip)}><Icon name={d.icon} className="h-6 w-6" /></span>
                <kbd className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-500" aria-label={`Press ${d.key}`}>{d.key}</kbd>
              </span>
              <span className="mt-4 text-2xl font-semibold tracking-tight text-slate-900">{d.title}</span>
              <span className="text-sm font-medium text-slate-500">{d.tag}</span>
              <span className="mt-2 text-sm text-slate-600">{d.text}</span>
              <span className="mt-4 flex flex-wrap gap-1.5">{d.items.map((x) => <span key={x} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">{x}</span>)}</span>
              <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-brand-700">Start at this desk<Icon name="chevronRight" className="h-4 w-4 transition group-hover:translate-x-0.5" /></span>
            </button>
          ))}
        </div>

        <div className="mt-8 flex items-center justify-between text-sm text-slate-500">
          <span>Press <kbd className="rounded border border-slate-200 bg-white px-1.5 text-xs">1</kbd> or <kbd className="rounded border border-slate-200 bg-white px-1.5 text-xs">2</kbd> to choose. You can switch desks later from the top bar.</span>
          <button type="button" className="rounded-md px-2 py-1 font-medium text-slate-600 hover:bg-slate-100" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </main>
  );
}
