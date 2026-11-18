"use client";
import clsx from "clsx";
import type { TempUnit } from "@/lib/temperature";

/** The °C / °F switch beside a temperature box. */
export function TempUnitSwitch({ unit, onChange }: { unit: TempUnit; onChange: (u: TempUnit) => void }) {
  return (
    <div role="radiogroup" aria-label="Temperature unit" className="inline-flex shrink-0 overflow-hidden rounded-md border border-slate-300 text-sm">
      {(["C", "F"] as const).map((u) => (
        <button key={u} type="button" role="radio" aria-checked={unit === u} onClick={() => onChange(u)}
          className={clsx("px-2.5 py-1.5 font-medium", unit === u ? "bg-brand-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50")}>°{u}</button>
      ))}
    </div>
  );
}
