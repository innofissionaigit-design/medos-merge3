"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Spinner } from "./ui";

export interface CatItem { serviceId: string; code: string; name: string; department: "PATHOLOGY" | "RADIOLOGY"; amount?: string; specimen: string | null; instructions: string | null }

export const DEPARTMENT_TITLE: Record<CatItem["department"], string> = { PATHOLOGY: "Pathology (laboratory)", RADIOLOGY: "Radiology (imaging)" };

/** The hospital's test list with the department that runs each test (docs/lims-portal.md). */
export function useCatalogue(enabled = true) {
  return useQuery({ queryKey: ["lims-catalogue"], queryFn: () => api.get<CatItem[]>("/lims/catalogue"), enabled, staleTime: 30_000 });
}

const DEPT_STYLE: Record<CatItem["department"], { icon: string; tone: string; ring: string }> = {
  PATHOLOGY: { icon: "M9 3h6M10 3v6.2L5.2 17.4A2.5 2.5 0 0 0 7.4 21h9.2a2.5 2.5 0 0 0 2.2-3.6L14 9.2V3M8 14h8", tone: "bg-rose-50 text-rose-600", ring: "has-[:checked]:border-rose-400 has-[:checked]:bg-rose-50/60" },
  RADIOLOGY: { icon: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm8 3v6m-3-3h6", tone: "bg-indigo-50 text-indigo-600", ring: "has-[:checked]:border-indigo-400 has-[:checked]:bg-indigo-50/60" },
};

/** Choose tests from the list, grouped between Pathology and Radiology. A test chosen here always goes to the technician of its department. */
export function TestPicker({ picked, onChange }: { picked: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
  const cat = useCatalogue();
  const [q, setQ] = useState("");
  if (cat.isLoading) return <Spinner />;
  const term = q.trim().toLowerCase();
  const items = (cat.data ?? []).filter((i) => !term || i.name.toLowerCase().includes(term) || i.code.toLowerCase().includes(term));
  const toggle = (id: string, on: boolean) => { const n = new Set(picked); if (on) n.add(id); else n.delete(id); onChange(n); };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative block w-full max-w-sm">
          <span className="sr-only">Search the test list</span>
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400"><svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4"><path d="m21 21-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" /></svg></span>
          <input type="search" aria-label="Search the test list" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the test list" className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/70 pl-9 pr-3 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-blue-100" />
        </label>
        <div className="flex items-center gap-2">
          {picked.size > 0 ? <><span className="rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold text-white">{picked.size} chosen</span><button type="button" className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline" onClick={() => onChange(new Set())}>Clear</button></> : <span className="text-xs text-slate-500">Tick the tests you need</span>}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {(["PATHOLOGY", "RADIOLOGY"] as const).map((d) => {
          const list = items.filter((i) => i.department === d);
          const chosen = list.filter((i) => picked.has(i.serviceId)).length;
          const st = DEPT_STYLE[d];
          return (
            <fieldset key={d} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <legend className="sr-only">{DEPARTMENT_TITLE[d]}</legend>
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-2.5" aria-hidden>
                <span className="flex items-center gap-2.5 text-sm font-semibold text-slate-800"><span className={`flex h-8 w-8 items-center justify-center rounded-lg ${st.tone}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d={st.icon} /></svg></span>{DEPARTMENT_TITLE[d]}</span>
                <span className="text-xs text-slate-500">{chosen > 0 ? `${chosen} of ${list.length} chosen` : `${list.length} ${list.length === 1 ? "test" : "tests"}`}</span>
              </div>
              <ul className="max-h-64 space-y-1.5 overflow-y-auto p-3 text-sm">
                {list.length === 0 && <li className="px-1 py-4 text-center text-slate-500">{term ? "Nothing matches." : "No tests in this group yet."}</li>}
                {list.map((i) => (
                  <li key={i.serviceId}>
                    <label className={`flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-3 py-2 transition hover:border-slate-300 hover:bg-slate-50 ${st.ring}`}>
                      <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500" checked={picked.has(i.serviceId)} onChange={(e) => toggle(i.serviceId, e.target.checked)} />
                      <span className="min-w-0 flex-1 font-medium text-slate-800">{i.name}</span>
                      {i.specimen && <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{i.specimen}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}
