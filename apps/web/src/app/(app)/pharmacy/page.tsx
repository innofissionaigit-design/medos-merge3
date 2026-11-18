"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { AdjustModal, LedgerModal, MedicinesTab, PurchasesTab, SalesTab, SuppliersTab } from "@/components/pharmacy-extras";
import { StockLocationsTab } from "@/components/stock-locations";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, PageHeader, Spinner, Table, Tabs, Td, useDebounced } from "@/components/ui";
import { api, ApiError, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { PrintLink } from "@/components/print-link";
import { Dispense, MedPick, type DispenseResult, type Med, type QOrder } from "@/components/pharmacy-dispense";

interface StockRow { medicineId: string; brandName: string; genericName: string; strength: string | null; sellableQuantity: number; expiredQuantity: number; nearExpiryQuantity: number; blockedQuantity: number; reorderLevel: number; lowStock: boolean; batches: { id: string; batchNo: string; expiryDate: string; quantity: number; sellingPrice: string }[] }

function AddBatch({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [med, setMed] = useState<Med | null>(null);
  const [f, setF] = useState({ batchNo: "", expiryDate: "", mrp: "", purchasePrice: "", sellingPrice: "", quantity: "" });
  const [key] = useState(newKey);
  const m = useMutation({ mutationFn: () => api.post("/pharmacy/batches", { medicineId: med!.id, ...f, quantity: Number(f.quantity) }, key), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); onClose(); } });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add opening stock (new batch)" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><Field as="div" label="Medicine"><MedPick value={med} onPick={setMed} /></Field></div>
        <Field label="Batch number"><Input value={f.batchNo} onChange={set("batchNo")} /></Field>
        <Field label="Expiry date"><Input type="date" value={f.expiryDate} onChange={set("expiryDate")} /></Field>
        <Field label="MRP"><Input inputMode="decimal" value={f.mrp} onChange={set("mrp")} /></Field>
        <Field label="Purchase price"><Input inputMode="decimal" value={f.purchasePrice} onChange={set("purchasePrice")} /></Field>
        <Field label="Selling price"><Input inputMode="decimal" value={f.sellingPrice} onChange={set("sellingPrice")} /></Field>
        <Field label="Quantity"><Input inputMode="numeric" value={f.quantity} onChange={set("quantity")} /></Field>
        <div className="col-span-2"><ErrorNote error={m.error} /></div>
        <div className="col-span-2 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!med || Object.values(f).some((v) => !v)} loading={m.isPending} onClick={() => m.mutate()}>Add stock</Button></div>
      </div>
    </Modal>
  );
}

interface HwScan {
  id: string; uploadedAt: string; uploadedBy: string | null; doctorName: string | null; encounterNumber: string; patientId: string; patientName: string; mrn: string | null;
  pages: { pageNo: number; fileId: string; fileName: string; contentType: string }[]; text: string | null; allergies: { allergen: string; severity: string }[];
}
interface HwRow { med: Med | null; qty: string }

/** A doctor's handwritten prescription: the pharmacist sees every page, confirms they checked it, enters the medicines from it and dispenses; the bill goes to the cashier. */
function HandwrittenDispense({ scan, onClose }: { scan: HwScan; onClose: () => void }) {
  const { can, money, dateTime } = useMe();
  const qc = useQueryClient();
  const [rows, setRows] = useState<HwRow[]>([{ med: null, qty: "" }]);
  const [verified, setVerified] = useState(false);
  const [later, setLater] = useState(false);
  const [ack, setAck] = useState(false);
  const [needAck, setNeedAck] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [key] = useState(newKey);
  const [done, setDone] = useState<DispenseResult | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["pharmacy-handwritten"] }); void qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); };
  const ready = rows.filter((r) => r.med && Number(r.qty) > 0);
  const dispense = useMutation({
    mutationFn: () => api.post<DispenseResult>("/pharmacy/dispenses", {
      patientId: scan.patientId, prescriptionScanId: scan.id, verifiedHandwriting: true, ...(later ? { completesPrescription: false } : {}),
      items: ready.map((r) => ({ medicineId: r.med!.id, quantity: Number(r.qty) })), ...(ack ? { acknowledgeAllergyWarnings: true } : {}),
    }, key),
    onSuccess: (r) => { setDone(r); refresh(); },
    onError: (e) => { if (e instanceof ApiError && e.code === "ALLERGY_CONFLICT") setNeedAck(true); },
  });
  const reject = useMutation({ mutationFn: () => api.post(`/pharmacy/handwritten/${scan.id}/reject`, { reason: reason.trim() }), onSuccess: () => { refresh(); onClose(); } });
  if (done) {
    return (
      <Modal title={`Dispensed — ${done.dispense.dispenseNumber}`} onClose={onClose}>
        <div className="space-y-3">
          <Notice tone="success">Total {money(done.dispense.total)}. Stock has been deducted from the earliest-expiring batches.{later ? " The prescription stays in the queue for the rest." : ""}</Notice>
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
    <Modal title={`Handwritten prescription — ${scan.patientName}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">MRN {scan.mrn ?? "—"} · visit {scan.encounterNumber} · {scan.doctorName ?? scan.uploadedBy ?? "doctor"} · uploaded {dateTime(scan.uploadedAt)}</p>
        {scan.allergies.length > 0 && <Notice tone="warn">Recorded allergies: {scan.allergies.map((a) => `${a.allergen} (${a.severity.toLowerCase().replace("_", " ")})`).join(", ")}</Notice>}
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">The doctor's prescription — {scan.pages.length} page{scan.pages.length === 1 ? "" : "s"}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            {scan.pages.map((pg) => (
              <a key={pg.fileId} href={`/api/proxy/files/${pg.fileId}/content`} target="_blank" rel="noreferrer" className="block rounded border border-slate-200 p-1 text-center text-xs text-brand-700 hover:bg-slate-50">
                {pg.contentType.startsWith("image/") ? <img src={`/api/proxy/files/${pg.fileId}/content`} alt={`Handwritten prescription, page ${pg.pageNo}`} className="mx-auto max-h-96 w-full object-contain" /> : <span className="flex h-40 items-center justify-center bg-slate-50">PDF — open to read</span>}
                Page {pg.pageNo} (click to enlarge)
              </a>
            ))}
          </div>
          {scan.text && <details className="mt-2 text-xs text-slate-600"><summary className="cursor-pointer">A note or machine reading of the handwriting (may be wrong: work from the picture)</summary><pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2">{scan.text}</pre></details>}
        </div>
        <label className="flex items-start gap-2 rounded-md border border-slate-200 p-2 text-sm"><input type="checkbox" className="mt-1" checked={verified} onChange={(e) => setVerified(e.target.checked)} /> <span>I have looked at {scan.pages.length === 1 ? "the page" : `all ${scan.pages.length} pages`} and checked that this is a valid prescription for this patient. I enter the medicines below from the handwriting.</span></label>
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Medicines to dispense</div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-12 items-start gap-2">
              <div className="col-span-9"><MedPick value={r.med} onPick={(m) => setRows(rows.map((x, j) => (j === i ? { ...x, med: m } : x)))} /></div>
              <Input className="col-span-2" aria-label="Quantity" placeholder="Qty" inputMode="numeric" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              {rows.length > 1 && <button className="col-span-1 pt-2 text-slate-500 hover:text-red-700" aria-label="Remove medicine" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          <Button variant="secondary" onClick={() => setRows([...rows, { med: null, qty: "" }])}>Add medicine</Button>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} /> More of this prescription is still to be dispensed later (keep it in the queue)</label>
        {needAck && (
          <div className="space-y-2">
            <Notice tone="warn">A medicine matches a recorded allergy of this patient. Check with the doctor before continuing.</Notice>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have reviewed the allergy warning and still want to dispense.</label>
          </div>
        )}
        <ErrorNote error={dispense.error instanceof ApiError && dispense.error.code === "ALLERGY_CONFLICT" ? null : dispense.error ?? reject.error} />
        {rejecting && (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2">
            <Field label="Why can this picture not be used? (the doctor will see this)"><Input aria-label="Reason" placeholder="e.g. Page is blurred, please upload again" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="flex gap-2"><Button variant="secondary" loading={reject.isPending} disabled={reason.trim().length < 5} onClick={() => reject.mutate()}>Send back to the doctor</Button><Button variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button></div>
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="ghost" onClick={() => setRejecting(true)}>I cannot use this picture…</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button loading={dispense.isPending} disabled={!verified || ready.length === 0 || (needAck && !ack)} onClick={() => dispense.mutate()}>Dispense and bill</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Handwritten prescriptions waiting for the pharmacy, from the moment the doctor uploads them. */
function HandwrittenQueue() {
  const { can, dateTime } = useMe();
  const [open, setOpen] = useState<HwScan | null>(null);
  const q = useQuery({ queryKey: ["pharmacy-handwritten"], queryFn: () => api.get<HwScan[]>("/pharmacy/handwritten"), enabled: can("PHARMACY_DISPENSE"), refetchInterval: 20_000 });
  if (!can("PHARMACY_DISPENSE") || (q.data?.length ?? 0) === 0) return null;
  return (
    <>
      <Card title={`Handwritten prescriptions from doctors (${q.data!.length})`}>
        <Table head={["Patient", "Doctor", "Pages", "Uploaded", ""]}>
          {q.data!.map((s) => (
            <tr key={s.id}>
              <Td><span className="font-medium">{s.patientName}</span> <span className="text-slate-500">· {s.mrn}</span>{s.allergies.length > 0 && <> <Badge tone="red">allergy alert</Badge></>}</Td>
              <Td>{s.doctorName ?? s.uploadedBy}</Td><Td>{s.pages.length}</Td><Td>{dateTime(s.uploadedAt)}</Td>
              <Td><Button onClick={() => setOpen(s)}>View and dispense</Button></Td>
            </tr>
          ))}
        </Table>
      </Card>
      {open && <HandwrittenDispense scan={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export default function PharmacyPage() {
  const { can, date } = useMe();
  const [tab, setTab] = useState<"queue" | "stock" | "sales" | "purchases" | "medicines" | "suppliers" | "locations">(can("PHARMACY_DISPENSE") ? "queue" : "stock");
  const [history, setHistory] = useState<{ id: string; label: string } | null>(null);
  const [order, setOrder] = useState<QOrder | null>(null);
  const [adding, setAdding] = useState(false);
  const [adjusting, setAdjusting] = useState<{ id: string; label: string; quantity: number } | null>(null);
  const [low, setLow] = useState(false);
  const [q, setQ] = useState("");
  // Shortcuts from the dashboard open the right tab: ?tab=stock&low=1, ?tab=medicines&add=1.
  const [startNew, setStartNew] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get("tab");
    if (t && ["queue", "stock", "sales", "purchases", "medicines", "suppliers", "locations"].includes(t)) setTab(t as typeof tab);
    if (p.get("low") === "1") setLow(true);
    if (p.get("add") === "1") setStartNew(true);
  }, []);
  const term = useDebounced(q.trim(), 250);
  const queue = useQuery({ queryKey: ["pharmacy-queue"], queryFn: () => api.page<QOrder>("/pharmacy/queue", { pageSize: 50 }), enabled: tab === "queue", refetchInterval: 20_000 });
  const stock = useQuery({ queryKey: ["pharmacy-stock", low, term], queryFn: () => api.page<StockRow>("/pharmacy/stock", { ...(low ? { lowStock: "true" } : {}), ...(term.length >= 2 ? { q: term } : {}), pageSize: 50 }), enabled: tab === "stock" });
  return (
    <Gate anyOf={["PHARMACY_READ"]} feature="PHARMACY_ENABLED">
      <PageHeader title="Pharmacy" actions={can("PHARMACY_ADJUST_STOCK", "PHARMACY_PURCHASE") ? <Button variant="secondary" onClick={() => setAdding(true)}>Add stock</Button> : undefined} />
      <Tabs tabs={[{ id: "queue", label: "Prescription queue" }, { id: "stock", label: "Stock" }, { id: "sales", label: "Sales" }, { id: "purchases", label: "Purchases" }, { id: "medicines", label: "Medicines" }, { id: "suppliers", label: "Suppliers" }, { id: "locations", label: "Locations and transfers" }]} value={tab} onChange={setTab} />
      {tab === "locations" && <StockLocationsTab />}
      {tab === "sales" && <SalesTab />}
      {tab === "medicines" && <MedicinesTab startNew={startNew} />}
      {tab === "purchases" && <PurchasesTab />}
      {tab === "suppliers" && <SuppliersTab />}
      {tab === "queue" && <HandwrittenQueue />}
      {tab === "queue" && (
        <Card title="Digital prescriptions">
          {queue.isLoading ? <Spinner /> : (
            <Table head={["Patient", "Prescription", "Doctor", "Status", ""]} {...(queue.data?.data.length === 0 ? { empty: "No prescriptions waiting." } : {})}>
              {queue.data?.data.map((o) => (
                <tr key={o.id}>
                  <Td><span className="font-medium">{o.patientName}</span> <span className="text-slate-500">· {o.mrn}</span>{o.allergyWarnings.length > 0 && <> <Badge tone="red">allergy alert</Badge></>}</Td>
                  <Td>{o.orderNumber}{o.source === "HANDWRITTEN" && <> <Badge tone="blue">handwritten, doctor approved</Badge></>}<div className="text-xs text-slate-500">{o.items.length} item(s) · {date(o.signedAt)}</div></Td><Td>{o.doctorName}</Td><Td><Badge tone={o.status === "PARTIAL" ? "amber" : "gray"}>{o.status.toLowerCase()}</Badge></Td>
                  <Td>{can("PHARMACY_DISPENSE") && <Button onClick={() => setOrder(o)}>Dispense</Button>}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {tab === "stock" && (
        <Card actions={<><Input placeholder="Search medicine" aria-label="Search medicine" className="w-48" value={q} onChange={(e) => setQ(e.target.value)} /><label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Low stock only</label></>}>
          {stock.isLoading ? <Spinner /> : (
            <Table head={["Medicine", "In stock", "Reorder at", "Near expiry", "Batches (earliest expiry first)"]} {...(stock.data?.data.length === 0 ? { empty: "No stock found." } : {})}>
              {stock.data?.data.map((s) => (
                <tr key={s.medicineId}>
                  <Td><span className="font-medium">{s.brandName}</span> <span className="text-slate-500">{s.strength}</span><div className="text-xs text-slate-500">{s.genericName}</div></Td>
                  <Td>{s.sellableQuantity} {s.lowStock && <Badge tone="red">low</Badge>}</Td><Td>{s.reorderLevel}</Td><Td>{s.nearExpiryQuantity > 0 ? <Badge tone="amber">{s.nearExpiryQuantity}</Badge> : "—"}{s.expiredQuantity > 0 && <> <Badge tone="red">{s.expiredQuantity} expired</Badge></>}</Td>
                  <Td>{s.batches.length === 0 ? "—" : s.batches.map((b) => (
                    <div key={b.id} className="text-xs">{b.batchNo} ({b.quantity}, exp {b.expiryDate})<button className="ml-2 text-brand-700 hover:underline" onClick={() => setHistory({ id: b.id, label: `${s.brandName} ${s.strength ?? ""} · ${b.batchNo}` })}>history</button>{can("PHARMACY_ADJUST_STOCK") && <button className="ml-2 text-brand-700 hover:underline" onClick={() => setAdjusting({ id: b.id, label: `${s.brandName} ${s.strength ?? ""} · ${b.batchNo}`, quantity: b.quantity })}>adjust</button>}</div>
                  ))}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {order && <Dispense order={order} onClose={() => setOrder(null)} />}
      {adding && <AddBatch onClose={() => setAdding(false)} />}
      {adjusting && <AdjustModal batch={adjusting} onClose={() => setAdjusting(null)} />}
      {history && <LedgerModal batch={history} onClose={() => setHistory(null)} />}
    </Gate>
  );
}
