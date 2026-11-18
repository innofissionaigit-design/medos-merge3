"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, newKey } from "@/lib/api";
import { ageText, type AgeValue } from "@/lib/format";
import { useMe } from "@/lib/me";
import { PatientPicker, type PickedPatient } from "./pickers";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, Modal, Notice, Select, StatusBadge, Table, Td, Textarea } from "./ui";

export type Level = "RED" | "ORANGE" | "YELLOW" | "GREEN" | "BLUE";
export const LEVELS: Record<Level, { label: string; hint: string; chip: string; row: string }> = {
  RED: { label: "Red", hint: "immediate", chip: "bg-red-600 text-white", row: "border-l-4 border-red-600 bg-red-50" },
  ORANGE: { label: "Orange", hint: "very urgent", chip: "bg-orange-500 text-white", row: "border-l-4 border-orange-500 bg-orange-50" },
  YELLOW: { label: "Yellow", hint: "urgent", chip: "bg-yellow-300 text-slate-900", row: "border-l-4 border-yellow-400 bg-yellow-50" },
  GREEN: { label: "Green", hint: "less urgent", chip: "bg-green-600 text-white", row: "border-l-4 border-green-600" },
  BLUE: { label: "Blue", hint: "not urgent", chip: "bg-blue-600 text-white", row: "border-l-4 border-blue-500" },
};
const CONSCIOUSNESS = [["ALERT", "Alert"], ["VOICE", "Responds to voice"], ["PAIN", "Responds to pain only"], ["UNRESPONSIVE", "Unresponsive"]] as const;
const ARRIVAL = [["WALK_IN", "Walked in"], ["AMBULANCE", "Ambulance"], ["POLICE", "Brought by police"], ["REFERRED", "Referred from another hospital"], ["OTHER", "Other"]] as const;

export function TriageBadge({ level }: { level: Level | null }) {
  if (!level) return <Badge tone="amber">Not triaged</Badge>;
  const l = LEVELS[level];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${l.chip}`}>{l.label} · {l.hint}</span>;
}

interface PersonView { id: string; name: string; mrn: string | null; gender: string; age: AgeValue; bloodGroup: string | null; mobile: string | null; emergencyContactName: string | null; emergencyContactMobile: string | null }
export interface CaseRow {
  id: string; caseNumber: string; status: string; arrivalMode: string; chiefComplaint: string; broughtBy: string | null; arrivedAt: string; triageLevel: Level | null; needsTriage: boolean; doctorAccepted: boolean;
  doctorName: string; calledByMe: boolean; encounterId: string; patientId: string; disposition: "OT" | "ICU" | "DISCHARGE" | null; dispositionNote: string | null; dispositionAt: string | null; cancelReason: string | null;
  patient: PersonView | null; admission: { id: string; admissionNumber: string | null; bed: string | null } | null;
  /** The emergency bed the patient lies in now (none when the ward was full). */
  bed: { id: string; code: string; room: string; since: string } | null;
  bill: { open: string; billed: string; paid: string; due: string };
}
interface BillInvoice { id: string; invoiceNumber: string | null; status: string; kind: string; total: string; paidTotal: string; balanceDue: string; lines: { lineNo: number; description: string; quantity: string; unitPrice: string; lineTotal: string; source: string | null }[] }
interface Triage { id: string; level: Level; consciousness: string; airwayClear: boolean; breathingOk: boolean; circulationOk: boolean; painScore: number | null; complaint: string; note: string | null; triagedAt: string; triagedBy: string | null }
interface Note { id: string; kind: string; text: string; diagnosis: string | null; createdAt: string; author: string | null }
export interface CaseDetail extends Omit<CaseRow, "bill"> {
  triages: Triage[]; notes: Note[]; allergies: { allergen: string; severity: string; reaction: string | null }[];
  vitals: { type: string; value: string; unit: string; recordedAt: string; recordedBy: string | null }[] | null;
  tests: { total: number; issued: number; pending: number }; medicines: { prescribed: number; pendingAtPharmacy: number };
  bill: { invoices: BillInvoice[]; openTotal: string; billedTotal: string; paidTotal: string; dueTotal: string; hasOpenBill: boolean };
}
export const isOpen = (status: string): boolean => ["ARRIVED", "TRIAGED", "IN_TREATMENT"].includes(status);

export const useErCase = (id: string) => useQuery({ queryKey: ["er-case", id], queryFn: () => api.get<CaseDetail>(`/emergency/cases/${id}`), refetchInterval: 8_000 });
export function useRefreshEmergency() {
  const qc = useQueryClient();
  return () => { for (const k of ["er-case", "er-cases", "er-alerts", "er-beds", "order-requests", "notif-unread", "notif-list"]) void qc.invalidateQueries({ queryKey: [k] }); };
}

// ───────────────────────── the desk: register an arriving patient ─────────────────────────

interface Doc { id: string; name: string; specialty: string | null; department: string | null; emergencyDoctor: boolean; activeCases: number }
interface Candidate { patient: { id: string; mrn: string | null; firstName: string; lastName: string | null; gender: string; mobile: string | null }; severity: string }

/** Registers an arriving patient: find the patient or add a new one in a few fields, name the doctor to call and the complaint. The doctor and the emergency nurses are alerted at once. */
export function RegisterArrival({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const refresh = useRefreshEmergency();
  const [picked, setPicked] = useState<PickedPatient | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [nameUnknown, setNameUnknown] = useState(false);
  const [p, setP] = useState({ firstName: "", lastName: "", gender: "MALE", age: "", mobile: "", relativeName: "", relativeMobile: "" });
  const [doctorId, setDoctorId] = useState("");
  const [complaint, setComplaint] = useState("");
  const [mode, setMode] = useState("AMBULANCE");
  const [broughtBy, setBroughtBy] = useState("");
  const [bedId, setBedId] = useState("");
  const wardBeds = useQuery({ queryKey: ["er-beds"], queryFn: () => api.get<WardBeds>("/emergency/beds") });
  const created = useRef<string | null>(null); // a patient made in this form is not made again if the next step has to be retried
  const docs = useQuery({ queryKey: ["er-doctors"], queryFn: () => api.get<Doc[]>("/emergency/doctors") });
  const fee = useQuery({ queryKey: ["reg-fee-config"], queryFn: () => api.get<{ enabled: boolean; exemptReasons: string[] }>("/patients/registration-fee/config") });
  const doctor = doctorId || docs.data?.[0]?.id || "";

  const submit = useMutation({
    mutationFn: async (override?: string) => {
      let patientId = picked?.id ?? created.current;
      if (!patientId) {
        const reason = fee.data?.enabled ? (fee.data.exemptReasons.find((r) => r.toLowerCase() === "emergency") ?? fee.data.exemptReasons[0]) : undefined;
        const body = {
          firstName: nameUnknown ? "Unknown" : p.firstName.trim(), ...(nameUnknown ? { lastName: p.gender === "FEMALE" ? "Woman" : p.gender === "MALE" ? "Man" : "Patient" } : p.lastName.trim() ? { lastName: p.lastName.trim() } : {}),
          gender: p.gender, estimatedAgeYears: Number(p.age), ...(p.mobile.trim() ? { mobile: p.mobile.trim() } : {}),
          ...(p.relativeName.trim() ? { emergencyContactName: p.relativeName.trim() } : {}), ...(p.relativeMobile.trim() ? { emergencyContactMobile: p.relativeMobile.trim() } : {}),
          ...(reason ? { registration: { exemption: { reason } } } : {}), ...(override ? { duplicateOverride: { confirmedDistinct: true, reason: override } } : {}),
        };
        patientId = (await api.post<{ id: string }>("/patients", body, newKey())).id;
        created.current = patientId;
      }
      return api.post<{ id: string }>("/emergency/cases", { patientId, doctorId: doctor, chiefComplaint: complaint.trim(), arrivalMode: mode, ...(broughtBy.trim() ? { broughtBy: broughtBy.trim() } : {}), ...(bedId ? { bedId } : {}) }, newKey());
    },
    onSuccess: (c) => { refresh(); onClose(); router.push(`/emergency/${c.id}`); },
  });
  const duplicates = submit.error instanceof ApiError && submit.error.code === "DUPLICATE_PATIENT_SUSPECTED" ? ((submit.error.details as { candidates?: Candidate[] } | undefined)?.candidates ?? []) : null;
  const newOk = (nameUnknown || p.firstName.trim().length > 0) && p.age !== "" && Number(p.age) >= 0 && Number(p.age) <= 130;
  const ready = (picked || created.current || (isNew && newOk)) && doctor && complaint.trim().length >= 3;

  return (
    <Modal title="Register an emergency arrival" onClose={onClose} wide>
      <div className="space-y-4">
        {!isNew ? (
          <div className="space-y-2">
            <Field label="Patient" as="div"><PatientPicker value={picked} onPick={setPicked} autoFocus /></Field>
            {!picked && <p className="text-sm text-slate-600">Not in the system? <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setIsNew(true)}>Register a new patient quickly</button></p>}
          </div>
        ) : (
          <div className="space-y-2 rounded-md border border-slate-200 p-3">
            <div className="flex items-center justify-between"><p className="text-sm font-medium">New patient</p><button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => { setIsNew(false); submit.reset(); }}>Search for an existing patient instead</button></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={nameUnknown} onChange={(e) => setNameUnknown(e.target.checked)} /> The name is not known (unconscious, or nobody is with the patient). Fix it later on the patient record.</label>
            <div className="grid gap-2 sm:grid-cols-4">
              {!nameUnknown && <><Field label="First name"><Input value={p.firstName} onChange={(e) => setP({ ...p, firstName: e.target.value })} autoFocus /></Field><Field label="Last name"><Input value={p.lastName} onChange={(e) => setP({ ...p, lastName: e.target.value })} /></Field></>}
              <Field label="Sex"><Select value={p.gender} onChange={(e) => setP({ ...p, gender: e.target.value })}><option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other</option><option value="UNKNOWN">Not known</option></Select></Field>
              <Field label="Age (years, approximate)"><Input inputMode="numeric" value={p.age} onChange={(e) => setP({ ...p, age: e.target.value.replace(/\D/g, "").slice(0, 3) })} /></Field>
              <Field label="Mobile (optional)"><Input inputMode="tel" value={p.mobile} onChange={(e) => setP({ ...p, mobile: e.target.value })} /></Field>
              <Field label="Relative's name (optional)"><Input value={p.relativeName} onChange={(e) => setP({ ...p, relativeName: e.target.value })} /></Field>
              <Field label="Relative's mobile (optional)"><Input inputMode="tel" value={p.relativeMobile} onChange={(e) => setP({ ...p, relativeMobile: e.target.value })} /></Field>
            </div>
          </div>
        )}
        <Field label="What is wrong? (chief complaint)"><Textarea rows={2} value={complaint} onChange={(e) => setComplaint(e.target.value)} placeholder="For example: road accident, bleeding from the head" /></Field>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Doctor to call"><Select value={doctor} onChange={(e) => setDoctorId(e.target.value)}>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.name}{d.department ? ` — ${d.department}` : ""} ({d.activeCases} now)</option>)}</Select></Field>
          <Field label="How did the patient come?"><Select value={mode} onChange={(e) => setMode(e.target.value)}>{ARRIVAL.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Brought by (optional)"><Input value={broughtBy} onChange={(e) => setBroughtBy(e.target.value)} placeholder="Name or relation" /></Field>
          <Field label="Emergency bed"><Select aria-label="Emergency bed" value={bedId} onChange={(e) => setBedId(e.target.value)}><option value="">First free bed ({wardBeds.data?.ER.filter((b) => b.free).length ?? 0} free)</option>{wardBeds.data?.ER.filter((b) => b.free).map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</Select></Field>
        </div>
        {duplicates ? (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-medium text-amber-900">A patient like this is already registered. Is it the same person?</p>
            <ul className="space-y-1">{duplicates.map((d) => (
              <li key={d.patient.id} className="flex flex-wrap items-center justify-between gap-2"><span>{[d.patient.firstName, d.patient.lastName].filter(Boolean).join(" ")} · {d.patient.mrn} · {d.patient.gender.toLowerCase()}{d.patient.mobile ? ` · ${d.patient.mobile}` : ""}</span>
                <Button variant="secondary" onClick={() => { setPicked({ id: d.patient.id, name: [d.patient.firstName, d.patient.lastName].filter(Boolean).join(" "), mrn: d.patient.mrn }); setIsNew(false); submit.reset(); }}>Same person: use this record</Button></li>
            ))}</ul>
            <Button variant="ghost" loading={submit.isPending} onClick={() => submit.mutate("Emergency: confirmed a different person")}>A different person: register as new</Button>
          </div>
        ) : <ErrorNote error={submit.error} />}
        <p className="text-xs text-slate-500">The doctor and every emergency nurse are alerted at once, and the emergency bill is opened for the patient.</p>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!ready} loading={submit.isPending} onClick={() => submit.mutate(undefined)}>Register and call the doctor</Button></div>
      </div>
    </Modal>
  );
}

// ───────────────────────── the emergency ward's beds ─────────────────────────

export interface WardBed { id: string; code: string; room: string; ward: string; status: string; free: boolean; occupant: { caseId: string; caseNumber: string; triageLevel: Level | null; patientName: string | null } | null }
export interface WardBeds { ER: WardBed[]; OT: WardBed[]; ICU: WardBed[] }
export const useWardBeds = () => useQuery({ queryKey: ["er-beds"], queryFn: () => api.get<WardBeds>("/emergency/beds"), refetchInterval: 10_000 });

/** The emergency ward as a row of beds: who lies in each, in the colour of their triage, and which are free. */
export function WardMap() {
  const beds = useWardBeds();
  const ward = beds.data?.ER ?? [];
  if (ward.length === 0) return null;
  return (
    <Card title="Emergency ward beds" actions={<span className="text-sm text-slate-600">{ward.filter((b) => b.free).length} of {ward.length} free</span>}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="ward-map">
        {ward.map((b) => {
          const o = b.occupant;
          const tone = o ? (o.triageLevel ? LEVELS[o.triageLevel].row : "border-l-4 border-slate-400 bg-slate-50") : b.free ? "border border-green-200 bg-green-50" : "border border-slate-200 bg-slate-100";
          return (
            <div key={b.id} className={`rounded-md p-2 text-sm ${tone}`}>
              <div className="flex items-center justify-between"><span className="font-semibold">{b.code}</span><span className="text-[11px] text-slate-500">{o ? "in use" : b.free ? "free" : b.status.toLowerCase()}</span></div>
              {o ? <Link href={`/emergency/${o.caseId}`} className="mt-0.5 block truncate text-brand-700 hover:underline">{o.patientName ?? o.caseNumber}</Link> : <div className="mt-0.5 text-xs text-slate-500">&nbsp;</div>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Where the patient lies now. The emergency nurse or the desk can move the patient to another free bed, or give one when the ward was full. */
export function BedCard({ c, onChange }: { c: CaseDetail; onChange: () => void }) {
  const { can } = useMe();
  const beds = useWardBeds();
  const qc = useQueryClient();
  const [pick, setPick] = useState("");
  const move = useMutation({ mutationFn: () => api.post(`/emergency/cases/${c.id}/bed`, { bedId: pick }), onSuccess: () => { setPick(""); void qc.invalidateQueries({ queryKey: ["er-beds"] }); onChange(); } });
  const free = beds.data?.ER.filter((b) => b.free) ?? [];
  const mayMove = isOpen(c.status) && (can("ER_TRIAGE") || can("ER_REGISTER"));
  return (
    <Card title="Bed in the emergency ward">
      <p className="mb-2 text-sm">{c.bed ? <>Lying in <span className="font-semibold">{c.bed.code}</span> ({c.bed.room}).</> : isOpen(c.status) ? <span className="text-amber-800">No bed yet: the ward was full when the patient arrived.</span> : "The patient has left the emergency ward."}</p>
      {mayMove && (
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Move to bed" className="min-w-0 flex-1" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">{c.bed ? "Move to another bed…" : "Give a bed…"}</option>{free.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</Select>
          <Button disabled={!pick} loading={move.isPending} onClick={() => move.mutate()}>{c.bed ? "Move" : "Give bed"}</Button>
        </div>
      )}
      <ErrorNote error={move.error} />
    </Card>
  );
}

// ───────────────────────── the emergency nurse: the triage record ─────────────────────────

/** The emergency triage record. Every assessment is kept; a new one is added when the patient is looked at again. */
export function TriageCard({ c, onChange }: { c: CaseDetail; onChange: () => void }) {
  const { can, dateTime } = useMe();
  const open = isOpen(c.status);
  const [f, setF] = useState({ level: "" as Level | "", consciousness: "ALERT", airway: true, breathing: true, circulation: true, pain: "", complaint: "", note: "" });
  const save = useMutation({
    mutationFn: () => api.post(`/emergency/cases/${c.id}/triage`, {
      level: f.level, consciousness: f.consciousness, airwayClear: f.airway, breathingOk: f.breathing, circulationOk: f.circulation,
      ...(f.pain !== "" ? { painScore: Number(f.pain) } : {}), ...(f.complaint.trim() ? { complaint: f.complaint.trim() } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}),
    }),
    onSuccess: () => { setF({ ...f, level: "", pain: "", complaint: "", note: "" }); onChange(); },
  });
  return (
    <Card title="Emergency triage record" actions={<TriageBadge level={c.triageLevel} />}>
      {open && can("ER_TRIAGE") && (
        <form className="mb-4 space-y-3 rounded-md border border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); if (f.level) save.mutate(); }}>
          <div>
            <p className="mb-1 text-sm font-medium text-slate-700">How urgent is this patient?</p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Triage level">
              {(Object.keys(LEVELS) as Level[]).map((l) => (
                <button key={l} type="button" role="radio" aria-checked={f.level === l} onClick={() => setF({ ...f, level: l })}
                  className={`rounded-md border-2 px-3 py-1.5 text-sm font-semibold ${LEVELS[l].chip} ${f.level === l ? "border-slate-900 ring-2 ring-slate-400" : "border-transparent opacity-80 hover:opacity-100"}`}>{LEVELS[l].label} · {LEVELS[l].hint}</button>
              ))}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Consciousness"><Select value={f.consciousness} onChange={(e) => setF({ ...f, consciousness: e.target.value })}>{CONSCIOUSNESS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            <Field label="Pain (0 to 10)"><Input inputMode="numeric" value={f.pain} onChange={(e) => setF({ ...f, pain: e.target.value.replace(/\D/g, "").slice(0, 2) })} /></Field>
            <div className="space-y-1 text-sm"><p className="font-medium text-slate-700">Found normal?</p>
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.airway} onChange={(e) => setF({ ...f, airway: e.target.checked })} /> Airway clear</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.breathing} onChange={(e) => setF({ ...f, breathing: e.target.checked })} /> Breathing normal</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.circulation} onChange={(e) => setF({ ...f, circulation: e.target.checked })} /> Circulation good</label></div>
          </div>
          <Field label="Complaint at triage (optional)"><Input value={f.complaint} onChange={(e) => setF({ ...f, complaint: e.target.value })} placeholder={c.chiefComplaint} /></Field>
          <Field label="Nurse's note (optional)"><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <ErrorNote error={save.error} />
          <Button type="submit" disabled={!f.level || (Number(f.pain) > 10)} loading={save.isPending}>Save triage record</Button>
        </form>
      )}
      {c.triages.length === 0 ? <p className="text-sm text-slate-500">Not triaged yet.</p> : (
        <ul className="space-y-2">
          {c.triages.map((t, i) => (
            <li key={t.id} className="rounded border border-slate-100 p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2"><TriageBadge level={t.level} />{i === 0 && <Badge tone="blue">latest</Badge>}<span className="text-xs text-slate-500">{dateTime(t.triagedAt)}{t.triagedBy ? ` · ${t.triagedBy}` : ""}</span></div>
              <div className="mt-1 text-slate-700">{CONSCIOUSNESS.find(([v]) => v === t.consciousness)?.[1] ?? t.consciousness}{t.painScore !== null ? ` · pain ${t.painScore}/10` : ""} · airway {t.airwayClear ? "clear" : "at risk"} · breathing {t.breathingOk ? "normal" : "abnormal"} · circulation {t.circulationOk ? "good" : "poor"}</div>
              <div className="text-slate-600">{t.complaint}{t.note ? ` — ${t.note}` : ""}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ───────────────────────── the doctor: assessment notes ─────────────────────────

export function NotesCard({ c, onChange }: { c: CaseDetail; onChange: () => void }) {
  const { can, dateTime } = useMe();
  const [text, setText] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [kind, setKind] = useState("ASSESSMENT");
  const write = isOpen(c.status) && can("ER_TREAT") && c.calledByMe;
  const save = useMutation({
    mutationFn: () => api.post(`/emergency/cases/${c.id}/notes`, { kind, text: text.trim(), ...(diagnosis.trim() ? { diagnosis: diagnosis.trim() } : {}) }),
    onSuccess: () => { setText(""); setDiagnosis(""); setKind("PROGRESS"); onChange(); },
  });
  return (
    <Card title="Doctor's assessment and notes">
      {write && (
        <form className="mb-4 space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 3) save.mutate(); }}>
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="ASSESSMENT">Assessment</option><option value="PROGRESS">Progress note</option></Select></Field>
            <Field label="Working diagnosis (optional)" className="sm:col-span-3"><Input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} /></Field>
          </div>
          <Field label="Findings and plan"><Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What you found and what you are doing" /></Field>
          <ErrorNote error={save.error} />
          <Button type="submit" disabled={text.trim().length < 3} loading={save.isPending}>Save note</Button>
          <p className="text-xs text-slate-500">Notes are kept as written; add a new note to correct one.</p>
        </form>
      )}
      {c.notes.length === 0 ? <p className="text-sm text-slate-500">No notes yet.</p> : (
        <ul className="space-y-2">{c.notes.map((n) => (
          <li key={n.id} className="rounded border border-slate-100 p-2 text-sm">
            <div className="text-xs text-slate-500">{n.kind === "ASSESSMENT" ? "Assessment" : "Progress note"} · {dateTime(n.createdAt)}{n.author ? ` · ${n.author}` : ""}</div>
            {n.diagnosis && <div className="font-medium">Diagnosis: {n.diagnosis}</div>}
            <div className="whitespace-pre-wrap">{n.text}</div>
          </li>
        ))}</ul>
      )}
    </Card>
  );
}

// ───────────────────────── the bill ─────────────────────────

const METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"];
function PayModal({ invoice, onClose, onPaid }: { invoice: BillInvoice; onClose: () => void; onPaid: () => void }) {
  const { money } = useMe();
  const key = useRef(newKey());
  const due = Number(invoice.balanceDue);
  const [rows, setRows] = useState([{ method: "CASH", amount: invoice.balanceDue, reference: "" }]);
  const sum = rows.reduce((n, r) => n + Math.round(Number(r.amount || 0) * 100), 0);
  const pay = useMutation({
    mutationFn: () => api.post<{ receipt: { receiptNumber: string } }>(`/invoices/${invoice.id}/payments`, { payments: rows.filter((r) => Number(r.amount) > 0).map((r) => ({ method: r.method, amount: Number(r.amount).toFixed(2), ...(r.reference.trim() ? { reference: r.reference.trim() } : {}) })) }, key.current),
    onSuccess: onPaid,
  });
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Modal title={`Collect payment · ${invoice.invoiceNumber ?? "bill"}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm">Still to pay: <span className="font-semibold">{money(invoice.balanceDue)}</span></p>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <Select aria-label="Mode" className="col-span-4" value={r.method} onChange={(e) => set(i, { method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ").toLowerCase()}</option>)}</Select>
            <Input aria-label="Amount" className="col-span-3" inputMode="decimal" value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} />
            <Input aria-label="Reference" className="col-span-4" placeholder={r.method === "CASH" ? "—" : "Reference"} disabled={r.method === "CASH"} value={r.reference} onChange={(e) => set(i, { reference: e.target.value })} />
            {rows.length > 1 && <button className="col-span-1 text-slate-500 hover:text-red-700" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>}
          </div>
        ))}
        <div className="flex items-center justify-between text-sm"><Button variant="ghost" onClick={() => setRows([...rows, { method: "UPI", amount: "", reference: "" }])}>+ Split payment</Button><span className={sum === Math.round(due * 100) ? "text-green-700" : "text-slate-600"}>Entered {money(sum / 100)} of {money(invoice.balanceDue)}</span></div>
        <ErrorNote error={pay.error} />
        {pay.data && <Notice tone="success">Payment taken. Receipt {pay.data.receipt.receiptNumber}.</Notice>}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>{pay.data ? "Close" : "Cancel"}</Button>{!pay.data && <Button disabled={sum <= 0 || sum > Math.round(due * 100)} loading={pay.isPending} onClick={() => pay.mutate()}>Take payment</Button>}</div>
      </div>
    </Modal>
  );
}

/** The emergency bill: everything charged to the patient during the emergency. The desk adds a charge, issues the bill and takes the payment. */
export function BillCard({ c, onChange }: { c: CaseDetail; onChange: () => void }) {
  const { can, money } = useMe();
  const open = isOpen(c.status);
  const [paying, setPaying] = useState<BillInvoice | null>(null);
  const [f, setF] = useState({ serviceId: "", description: "", unitPrice: "", quantity: "1" });
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.page<{ id: string; name: string; price: string; category: string }>("/services", { pageSize: 100 }), enabled: can("ER_BILL") });
  const add = useMutation({
    mutationFn: () => api.post(`/emergency/cases/${c.id}/bill/charges`, f.serviceId ? { serviceId: f.serviceId, quantity: f.quantity } : { description: f.description.trim(), unitPrice: f.unitPrice, quantity: f.quantity }),
    onSuccess: () => { setF({ serviceId: "", description: "", unitPrice: "", quantity: "1" }); onChange(); },
  });
  const issue = useMutation({ mutationFn: () => api.post(`/emergency/cases/${c.id}/bill/issue`), onSuccess: onChange });
  const b = c.bill;
  return (
    <Card title="Emergency bill" actions={<span className="text-sm text-slate-600">Due now <span className={`font-semibold ${Number(b.dueTotal) > 0 ? "text-red-700" : "text-green-700"}`}>{money(b.dueTotal)}</span></span>}>
      <div className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className="rounded border border-slate-200 p-2"><div className="text-xs text-slate-500">Not issued yet</div><div className="font-semibold">{money(b.openTotal)}</div></div>
        <div className="rounded border border-slate-200 p-2"><div className="text-xs text-slate-500">Issued</div><div className="font-semibold">{money(b.billedTotal)}</div></div>
        <div className="rounded border border-slate-200 p-2"><div className="text-xs text-slate-500">Paid</div><div className="font-semibold">{money(b.paidTotal)}</div></div>
        <div className="rounded border border-slate-200 p-2"><div className="text-xs text-slate-500">Still due</div><div className="font-semibold">{money(b.dueTotal)}</div></div>
      </div>
      {b.invoices.length === 0 && <p className="text-sm text-slate-500">Nothing has been charged yet.</p>}
      <div className="space-y-3">
        {b.invoices.map((i) => (
          <div key={i.id} className="rounded border border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-sm">
              <span className="font-medium">{i.status === "DRAFT" ? "Open bill (not issued)" : `${i.kind === "PHARMACY" ? "Pharmacy bill" : "Bill"} ${i.invoiceNumber ?? ""}`} <StatusBadge value={i.status} /></span>
              <span className="flex items-center gap-2">
                <span className="font-semibold">{money(i.total)}</span>
                {i.status === "DRAFT" && can("ER_BILL") && i.lines.length > 0 && <ConfirmButton variant="secondary" label="Issue bill" confirmLabel="Yes, issue" loading={issue.isPending} onConfirm={() => issue.mutate()} />}
                {i.status !== "DRAFT" && Number(i.balanceDue) > 0 && can("PAYMENT_CREATE") && <Button onClick={() => setPaying(i)}>Collect {money(i.balanceDue)}</Button>}
              </span>
            </div>
            {i.lines.length > 0 && <Table head={["Item", "Qty", "Rate", "Amount"]}>{i.lines.map((l) => <tr key={l.lineNo}><Td>{l.description}</Td><Td>{l.quantity}</Td><Td>{money(l.unitPrice)}</Td><Td>{money(l.lineTotal)}</Td></tr>)}</Table>}
          </div>
        ))}
      </div>
      <ErrorNote error={issue.error} />
      {open && can("ER_BILL") && (
        <form className="mt-3 grid grid-cols-12 gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Select aria-label="Service" className="col-span-12 sm:col-span-4" value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: e.target.value })}><option value="">Other charge…</option>{services.data?.data.filter((s) => s.category !== "ROOM_BED").map((s) => <option key={s.id} value={s.id}>{s.name} · {money(s.price)}</option>)}</Select>
          {!f.serviceId && <><Input className="col-span-6 sm:col-span-4" placeholder="Description" aria-label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /><Input className="col-span-3 sm:col-span-2" placeholder="Rate" aria-label="Rate" inputMode="decimal" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} /></>}
          <Input className="col-span-3 sm:col-span-1" aria-label="Quantity" inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
          <Button type="submit" className="col-span-12 sm:col-span-1" loading={add.isPending} disabled={!f.serviceId && (!f.description.trim() || !f.unitPrice)}>Add</Button>
          <div className="col-span-12"><ErrorNote error={add.error} /></div>
        </form>
      )}
      {paying && <PayModal invoice={paying} onClose={() => setPaying(null)} onPaid={() => { onChange(); }} />}
    </Card>
  );
}

// ───────────────────────── the doctor's decision ─────────────────────────

interface BedRow { id: string; code: string; room: string; ward: string; free: boolean; dailyRate: string }

/** Where the patient goes: the operation theatre, the ICU, or home. A patient sent to the OT or ICU is admitted to that bed at once. */
export function DecisionCard({ c, onChange }: { c: CaseDetail; onChange: () => void }) {
  const { can, money, dateTime } = useMe();
  const [choice, setChoice] = useState<"OT" | "ICU" | "DISCHARGE" | null>(null);
  const [bedId, setBedId] = useState("");
  const [note, setNote] = useState("");
  const [icuDoctor, setIcuDoctor] = useState("");
  const key = useRef(newKey());
  const icuDocs = useQuery({ queryKey: ["er-icu-doctors"], queryFn: () => api.get<{ id: string; name: string; patients: number }[]>("/emergency/icu-doctors"), enabled: c.calledByMe && isOpen(c.status) });
  const beds = useQuery({ queryKey: ["er-beds"], queryFn: () => api.get<{ OT: BedRow[]; ICU: BedRow[] }>("/emergency/beds"), refetchInterval: 15_000 });
  const decide = useMutation({
    mutationFn: () => api.post(`/emergency/cases/${c.id}/decision`, { disposition: choice, ...(choice !== "DISCHARGE" ? { bedId } : {}), ...(choice === "ICU" && icuDoctor ? { consultantId: icuDoctor } : {}), note: note.trim() }, key.current),
    onSuccess: () => { onChange(); void beds.refetch(); },
    onError: () => { key.current = newKey(); },
  });
  if (!isOpen(c.status)) {
    return (
      <Card title="Decision">
        {c.status === "CANCELLED" ? <p className="text-sm">Cancelled: {c.cancelReason}</p> : (
          <div className="space-y-1 text-sm">
            <p><Badge tone={c.disposition === "DISCHARGE" ? "green" : "purple"}>{c.disposition === "OT" ? "Sent to the operation theatre" : c.disposition === "ICU" ? "Sent to the ICU" : "Sent home"}</Badge></p>
            <p className="text-slate-700">{c.dispositionNote}</p>
            <p className="text-xs text-slate-500">{dateTime(c.dispositionAt)}</p>
            {c.admission && <p>Admission <Link className="font-medium text-brand-700 hover:underline" href={`/ipd/${c.admission.id}`}>{c.admission.admissionNumber}</Link>{c.admission.bed ? ` · ${c.admission.bed}` : ""}</p>}
          </div>
        )}
      </Card>
    );
  }
  if (!can("ER_TREAT") || !c.calledByMe) return <Card title="Decision"><p className="text-sm text-slate-500">The doctor who was called ({c.doctorName}) decides where the patient goes: the operation theatre, the ICU, or home.</p></Card>;
  const list = choice === "OT" ? beds.data?.OT : choice === "ICU" ? beds.data?.ICU : undefined;
  const free = list?.filter((b) => b.free) ?? [];
  const label = { OT: "Operation theatre", ICU: "ICU", DISCHARGE: "Send home" } as const;
  return (
    <Card title="Decision: where does the patient go?">
      <div className="space-y-3">
        {(c.tests.pending > 0 || c.medicines.pendingAtPharmacy > 0) && <Notice tone="warn">{[c.tests.pending > 0 ? `${c.tests.pending} test(s) still waiting for a result` : "", c.medicines.pendingAtPharmacy > 0 ? `${c.medicines.pendingAtPharmacy} medicine(s) not yet given by the pharmacy` : ""].filter(Boolean).join(" · ")}. They stay on the patient's record after the move.</Notice>}
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Decision">
          {(["OT", "ICU", "DISCHARGE"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={choice === k} onClick={() => { setChoice(k); setBedId(""); decide.reset(); }}
              className={`rounded-md border-2 px-4 py-2 text-sm font-semibold ${choice === k ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-300 bg-white hover:bg-slate-50"}`}>{label[k]}{k !== "DISCHARGE" && beds.data ? <span className="ml-1 text-xs font-normal text-slate-500">({beds.data[k].filter((b) => b.free).length} of {beds.data[k].length} free)</span> : null}</button>
          ))}
        </div>
        {choice && choice !== "DISCHARGE" && (
          <Field label={choice === "OT" ? "Operating room" : "ICU bed"}>
            <Select value={bedId} onChange={(e) => setBedId(e.target.value)}><option value="">Choose…</option>{free.map((b) => <option key={b.id} value={b.id}>{b.room} · bed {b.code} · {money(b.dailyRate)}/day</option>)}</Select>
          </Field>
        )}
        {choice && choice !== "DISCHARGE" && free.length === 0 && <Notice tone="error">No free {choice === "OT" ? "operating room" : "ICU bed"} right now.</Notice>}
        {choice === "ICU" && (icuDocs.data?.length ?? 0) > 0 && (
          <Field label="ICU doctor who takes over"><Select value={icuDoctor} onChange={(e) => setIcuDoctor(e.target.value)}><option value="">Choose…</option>{icuDocs.data?.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.patients} in the ICU now)</option>)}</Select></Field>
        )}
        {choice && <Field label="Reason for the decision"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={choice === "DISCHARGE" ? "Treated, condition and advice" : "Why the patient needs this now"} /></Field>}
        <ErrorNote error={decide.error} />
        {choice && <ConfirmButton variant="primary" label={choice === "DISCHARGE" ? "Send the patient home" : `Send to the ${choice === "OT" ? "operation theatre" : "ICU"}`} confirmLabel="Yes, do it now" disabled={note.trim().length < 3 || (choice !== "DISCHARGE" && !bedId) || (choice === "ICU" && (icuDocs.data?.length ?? 0) > 0 && !icuDoctor)} loading={decide.isPending} onConfirm={() => decide.mutate()} />}
        <p className="text-xs text-slate-500">The patient is admitted to the bed on this same record: vitals, medicines and tests stay with the patient, and the ICU doctor and nurses see everything done here. The emergency bill is issued for payment at the emergency desk.</p>
      </div>
    </Card>
  );
}

/** Press to accept the patient when you are the doctor who was called. */
export function AcceptBanner({ c, onChange }: { c: CaseDetail; onChange: () => void }) {
  const { can } = useMe();
  const accept = useMutation({ mutationFn: () => api.post(`/emergency/cases/${c.id}/accept`), onSuccess: onChange });
  if (!isOpen(c.status) || c.doctorAccepted || !can("ER_TREAT") || !c.calledByMe) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border-2 border-red-600 bg-red-50 px-4 py-3">
      <p className="text-sm font-semibold text-red-800">You were called to this patient. Accept to start treatment.</p>
      <Button onClick={() => accept.mutate()} loading={accept.isPending}>Accept the patient</Button>
      <div className="w-full"><ErrorNote error={accept.error} /></div>
    </div>
  );
}

/** A registration made by mistake, before anything was done for the patient. */
export function CancelArrival({ c, onChange }: { c: CaseDetail; onChange: () => void }) {
  const { can } = useMe();
  const [reason, setReason] = useState("");
  const cancel = useMutation({ mutationFn: () => api.post(`/emergency/cases/${c.id}/cancel`, { reason: reason.trim() }), onSuccess: onChange });
  if (c.status !== "ARRIVED" || !can("ER_REGISTER")) return null;
  return (
    <Card title="Registered by mistake?">
      <div className="space-y-2">
        <p className="text-sm text-slate-600">Only possible before the nurse or doctor has done anything for the patient. The empty bill is cancelled.</p>
        <Input placeholder="Reason (at least 3 characters)" aria-label="Cancel reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorNote error={cancel.error} />
        <ConfirmButton label="Cancel this registration" confirmLabel="Yes, cancel it" disabled={reason.trim().length < 3} loading={cancel.isPending} onConfirm={() => cancel.mutate()} />
      </div>
    </Card>
  );
}

export const patientLine = (p: PersonView | null): string => (p ? `${p.mrn ?? "no MRN"} · ${p.gender.toLowerCase()}${ageText(p.age) ? `, ${ageText(p.age)}` : ""}` : "");
