"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { calculateQuantity } from "@/lib/rx-quantity";
import { Input, Select, useDebounced } from "./ui";

export interface RxItem {
  id?: string; medicineId?: string | undefined; genericName: string; brandName?: string | undefined; strength?: string | undefined; dosage: string; route: string; frequency: string;
  frequencyText?: string | undefined; durationDays?: number | undefined; quantity?: number | undefined; instructions?: string | undefined; status?: string; foodRelation?: string | null | undefined;
  /** Set by the server on a signed prescription: how much the pharmacy has given and why a medicine was stopped. Never sent back. */
  dispensedQuantity?: number | undefined; stopReason?: string | null | undefined;
  /** The quantity was worked out from dose, how often and days (not typed): it follows them until the doctor types a number. Not sent to the server. */
  qtyAuto?: boolean;
}

export const blankItem = (): RxItem => ({ genericName: "", dosage: "1 tablet", route: "ORAL", frequency: "BD", durationDays: 3, quantity: calculateQuantity("1 tablet", "BD", 3) ?? undefined, qtyAuto: true });

/** Drops empty optional fields so the payload satisfies the API's strict schema. */
export function toPayload(i: RxItem) {
  return {
    ...(i.medicineId ? { medicineId: i.medicineId } : {}), genericName: i.genericName.trim(), ...(i.brandName ? { brandName: i.brandName } : {}), ...(i.strength ? { strength: i.strength } : {}),
    dosage: i.dosage.trim() || "1", route: i.route, frequency: i.frequency, ...(i.frequency === "OTHER" && i.frequencyText ? { frequencyText: i.frequencyText } : {}),
    ...(i.durationDays ? { durationDays: i.durationDays } : {}), ...(i.quantity ? { quantity: i.quantity } : {}), ...(i.instructions?.trim() ? { instructions: i.instructions.trim() } : {}),
    ...(i.foodRelation ? { foodRelation: i.foodRelation } : {}),
  };
}

function MedicineInput({ item, onChange, disabled }: { item: RxItem; onChange: (patch: Partial<RxItem>) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const term = useDebounced(item.genericName.trim(), 250);
  const res = useQuery({ queryKey: ["med-search", term], queryFn: () => api.page<{ id: string; brandName: string; genericName: string; strength: string | null }>("/medicines", { q: term, pageSize: 6 }), enabled: open && term.length >= 2 });
  return (
    <div className="relative">
      <Input aria-label="Medicine" disabled={disabled} placeholder="Medicine name" value={item.genericName} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => onChange({ genericName: e.target.value, medicineId: undefined })} />
      {open && (res.data?.data.length ?? 0) > 0 && (
        <ul className="absolute z-30 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg">
          {res.data!.data.map((m) => (
            <li key={m.id} className="cursor-pointer px-3 py-1.5 text-sm hover:bg-brand-50" onMouseDown={() => { onChange({ medicineId: m.id, genericName: m.genericName, brandName: m.brandName, ...(m.strength ? { strength: m.strength } : {}) }); setOpen(false); }}>
              {m.brandName} <span className="text-slate-500">· {m.genericName} {m.strength}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ROUTES = ["ORAL", "IV", "IM", "SC", "TOPICAL", "OTHER"];
export const FOOD_OPTIONS = [{ id: "", label: "Food: not specified" }, { id: "BEFORE_FOOD", label: "Before food" }, { id: "AFTER_FOOD", label: "After food" }, { id: "WITH_FOOD", label: "With food" }, { id: "EMPTY_STOMACH", label: "Empty stomach" }, { id: "ANY_TIME", label: "Any time" }];
const FREQS = ["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT", "OTHER"];

/** Editable (or read-only) list of prescription lines, shared by the OPD consultation and the IPD orders tab. */
export function RxRows({ items, setItems, disabled }: { items: RxItem[]; setItems: (x: RxItem[]) => void; disabled: boolean }) {
  const patch = (i: number, p: Partial<RxItem>) => setItems(items.map((x, j) => {
    if (j !== i) return x;
    const next: RxItem = { ...x, ...p };
    if ("quantity" in p) next.qtyAuto = false; // typed by the doctor: leave it alone
    else if (("dosage" in p || "frequency" in p || "durationDays" in p) && (x.qtyAuto || x.quantity === undefined)) {
      const q = calculateQuantity(next.dosage, next.frequency, next.durationDays);
      next.quantity = q ?? undefined;
      next.qtyAuto = q !== null;
    }
    return next;
  }));
  const cap = (text: string) => <span aria-hidden className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{text}</span>;
  return (
    <div className="space-y-3">
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-12 items-start gap-x-3 gap-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
          <div className="col-span-12 flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs font-semibold text-slate-600"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-[11px] text-white">{i + 1}</span>Medicine {i + 1}</span>
            {!disabled && <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-700" aria-label="Remove medicine" onClick={() => setItems(items.filter((_, j) => j !== i))}>Remove</button>}
          </div>
          <div className="col-span-12 sm:col-span-6">{cap("Medicine")}<MedicineInput item={it} disabled={disabled} onChange={(p) => patch(i, p)} /></div>
          <div className="col-span-6 sm:col-span-3">{cap("Dose")}<Input aria-label="Dose" placeholder="e.g. 1 tablet" disabled={disabled} value={it.dosage} onChange={(e) => patch(i, { dosage: e.target.value })} /></div>
          <div className="col-span-6 sm:col-span-3">{cap("Route")}<Select aria-label="Route" disabled={disabled} value={it.route} onChange={(e) => patch(i, { route: e.target.value })}>{ROUTES.map((r) => <option key={r}>{r}</option>)}</Select></div>
          <div className="col-span-6 sm:col-span-3">{cap("How often")}<Select aria-label="Frequency" disabled={disabled} value={it.frequency} onChange={(e) => patch(i, { frequency: e.target.value })}>{FREQS.map((r) => <option key={r}>{r}</option>)}</Select></div>
          <div className="col-span-3 sm:col-span-2">{cap("Days")}<Input aria-label="Days" placeholder="Days" inputMode="numeric" disabled={disabled} value={it.durationDays ?? ""} onChange={(e) => patch(i, { durationDays: e.target.value ? Number(e.target.value) : undefined })} /></div>
          <div className="col-span-3 sm:col-span-2">{cap("Quantity")}<Input aria-label="Quantity" placeholder="Qty" inputMode="numeric" disabled={disabled} value={it.quantity ?? ""} onChange={(e) => patch(i, { quantity: e.target.value ? Number(e.target.value) : undefined })} /></div>
          <div className="col-span-12 sm:col-span-5">{cap("Food timing")}<Select aria-label="Food timing" disabled={disabled} value={it.foodRelation ?? ""} onChange={(e) => patch(i, { foodRelation: e.target.value || undefined })}>{FOOD_OPTIONS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select></div>
          {it.frequency === "OTHER" && <div className="col-span-12">{cap("Describe how often")}<Input placeholder="Describe the frequency" aria-label="Frequency text" disabled={disabled} value={it.frequencyText ?? ""} onChange={(e) => patch(i, { frequencyText: e.target.value })} /></div>}
          <div className="col-span-12">{cap("Instructions")}<Input placeholder="Optional, for the nurse and the pharmacist" aria-label="Instructions" disabled={disabled} value={it.instructions ?? ""} onChange={(e) => patch(i, { instructions: e.target.value })} /></div>
          {!disabled && it.genericName.trim() && (it.quantity === undefined
            ? <p className="col-span-12 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="qty-missing">No quantity yet: enter how many the pharmacy should give. It cannot be worked out from this dose or frequency, so the pharmacist would have to guess.</p>
            : it.qtyAuto ? <p className="col-span-12 text-xs text-slate-500" data-testid="qty-auto">Quantity {it.quantity} is worked out from the dose, how often and the days. Type a different number to change it.</p> : null)}
        </div>
      ))}
      {items.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">No medicines prescribed.</p>}
    </div>
  );
}
