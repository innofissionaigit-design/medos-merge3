"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { PatientPicker, todayIn, type PickedPatient } from "@/components/pickers";
import { Badge, Button, ErrorNote, Field, Input, Modal, Notice, Select, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

export interface PlanRow { id: string; requestNumber: string; status: string; waitingFor: string; source: string; patient: { id: string; name: string; mrn: string | null }; consultant: { id: string; name: string }; diagnosis: string | null; plannedProcedure: string | null; proposedDate: string | null; expectedStayDays: number | null; ward: string | null; bed: string | null; closeReason: string | null; createdAt: string; updatedAt: string }
export interface PlanLine { lineNo: number; description: string; quantity: string; unitPrice: string; amount: string }
export interface Plan {
  id: string; requestNumber: string; status: string; waitingFor: string; source: "OPD_ADVISED" | "OUTSIDE_ARRANGED" | "OUTSIDE_DIRECT"; version: number;
  patient: { id: string; name: string; mrn: string | null; gender: string; mobile: string | null; dateOfBirth: string | null };
  consultant: { id: string; name: string; department: string | null };
  details: string; askMode: "CHAMBER" | "REPORTS" | "INVESTIGATIONS" | null; askNote: string | null;
  diagnosis: string | null; plannedProcedure: string | null; proposedDate: string | null; expectedStayDays: number | null; ward: { id: string; name: string } | null; roomNote: string | null; deskVerifiedAt: string | null;
  consent: { at: string; note: string | null; by: string | null } | null;
  payer: "SELF_PAY" | "INSURED" | null; preauthRequired: boolean; eligibilityNote: string | null;
  policy: { id: string; policyNumber: string; validTo: string | null; insurer: string } | null;
  claim: { id: string; claimNumber: string; status: string; preauthRequested: string | null; preauthApproved: string | null; closeReason: string | null } | null;
  estimate: { total: string; lines: PlanLine[]; suggestedBedLine: { description: string; quantity: string; unitPrice: string } | null };
  deposit: { required: string | null; held: string; basis: string | null; note: string | null; clearedAt: string | null; suggested: string; items: { id: string; receiptNumber: string; amount: string; receivedAt: string }[] };
  bed: { id: string; code: string; ward: string; room: string; dailyRate: string; allocatedAt: string | null } | null;
  admission: { id: string; admissionNumber: string; admittedAt: string; status: string } | null;
  nursingAssessment: { status: string; completedAt: string | null; note: string | null } | null;
  close: { reason: string; note: string | null; at: string | null } | null;
  events: { at: string; action: string; from: string | null; to: string; note: string | null; by: string | null }[];
  can: Record<"consent" | "ask" | "accept" | "patientReady" | "verify" | "reschedule" | "estimate" | "payerSelf" | "payerInsured" | "tariffDone" | "preauth" | "depositRequired" | "takeDeposit" | "waive" | "bed" | "admit" | "noShow" | "cancel", boolean>;
  createdAt: string; updatedAt: string;
}

export const SOURCE_LABEL: Record<string, string> = { OPD_ADVISED: "Advised by the OPD doctor", OUTSIDE_ARRANGED: "Arranged with a consultant", OUTSIDE_DIRECT: "Came with outside papers" };
export const STATUS_LABEL: Record<string, string> = {
  ADVISED: "Advised: asking the patient", DOCTOR_REVIEW: "With the doctor", AWAITING_PATIENT: "Waiting for the patient", DESK_REVIEW: "Admission desk", TARIFF_PAYER: "Billing and insurance", PREAUTH: "Insurer's approval",
  DEPOSIT: "Deposit", BED_ALLOCATION: "Bed", READY: "Ready for the day", ADMITTED: "Admitted", CLOSED: "Closed",
};
const TONE: Record<string, "gray" | "green" | "amber" | "red" | "blue" | "purple"> = { ADVISED: "amber", DOCTOR_REVIEW: "amber", AWAITING_PATIENT: "amber", DESK_REVIEW: "blue", TARIFF_PAYER: "blue", PREAUTH: "blue", DEPOSIT: "blue", BED_ALLOCATION: "purple", READY: "green", ADMITTED: "green", CLOSED: "gray" };
export const PlanBadge = ({ status }: { status: string }) => <Badge tone={TONE[status] ?? "gray"}>{STATUS_LABEL[status] ?? status}</Badge>;
export const CLOSE_LABEL: Record<string, string> = { PATIENT_DECLINED: "The patient did not want to be admitted", DOCTOR_DECLINED: "The doctor declined the admission", OTHER_TREATMENT: "The doctor recommended other treatment", CANCELLED: "Cancelled", NO_SHOW: "The patient did not come" };

/** Refreshes everything a planned-admission change can touch. */
export function useRefreshPlanned(): (planId?: string) => void {
  const qc = useQueryClient();
  return (planId) => { for (const k of ["planned-list", "planned-summary", "beds-available", "board", "notif-unread", "notif-list", "admissions", "planned-visit"]) void qc.invalidateQueries({ queryKey: [k] }); if (planId) void qc.invalidateQueries({ queryKey: ["planned", planId] }); };
}

/** The steps in order, for the strip at the top of a request. */
const STAGES: { id: string; label: string; at: string[] }[] = [
  { id: "request", label: "Request", at: ["ADVISED"] },
  { id: "doctor", label: "Doctor", at: ["DOCTOR_REVIEW", "AWAITING_PATIENT"] },
  { id: "desk", label: "Admission desk", at: ["DESK_REVIEW"] },
  { id: "tariff", label: "Estimate and payer", at: ["TARIFF_PAYER"] },
  { id: "preauth", label: "Insurer", at: ["PREAUTH"] },
  { id: "deposit", label: "Deposit", at: ["DEPOSIT"] },
  { id: "bed", label: "Bed", at: ["BED_ALLOCATION"] },
  { id: "ready", label: "On the day", at: ["READY"] },
  { id: "admitted", label: "Admitted", at: ["ADMITTED"] },
];
export function Stepper({ plan }: { plan: Plan }) {
  const order = ["ADVISED", "DOCTOR_REVIEW", "AWAITING_PATIENT", "DESK_REVIEW", "TARIFF_PAYER", "PREAUTH", "DEPOSIT", "BED_ALLOCATION", "READY", "ADMITTED"];
  const here = plan.status === "CLOSED" ? -1 : order.indexOf(plan.status);
  const skipInsurer = plan.payer !== "INSURED" || !plan.preauthRequired;
  const stages = STAGES.filter((s) => !(s.id === "preauth" && skipInsurer && plan.status !== "PREAUTH") && !(s.id === "request" && plan.source !== "OPD_ADVISED") && !(s.id === "doctor" && plan.source === "OPD_ADVISED"));
  return (
    <ol className="flex flex-wrap gap-1 text-xs" aria-label="Progress of the planned admission">
      {stages.map((s) => {
        const idx = Math.min(...s.at.map((x) => order.indexOf(x)));
        const state = plan.status === "CLOSED" ? "closed" : s.at.includes(plan.status) ? "now" : idx < here ? "done" : "later";
        return (
          <li key={s.id} aria-current={state === "now" ? "step" : undefined} className={clsx("rounded-full px-3 py-1 ring-1", state === "done" && "bg-green-50 text-green-800 ring-green-200", state === "now" && "bg-brand-600 font-medium text-white ring-brand-600", state === "later" && "bg-white text-slate-500 ring-slate-200", state === "closed" && "bg-slate-100 text-slate-400 ring-slate-200")}>
            {state === "done" ? "✓ " : ""}{s.label}
          </li>
        );
      })}
    </ol>
  );
}

/** The doctor's "needs admission" tick in a consultation (docs/planned-admission.md). Reception then asks the patient. */
export function AdmissionAdviceCard({ encounterId, open }: { encounterId: string; open: boolean }) {
  const { can, me } = useMe();
  const refresh = useRefreshPlanned();
  const mine = useQuery({ queryKey: ["planned-visit", encounterId], queryFn: () => api.get<PlanRow | null>(`/encounters/${encounterId}/planned-admission`), enabled: can("PLANNED_DOCTOR", "PLANNED_READ") });
  const [ticked, setTicked] = useState(false);
  const [f, setF] = useState({ details: "", diagnosis: "", plannedProcedure: "", proposedDate: "", expectedStayDays: "" });
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const send = useMutation({
    mutationFn: () => api.post<Plan>(`/encounters/${encounterId}/planned-admission`, { details: f.details.trim(), ...(f.diagnosis.trim() ? { diagnosis: f.diagnosis.trim() } : {}), ...(f.plannedProcedure.trim() ? { plannedProcedure: f.plannedProcedure.trim() } : {}), ...(f.proposedDate ? { proposedDate: f.proposedDate } : {}), ...(f.expectedStayDays ? { expectedStayDays: Number(f.expectedStayDays) } : {}) }),
    onSuccess: () => { setTicked(false); refresh(); },
  });
  const withdraw = useMutation({ mutationFn: (planId: string) => api.post(`/planned-admissions/${planId}/cancel`, { reason: "Doctor withdrew the admission advice" }), onSuccess: () => refresh() });
  if (!can("PLANNED_DOCTOR")) return null;
  const plan = mine.data && !["CLOSED", "ADMITTED"].includes(mine.data.status) ? mine.data : null;
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Admission advice">
      <h2 className="mb-2 text-sm font-semibold text-slate-800">Admission</h2>
      {plan ? (
        <div className="space-y-2 text-sm">
          <Notice tone="success">{`Admission advised. Request ${plan.requestNumber} is with ${plan.waitingFor.toLowerCase()}.`}</Notice>
          <div className="flex flex-wrap items-center gap-2"><PlanBadge status={plan.status} /><Link className="text-brand-700 hover:underline" href={`/planned/${plan.id}`}>Open the request</Link>
            {plan.status === "ADVISED" && open && <Button variant="ghost" loading={withdraw.isPending} onClick={() => withdraw.mutate(plan.id)}>Withdraw the advice</Button>}</div>
          <ErrorNote error={withdraw.error} />
        </div>
      ) : mine.data?.status === "ADMITTED" ? <Notice tone="success">{`This patient was admitted from request ${mine.data.requestNumber}.`}</Notice> : !open ? <p className="text-sm text-slate-500">The visit is closed.</p> : (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} /> This patient needs to be admitted</label>
          {ticked && (
            <div className="grid gap-3">
              <Field label="Why admission is needed"><Textarea rows={2} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} placeholder="e.g. Gallstones with repeated colic; surgery advised" /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Diagnosis (optional)"><Input value={f.diagnosis} onChange={(e) => setF({ ...f, diagnosis: e.target.value })} /></Field>
                <Field label="Planned procedure (optional)"><Input value={f.plannedProcedure} onChange={(e) => setF({ ...f, plannedProcedure: e.target.value })} /></Field>
                <Field label="Suggested day (optional)"><Input type="date" min={todayIn(tz)} value={f.proposedDate} onChange={(e) => setF({ ...f, proposedDate: e.target.value })} /></Field>
                <Field label="Expected stay in days (optional)"><Input inputMode="numeric" value={f.expectedStayDays} onChange={(e) => setF({ ...f, expectedStayDays: e.target.value.replace(/\D/g, "") })} /></Field>
              </div>
              <ErrorNote error={send.error} />
              <div className="flex items-center gap-2"><Button loading={send.isPending} disabled={f.details.trim().length < 3} onClick={() => send.mutate()}>Send to reception</Button><span className="text-xs text-slate-500">Reception will ask the patient and start the admission procedure.</span></div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Reception: a new request for a patient who comes from outside. */
export function NewRequest({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const refresh = useRefreshPlanned();
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [source, setSource] = useState<"OUTSIDE_ARRANGED" | "OUTSIDE_DIRECT">("OUTSIDE_ARRANGED");
  const [doc, setDoc] = useState("");
  const [details, setDetails] = useState("");
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<{ id: string; displayName: string; userId?: string | null; specialty?: string | null }[]>("/practitioners") });
  const m = useMutation({ mutationFn: () => api.post<Plan>("/planned-admissions", { patientId: patient!.id, source, consultantId: doc, details: details.trim() }), onSuccess: (p) => { refresh(); router.push(`/planned/${p.id}`); } });
  return (
    <Modal title="New planned admission request" onClose={onClose} wide>
      <div className="grid gap-3">
        <Field as="div" label="Patient"><PatientPicker value={patient} onPick={setPatient} autoFocus /></Field>
        <fieldset className="grid gap-2 text-sm">
          <legend className="mb-1 font-medium text-slate-700">How did the patient come?</legend>
          <label className="flex items-start gap-2"><input type="radio" name="source" checked={source === "OUTSIDE_ARRANGED"} onChange={() => setSource("OUTSIDE_ARRANGED")} /><span><b>Already arranged with a consultant of this hospital.</b> The request goes to that doctor.</span></label>
          <label className="flex items-start gap-2"><input type="radio" name="source" checked={source === "OUTSIDE_DIRECT"} onChange={() => setSource("OUTSIDE_DIRECT")} /><span><b>Came directly with an outside doctor's prescription and reports.</b> A consultant assesses first; the outside doctor's advice is not an admission order.</span></label>
        </fieldset>
        <Field label={source === "OUTSIDE_ARRANGED" ? "Consultant the patient arranged with" : "Consultant to assess the patient"}><Select value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">Choose…</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}{d.specialty ? ` · ${d.specialty}` : ""}</option>)}</Select></Field>
        <Field label={source === "OUTSIDE_ARRANGED" ? "What the patient tells you (procedure, arrangement, reports he or she has)" : "What the patient brought (outside doctor's advice, prescription, reports)"}><Textarea rows={4} value={details} onChange={(e) => setDetails(e.target.value)} /></Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!patient || !doc || details.trim().length < 5} onClick={() => m.mutate()}>Send to the doctor</Button></div>
      </div>
    </Modal>
  );
}
