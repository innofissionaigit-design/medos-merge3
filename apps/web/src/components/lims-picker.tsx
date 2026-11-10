"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Input, Spinner } from "./ui";

export interface CatItem { serviceId: string; code: string; name: string; department: "PATHOLOGY" | "RADIOLOGY"; amount?: string; specimen: string | null; instructions: string | null }

export const DEPARTMENT_TITLE: Record<CatItem["department"], string> = { PATHOLOGY: "Pathology (laboratory)", RADIOLOGY: "Radiology (imaging)" };

/** The hospital's test list with the department that runs each test (docs/lims-portal.md). */
export function useCatalogue(enabled = true) {
  return useQuery({ queryKey: ["lims-catalogue"], queryFn: () => api.get<CatItem[]>("/lims/catalogue"), enabled, staleTime: 30_000 });
}

/** Choose tests from the list, grouped between Pathology and Radiology. A test chosen here always goes to the technician of its department. */
export function TestPicker({ picked, onChange }: { picked: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
  const cat = useCatalogue();
  const [q, setQ] = useState("");
  if (cat.isLoading) return <Spinner />;
  const term = q.trim().toLowerCase();
  const items = (cat.data ?? []).filter((i) => !term || i.name.toLowerCase().includes(term) || i.code.toLowerCase().includes(term));
  const toggle = (id: string, on: boolean) => { const n = new Set(picked); if (on) n.add(id); else n.delete(id); onChange(n); };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Search the test list" className="max-w-xs" placeholder="Search the test list" value={q} onChange={(e) => setQ(e.target.value)} />
        {picked.size > 0 && <Badge tone="blue">{picked.size} chosen</Badge>}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {(["PATHOLOGY", "RADIOLOGY"] as const).map((d) => {
          const list = items.filter((i) => i.department === d);
          return (
            <fieldset key={d} className="rounded-md border border-slate-200 p-2">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{DEPARTMENT_TITLE[d]}</legend>
              <ul className="max-h-48 space-y-0.5 overflow-y-auto text-sm">
                {list.length === 0 && <li className="text-slate-400">{term ? "Nothing matches." : "No tests in this group yet."}</li>}
                {list.map((i) => (
                  <li key={i.serviceId}><label className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-50"><input type="checkbox" checked={picked.has(i.serviceId)} onChange={(e) => toggle(i.serviceId, e.target.checked)} /> <span>{i.name}</span>{i.specimen && <span className="text-xs text-slate-400">· {i.specimen}</span>}</label></li>
                ))}
              </ul>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}
