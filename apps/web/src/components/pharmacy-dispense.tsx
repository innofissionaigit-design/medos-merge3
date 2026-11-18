"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ErrorNote, Input, Modal, Notice, Table, Td, useDebounced } from "@/components/ui";
import { api, ApiError, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { PrintLink } from "@/components/print-link";

export interface QItem { suggestedQuantity?: number | null; id: string; lineNo: number; medicineId: string | null; genericName: string; brandName: string | null; strength: string | null; dosage: string; frequency: string; durationDays: number | null; quantity: number | null; dispensedQuantity: number; remaining: number | null; status: string }
export interface QOrder { testsAdvised?: { name: string; category: string; status: string }[]; id: string; orderNumber: string | null; source?: string; handwrittenPages?: { pageNo: number; fileId: string; fileName: string; contentType: string }[]; signedAt: string; patientId: string; patientName: string; mrn: string | null; doctorName: string | null; status: string; allergyWarnings: { allergen: string; matchedItem: string; severity: string }[]; items: QItem[] }
export interface DispenseResult { dispense: { dispenseNumber: string; total: string; invoiceId: string | null } }
export interface Med { id: string; brandName: string; genericName: string; strength: string | null }

export function MedPick({ value, onPick, initial = "" }: { value: Med | null; onPick: (m: Med | null) => void; initial?: string }) {
  // Starts from the prescribed name, so free-text prescriptions show their matches straight away.
  const [q, setQ] = useState(initial);
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["med-pick", term], queryFn: () => api.page<Med>("/medicines", { q: term, pageSize: 6 }), enabled: term.length >= 2 && !value });
  if (value) return <div className="flex items-center justify-between rounded border border-slate-300 bg-slate-50 px-2 py-1 text-sm"><span>{value.brandName} {value.strength}</span><button className="text-xs text-brand-700" onClick={() => onPick(null)}>change</button></div>;
  const found = res.data?.data ?? [];
  return (
    <div className="relative">
      <Input aria-label="Medicine" placeholder="Search medicine" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && found[0]) { e.preventDefault(); onPick(found[0]); } }} />
      {/* In normal flow (not a floating dropdown): inside the dispense table a floating list was clipped by the table's scroll area. */}
      {term.length >= 2 && res.data && found.length > 0 && (
        <ul className="mt-1 w-full rounded-md border border-slate-200 bg-white">
          <li className="px-3 pt-1.5 text-xs text-slate-500">Click the medicine to dispense (or press Enter for the first one):</li>
          {found.map((m) => <li key={m.id}><button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-brand-50 focus:bg-brand-50 focus:outline-none" onClick={() => onPick(m)}>{m.brandName} <span className="text-slate-500">· {m.genericName} {m.strength}</span></button></li>)}
        </ul>
      )}
      {term.length >= 2 && res.data && found.length === 0 && <p className="mt-1 text-xs text-amber-800">No medicine named “{term}” in the medicine list. Try the generic name (e.g. Paracetamol), or add it under Pharmacy → Medicines.</p>}
      {term.length < 2 && <p className="mt-1 text-xs text-slate-500">Type at least 2 letters to search.</p>}
    </div>
  );
}

export function Dispense({ order, onClose }: { order: QOrder; onClose: () => void }) {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const [rows, setRows] = useState(() => order.items.filter((i) => i.status === "ACTIVE" && (i.remaining === null || i.remaining > 0)).map((i) => ({ item: i, med: i.medicineId ? ({ id: i.medicineId, brandName: i.brandName ?? i.genericName, genericName: i.genericName, strength: i.strength } as Med) : null, qty: String(i.remaining ?? i.suggestedQuantity ?? "") })));
  const [ack, setAck] = useState(false);
  const [needAck, setNeedAck] = useState(false);
  const [key] = useState(newKey);
  const [done, setDone] = useState<DispenseResult | null>(null);
  const dispense = useMutation({
    mutationFn: () => api.post<DispenseResult>("/pharmacy/dispenses", {
      patientId: order.patientId, medicationOrderId: order.id,
      items: rows.filter((r) => r.med && Number(r.qty) > 0).map((r) => ({ medicationOrderItemId: r.item.id, medicineId: r.med!.id, quantity: Number(r.qty) })),
      ...(ack ? { acknowledgeAllergyWarnings: true } : {}),
    }, key),
    onSuccess: (r) => { setDone(r); void qc.invalidateQueries({ queryKey: ["pharmacy-queue"] }); void qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); },
    onError: (e) => { if (e instanceof ApiError && e.code === "ALLERGY_CONFLICT") setNeedAck(true); },
  });
  if (done) {
    return (
      <Modal title={`Dispensed — ${done.dispense.dispenseNumber}`} onClose={onClose}>
        <div className="space-y-3">
          <Notice tone="success">Total {money(done.dispense.total)}. Stock has been deducted from the earliest-expiring batches.</Notice>
          {done.dispense.invoiceId && <Notice tone="info">The bill has gone to the Cashier. Ask the patient to pay at the billing counter; the pharmacy does not take payment.</Notice>}
          <div className="flex justify-end gap-2">
            {done.dispense.invoiceId && can("INVOICE_READ") && <Link href={`/billing/${done.dispense.invoiceId}`} className="self-center text-sm text-brand-700 hover:underline">Open bill</Link>}
            {done.dispense.invoiceId && <PrintLink href={printUrl(`invoices/${done.dispense.invoiceId}`)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">Print bill</PrintLink>}
            <Button variant="secondary" onClick={onClose}>Done</Button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`Dispense — ${order.patientName}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">Prescription {order.orderNumber} by {order.doctorName ?? "doctor"}</p>
        {(order.testsAdvised?.length ?? 0) > 0 && (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-sm" data-testid="tests-advised">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Tests the doctor advised (billed at the Cashier, not here)</div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">{order.testsAdvised!.map((x, i) => <li key={i}>{x.name} <span className="text-xs text-slate-500">({x.category.toLowerCase()}{x.status === "BILLED" ? ", billed" : ""})</span></li>)}</ul>
          </div>
        )}
        {(order.handwrittenPages?.length ?? 0) > 0 && (
          <div className="rounded-md border border-slate-200 p-2">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Doctor's handwritten prescription (original) — the medicines below were checked and approved by the doctor</div>
            <div className="flex flex-wrap gap-2">
              {order.handwrittenPages!.map((pg) => (
                <a key={pg.fileId} href={`/api/proxy/files/${pg.fileId}/content`} target="_blank" rel="noreferrer" className="block text-center text-xs text-brand-700 hover:underline">
                  {pg.contentType.startsWith("image/") ? <img src={`/api/proxy/files/${pg.fileId}/content`} alt={`Handwritten prescription, page ${pg.pageNo}`} className="h-40 w-40 rounded border border-slate-200 object-cover" /> : <span className="flex h-40 w-40 items-center justify-center rounded border border-slate-200 bg-slate-50">PDF</span>}
                  Page {pg.pageNo}
                </a>
              ))}
            </div>
          </div>
        )}
        {order.allergyWarnings.length > 0 && <Notice tone="warn">Allergy alert: {order.allergyWarnings.map((w) => `${w.matchedItem} matches ${w.allergen}`).join("; ")}</Notice>}
        <Table head={["Prescribed", "Medicine to dispense", "Qty"]}>
          {rows.map((r, i) => (
            <tr key={r.item.id}>
              <Td><div className="font-medium">{r.item.genericName} {r.item.strength}</div><div className="text-xs text-slate-500">{r.item.dosage} · {r.item.frequency}{r.item.durationDays ? ` · ${r.item.durationDays} d` : ""}</div>
                <div className="mt-0.5 text-xs" data-testid="qty-guide">{r.item.quantity !== null ? <span className="text-slate-600">Doctor wrote: give {r.item.quantity}{r.item.remaining !== null && r.item.remaining !== r.item.quantity ? ` (${r.item.remaining} still to give)` : ""}</span> : r.item.suggestedQuantity ? <span className="text-amber-800">The doctor wrote no quantity: {r.item.suggestedQuantity} worked out from the dose, how often and the days. Check it.</span> : <span className="text-red-700">The doctor wrote no quantity and it cannot be worked out: ask the doctor, then enter how many.</span>}</div></Td>
              <Td><MedPick value={r.med} initial={r.item.genericName} onPick={(m) => setRows(rows.map((x, j) => (j === i ? { ...x, med: m } : x)))} /></Td>
              <Td><Input aria-label="Quantity" className="w-20" inputMode="numeric" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></Td>
            </tr>
          ))}
        </Table>
        {needAck && <label className="flex items-center gap-2 text-sm text-amber-900"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have checked the allergy warning with the prescriber and want to continue.</label>}
        {rows.every((r) => !r.med) && <Notice tone="info">Choose the medicine from the list for at least one line to dispense. Prescribed names typed by the doctor may differ from the pharmacy list.</Notice>}
        <ErrorNote error={dispense.error instanceof ApiError && dispense.error.code === "ALLERGY_CONFLICT" ? null : dispense.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={rows.every((r) => !r.med || !Number(r.qty)) || (needAck && !ack)} loading={dispense.isPending} onClick={() => dispense.mutate()}>Dispense</Button></div>
      </div>
    </Modal>
  );
}
