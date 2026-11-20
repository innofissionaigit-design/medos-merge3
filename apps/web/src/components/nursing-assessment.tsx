"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ErrorNote, Field, Input, Select, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { useRefreshPlanned } from "@/components/planned";

type Risk = "LOW" | "MEDIUM" | "HIGH";
interface Assessment {
  id: string; assessedAt: string; assessedByName: string | null; consciousness: string; mobility: string; painScore: number; allergyChecked: boolean; allergyNote: string | null;
  fallRisk: Risk; pressureRisk: Risk; nutritionRisk: Risk; dietNote: string | null; idBandChecked: boolean; consentChecked: boolean; belongingsNote: string | null; note: string | null;
}

const RISK_LABEL: Record<Risk, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };
const RISK_TONE: Record<Risk, "green" | "amber" | "red"> = { LOW: "green", MEDIUM: "amber", HIGH: "red" };
const CONSCIOUSNESS: Record<string, string> = { ALERT: "Alert", DROWSY: "Drowsy", CONFUSED: "Confused", UNRESPONSIVE: "Does not respond" };
const MOBILITY: Record<string, string> = { INDEPENDENT: "Walks alone", NEEDS_HELP: "Needs help to move", BEDBOUND: "Stays in bed" };

/** The nurse's admission assessment of one admission (docs/planned-admission.md): the form until it is recorded, then what was found. Saving it closes the nursing task. */
export function AssessmentCard({ admissionId, planId }: { admissionId: string; planId?: string }) {
  const { can, dateTime } = useMe();
  const q = useQuery({ queryKey: ["nursing-assessment", admissionId], queryFn: () => api.get<Assessment | null>(`/admissions/${admissionId}/nursing-assessment`) });
  if (q.isLoading) return null;
  if (q.data) return <Summary a={q.data} when={dateTime(q.data.assessedAt)} />;
  if (!can("NURSING_DOCUMENT")) return <p className="mt-2 text-sm">Nursing admission assessment: <Badge tone="amber">waiting for the nurse</Badge></p>;
  return <Form admissionId={admissionId} {...(planId ? { planId } : {})} />;
}

function Summary({ a, when }: { a: Assessment; when: string }) {
  const risk = (label: string, r: Risk) => <span className="inline-flex items-center gap-1">{label} <Badge tone={RISK_TONE[r]}>{RISK_LABEL[r]}</Badge></span>;
  const flagged = a.fallRisk === "HIGH" || a.pressureRisk === "HIGH" || a.nutritionRisk === "HIGH" || a.painScore >= 7;
  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3 text-sm" aria-label="Nursing admission assessment">
      <div className="mb-2 flex flex-wrap items-center gap-2"><b>Nursing admission assessment</b><Badge tone="green">done</Badge>{flagged && <Badge tone="red">needs attention</Badge>}<span className="text-xs text-slate-500">{`${a.assessedByName ?? "A nurse"}, ${when}`}</span></div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">{risk("Fall risk", a.fallRisk)}{risk("Pressure sore risk", a.pressureRisk)}{risk("Nutrition risk", a.nutritionRisk)}<span>{`Pain ${a.painScore}/10`}</span></div>
      <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <div><dt className="inline text-slate-500">Awareness: </dt><dd className="inline">{CONSCIOUSNESS[a.consciousness] ?? a.consciousness}</dd></div>
        <div><dt className="inline text-slate-500">Movement: </dt><dd className="inline">{MOBILITY[a.mobility] ?? a.mobility}</dd></div>
        <div><dt className="inline text-slate-500">Allergies: </dt><dd className="inline">{a.allergyChecked ? "None reported" : a.allergyNote}</dd></div>
        <div><dt className="inline text-slate-500">ID band and consent: </dt><dd className="inline">{a.idBandChecked && a.consentChecked ? "Checked" : `${a.idBandChecked ? "" : "ID band not checked. "}${a.consentChecked ? "" : "Consent not checked."}`}</dd></div>
        {a.dietNote && <div><dt className="inline text-slate-500">Diet: </dt><dd className="inline">{a.dietNote}</dd></div>}
        {a.belongingsNote && <div><dt className="inline text-slate-500">Belongings: </dt><dd className="inline">{a.belongingsNote}</dd></div>}
      </dl>
      {a.note && <p className="mt-2 rounded bg-slate-50 p-2"><b>Nurse's note:</b> {a.note}</p>}
    </div>
  );
}

function Form({ admissionId, planId }: { admissionId: string; planId?: string }) {
  const qc = useQueryClient();
  const refresh = useRefreshPlanned();
  const [f, setF] = useState({ consciousness: "ALERT", mobility: "INDEPENDENT", painScore: "0", noAllergy: true, allergyNote: "", fallRisk: "LOW", pressureRisk: "LOW", nutritionRisk: "LOW", dietNote: "", idBandChecked: false, consentChecked: false, belongingsNote: "", note: "" });
  const [err, setErr] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); setErr({}); };
  const needsNote = f.fallRisk === "HIGH" || f.pressureRisk === "HIGH" || f.nutritionRisk === "HIGH" || Number(f.painScore) >= 7;
  const save = useMutation({
    mutationFn: () => api.post<Assessment>(`/admissions/${admissionId}/nursing-assessment`, {
      consciousness: f.consciousness, mobility: f.mobility, painScore: Number(f.painScore), allergyChecked: f.noAllergy, ...(f.noAllergy ? {} : { allergyNote: f.allergyNote.trim() }),
      fallRisk: f.fallRisk, pressureRisk: f.pressureRisk, nutritionRisk: f.nutritionRisk, idBandChecked: f.idBandChecked, consentChecked: f.consentChecked,
      ...(f.dietNote.trim() ? { dietNote: f.dietNote.trim() } : {}), ...(f.belongingsNote.trim() ? { belongingsNote: f.belongingsNote.trim() } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}),
    }),
    onSuccess: (a) => { qc.setQueryData(["nursing-assessment", admissionId], a); void qc.invalidateQueries({ queryKey: ["nursing-worklist"] }); refresh(planId); },
  });
  const submit = () => {
    const e: Record<string, string> = {};
    if (!f.noAllergy && f.allergyNote.trim().length < 2) e.allergyNote = "Write the allergies, or tick no known allergies";
    if (needsNote && f.note.trim().length < 3) e.note = "A high risk or pain of 7 or more needs a note on what was done";
    setErr(e);
    if (Object.keys(e).length === 0) save.mutate();
  };
  const risk = (k: "fallRisk" | "pressureRisk" | "nutritionRisk", label: string) => (
    <Field label={label}><Select value={f[k]} onChange={(e) => set(k, e.target.value)}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></Select></Field>
  );
  return (
    <form className="mt-3 space-y-3 rounded-md border border-brand-200 bg-brand-50/40 p-3" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Nursing admission assessment form">
      <div><b className="text-sm">Nursing admission assessment</b><p className="text-xs text-slate-600">Fill this in when the patient reaches the ward. It cannot be edited afterwards; add a nursing note for anything new.</p></div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Awareness"><Select value={f.consciousness} onChange={(e) => set("consciousness", e.target.value)}>{Object.entries(CONSCIOUSNESS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Movement"><Select value={f.mobility} onChange={(e) => set("mobility", e.target.value)}>{Object.entries(MOBILITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Pain, 0 (none) to 10 (worst)"><Select value={f.painScore} onChange={(e) => set("painScore", e.target.value)}>{Array.from({ length: 11 }, (_, i) => <option key={i} value={String(i)}>{i}</option>)}</Select></Field>
        {risk("fallRisk", "Fall risk")}{risk("pressureRisk", "Pressure sore risk")}{risk("nutritionRisk", "Nutrition risk")}
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.noAllergy} onChange={(e) => set("noAllergy", e.target.checked)} /> Patient reports no known allergies</label>
      {!f.noAllergy && <Field label="Allergies reported" error={err.allergyNote}><Input value={f.allergyNote} onChange={(e) => set("allergyNote", e.target.value)} placeholder="Medicine, food or latex allergy and the reaction" /></Field>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Diet or fasting instruction (optional)"><Input value={f.dietNote} onChange={(e) => set("dietNote", e.target.value)} placeholder="Nil by mouth from midnight" /></Field>
        <Field label="Belongings and valuables (optional)"><Input value={f.belongingsNote} onChange={(e) => set("belongingsNote", e.target.value)} placeholder="Handed to the family" /></Field>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.idBandChecked} onChange={(e) => set("idBandChecked", e.target.checked)} /> ID band put on and checked</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.consentChecked} onChange={(e) => set("consentChecked", e.target.checked)} /> Admission consent form checked</label>
      </div>
      <Field label={needsNote ? "Nurse's note (needed: high risk or strong pain)" : "Nurse's note (optional)"} error={err.note}><Textarea rows={2} value={f.note} onChange={(e) => set("note", e.target.value)} placeholder={needsNote ? "What was done and who was told" : ""} /></Field>
      <ErrorNote error={save.error} />
      <div className="flex justify-end"><Button type="submit" loading={save.isPending}>Save assessment</Button></div>
    </form>
  );
}
