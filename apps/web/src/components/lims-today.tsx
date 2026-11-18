"use client";
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { DetailModal, PriorityBadge, useRefreshLims, useRequests, type Req } from "./lims-common";
import { Badge, Button, Card, ErrorNote, Input, Modal, Notice, Select, Spinner } from "./ui";

const METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"];
const methodLabel = (m: string) => m.replace("_", " ").toLowerCase();

interface Billing {
  batchId: string; arrived: boolean; owed: string; advanceAvailable: string; advanceToUse: string; toCollect: string; unpriced: number; paid: boolean;
  tests: { requestNumber: string; test: string; department: string; billed: boolean; amount: string | null }[];
}
interface Arrived { invoiceIds: string[]; owed: string; advanceUsed: string; collected: string; receipts: { invoiceNumber: string | null; receiptNumber: string; amount: string }[] }

/**
 * The patient is at reception. One step bills the tests, uses what the patient paid in advance, takes the rest (one way or split) and tells the nurse the patient is here.
 * Nothing is taken unless the whole balance is paid.
 */
export function ArriveModal({ batchId, name, onClose }: { batchId: string; name: string; onClose: () => void }) {
  const { money } = useMe();
  const refresh = useRefreshLims();
  const key = useRef(newKey());
  const q = useQuery({ queryKey: ["lims-billing", batchId], queryFn: () => api.get<Billing>(`/lims/batches/${batchId}/billing`) });
  const [rows, setRows] = useState<{ method: string; amount: string; reference: string }[] | null>(null);
  const due = Number(q.data?.toCollect ?? 0);
  const lines = rows ?? (due > 0 ? [{ method: "CASH", amount: q.data?.toCollect ?? "", reference: "" }] : []);
  const sum = lines.reduce((n, r) => n + Math.round(Number(r.amount || 0) * 100), 0);
  // The printable bill opens in a new tab. The tab is opened on the click itself (a tab opened after the wait is blocked by the browser) and shown the bill once the payment is saved.
  const billTab = useRef<Window | null>(null);
  const billPdf = (invoiceId: string) => `${printUrl(`invoices/${invoiceId}`)}?format=pdf`;
  const arrive = useMutation({
    mutationFn: () => api.post<Arrived>(`/lims/batches/${batchId}/arrive`, { payments: lines.filter((r) => Number(r.amount) > 0).map((r) => ({ method: r.method, amount: Number(r.amount).toFixed(2), ...(r.reference.trim() ? { reference: r.reference.trim() } : {}) })) }, key.current),
    onSuccess: (r) => {
      refresh();
      if (billTab.current && !billTab.current.closed && r.invoiceIds[0]) billTab.current.location.href = billPdf(r.invoiceIds[0]);
      else billTab.current?.close();
      billTab.current = null;
    },
    onError: () => { billTab.current?.close(); billTab.current = null; },
  });
  const startArrive = () => {
    const w = window.open("", "_blank");
    if (w) { w.opener = null; w.document.title = "Bill"; w.document.body.textContent = "Preparing the bill…"; }
    billTab.current = w;
    arrive.mutate();
  };
  const set = (i: number, patch: Partial<{ method: string; amount: string; reference: string }>) => setRows(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const b = q.data;
  return (
    <Modal title={`${name} has arrived`} onClose={onClose}>
      {q.isLoading || !b ? <Spinner /> : arrive.data ? (
        <div className="space-y-3">
          <Notice tone="success">The patient is now with the nurse's list. Total {money(arrive.data.owed)}: advance used {money(arrive.data.advanceUsed)}, collected {money(arrive.data.collected)}.</Notice>
          {arrive.data.receipts.length > 0 && <p className="text-sm text-slate-600">Receipt{arrive.data.receipts.length > 1 ? "s" : ""}: {arrive.data.receipts.map((r) => r.receiptNumber).join(", ")}</p>}
          {arrive.data.invoiceIds.length > 0 && <p className="text-sm">{arrive.data.invoiceIds.map((id, i) => <a key={id} href={billPdf(id)} target="_blank" rel="noreferrer" className="mr-3 text-brand-700 hover:underline">Print bill{arrive.data.invoiceIds.length > 1 ? ` ${i + 1}` : ""} (PDF)</a>)}</p>}
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <table className="w-full text-sm">
            <tbody>
              {b.tests.map((t) => <tr key={t.requestNumber}><td className="py-0.5">{t.test} <span className="text-xs text-slate-500">({t.requestNumber})</span></td><td className="py-0.5 text-right">{t.billed ? <Badge tone="green">billed</Badge> : t.amount ? money(t.amount) : <Badge tone="amber">no price</Badge>}</td></tr>)}
              <tr className="border-t border-slate-200 font-medium"><td className="py-1">Total to pay</td><td className="py-1 text-right">{money(b.owed)}</td></tr>
              <tr><td className="py-0.5 text-slate-600">Advance the patient paid earlier (used first)</td><td className="py-0.5 text-right">− {money(b.advanceToUse)}</td></tr>
              <tr className="font-semibold"><td className="py-0.5">To collect now</td><td className="py-0.5 text-right">{money(b.toCollect)}</td></tr>
            </tbody>
          </table>
          {b.unpriced > 0 && <Notice tone="warn">{b.unpriced} test{b.unpriced > 1 ? "s have" : " has"} no price on the price list. The cashier must give {b.unpriced > 1 ? "them" : "it"} a price before the patient can pay.</Notice>}
          {due > 0 && (
            <div className="space-y-2">
              {lines.map((r, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <Select aria-label="Mode" className="col-span-4" value={r.method} onChange={(e) => set(i, { method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}</Select>
                  <Input aria-label="Amount" className="col-span-3" inputMode="decimal" value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} />
                  <Input aria-label="Reference" className="col-span-4" placeholder={r.method === "CASH" ? "—" : "Reference"} disabled={r.method === "CASH"} value={r.reference} onChange={(e) => set(i, { reference: e.target.value })} />
                  {lines.length > 1 && <button className="col-span-1 text-slate-400 hover:text-red-700" aria-label="Remove" onClick={() => setRows(lines.filter((_, j) => j !== i))}>✕</button>}
                </div>
              ))}
              <div className="flex items-center justify-between text-sm"><Button variant="ghost" onClick={() => setRows([...lines, { method: "UPI", amount: "", reference: "" }])}>+ Split payment</Button><span className={sum === Math.round(due * 100) ? "text-green-700" : "text-slate-600"}>Entered {money(sum / 100)} of {money(b.toCollect)}</span></div>
            </div>
          )}
          <ErrorNote error={arrive.error} />
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={b.unpriced > 0 || sum !== Math.round(due * 100)} loading={arrive.isPending} onClick={startArrive}>{due > 0 ? "Collect and send to the nurse" : "Send to the nurse"}</Button></div>
        </div>
      )}
    </Modal>
  );
}

interface Group { batchId: string; patient: Req["patient"]; rows: Req[]; at: string | null; arrived: boolean; billed: boolean; priority: Req["priority"]; nurses: string[] }

/**
 * The outpatients due today (or earlier and not yet attended), one card per patient: when they were asked to come, whether they have reported at reception, and who is to take the
 * sample. Reception takes the patient in here; the nurse sees who has arrived; the LIMS manager sees the whole day and can give the work to a nurse.
 */
export function TodayBoard({ mode }: { mode: "reception" | "nurse" | "manager" }) {
  const { dateTime } = useMe();
  const list = useRequests({ expected: "true", pageSize: 100 }, { every: 15_000 });
  const [arriving, setArriving] = useState<{ batchId: string; name: string } | null>(null);
  const [open, setOpen] = useState<Req | null>(null);
  const groups = new Map<string, Group>();
  for (const r of list.data?.items ?? []) {
    const g = groups.get(r.batchId) ?? { batchId: r.batchId, patient: r.patient, rows: [], at: null, arrived: true, billed: true, priority: "ROUTINE" as Req["priority"], nurses: [] };
    g.rows.push(r);
    if (r.scheduledFor && (!g.at || r.scheduledFor < g.at)) g.at = r.scheduledFor;
    if (!r.arrivedAt) g.arrived = false;
    if (!r.billed) g.billed = false;
    if (r.priority === "EMERGENCY" || (r.priority === "URGENT" && g.priority === "ROUTINE")) g.priority = r.priority;
    const nurse = r.assignedNurse?.name; if (nurse && !g.nurses.includes(nurse)) g.nurses.push(nurse);
    groups.set(r.batchId, g);
  }
  const all = [...groups.values()].sort((a, b) => Number(a.arrived) - Number(b.arrived) || (a.at ?? "").localeCompare(b.at ?? ""));
  const arrivedFirst = mode === "nurse" ? [...all].sort((a, b) => Number(b.arrived) - Number(a.arrived) || (a.at ?? "").localeCompare(b.at ?? "")) : all;
  return (
    <Card title={mode === "nurse" ? "Outpatients expected today" : "Today's outpatients"}>
      {list.isLoading ? <Spinner /> : arrivedFirst.length === 0 ? <p className="text-sm text-slate-500">Nobody is expected for a laboratory or imaging test today.</p> : (
        <ul className="divide-y divide-slate-100">
          {arrivedFirst.map((g) => (
            <li key={g.batchId} data-priority={g.priority} className={g.priority === "EMERGENCY" ? "-mx-2 flex flex-wrap items-center justify-between gap-2 rounded-md border-l-4 border-l-red-600 bg-red-50 px-2 py-2" : "flex flex-wrap items-center justify-between gap-2 py-2"}>
              <div className="min-w-0">
                <p className="text-sm"><span className={g.priority === "EMERGENCY" ? "font-semibold text-red-700" : "font-medium"}>{g.patient.name}</span> <span className="text-slate-500">· {g.patient.mrn}</span> <PriorityBadge p={g.priority} /></p>
                <p className="text-xs text-slate-500">{g.rows.map((r) => r.test).join(", ")} · {g.at ? `asked to come at ${dateTime(g.at)}` : "come now"}{g.nurses.length ? ` · nurse: ${g.nurses.join(", ")}` : mode !== "reception" ? " · no nurse assigned yet" : ""}</p>
                {mode !== "reception" && <p className="mt-0.5 flex flex-wrap gap-1">{g.rows.map((r) => <button key={r.id} className="text-xs text-brand-700 underline" onClick={() => setOpen(r)}>{r.requestNumber}</button>)}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {g.billed && <Badge tone="green">billed</Badge>}
                {g.arrived ? <Badge tone="green">at reception: ready for the nurse</Badge> : <Badge tone="amber">not here yet</Badge>}
                {mode === "reception" && !g.arrived && <Button onClick={() => setArriving({ batchId: g.batchId, name: g.patient.name })}>Patient arrived</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {arriving && <ArriveModal batchId={arriving.batchId} name={arriving.name} onClose={() => setArriving(null)} />}
      {open && <DetailModal id={open.id} onClose={() => setOpen(null)} />}
    </Card>
  );
}
