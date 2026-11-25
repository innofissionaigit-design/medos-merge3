"use client";
import clsx from "clsx";
import { Select } from "@/components/ui";
import { useT } from "@/lib/i18n";

export interface NavGroup<T extends string> { title: string; items: { id: T; label: string }[] }

/**
 * The sections of a page with many parts, grouped under headings: a quiet side menu on a wide screen (one section per line, the open one highlighted), and a
 * single dropdown on a phone. It keeps the tab roles, so a keyboard or screen reader treats it like the tab bar it replaces.
 */
export function SectionNav<T extends string>({ groups, value, onChange }: { groups: NavGroup<T>[]; value: T; onChange: (t: T) => void }) {
  const tr = useT();
  const shown = groups.filter((g) => g.items.length > 0);
  return (
    <>
      <div className="lg:hidden">
        <Select aria-label={tr("Section")} value={value} onChange={(e) => onChange(e.target.value as T)}>
          {shown.map((g) => <optgroup key={g.title} label={tr(g.title)}>{g.items.map((i) => <option key={i.id} value={i.id}>{tr(i.label)}</option>)}</optgroup>)}
        </Select>
      </div>
      <nav className="hidden lg:block lg:sticky lg:top-4 rounded-xl border border-slate-200 bg-white p-2 shadow-sm" aria-label={tr("Sections")}>
        <div role="tablist" aria-orientation="vertical" className="space-y-3">
          {shown.map((g) => (
            <div key={g.title}>
              <h3 className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{tr(g.title)}</h3>
              <div className="space-y-0.5">
                {g.items.map((i) => {
                  const on = value === i.id;
                  return (
                    <button key={i.id} role="tab" aria-selected={on} onClick={() => onChange(i.id)} className={clsx("flex w-full items-center rounded-lg px-3 py-2 text-left text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", on ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900")}>
                      <span className={clsx("mr-2.5 h-4 w-1 rounded-full", on ? "bg-brand-600" : "bg-transparent")} aria-hidden />{tr(i.label)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}
