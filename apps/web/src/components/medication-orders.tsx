"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { AmendMedicine } from "./prescription-extras";
import { blankItem, RxRows, toPayload, type RxItem } from "./rx-editor";
import { Button, Card, ConfirmButton, ErrorNote, Field, Input, Notice, Spinner, StatusBadge, Table, Td } from "./ui";

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
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Signed orders">
        {signedOrders.length === 0 ? <p className="text-sm text-slate-500">No signed medication orders yet.</p> : signedOrders.map((o) => (
          <div key={o.id} className="mb-3 last:mb-0"><div className="mb-1 text-xs text-slate-500">{o.orderNumber}</div>
            <Table head={["Medicine", "Dose", "Route", "Frequency", "Status", ""]}>
              {o.items.map((i) => (
                <tr key={i.id}><Td>{i.genericName} {i.strength}</Td><Td>{i.dosage}</Td><Td>{i.route}</Td><Td>{i.frequency}</Td><Td><StatusBadge value={i.status} /></Td>
                  <Td>{i.status === "ACTIVE" && canWrite && can("PRESCRIPTION_SIGN") && <button className="mr-2 text-xs text-slate-500 hover:text-brand-700" onClick={() => setChanging(i)}>change</button>}{i.status === "ACTIVE" && canWrite && <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => { stop.reset(); setStopReason(""); setStopping({ id: i.id, name: [i.genericName, i.strength].filter(Boolean).join(" ") }); }}>stop</button>}</Td></tr>
              ))}
            </Table>
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
      </Card>
      {canWrite && (
        <Card title="New order">
          {(rx.data?.allergyWarnings.length ?? 0) > 0 && <div className="mb-3"><Notice tone="warn">Allergy alert: {rx.data!.allergyWarnings.map((w) => `${w.matchedItem} matches ${w.allergen}`).join("; ")}</Notice></div>}
          <RxRows items={items} setItems={setItems} disabled={false} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setItems([...items, blankItem()])}>Add medicine</Button>
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
        </Card>
      )}
    </div>
  );
}
