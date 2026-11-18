"use client";
import { useEffect, useState } from "react";
import { api, newKey } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * The pop-ups that say whether the patient's messages went: one each for email, SMS and WhatsApp, a green tick when it was sent and a red cross when it could not be.
 * They appear one after the other, stay a few seconds and go. Anything can ask for them with notifyBatch(); the host sits in the shell (shell.tsx).
 */
export interface DeliveryChannel { channel: "EMAIL" | "SMS" | "WHATSAPP"; ok: boolean; text: string }
type Toast = { id: number; ok: boolean; text: string };

const EVENT = "medos-delivery-toasts";
const STAGGER_MS = 350;
const SHOW_MS = 7000;

function announce(list: { ok: boolean; text: string }[]): void {
  if (list.length > 0) window.dispatchEvent(new CustomEvent(EVENT, { detail: list }));
}

/**
 * Sends the booking's email, SMS and WhatsApp now (the API does the sending and answers for each one), then shows the three pop-ups.
 * `SCHEDULED` after registering a patient for tests (when to come); `REPORT_READY` when the reports are ready to hand over (nothing is shown until every report of the booking is).
 */
export async function notifyBatch(batchId: string, kind: "SCHEDULED" | "REPORT_READY"): Promise<void> {
  try {
    const r = await api.post<{ channels: DeliveryChannel[] }>(`/lims/batches/${batchId}/notify`, { kind }, newKey());
    announce(r.channels);
  } catch {
    announce([{ ok: false, text: "The patient's email, SMS and WhatsApp could not be sent. Tell the patient by phone." }]);
  }
}

export function DeliveryToastHost() {
  const t = useT();
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => { const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };
    const on = (e: Event) => {
      const list = (e as CustomEvent<{ ok: boolean; text: string }[]>).detail;
      list.forEach((c, i) => {
        const id = ++n;
        later(() => { setItems((x) => [...x, { id, ok: c.ok, text: c.text }]); later(() => setItems((x) => x.filter((y) => y.id !== id)), SHOW_MS); }, i * STAGGER_MS);
      });
    };
    window.addEventListener(EVENT, on);
    return () => { window.removeEventListener(EVENT, on); timers.forEach((id) => window.clearTimeout(id)); };
  }, []);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
      {items.map((x) => (
        <div key={x.id} data-testid={x.ok ? "delivery-ok" : "delivery-failed"} className={`pointer-events-auto flex items-start gap-2 rounded-lg border p-3 text-sm shadow-lg ${x.ok ? "border-green-300 bg-green-50 text-green-900" : "border-red-300 bg-red-50 text-red-900"}`}>
          <span aria-hidden className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${x.ok ? "bg-green-700" : "bg-red-700"}`}>{x.ok ? "✓" : "✕"}</span>
          <span className="min-w-0 flex-1">{x.text}</span>
          <button type="button" aria-label={t("Dismiss")} className="shrink-0 text-slate-500 hover:text-slate-800" onClick={() => setItems((y) => y.filter((z) => z.id !== x.id))}>✕</button>
        </div>
      ))}
    </div>
  );
}
