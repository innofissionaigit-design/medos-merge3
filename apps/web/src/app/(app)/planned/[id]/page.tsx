"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { AssessmentCard } from "@/components/nursing-assessment";
import { useAvailableBeds, todayIn } from "@/components/pickers";
import { CLOSE_LABEL, dayCount, RequestHeader, Stepper, useRefreshPlanned, waitedFor, type Plan } from "@/components/planned";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, KV, Notice, Select, Spinner, Textarea } from "@/components/ui";
import { api, ApiError, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";

/** One step of the request: posts to the step's route and puts the new state of the request on the screen. */
function useStep(planId: string, path: string, method: "post" | "put" = "post") {
  const qc = useQueryClient();
  const refresh = useRefreshPlanned();
  return useMutation({
    mutationFn: (body?: unknown) => (method === "put" ? api.put<Plan>(`/planned-admissions/${planId}/${path}`, body) : api.post<Plan>(`/planned-admissions/${planId}/${path}`, body)),
    onSuccess: (p) => { qc.setQueryData(["planned", planId], p); refresh(planId); },
  });
}

const ASK_LABEL = { CHAMBER: "Come to my chamber", REPORTS: "Send the reports", INVESTIGATIONS: "Get these tests done and bring the reports" } as const;

// ───────────────────────── the doctor and the patient ─────────────────────────

function ConsentStep({ plan }: { plan: Plan }) {
  const [note, setNote] = useState("");
  const yes = useStep(plan.id, "consent");
  return (
    <Card title="Ask the patient">
      <p className="mb-3 text-sm text-slate-600">{`${plan.consultant.name} advised that ${plan.patient.name} should be admitted. Ask the patient. If the patient agrees, the admission procedure starts.`}</p>
      <div className="mb-3 rounded-md bg-slate-50 p-3 text-sm"><b>Doctor's note:</b> {plan.details}</div>
      <Field label="Patient's answer (a note, required if the patient does not agree)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorNote error={yes.error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button loading={yes.isPending} onClick={() => yes.mutate({ consented: true, ...(note.trim().length >= 3 ? { note: note.trim() } : {}) })}>The patient agrees: start the admission procedure</Button>
        <Button variant="secondary" disabled={note.trim().length < 3} onClick={() => yes.mutate({ consented: false, note: note.trim() })}>The patient does not want to be admitted</Button>
      </div>
    </Card>
  );
}

function DoctorStep({ plan }: { plan: Plan }) {
  const { me } = useMe();
  const [mode, setMode] = useState<"ASK" | "ACCEPT" | "OTHER" | "DECLINE">("ASK");
  const [ask, setAsk] = useState<"CHAMBER" | "REPORTS" | "INVESTIGATIONS">("CHAMBER");
  const [note, setNote] = useState("");
  const [f, setF] = useState({ diagnosis: plan.diagnosis ?? "", plannedProcedure: plan.plannedProcedure ?? "", proposedDate: plan.proposedDate ?? "", expectedStayDays: plan.expectedStayDays ? String(plan.expectedStayDays) : "", wardId: plan.ward?.id ?? "", roomNote: plan.roomNote ?? "" });
  const wards = useQuery({ queryKey: ["wards"], queryFn: () => api.get<{ id: string; name: string; status: string }[]>("/wards") });
  const m = useStep(plan.id, "doctor");
  const send = () => {
    if (mode === "ASK") m.mutate({ action: "ASK", mode: ask, note: note.trim() });
    else if (mode === "ACCEPT") m.mutate({ action: "ACCEPT", diagnosis: f.diagnosis.trim(), ...(f.plannedProcedure.trim() ? { plannedProcedure: f.plannedProcedure.trim() } : {}), proposedDate: f.proposedDate, expectedStayDays: Number(f.expectedStayDays), ...(f.wardId ? { wardId: f.wardId } : {}), ...(f.roomNote.trim() ? { roomNote: f.roomNote.trim() } : {}), ...(note.trim().length >= 3 ? { note: note.trim() } : {}) });
    else if (mode === "OTHER") m.mutate({ action: "OTHER_TREATMENT", note: note.trim() });
    else m.mutate({ action: "DECLINE", reason: note.trim() });
  };
  const ready = mode === "ASK" ? note.trim().length >= 3 : mode === "ACCEPT" ? f.diagnosis.trim().length >= 2 && !!f.proposedDate && Number(f.expectedStayDays) >= 1 : note.trim().length >= 5;
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  return (
    <Card title="Your decision">
      <p className="mb-3 text-sm text-slate-600">{plan.source === "OUTSIDE_DIRECT" ? "An outside doctor's advice is not an admission order from this hospital. Review the reports, examine the patient if needed, and decide." : "Review the request. You can ask the patient to come to your chamber or send reports before you decide."}</p>
      <div className="mb-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Your decision">
        {([["ASK", "Ask the patient for something first"], ["ACCEPT", "Accept the admission"], ["OTHER", "Recommend other treatment"], ["DECLINE", "Decline"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} onClick={() => setMode(id)} className={`rounded-md px-3 py-1.5 text-sm ring-1 ${mode === id ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}>{label}</button>
        ))}
      </div>
      {mode === "ASK" && (
        <div className="mb-3 grid gap-3">
          <Field label="What do you need from the patient?"><Select value={ask} onChange={(e) => setAsk(e.target.value as typeof ask)}>{Object.entries(ASK_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Your instruction for reception and the patient"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Bring the ultrasound and the old prescription" /></Field>
        </div>
      )}
      {mode === "ACCEPT" && (
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <Field label="Diagnosis"><Input value={f.diagnosis} onChange={(e) => setF({ ...f, diagnosis: e.target.value })} /></Field>
          <Field label="Planned procedure"><Input value={f.plannedProcedure} onChange={(e) => setF({ ...f, plannedProcedure: e.target.value })} /></Field>
          <Field label="Day of admission"><Input type="date" min={todayIn(tz)} value={f.proposedDate} onChange={(e) => setF({ ...f, proposedDate: e.target.value })} /></Field>
          <Field label="Expected stay (days)"><Input inputMode="numeric" value={f.expectedStayDays} onChange={(e) => setF({ ...f, expectedStayDays: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="Room category (ward)"><Select value={f.wardId} onChange={(e) => setF({ ...f, wardId: e.target.value })}><option value="">No preference</option>{wards.data?.filter((w) => w.status === "ACTIVE").map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
          <Field label="Room note (optional)"><Input value={f.roomNote} onChange={(e) => setF({ ...f, roomNote: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Note for the admission desk (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
        </div>
      )}
      {(mode === "OTHER" || mode === "DECLINE") && <div className="mb-3"><Field label={mode === "OTHER" ? "The treatment you recommend, and why admission is not needed" : "Why admission is not clinically appropriate"}><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>}
      <ErrorNote error={m.error} />
      <div className="mt-2"><Button loading={m.isPending} disabled={!ready} onClick={send}>{mode === "ASK" ? "Send to reception" : mode === "ACCEPT" ? "Accept and confirm the day" : mode === "OTHER" ? "Close: other treatment" : "Decline the admission"}</Button></div>
    </Card>
  );
}

function WaitingStep({ plan }: { plan: Plan }) {
  const [note, setNote] = useState("");
  const [queue, setQueue] = useState(true);
  const m = useStep(plan.id, "patient-ready");
  const feeBlocked = m.error instanceof ApiError && m.error.code === "CONSULTATION_PAYMENT_REQUIRED";
  const body = (sendToQueue: boolean) => ({ sendToQueue, ...(note.trim().length >= 3 ? { note: note.trim() } : {}) });
  return (
    <Card title="Waiting for the patient">
      <div className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900"><b>{plan.askMode ? ASK_LABEL[plan.askMode] : "The doctor asked the patient"}.</b> {plan.askNote}</div>
      {plan.can.patientReady ? (
        <>
          {plan.askMode === "CHAMBER" && <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} /> Put the patient in the doctor's OPD queue now</label>}
          <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={plan.askMode === "CHAMBER" ? "e.g. Patient is here with the X-rays" : "e.g. Reports handed over"} /></Field>
          {feeBlocked ? (
            <Notice tone="warn">
              <div>
                <p><b>The OPD consultation fee is not paid yet</b>, so the patient cannot join the doctor's queue.</p>
                <p className="mt-1">{"Either collect the fee first, or send the request to the doctor without the queue (for example when the patient is already booked or the doctor will see the patient directly)."}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-amber-50" href={`/patients/${plan.patient.id}`}>Collect the fee on the patient's page</Link>
                  <Button variant="secondary" loading={m.isPending} onClick={() => m.mutate(body(false))}>Send to the doctor without the queue</Button>
                </div>
              </div>
            </Notice>
          ) : <ErrorNote error={m.error} />}
          <div className="mt-3"><Button loading={m.isPending} onClick={() => m.mutate(body(queue))}>{plan.askMode === "CHAMBER" ? "Patient is here: send to the doctor" : "Reports received: send to the doctor"}</Button></div>
        </>
      ) : <p className="text-sm text-slate-500">Reception will send the patient or the reports to the doctor.</p>}
    </Card>
  );
}

// ───────────────────────── the admission desk ─────────────────────────

function VerifyStep({ plan }: { plan: Plan }) {
  const { me } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const [f, setF] = useState({ consultantId: plan.consultant.id, diagnosis: plan.diagnosis ?? "", plannedProcedure: plan.plannedProcedure ?? "", proposedDate: plan.proposedDate ?? "", expectedStayDays: plan.expectedStayDays ? String(plan.expectedStayDays) : "", wardId: plan.ward?.id ?? "", roomNote: plan.roomNote ?? "" });
  const wards = useQuery({ queryKey: ["wards"], queryFn: () => api.get<{ id: string; name: string; status: string }[]>("/wards") });
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<{ id: string; displayName: string }[]>("/practitioners") });
  const m = useStep(plan.id, "verify");
  const need = { diagnosis: f.diagnosis.trim().length < 2, proposedDate: !f.proposedDate, expectedStayDays: !(Number(f.expectedStayDays) >= 1), wardId: !f.wardId };
  const ok = !Object.values(need).some(Boolean);
  const missing = [need.diagnosis && "the diagnosis", need.proposedDate && "the day of admission", need.expectedStayDays && "the expected stay", need.wardId && "the room category"].filter((x): x is string => !!x);
  return (
    <Card title="Verify the admission details">
      <p className="mb-3 text-sm text-slate-600">Check what the doctor has written. You may correct it. Then billing and insurance take over.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Admitting consultant"><Select value={f.consultantId} onChange={(e) => setF({ ...f, consultantId: e.target.value })}>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select></Field>
        <Field label="Diagnosis" error={need.diagnosis ? "Required" : undefined}><Input value={f.diagnosis} onChange={(e) => setF({ ...f, diagnosis: e.target.value })} /></Field>
        <Field label="Planned procedure"><Input value={f.plannedProcedure} onChange={(e) => setF({ ...f, plannedProcedure: e.target.value })} /></Field>
        <Field label="Proposed day of admission" error={need.proposedDate ? "Required" : undefined}><Input type="date" min={todayIn(tz)} value={f.proposedDate} onChange={(e) => setF({ ...f, proposedDate: e.target.value })} /></Field>
        <Field label="Expected length of stay (days)" error={need.expectedStayDays ? "Required" : undefined}><Input inputMode="numeric" value={f.expectedStayDays} onChange={(e) => setF({ ...f, expectedStayDays: e.target.value.replace(/\D/g, "") })} /></Field>
        <Field label="Requested room category (ward)" error={need.wardId ? "Required: choose where the patient will stay" : undefined}><Select value={f.wardId} onChange={(e) => setF({ ...f, wardId: e.target.value })}><option value="">Choose…</option>{wards.data?.filter((w) => w.status === "ACTIVE").map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <div className="sm:col-span-2"><Field label="Room note (optional)"><Input value={f.roomNote} onChange={(e) => setF({ ...f, roomNote: e.target.value })} /></Field></div>
      </div>
      <ErrorNote error={m.error} />
      <div className="mt-3 flex flex-wrap items-center gap-3"><Button loading={m.isPending} disabled={!ok} onClick={() => m.mutate({ ...(f.consultantId !== plan.consultant.id ? { consultantId: f.consultantId } : {}), diagnosis: f.diagnosis.trim(), ...(f.plannedProcedure.trim() ? { plannedProcedure: f.plannedProcedure.trim() } : {}), proposedDate: f.proposedDate, expectedStayDays: Number(f.expectedStayDays), wardId: f.wardId, ...(f.roomNote.trim() ? { roomNote: f.roomNote.trim() } : {}) })}>Verified: send to billing and insurance</Button>{missing.length > 0 && <span className="text-xs text-slate-500" aria-live="polite">{`To continue, add ${missing.join(", ")}.`}</span>}</div>
    </Card>
  );
}

// ───────────────────────── billing, insurance, deposit ─────────────────────────

function EstimateCard({ plan }: { plan: Plan }) {
  const { money } = useMe();
  const [rows, setRows] = useState(() => plan.estimate.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })));
  const save = useStep(plan.id, "estimate", "put");
  const edit = plan.can.estimate;
  const set = (i: number, k: "description" | "quantity" | "unitPrice", v: string) => setRows(rows.map((r, n) => (n === i ? { ...r, [k]: v } : r)));
  const valid = rows.length > 0 && rows.every((r) => r.description.trim().length >= 2 && Number(r.quantity) > 0 && r.unitPrice !== "" && Number(r.unitPrice) >= 0);
  return (
    <Card title="Estimate of charges" actions={plan.estimate.total !== "0.00" ? <Badge tone="blue">{`Total ${money(plan.estimate.total)}`}</Badge> : undefined}>
      {!edit ? (
        plan.estimate.lines.length === 0 ? <p className="text-sm text-slate-500">Billing has not made the estimate yet.</p> : (
          <table className="w-full text-sm"><thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-1">Item</th><th>Qty</th><th>Price</th><th className="text-right">Amount</th></tr></thead>
            <tbody>{plan.estimate.lines.map((l) => <tr key={l.lineNo} className="border-t border-slate-100"><td className="py-1">{l.description}</td><td>{l.quantity}</td><td>{money(l.unitPrice)}</td><td className="text-right">{money(l.amount)}</td></tr>)}</tbody></table>
        )
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_70px_100px_auto] items-center gap-2">
              <Input aria-label="Item" placeholder="Item (e.g. Surgeon and theatre)" value={r.description} onChange={(e) => set(i, "description", e.target.value)} />
              <Input aria-label="Quantity" inputMode="decimal" value={r.quantity} onChange={(e) => set(i, "quantity", e.target.value)} />
              <Input aria-label="Price" inputMode="decimal" placeholder="Price" value={r.unitPrice} onChange={(e) => set(i, "unitPrice", e.target.value)} />
              <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => setRows(rows.filter((_, n) => n !== i))}>remove</button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setRows([...rows, { description: "", quantity: "1", unitPrice: "" }])}>Add a line</Button>
            {plan.estimate.suggestedBedLine && !rows.some((r) => r.description === plan.estimate.suggestedBedLine!.description) && <Button variant="secondary" onClick={() => setRows([...rows, { ...plan.estimate.suggestedBedLine! }])}>{`Add the bed charge: ${plan.estimate.suggestedBedLine.description}`}</Button>}
            <Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate({ lines: rows.map((r) => ({ description: r.description.trim(), quantity: r.quantity, unitPrice: r.unitPrice })) })}>Save the estimate</Button>
          </div>
          <ErrorNote error={save.error} />
        </div>
      )}
    </Card>
  );
}

interface Policy { id: string; policyNumber: string; validTo: string; validToday: boolean; status: string; insurer: { name: string } }
function PayerCard({ plan }: { plan: Plan }) {
  const { date } = useMe();
  const [policyId, setPolicyId] = useState("");
  const [pre, setPre] = useState(true);
  const [note, setNote] = useState("");
  const policies = useQuery({ queryKey: ["policies", plan.patient.id], queryFn: () => api.get<Policy[]>(`/patients/${plan.patient.id}/policies`), enabled: plan.can.payerInsured });
  const payer = useStep(plan.id, "payer");
  const done = useStep(plan.id, "tariff-done");
  return (
    <Card title="Payer and insurance" actions={plan.payer ? <Badge tone="blue">{plan.payer === "SELF_PAY" ? "Self-pay" : "Insured"}</Badge> : undefined}>
      {plan.payer === "INSURED" && plan.policy && <div className="mb-3 space-y-1 text-sm"><KV label="Insurer">{plan.policy.insurer}</KV><KV label="Policy">{`${plan.policy.policyNumber}${plan.policy.validTo ? `, valid to ${date(plan.policy.validTo)}` : ""}`}</KV><KV label="Pre-authorisation">{plan.preauthRequired ? "Needed" : "Not needed"}</KV><KV label="Eligibility check">{plan.eligibilityNote}</KV>{plan.claim && <KV label="Claim"><Link className="text-brand-700 hover:underline" href={`/claims?open=${plan.claim.id}`}>{plan.claim.claimNumber}</Link> {` (${plan.claim.status.replace(/_/g, " ").toLowerCase()})`}</KV>}</div>}
      {plan.payer === "SELF_PAY" && <p className="mb-3 text-sm text-slate-600">The patient will pay.{plan.eligibilityNote ? ` ${plan.eligibilityNote}` : ""}</p>}
      {!plan.payer && !plan.can.payerSelf && !plan.can.payerInsured && <p className="text-sm text-slate-500">The payer is not set yet.</p>}
      {(plan.can.payerSelf || plan.can.payerInsured) && plan.status === "TARIFF_PAYER" && (
        <div className="space-y-3">
          {plan.can.payerInsured && (
            <div className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium">Insured: check the policy, coverage and network</div>
              {policies.data?.length === 0 && <Notice tone="warn">This patient has no policy on record. Add it on the patient's page, then come back.</Notice>}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Policy"><Select value={policyId} onChange={(e) => setPolicyId(e.target.value)}><option value="">Choose…</option>{policies.data?.map((p) => <option key={p.id} value={p.id} disabled={!p.validToday}>{`${p.insurer.name} · ${p.policyNumber}${p.validToday ? "" : " (not valid today)"}`}</option>)}</Select></Field>
                <Field label="Result of the policy, coverage and network check"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Active, network hospital, room rent within limit" /></Field>
              </div>
              <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={pre} onChange={(e) => setPre(e.target.checked)} /> Pre-authorisation from the insurer is needed</label>
              <div className="mt-2"><Button variant="secondary" loading={payer.isPending} disabled={!policyId || note.trim().length < 3} onClick={() => payer.mutate({ payer: "INSURED", policyId, preauthRequired: pre, eligibilityNote: note.trim() })}>Confirm as insured</Button></div>
            </div>
          )}
          {plan.can.payerSelf && <div><Button variant="secondary" loading={payer.isPending} onClick={() => payer.mutate({ payer: "SELF_PAY" })}>The patient pays himself or herself</Button></div>}
        </div>
      )}
      <ErrorNote error={payer.error ?? done.error} />
      {plan.can.tariffDone && <div className="mt-3"><Button loading={done.isPending} onClick={() => done.mutate(undefined)}>{plan.payer === "INSURED" && plan.preauthRequired ? "Estimate and payer are done: ask the insurer" : "Estimate and payer are done: go to the deposit"}</Button></div>}
      {plan.status === "TARIFF_PAYER" && !plan.can.tariffDone && (plan.estimate.total === "0.00" || !plan.payer) && <p className="mt-3 text-xs text-slate-500">This step finishes when the estimate is saved and the payer is chosen.</p>}
    </Card>
  );
}

function PreauthStep({ plan }: { plan: Plan }) {
  const { money } = useMe();
  const [amount, setAmount] = useState(plan.estimate.total);
  const [reason, setReason] = useState("");
  const [selfWhy, setSelfWhy] = useState("");
  const m = useStep(plan.id, "preauth");
  const claim = plan.claim;
  if (!claim) return <Card title="Insurer's pre-authorisation"><Notice tone="warn">There is no claim for this request. Choose the payer again.</Notice></Card>;
  return (
    <Card title="Insurer's pre-authorisation" actions={<Badge tone="blue">{claim.status.replace(/_/g, " ").toLowerCase()}</Badge>}>
      <p className="mb-3 text-sm text-slate-600">{`Claim ${claim.claimNumber}. Ask the insurer, then record its answer here. Documents and further steps are on the `}<Link className="text-brand-700 hover:underline" href={`/claims?open=${claim.id}`}>claim</Link>.</p>
      {claim.preauthRequested && <p className="mb-2 text-sm">{`Asked for ${money(claim.preauthRequested)}.`}</p>}
      {plan.can.preauth ? (
        <div className="space-y-3">
          {claim.status === "DRAFT" && (
            <div className="grid gap-3 sm:grid-cols-[200px_1fr_auto] sm:items-end">
              <Field label="Amount to ask for"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
              <Field label="Note (optional)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Pre-auth form sent to the TPA" /></Field>
              <Button loading={m.isPending} disabled={!(Number(amount) > 0)} onClick={() => m.mutate({ action: "REQUEST", requestedAmount: amount, ...(reason.trim().length >= 3 ? { note: reason.trim() } : {}) })}>Ask the insurer</Button>
            </div>
          )}
          {claim.status === "PREAUTH_PENDING" && (
            <div className="grid gap-3 sm:grid-cols-[200px_1fr] sm:items-end">
              <Field label="Amount the insurer approved"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
              <Field label="Reason (needed if rejected)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button loading={m.isPending} disabled={!(Number(amount) > 0)} onClick={() => m.mutate({ action: "APPROVE", amount, ...(reason.trim().length >= 3 ? { reason: reason.trim() } : {}) })}>The insurer approved</Button>
                <Button variant="secondary" disabled={reason.trim().length < 5} onClick={() => m.mutate({ action: "REJECT", reason: reason.trim() })}>The insurer rejected</Button>
              </div>
            </div>
          )}
          {claim.status === "REJECTED" && <Notice tone="warn">{`The insurer rejected the request${claim.closeReason ? `: ${claim.closeReason}` : ""}. The patient can pay himself or herself, or the request can be cancelled.`}</Notice>}
          {claim.status !== "REJECTED" && claim.status !== "DRAFT" && <hr className="border-slate-200" />}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Switch to self-pay (reason)"><Input value={selfWhy} onChange={(e) => setSelfWhy(e.target.value)} placeholder="e.g. The patient will pay himself or herself" /></Field>
            <ConfirmButton label="Patient will pay himself or herself" confirmLabel="Yes, switch to self-pay" variant="secondary" disabled={selfWhy.trim().length < 5} onConfirm={() => m.mutate({ action: "SELF_PAY", reason: selfWhy.trim() })} />
          </div>
          <ErrorNote error={m.error} />
        </div>
      ) : <p className="text-sm text-slate-500">The insurance team handles this step.</p>}
    </Card>
  );
}

const METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"] as const;
function DepositCard({ plan }: { plan: Plan }) {
  const { money, dateTime } = useMe();
  const [required, setRequired] = useState(plan.deposit.required ?? plan.deposit.suggested);
  const [t, setT] = useState<{ method: (typeof METHODS)[number]; amount: string; reference: string }>({ method: "UPI", amount: "", reference: "" });
  const [key, setKey] = useState(newKey);
  const [why, setWhy] = useState("");
  const refresh = useRefreshPlanned();
  const qc = useQueryClient();
  const setReq = useStep(plan.id, "deposit-required", "put");
  const check = useStep(plan.id, "financial-check");
  const waive = useStep(plan.id, "waive");
  const take = useMutation({
    mutationFn: () => api.post<Plan>(`/planned-admissions/${plan.id}/deposit`, { tenders: [{ method: t.method, amount: t.amount, ...(t.method !== "CASH" ? { reference: t.reference.trim() } : {}) }] }, key),
    onSuccess: (p) => { qc.setQueryData(["planned", plan.id], p); setT({ ...t, amount: "", reference: "" }); setKey(newKey()); refresh(plan.id); },
  });
  const active = plan.status === "DEPOSIT";
  return (
    <Card title="Deposit or approval" actions={plan.deposit.basis ? <Badge tone="green">{{ DEPOSIT_PAID: "Deposit paid", INSURANCE_APPROVED: "Insurer approved", WAIVED: "Waived", NOT_REQUIRED: "Not required" }[plan.deposit.basis] ?? plan.deposit.basis}</Badge> : undefined}>
      <div className="mb-3 grid gap-1 text-sm sm:grid-cols-3"><KV label="Asked">{plan.deposit.required === null ? "Not set yet" : money(plan.deposit.required)}</KV><KV label="Received">{money(plan.deposit.held)}</KV><KV label="Suggested">{money(plan.deposit.suggested)}</KV></div>
      {plan.deposit.items.length > 0 && <ul className="mb-3 text-sm text-slate-600">{plan.deposit.items.map((d) => <li key={d.id}>{`${d.receiptNumber}: ${money(d.amount)}, ${dateTime(d.receivedAt)}`}</li>)}</ul>}
      {plan.deposit.note && <p className="mb-3 text-sm text-slate-600">{`Note: ${plan.deposit.note}`}</p>}
      {active && plan.can.depositRequired && (
        <div className="mb-3 flex flex-wrap items-end gap-2"><Field label="Deposit to ask for"><Input inputMode="decimal" value={required} onChange={(e) => setRequired(e.target.value)} /></Field><Button variant="secondary" loading={setReq.isPending} disabled={required === "" || Number(required) < 0} onClick={() => setReq.mutate({ amount: required })}>Set the deposit</Button></div>
      )}
      {active && plan.can.takeDeposit && (
        <div className="mb-3 rounded-md border border-slate-200 p-3">
          <div className="mb-2 text-sm font-medium">Take the deposit</div>
          <div className={`grid gap-3 sm:items-end ${t.method === "CASH" ? "sm:grid-cols-[140px_140px_auto]" : "sm:grid-cols-[140px_140px_1fr_auto]"}`}>
            <Field label="Method"><Select value={t.method} onChange={(e) => setT({ ...t, method: e.target.value as typeof t.method })}>{METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ").toLowerCase()}</option>)}</Select></Field>
            <Field label="Amount"><Input inputMode="decimal" value={t.amount} onChange={(e) => setT({ ...t, amount: e.target.value })} /></Field>
            {t.method !== "CASH" && <Field label="Reference (transaction id)"><Input value={t.reference} onChange={(e) => setT({ ...t, reference: e.target.value })} /></Field>}
            <Button loading={take.isPending} disabled={!(Number(t.amount) > 0) || (t.method !== "CASH" && t.reference.trim().length < 4)} onClick={() => take.mutate()}>Take deposit</Button>
          </div>
          <ErrorNote error={take.error} />
        </div>
      )}
      {active && plan.can.depositRequired && plan.deposit.required !== null && <div className="mb-3"><Button variant="ghost" loading={check.isPending} onClick={() => check.mutate(undefined)}>Check again</Button><ErrorNote error={check.error} /></div>}
      {active && plan.can.waive && (
        <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
          <Field label="Waive the deposit (manager): reason"><Input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why the deposit is not needed" /></Field>
          <ConfirmButton label="Waive the deposit" confirmLabel="Yes, waive it" disabled={why.trim().length < 10} onConfirm={() => waive.mutate({ reason: why.trim() })} />
          <ErrorNote error={waive.error} />
        </div>
      )}
      {active && !plan.can.depositRequired && !plan.can.takeDeposit && !plan.can.waive && <p className="text-sm text-slate-500">Billing takes the deposit, or a manager approves a waiver.</p>}
      <ErrorNote error={setReq.error} />
    </Card>
  );
}

// ───────────────────────── bed and the day ─────────────────────────

function BedCard({ plan }: { plan: Plan }) {
  const { money, dateTime } = useMe();
  const [bedId, setBedId] = useState("");
  const [allWards, setAllWards] = useState(false);
  const all = useAvailableBeds();
  // The beds of the ward the patient asked for come first; the others are a tick away (the emergency ward's beds are never offered, and the server refuses them too).
  const notEmergency = all.data?.filter((b) => !plan.emergencyWardCode || b.wardCode !== plan.emergencyWardCode);
  const beds = { data: plan.ward && !allWards ? notEmergency?.filter((b) => b.label.startsWith(`${plan.ward!.name} · `)) : notEmergency };
  const m = useStep(plan.id, "bed");
  return (
    <Card title="Bed" actions={plan.bed ? <Badge tone="purple">{`Held: ${plan.bed.code}`}</Badge> : undefined}>
      {plan.bed ? <div className="mb-3 text-sm"><b>{`${plan.bed.ward} · ${plan.bed.room} · ${plan.bed.code}`}</b>{` at ${money(plan.bed.dailyRate)} a day, held since ${dateTime(plan.bed.allocatedAt)}. It stays reserved until the patient is admitted or the request ends.`}</div> : plan.ward ? <p className="mb-3 text-sm text-slate-600">{`Room category asked: ${plan.ward.name}.`}</p> : null}
      {plan.can.bed ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={plan.bed ? "Change to another bed" : "Hold a bed"}><Select value={bedId} onChange={(e) => setBedId(e.target.value)}><option value="">Choose an available bed…</option>{beds.data?.map((b) => <option key={b.id} value={b.id}>{`${b.label} · ${money(b.dailyRate)}/day`}</option>)}</Select></Field>
          <Button loading={m.isPending} disabled={!bedId} onClick={() => { m.mutate({ bedId }); setBedId(""); }}>{plan.bed ? "Change the bed" : "Hold this bed"}</Button>
          {plan.ward && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allWards} onChange={(e) => setAllWards(e.target.checked)} /> Show beds of other wards too</label>}
          {plan.ward && beds.data?.length === 0 && !allWards && <p className="w-full text-sm text-amber-800">{`No bed is free in ${plan.ward.name}. Tick the box to see other wards, or move the day.`}</p>}
          <ErrorNote error={m.error} />
        </div>
      ) : !plan.bed && <p className="text-sm text-slate-500">Bed management holds a bed once the money is cleared.</p>}
    </Card>
  );
}

function DayCard({ plan }: { plan: Plan }) {
  const { me, date } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const [d, setD] = useState(plan.proposedDate ?? "");
  const [why, setWhy] = useState("");
  const resched = useStep(plan.id, "reschedule");
  const admit = useStep(plan.id, "admit");
  return (
    <Card title="The day of admission" actions={plan.proposedDate ? <Badge tone="green">{date(plan.proposedDate)}</Badge> : undefined}>
      {plan.status === "READY" && plan.can.admit && (
        <div className="mb-3 space-y-2">
          <Notice tone="success">Everything is cleared and a bed is held. When the patient arrives, admit the patient here: the admission opens on the held bed and the nursing admission assessment goes to the nurses.</Notice>
          <ConfirmButton variant="primary" label="The patient has arrived: admit now" confirmLabel="Yes, admit the patient" loading={admit.isPending} onConfirm={() => admit.mutate(undefined)} />
          <ErrorNote error={admit.error} />
        </div>
      )}
      {plan.can.reschedule && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Move to another day"><Input type="date" min={todayIn(tz)} value={d} onChange={(e) => setD(e.target.value)} /></Field>
          <Field label="Reason"><Input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. Patient asked for next week" /></Field>
          <Button variant="secondary" loading={resched.isPending} disabled={!d || d === plan.proposedDate || why.trim().length < 3} onClick={() => resched.mutate({ proposedDate: d, reason: why.trim() })}>Move the day</Button>
          <ErrorNote error={resched.error} />
        </div>
      )}
      {!plan.can.reschedule && !plan.can.admit && <p className="text-sm text-slate-600">{plan.proposedDate ? `Planned for ${date(plan.proposedDate)}${plan.expectedStayDays ? `, about ${dayCount(plan.expectedStayDays)}` : ""}.` : "The day is not fixed yet."}</p>}
    </Card>
  );
}

function CancelBox({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const m = useStep(plan.id, "cancel");
  if (!plan.can.cancel) return null;
  if (!open) return <div className="text-right"><button type="button" className="text-sm text-slate-500 hover:text-red-700" onClick={() => setOpen(true)}>Cancel this request…</button></div>;
  return (
    <Card title="Cancel this request">
      <p className="mb-2 text-sm text-slate-600">{plan.bed ? "The held bed goes back to the available list. " : ""}{plan.deposit.held !== "0.00" ? "The deposit stays the patient's advance, to be given back or used from the patient's advance payments." : ""}</p>
      <Field label="Reason"><Input value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
      <ErrorNote error={m.error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <ConfirmButton label="Cancel the request" confirmLabel="Yes, cancel it" disabled={why.trim().length < 5} loading={m.isPending} onConfirm={() => m.mutate({ reason: why.trim(), kind: "CANCELLED" })} />
        {plan.can.noShow && <ConfirmButton label="The patient did not come" confirmLabel="Yes, record no-show" disabled={why.trim().length < 5} onConfirm={() => m.mutate({ reason: why.trim(), kind: "NO_SHOW" })} />}
        <Button variant="ghost" onClick={() => setOpen(false)}>Keep it</Button>
      </div>
    </Card>
  );
}

// ───────────────────────── the page ─────────────────────────

export default function PlannedDetail() {
  const { id } = useParams<{ id: string }>();
  const { date, dateTime } = useMe();
  const q = useQuery({ queryKey: ["planned", id], queryFn: () => api.get<Plan>(`/planned-admissions/${id}`), refetchInterval: 15_000 });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? new Error("Request not found")} />;
  const p = q.data;
  const finished = p.status === "ADMITTED" || p.status === "CLOSED";
  const moneyShown = !["ADVISED", "DOCTOR_REVIEW", "AWAITING_PATIENT", "DESK_REVIEW"].includes(p.status) || p.estimate.lines.length > 0;
  return (
    <Gate anyOf={["PLANNED_READ"]} feature="IPD_ENABLED">
      <RequestHeader plan={p} />
      <div className="mb-4 rounded-xl border border-slate-200 bg-white px-3 py-4 shadow-sm"><Stepper plan={p} /></div>
      {!finished && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900" role="status">
          <span><span className="font-semibold">{"Now with: "}</span>{p.waitingFor}</span>
          <span className="text-xs text-brand-700">{`here for ${waitedFor(p.updatedAt)}`}</span>
        </div>
      )}
      {p.status === "CLOSED" && p.close && <div className="mb-4"><Notice tone="warn">{`${CLOSE_LABEL[p.close.reason] ?? p.close.reason}${p.close.note ? `: ${p.close.note}` : ""}`}</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {p.status === "ADVISED" && p.can.consent && <ConsentStep plan={p} />}
          {p.status === "DOCTOR_REVIEW" && p.can.ask && <DoctorStep plan={p} />}
          {p.status === "AWAITING_PATIENT" && <WaitingStep plan={p} />}
          {p.status === "DESK_REVIEW" && p.can.verify && <VerifyStep plan={p} />}
          {p.status === "PREAUTH" && <PreauthStep plan={p} />}

          <Card title="Admission details">
            {(() => {
              const empty = <span className="italic text-slate-400">Not decided yet</span>;
              return (
                <div className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  <KV label="Admitting consultant">{`${p.consultant.name}${p.consultant.department ? ` (${p.consultant.department})` : ""}`}</KV>
                  <KV label="Diagnosis">{p.diagnosis ?? empty}</KV>
                  <KV label="Planned procedure">{p.plannedProcedure ?? empty}</KV>
                  <KV label="Proposed day">{p.proposedDate ? date(p.proposedDate) : empty}</KV>
                  <KV label="Expected stay">{p.expectedStayDays ? dayCount(p.expectedStayDays) : empty}</KV>
                  <KV label="Room category">{p.ward ? `${p.ward.name}${p.roomNote ? ` (${p.roomNote})` : ""}` : empty}</KV>
                </div>
              );
            })()}
            <figure className="mt-4 rounded-md border-l-4 border-brand-300 bg-slate-50 px-4 py-3">
              <figcaption className="text-xs font-medium uppercase tracking-wide text-slate-500">{p.source === "OPD_ADVISED" ? "Doctor's note" : "What the patient said"}</figcaption>
              <blockquote className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{p.details}</blockquote>
            </figure>
            {p.consent && <p className="mt-3 text-sm text-slate-600">{`Patient consent recorded${p.consent.by ? ` by ${p.consent.by}` : ""}, ${dateTime(p.consent.at)}${p.consent.note ? `: ${p.consent.note}` : ""}.`}</p>}
            {p.askNote && p.status !== "AWAITING_PATIENT" && <p className="mt-2 text-sm text-slate-600">{`The doctor asked: ${p.askMode ? ASK_LABEL[p.askMode] : ""}. ${p.askNote}`}</p>}
          </Card>

          {moneyShown && <EstimateCard key={`${p.estimate.total}-${p.estimate.lines.length}-${p.status}`} plan={p} />}
          {moneyShown && !["PREAUTH"].includes(p.status) && (p.status === "TARIFF_PAYER" || p.payer) && <PayerCard plan={p} />}
          {["PREAUTH", "DEPOSIT", "BED_ALLOCATION", "READY", "ADMITTED"].includes(p.status) && p.payer === "INSURED" && p.status !== "PREAUTH" && p.claim && <Card title="Insurer's pre-authorisation"><p className="text-sm">{`Claim ${p.claim.claimNumber}: ${p.claim.status.replace(/_/g, " ").toLowerCase()}${p.claim.preauthApproved ? `, approved ${p.claim.preauthApproved}` : ""}. `}<Link className="text-brand-700 hover:underline" href={`/claims?open=${p.claim.id}`}>Open the claim</Link></p></Card>}
          {["DEPOSIT", "BED_ALLOCATION", "READY", "ADMITTED"].includes(p.status) && <DepositCard key={`${p.deposit.held}-${p.deposit.required}-${p.status}`} plan={p} />}
          {["BED_ALLOCATION", "READY", "ADMITTED"].includes(p.status) && <BedCard plan={p} />}
          {["DESK_REVIEW", "TARIFF_PAYER", "PREAUTH", "DEPOSIT", "BED_ALLOCATION", "READY"].includes(p.status) && <DayCard plan={p} />}

          {p.admission && (
            <Card title="Admitted" actions={<Badge tone="green">{p.admission.admissionNumber}</Badge>}>
              <p className="text-sm">{`Admitted on ${dateTime(p.admission.admittedAt)}${p.bed ? ` in bed ${p.bed.code}` : ""}. The stay continues in the ordinary admission: charges, nursing, medicines and discharge.`}</p>
              <AssessmentCard admissionId={p.admission.id} planId={p.id} />
              <div className="mt-3"><Link className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700" href={`/ipd/${p.admission.id}`}>Open the admission</Link></div>
            </Card>
          )}
          <CancelBox plan={p} />
        </div>

        <div className="space-y-4">
          <Card title="What happened">
            <ol className="space-y-3 text-sm">
              {[...p.events].reverse().map((e, i) => (
                <li key={i} className="border-l-2 border-slate-200 pl-3">
                  <div className="font-medium">{e.action.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}</div>
                  {e.note && <div className="text-slate-600">{e.note}</div>}
                  <div className="text-xs text-slate-500">{dateTime(e.at)}{e.by ? ` · ${e.by}` : ""}</div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </Gate>
  );
}
