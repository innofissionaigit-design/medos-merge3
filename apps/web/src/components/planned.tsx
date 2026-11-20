"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
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
  emergencyWardCode: string;
  bed: { id: string; code: string; ward: string; room: string; dailyRate: string; allocatedAt: string | null } | null;
  admission: { id: string; admissionNumber: string; admittedAt: string; status: string } | null;
  nursingAssessment: { status: string; completedAt: string | null; note: string | null; recorded?: { fallRisk: string; pressureRisk: string; nutritionRisk: string; painScore: number } } | null;
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
/** The seven steps of a planned admission as a small tracker: done, now, still to come. A closed request shows nothing. */
const STEP_NAMES = ["Doctor", "Admission desk", "Estimate and payer", "Deposit", "Bed", "On the day", "Admitted"] as const;
const STEP_OF: Record<string, number> = { ADVISED: 0, DOCTOR_REVIEW: 0, AWAITING_PATIENT: 0, DESK_REVIEW: 1, TARIFF_PAYER: 2, PREAUTH: 2, DEPOSIT: 3, BED_ALLOCATION: 4, READY: 5, ADMITTED: 6 };
export function StageDots({ status }: { status: string }) {
  const at = STEP_OF[status];
  if (at === undefined) return null;
  const finished = status === "ADMITTED";
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={finished ? "All steps done" : `Step ${at + 1} of ${STEP_NAMES.length}: ${STEP_NAMES[at]}`} title={finished ? "All steps done" : `Step ${at + 1} of ${STEP_NAMES.length}: ${STEP_NAMES[at]}`}>
      {STEP_NAMES.map((name, i) => <i key={name} className={clsx("h-1.5 w-4 rounded-full", finished || i < at ? "bg-brand-600" : i === at ? "bg-brand-300 ring-1 ring-brand-600" : "bg-slate-200")} />)}
    </span>
  );
}

/** A number of days in words: "1 day", "3 days". */
export const dayCount = (n: number): string => `${n} ${n === 1 ? "day" : "days"}`;

/** How long a request has been where it is, in plain words ("today", "1 day", "3 days"). */
export function waitedFor(updatedAt: string): string {
  const d = Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86_400_000));
  return d === 0 ? "today" : d === 1 ? "1 day" : `${d} days`;
}

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
  const states = stages.map((s) => {
    const idx = Math.min(...s.at.map((x) => order.indexOf(x)));
    return plan.status === "CLOSED" ? "closed" : plan.status === "ADMITTED" ? "done" : s.at.includes(plan.status) ? "now" : idx < here ? "done" : "later";
  });
  return (
    <ol className="flex overflow-x-auto pb-1" aria-label="Progress of the planned admission">
      {stages.map((s, i) => {
        const state = states[i]!;
        return (
          <li key={s.id} aria-current={state === "now" ? "step" : undefined} className="relative min-w-[4.5rem] flex-1 text-center">
            {i < stages.length - 1 && <span aria-hidden className={clsx("absolute left-1/2 top-3.5 h-0.5 w-full", state === "done" ? "bg-brand-600" : "bg-slate-200")} />}
            <span className={clsx("relative z-10 mx-auto flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ring-2",
              state === "done" && "bg-brand-600 text-white ring-brand-600",
              state === "now" && "bg-white text-brand-700 ring-brand-600 shadow-[0_0_0_4px_rgba(37,99,235,0.15)]",
              (state === "later" || state === "closed") && "bg-white text-slate-400 ring-slate-200")}>
              {state === "done" ? <span aria-hidden>&#10003;</span> : i + 1}
            </span>
            <span className={clsx("mt-1.5 block px-1 text-xs leading-tight", state === "now" ? "font-semibold text-slate-900" : state === "done" ? "text-slate-700" : "text-slate-400")}>
              {s.label}
              {state === "done" && <span className="sr-only"> (done)</span>}
              {state === "now" && <span className="sr-only"> (current step)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The patient and request at the top of a request: who it is for, how to reach them, and where the request stands. */
export function RequestHeader({ plan }: { plan: Plan }) {
  const initials = plan.patient.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  const age = plan.patient.dateOfBirth ? Math.floor((Date.now() - new Date(plan.patient.dateOfBirth).getTime()) / (365.25 * 86_400_000)) : null;
  const chips = [plan.patient.mrn ? `MRN ${plan.patient.mrn}` : null, plan.patient.gender ? plan.patient.gender.charAt(0) + plan.patient.gender.slice(1).toLowerCase() : null, age !== null && age >= 0 ? `${age} years` : null, plan.patient.mobile].filter((x): x is string => !!x);
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-base font-semibold text-brand-700 ring-1 ring-brand-200" aria-hidden>{initials}</span>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-900">{plan.patient.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
            {chips.map((c, i) => <span key={c} className="inline-flex items-center gap-2">{i > 0 && <i className="h-1 w-1 rounded-full bg-slate-300" aria-hidden />}{c}</span>)}
          </p>
          <p className="mt-1 text-xs text-slate-500">{`Request ${plan.requestNumber} · ${SOURCE_LABEL[plan.source]}`}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <PlanBadge status={plan.status} />
        <Link className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50" href="/planned">All requests</Link>
      </div>
    </header>
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
/** One of two choices shown as a card: the whole card is the radio, so it is easy to hit and easy to read. */
function ChoiceCard({ name, checked, onSelect, title, text }: { name: string; checked: boolean; onSelect: () => void; title: string; text: string }) {
  return (
    <label className={clsx("flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition", checked ? "border-brand-600 bg-brand-50 ring-1 ring-brand-600" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50")}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="mt-1 h-4 w-4 accent-brand-600" />
      <span className="min-w-0"><span className="block text-sm font-semibold text-slate-900">{title}</span><span className="mt-0.5 block text-sm text-slate-600">{text}</span></span>
    </label>
  );
}

/** A numbered section of the form: the number and heading say what is being asked, the hint says how. */
function FormStep({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-[1.75rem_1fr] gap-x-3">
      <span className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white" aria-hidden>{n}</span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {hint && <p className="mb-2 text-xs text-slate-500">{hint}</p>}
        {!hint && <div className="mb-2" />}
        {children}
      </div>
    </section>
  );
}

export function NewRequest({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const refresh = useRefreshPlanned();
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [source, setSource] = useState<"OUTSIDE_ARRANGED" | "OUTSIDE_DIRECT">("OUTSIDE_ARRANGED");
  const [doc, setDoc] = useState("");
  const [details, setDetails] = useState("");
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<{ id: string; displayName: string; userId?: string | null; specialty?: string | null }[]>("/practitioners") });
  const m = useMutation({ mutationFn: () => api.post<Plan>("/planned-admissions", { patientId: patient!.id, source, consultantId: doc, details: details.trim() }), onSuccess: (p) => { refresh(); router.push(`/planned/${p.id}`); } });
  const arranged = source === "OUTSIDE_ARRANGED";
  const chosen = docs.data?.find((d) => d.id === doc);
  const missing = [!patient && "choose the patient", !doc && "choose the consultant", details.trim().length < 5 && "add a few words about what the patient said"].filter((x): x is string => !!x);
  return (
    <Modal title="New planned admission request" onClose={onClose} wide>
      <p className="mb-4 -mt-1 text-sm text-slate-600">Record a patient who is to be admitted on a chosen day. A consultant reviews the request first; admission desk, billing, insurance and bed management follow.</p>
      <div className="grid gap-5">
        <FormStep n={1} title="Patient" hint="Search by name, MRN or mobile number (at least 2 characters).">
          <PatientPicker value={patient} onPick={setPatient} autoFocus />
        </FormStep>

        <FormStep n={2} title="How did the patient come?">
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">How did the patient come?</legend>
            <ChoiceCard name="source" checked={arranged} onSelect={() => setSource("OUTSIDE_ARRANGED")} title="Already arranged with a consultant of this hospital." text="The request goes to that doctor." />
            <ChoiceCard name="source" checked={!arranged} onSelect={() => setSource("OUTSIDE_DIRECT")} title="Came directly with an outside doctor's prescription and reports." text="A consultant assesses first; the outside doctor's advice is not an admission order." />
          </fieldset>
        </FormStep>

        <FormStep n={3} title={arranged ? "Consultant the patient arranged with" : "Consultant to assess the patient"} hint={arranged ? "This doctor receives the request and decides." : "Pick the doctor who should assess the patient and the outside papers."}>
          <Select aria-label={arranged ? "Consultant the patient arranged with" : "Consultant to assess the patient"} value={doc} onChange={(e) => setDoc(e.target.value)}>
            <option value="">Choose…</option>
            {docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}{d.specialty ? ` · ${d.specialty}` : ""}</option>)}
          </Select>
        </FormStep>

        <FormStep n={4} title={arranged ? "What the patient tells you" : "What the patient brought"} hint={arranged ? "Procedure, the arrangement made, and any reports he or she has." : "The outside doctor's advice, prescription and reports."}>
          <Textarea aria-label={arranged ? "What the patient tells you (procedure, arrangement, reports he or she has)" : "What the patient brought (outside doctor's advice, prescription, reports)"} rows={4} value={details} maxLength={2000} onChange={(e) => setDetails(e.target.value)} placeholder={arranged ? "e.g. Laparoscopic gallbladder surgery arranged with the doctor after the OPD visit; ultrasound report with the patient" : "e.g. Advised angioplasty by Dr. Rao at an outside hospital; angiography report and prescription brought"} />
          <div className="mt-1 text-right text-xs text-slate-400">{details.length}/2000</div>
        </FormStep>

        <ErrorNote error={m.error} />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <p className="min-w-0 flex-1 text-xs text-slate-500" aria-live="polite">
            {missing.length > 0 ? `To send: ${missing.join(", ")}.` : `The request will go to ${chosen?.displayName ?? "the doctor"} for review.`}
          </p>
          <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={missing.length > 0} onClick={() => m.mutate()}>Send to the doctor</Button></div>
        </div>
      </div>
    </Modal>
  );
}
