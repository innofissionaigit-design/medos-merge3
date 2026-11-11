"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Select } from "./ui";

interface Req { id: string; kind: "TEST" | "MEDICINE"; status: "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED"; summary: string; note: string | null; requestedAt: string; requestedBy: string | null; mine: boolean; decidedAt: string | null; decidedBy: string | null; decisionNote: string | null }
const TONE = { PENDING: "amber", ACCEPTED: "green", DECLINED: "red", CANCELLED: "gray" } as const;
const WORD = { PENDING: "waiting for the doctor", ACCEPTED: "accepted", DECLINED: "declined", CANCELLED: "withdrawn" } as const;
const ROUTES = ["ORAL", "IV", "IM", "SC", "TOPICAL", "OTHER"] as const;
const FREQUENCIES = ["STAT", "OD", "BD", "TDS", "QID", "HS", "SOS"] as const;

/**
 * Nurse requests for a patient in the emergency ward or the ICU. The nurse asks for a test or a medicine; the doctor in charge accepts it (a test is then ordered, a medicine goes on the
 * doctor's draft prescription to review and sign) or declines it with a reason. Nothing reaches the laboratory or the pharmacy before the doctor says yes.
 */
export function OrderRequests({ encounterId, open, area, mayDecide, rxKey }: { encounterId: string; open: boolean; area: "ER" | "ICU"; mayDecide: boolean; rxKey: string }) {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const mayAsk = can("ORDER_REQUEST") && open;
  const seesAny = can("ORDER_REQUEST") || can("ER_TREAT") || can("ICU_DOCTOR");
  const list = useQuery({ queryKey: ["order-requests", encounterId], queryFn: () => api.get<Req[]>("/order-requests", { encounterId }), enabled: seesAny, refetchInterval: 8_000 });
  const rows = list.data ?? [];
  const after = (): void => { for (const k of ["order-requests", "ipd-rx", "lims-visit", "lab-results", "notif-unread", "notif-list", "er-case", "icu-stay"]) void qc.invalidateQueries({ queryKey: [k] }); void qc.invalidateQueries({ queryKey: ["ipd-rx", rxKey] }); };
  if (!seesAny) return null;
  const pending = rows.filter((r) => r.status === "PENDING");
  if (!mayAsk && rows.length === 0) return null;
  return (
    <Card title={mayDecide ? "Requests from the nurses" : "Ask the doctor for a test or a medicine"} actions={pending.length > 0 ? <Badge tone="amber">{`${pending.length} waiting`}</Badge> : undefined}>
      {mayAsk && <AskForm encounterId={encounterId} area={area} onDone={after} />}
      <ErrorNote error={list.error} />
      {rows.length === 0 ? <p className="text-sm text-slate-500">No requests yet.</p> : (
        <ul className="mt-3 space-y-2">
          {rows.map((r) => <RequestRow key={r.id} r={r} mayDecide={mayDecide} onDone={after} when={dateTime(r.requestedAt)} />)}
        </ul>
      )}
    </Card>
  );
}

function RequestRow({ r, mayDecide, onDone, when }: { r: Req; mayDecide: boolean; onDone: () => void; when: string }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const decide = useMutation({ mutationFn: (body: Record<string, unknown>) => api.post(`/order-requests/${r.id}/decision`, body), onSuccess: () => { setDeclining(false); setReason(""); onDone(); } });
  const withdraw = useMutation({ mutationFn: () => api.post(`/order-requests/${r.id}/cancel`), onSuccess: onDone });
  return (
    <li className="rounded-md border border-slate-200 p-2 text-sm" data-testid="order-request">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><span className="mr-2 text-xs uppercase text-slate-500">{r.kind === "TEST" ? "Test" : "Medicine"}</span><span className="font-medium">{r.summary}</span></div>
        <Badge tone={TONE[r.status]}>{WORD[r.status]}</Badge>
      </div>
      <div className="text-xs text-slate-500">{r.requestedBy} · {when}{r.note ? ` · ${r.note}` : ""}</div>
      {r.decidedAt && <div className="text-xs text-slate-600">{WORD[r.status]} by {r.decidedBy}{r.decisionNote ? `: ${r.decisionNote}` : ""}</div>}
      {r.status === "PENDING" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {mayDecide && !declining && <><Button loading={decide.isPending} onClick={() => decide.mutate({ action: "ACCEPT" })}>{r.kind === "TEST" ? "Accept and order the test" : "Accept: add to my prescription"}</Button><Button variant="secondary" onClick={() => setDeclining(true)}>Decline…</Button></>}
          {mayDecide && declining && (
            <>
              <Input aria-label="Reason for declining" className="min-w-0 flex-1" placeholder="Why not?" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button variant="secondary" disabled={reason.trim().length < 3} loading={decide.isPending} onClick={() => decide.mutate({ action: "DECLINE", note: reason.trim() })}>Decline</Button>
              <Button variant="ghost" onClick={() => setDeclining(false)}>Back</Button>
            </>
          )}
          {r.mine && <Button variant="ghost" loading={withdraw.isPending} onClick={() => withdraw.mutate()}>Withdraw</Button>}
        </div>
      )}
      <ErrorNote error={decide.error ?? withdraw.error} />
    </li>
  );
}

function AskForm({ encounterId, area, onDone }: { encounterId: string; area: "ER" | "ICU"; onDone: () => void }) {
  const [kind, setKind] = useState<"TEST" | "MEDICINE">("TEST");
  const [serviceId, setServiceId] = useState("");
  const [priority, setPriority] = useState(area === "ER" ? "EMERGENCY" : "URGENT");
  const [note, setNote] = useState("");
  const [m, setM] = useState({ genericName: "", strength: "", dosage: "1 tablet", route: "ORAL", frequency: "TDS", days: "" });
  const tests = useQuery({ queryKey: ["services-investigation"], queryFn: () => api.page<{ id: string; name: string }>("/services", { category: "INVESTIGATION", pageSize: 100 }) });
  const send = useMutation({
    mutationFn: () => api.post("/order-requests", kind === "TEST"
      ? { kind, encounterId, tests: [{ serviceId }], priority, ...(note.trim() ? { note: note.trim() } : {}) }
      : { kind, encounterId, item: { genericName: m.genericName.trim(), ...(m.strength.trim() ? { strength: m.strength.trim() } : {}), dosage: m.dosage.trim(), route: m.route, frequency: m.frequency, ...(m.days ? { durationDays: Number(m.days) } : {}) }, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => { setServiceId(""); setNote(""); setM({ ...m, genericName: "", strength: "", days: "" }); onDone(); },
  });
  const ready = kind === "TEST" ? serviceId !== "" : m.genericName.trim().length >= 2 && m.dosage.trim().length > 0;
  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-2">
      <div className="flex gap-2" role="radiogroup" aria-label="What to ask for">
        {(["TEST", "MEDICINE"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`rounded-md border px-3 py-1 text-sm ${kind === k ? "border-brand-600 bg-white font-medium text-brand-700" : "border-slate-300 bg-white text-slate-600"}`}>{k === "TEST" ? "A test" : "A medicine"}</button>)}
      </div>
      {kind === "TEST" ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Test" ><Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}><option value="">Choose a test…</option>{tests.data?.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="How soon"><Select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="ROUTINE">Routine</option><option value="URGENT">Urgent</option><option value="EMERGENCY">Emergency</option></Select></Field>
          <Field label="Why (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label="Medicine"><Input value={m.genericName} onChange={(e) => setM({ ...m, genericName: e.target.value })} placeholder="Name" /></Field>
          <Field label="Strength"><Input value={m.strength} onChange={(e) => setM({ ...m, strength: e.target.value })} placeholder="500 mg" /></Field>
          <Field label="Dose"><Input value={m.dosage} onChange={(e) => setM({ ...m, dosage: e.target.value })} /></Field>
          <Field label="Route"><Select value={m.route} onChange={(e) => setM({ ...m, route: e.target.value })}>{ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}</Select></Field>
          <Field label="How often"><Select value={m.frequency} onChange={(e) => setM({ ...m, frequency: e.target.value })}>{FREQUENCIES.map((r) => <option key={r} value={r}>{r}</option>)}</Select></Field>
          <Field label="Days (optional)"><Input inputMode="numeric" value={m.days} onChange={(e) => setM({ ...m, days: e.target.value.replace(/\D/g, "").slice(0, 3) })} /></Field>
          <Field label="Why (optional)" ><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
      )}
      <ErrorNote error={send.error} />
      <div className="flex justify-end"><Button disabled={!ready} loading={send.isPending} onClick={() => send.mutate()}>Ask the doctor</Button></div>
    </div>
  );
}
