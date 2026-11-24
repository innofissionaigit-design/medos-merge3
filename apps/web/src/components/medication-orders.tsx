"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { AmendMedicine } from "./prescription-extras";
import { blankItem, RxRows, toPayload, type RxItem } from "./rx-editor";
import { Button, ConfirmButton, ErrorNote, Field, Input, Notice, Spinner, StatusBadge } from "./ui";

interface OrderRow { id: string; orderNumber: string | null; status: string; signedAt?: string | null; items: (RxItem & { id: string; status: string })[] }
interface RxWarning { allergen: string; matchedItem: string; severity: string }

/**
 * Medication orders of a visit: the doctor's signed orders and a form for a new one. Signing makes them visible to the pharmacy (and, for an admitted patient, generates the nurse's medication chart).
 * Used on the admission page and on the emergency case page. `cacheKey` keeps each visit's data apart in the page cache.
 */
export function MedicationOrders({ encounterId, open, cacheKey }: { encounterId: string; open: boolean; cacheKey: string }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const rx = useQuery({ queryKey: ["ipd-rx", cacheKey], queryFn: () => api.get<{ orders: OrderRow[]; allergyWarnings: RxWarning[] }>(`/encounters/${encounterId}/prescription`) });
  const draft = rx.data?.orders.find((o) => o.status === "DRAFT");
  const signedOrders = rx.data?.orders.filter((o) => o.status === "SIGNED") ?? [];
  const [items, setItems] = useState<RxItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [ack, setAck] = useState<RxWarning[] | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  useEffect(() => { if (rx.data && !loaded) { setItems(draft?.items.map((i) => ({ ...i })) ?? []); setLoaded(true); } }, [rx.data, loaded, draft]);
  // A medicine added to the draft from outside this form (a nurse's request the doctor accepted) appears at once, without losing rows being typed.
  const draftIds = (draft?.items ?? []).map((i) => i.id).join(",");
  useEffect(() => {
    if (!loaded || !draft) return;
    setItems((prev) => {
      const have = new Set(prev.flatMap((p) => (p.id ? [p.id] : [])));
      const add = draft.items.filter((i) => !have.has(i.id)).map((i) => ({ ...i }));
      return add.length ? [...prev.filter((p) => p.genericName.trim()), ...add] : prev;
    });
  }, [draftIds, loaded]);
  // Fetch the saved copy FIRST, then refill the rows from it: refilling from the copy loaded before the save would blank what was just typed.
  const resync = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ["ipd-rx", cacheKey] }), qc.invalidateQueries({ queryKey: ["mar", cacheKey] })]); setLoaded(false); };
  const filled = () => items.filter((i) => i.genericName.trim()).map(toPayload);
  const save = useMutation({ mutationFn: () => api.put(`/encounters/${encounterId}/prescription`, { items: filled() }), onSuccess: resync });
  const sign = useMutation({
    mutationFn: async (acknowledge: boolean) => { await api.put(`/encounters/${encounterId}/prescription`, { items: filled() }); return api.post(`/encounters/${encounterId}/prescription/sign`, acknowledge ? { acknowledgeAllergyWarnings: true } : {}); },
    onSuccess: () => { setAck(null); setAckChecked(false); setItems([]); resync(); },
    onError: (e) => { if (e instanceof ApiError && e.code === "ALLERGY_CONFLICT") setAck(((e.details as { allergyWarnings?: RxWarning[] } | undefined)?.allergyWarnings) ?? []); },
  });
  // Stopping is a clinical change, so the doctor confirms it and gives a reason that stays on the record.
  const [stopping, setStopping] = useState<{ id: string; name: string } | null>(null);
  const [stopReason, setStopReason] = useState("");
  const [changing, setChanging] = useState<(RxItem & { id: string }) | null>(null);
  const stop = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.post(`/medication-order-items/${v.id}/stop`, { reason: v.reason }), onSuccess: () => { setStopping(null); setStopReason(""); resync(); } });
  const canWrite = open && can("PRESCRIPTION_CREATE");
  if (rx.isLoading) return <Spinner />;
  const activeCount = signedOrders.reduce((n, o) => n + o.items.filter((i) => i.status === "ACTIVE").length, 0);
  const stoppedCount = signedOrders.reduce((n, o) => n + o.items.filter((i) => i.status !== "ACTIVE").length, 0);
  const CARD = "rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_4px_16px_-8px_rgba(16,24,40,0.08)]";
  const HEAD = "flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Medication orders</h2>
          <p className="text-sm text-slate-500">The doctor signs the medicines for this stay. Once signed, the pharmacy sees them and the nurse's medication chart is made from them.</p>
        </div>
        <div className="flex items-center gap-2 text-xs font-medium">
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700 ring-1 ring-emerald-200">{activeCount} active</span>
          {stoppedCount > 0 && <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600 ring-1 ring-slate-200">{stoppedCount} stopped</span>}
          {draft && <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-800 ring-1 ring-amber-200">Draft saved</span>}
        </div>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <section className={CARD} aria-label="Signed orders">
        <header className={HEAD}><h3 className="text-sm font-semibold text-slate-900">Signed orders</h3><span className="text-xs text-slate-500">{signedOrders.length === 0 ? "None yet" : `${signedOrders.length} ${signedOrders.length === 1 ? "order" : "orders"}`}</span></header>
        <div className="p-5">
        {signedOrders.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-4 py-10 text-center"><span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-blue-50 text-blue-600"><svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M10.5 20.5 3.5 13.5a4.95 4.95 0 0 1 7-7l7 7a4.95 4.95 0 0 1-7 7ZM8.5 8.5l7 7" /></svg></span><p className="text-sm font-semibold text-slate-800">No signed medication orders yet.</p><p className="mx-auto mt-1 max-w-xs text-xs text-slate-500">The doctor writes the medicines for this stay and signs the order. Once it is signed, the nurse's medication chart is made from it.</p></div> : signedOrders.map((o) => (
          <div key={o.id} className="mb-5 last:mb-0">
            <div className="mb-2 flex items-center justify-between text-xs"><span className="font-semibold text-slate-700">{o.orderNumber}</span>{o.signedAt && <span className="text-slate-500">Signed {new Date(o.signedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>}</div>
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
              {o.items.map((i) => (
                <li key={i.id} className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${i.status === "ACTIVE" ? "" : "bg-slate-50/70"}`}>
                  <span className={`h-9 w-1 shrink-0 rounded-full ${i.status === "ACTIVE" ? "bg-emerald-500" : "bg-slate-300"}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-sm font-semibold ${i.status === "ACTIVE" ? "text-slate-900" : "text-slate-500 line-through"}`}>{i.genericName} {i.strength}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-medium text-slate-600">
                      <span className="rounded-md bg-slate-100 px-2 py-0.5">{i.dosage}</span><span className="rounded-md bg-slate-100 px-2 py-0.5">{i.route}</span><span className="rounded-md bg-blue-50 px-2 py-0.5 text-blue-700">{i.frequency}</span>
                    </div>
                  </div>
                  <StatusBadge value={i.status} />
                  <div className="flex items-center gap-1">
                    {i.status === "ACTIVE" && canWrite && can("PRESCRIPTION_SIGN") && <button className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-blue-50 hover:text-blue-700" onClick={() => setChanging(i)}>Change</button>}
                    {i.status === "ACTIVE" && canWrite && <button className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-700" onClick={() => { stop.reset(); setStopReason(""); setStopping({ id: i.id, name: [i.genericName, i.strength].filter(Boolean).join(" ") }); }}>Stop</button>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {changing && <AmendMedicine item={changing} onClose={() => setChanging(null)} onDone={() => { setChanging(null); resync(); }} />}
        {stopping && (
          <div className="mt-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
            <Notice tone="warn">Stop {stopping.name}? It stays on the record as stopped, with your name and reason. Nurses will no longer give it.</Notice>
            <Field label="Reason for stopping" hint="At least 3 characters"><Input autoFocus value={stopReason} onChange={(e) => setStopReason(e.target.value)} /></Field>
            <div className="flex gap-2">
              <Button variant="danger" loading={stop.isPending} disabled={stopReason.trim().length < 3} onClick={() => stop.mutate({ id: stopping.id, reason: stopReason.trim() })}>Stop medicine</Button>
              <Button variant="secondary" onClick={() => { setStopping(null); setStopReason(""); }}>Keep it</Button>
            </div>
          </div>
        )}
        <ErrorNote error={stop.error} />
        </div>
      </section>
      {canWrite && (
        <section className={CARD} aria-label="New order">
          <header className={HEAD}><h3 className="text-sm font-semibold text-slate-900">New order</h3><span className="text-xs text-slate-500">Add each medicine, then sign</span></header>
          <div className="p-5">
          {(rx.data?.allergyWarnings.length ?? 0) > 0 && <div className="mb-3"><Notice tone="warn">Allergy alert: {rx.data!.allergyWarnings.map((w) => `${w.matchedItem} matches ${w.allergen}`).join("; ")}</Notice></div>}
          <RxRows items={items} setItems={setItems} disabled={false} />
          <button type="button" className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-blue-300 bg-blue-50/40 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50" onClick={() => setItems([...items, blankItem()])}>+ Add medicine</button>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
            <Button variant="secondary" loading={save.isPending} disabled={items.length === 0} onClick={() => save.mutate()}>Save draft</Button>
            {can("PRESCRIPTION_SIGN") && !ack && <ConfirmButton variant="primary" label="Sign orders" confirmLabel="Yes, sign" disabled={!items.some((i) => i.genericName.trim())} loading={sign.isPending} onConfirm={() => sign.mutate(false)} />}
          </div>
          {ack && (
            <div className="mt-3 space-y-2">
              <Notice tone="warn">{ack.map((w) => `${w.matchedItem} matches the recorded allergy to ${w.allergen}`).join("; ")}</Notice>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} /> I have reviewed the allergy warning and still want to sign.</label>
              <div className="flex gap-2"><Button disabled={!ackChecked} loading={sign.isPending} onClick={() => sign.mutate(true)}>Sign with acknowledged warning</Button><Button variant="ghost" onClick={() => setAck(null)}>Go back</Button></div>
            </div>
          )}
          <div className="mt-2"><ErrorNote error={save.error ?? (sign.error instanceof ApiError && sign.error.code === "ALLERGY_CONFLICT" ? null : sign.error)} /></div>
          </div>
        </section>
      )}
      </div>
    </div>
  );
}
