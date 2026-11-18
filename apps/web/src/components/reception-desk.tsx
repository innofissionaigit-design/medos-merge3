"use client";
import type { Desk } from "@/lib/desk";

/** The question every receptionist is asked after signing in: which desk are they working at? (lib/desk.ts). The dashboard for each desk is ReceptionDashboard in reception-dashboard.tsx. */
export function DeskChooser({ name, onChoose, onSignOut }: { name: string; onChoose: (d: Desk) => void; onSignOut: () => void }) {
  const card = "flex-1 rounded-xl border-2 border-slate-200 bg-white p-6 text-left shadow-sm hover:border-brand-500 focus:border-brand-500 focus:outline-none";
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome, {name}</h1>
        <p className="mt-1 text-slate-600">Which desk are you working at?</p>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <button type="button" className={card} onClick={() => onChoose("OPD")} autoFocus>
          <div className="text-xl font-semibold text-brand-700">OPD</div>
          <p className="mt-1 text-sm text-slate-600">Outpatient desk: start a new visit, appointments, the OPD queue and OPD bills.</p>
        </button>
        <button type="button" className={card} onClick={() => onChoose("IPD")}>
          <div className="text-xl font-semibold text-brand-700">IPD</div>
          <p className="mt-1 text-sm text-slate-600">Inpatient desk: admissions, the wards, going home and inpatient bills.</p>
        </button>
      </div>
      <div><button type="button" className="text-sm text-slate-500 underline" onClick={onSignOut}>Sign out</button></div>
    </main>
  );
}
