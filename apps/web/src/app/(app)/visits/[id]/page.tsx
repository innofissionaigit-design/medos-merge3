"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { Badge, Button, Card, ErrorNote, Field, Input, Notice, Select, Spinner, StatusBadge, Textarea } from "@/components/ui";
import { AmendModal, VersionHistory, type VersionRow } from "@/components/amend-consultation";
import { FollowUpCard } from "@/components/follow-up-extras";
import { VitalsCard } from "@/components/ipd-extras";
import { VisitLabResults } from "@/components/lab";
import { LimsVisitCard } from "@/components/lims-order";
import { AiAssist } from "@/components/ai";
import { AdmissionAdviceCard } from "@/components/planned";
import { VisitRadiology } from "@/components/radiology";
import { HandwrittenCard, InvestigationsPicker, RxPreview, ShareCard, StopMedicinesCard, TemplatesBar } from "@/components/prescription-extras";
import type { FillResult } from "@/components/scan-prescription";
import { blankItem, RxRows, toPayload, type RxItem } from "@/components/rx-editor";
import { api, ApiError, printUrl } from "@/lib/api";
import { ageText, type AgeValue } from "@/lib/format";
import { useMe } from "@/lib/me";
import { PrintLink } from "@/components/print-link";

interface Workspace {
  header: { patientId: string; mrn: string | null; name: string; gender: string; age: AgeValue; bloodGroup: string | null; encounterId: string; encounterNumber: string; visitStatus: string; startedAt: string; practitionerId: string | null; practitionerName: string | null; practitionerSpecialty: string | null; practitionerRegistrationNo: string | null; departmentName: string | null; consultedByVideo?: boolean };
  allergies: { id: string; allergen: string; severity: string; reaction: string | null }[];
  latestVitals: Record<string, { value: string; unit: string; recordedAt: string }>;
  previousVisits: { id: string; encounterNumber: string; startedAt: string; practitionerName: string | null; diagnoses?: { text: string }[]; summary?: string | null }[];
  consultation: Consultation;
}
interface Order { id: string; orderNumber: string | null; status: string; source?: string; items: RxItem[] }
interface Consultation {
  document: { id: string; status: string; version: number; currentVersion: number; content: Content; signedAt: string | null; signedByName: string | null; versions: VersionRow[] } | null;
  diagnoses: { id: string; text: string; code: string | null; type: string }[];
  prescription: { orders: Order[]; allergyWarnings: Warning[] } | null;
}
interface Content { chiefComplaint?: string; historyOfPresentIllness?: string; pastHistory?: string; otherTestsAdvised?: string[]; cardiologyAdvised?: string[]; proceduresAdvised?: string[]; examination?: string; advice?: string; dietAdvice?: string; referral?: string; investigationsAdvised?: string[]; followUp?: { afterDays?: number; date?: string; notes?: string } }
interface Warning { allergyId: string; allergen: string; severity: string; matchedItem: string }

export default function VisitPage() {
  const { id } = useParams<{ id: string }>();
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ["workspace", id], queryFn: () => api.get<Workspace>(`/encounters/${id}/workspace`) });
  const [note, setNote] = useState<Content>({});
  const [items, setItems] = useState<RxItem[]>([]);
  const [dx, setDx] = useState({ text: "", code: "", type: "PROVISIONAL" });
  const [amending, setAmending] = useState(false);
  const [ack, setAck] = useState<Warning[] | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  // Signing locks the record, so it is confirmed, but the confirmation stays on screen until the doctor answers (a timed-out confirm looked like a dead button).
  const [confirmSign, setConfirmSign] = useState(false);
  // The note and the prescription are saved separately, so each re-syncs from the server independently: saving one must not wipe unsaved edits to the other.
  const [synced, setSynced] = useState<{ note: string | null; rx: string | null }>({ note: null, rx: null });

  const c = ws.data?.consultation;
  const doc = c?.document;
  const signed = !!doc && doc.status !== "DRAFT";
  const orders = c?.prescription?.orders ?? [];
  const digital = orders.filter((o) => o.source !== "HANDWRITTEN");
  const rxOrder = digital.find((o) => o.status === "DRAFT") ?? digital.find((o) => o.status === "SIGNED");
  // The same list the handwritten prescription card shows (one shared request): with a picture uploaded, the doctor can sign straight away.
  const scans = useQuery({ queryKey: ["rx-scans", id], queryFn: () => api.get<{ pharmacy: { outcome: string | null } }[]>(`/encounters/${id}/prescription-scans`), enabled: can("CONSULTATION_READ") });
  const hasHandwritten = (scans.data ?? []).some((x) => x.pharmacy.outcome !== "REJECTED");

  useEffect(() => {
    if (!ws.data) return;
    if (synced.note !== id) setNote(doc?.content ?? {});
    if (synced.rx !== id) setItems(rxOrder?.items.map((i) => ({ ...i })) ?? []);
    if (synced.note !== id || synced.rx !== id) setSynced({ note: id, rx: id });
  }, [ws.data, id, synced, doc, rxOrder]);

  const reload = () => qc.invalidateQueries({ queryKey: ["workspace", id] });
  /**
   * Puts what the doctor approved in the handwritten-picture review onto this screen: medicines and tests are added to what is already here, advice is added
   * below it, and the diagnoses are recorded like any diagnosis added by hand. Nothing is saved or signed: the doctor checks it here, then saves and signs.
   */
  const fillFromScan = async (r: FillResult) => {
    const have = new Set((c?.diagnoses ?? []).map((d) => d.text.trim().toLowerCase()));
    for (const text of r.diagnoses) if (!have.has(text.toLowerCase())) { await api.post(`/encounters/${id}/diagnoses`, { text, type: "PROVISIONAL" }); have.add(text.toLowerCase()); }
    if (r.diagnoses.length > 0) await reload();
    const merge = (a: string[] | undefined, b: string[]): string[] => [...new Set([...(a ?? []), ...b])].slice(0, 20);
    const join = (a: string | undefined, b: string): string => [a?.trim(), b].filter(Boolean).join("\n");
    const inv = merge(note.investigationsAdvised, r.investigationsAdvised), img = merge(note.otherTestsAdvised, r.otherTestsAdvised), card = merge(note.cardiologyAdvised, r.cardiologyAdvised), proc = merge(note.proceduresAdvised, r.proceduresAdvised);
    setNote({
      ...note,
      ...(inv.length ? { investigationsAdvised: inv } : {}), ...(img.length ? { otherTestsAdvised: img } : {}), ...(card.length ? { cardiologyAdvised: card } : {}), ...(proc.length ? { proceduresAdvised: proc } : {}),
      ...(r.advice ? { advice: join(note.advice, r.advice) } : {}), ...(r.dietAdvice ? { dietAdvice: join(note.dietAdvice, r.dietAdvice) } : {}),
      ...(r.referral && !note.referral?.trim() ? { referral: r.referral } : {}),
      ...(r.followUpDays && !note.followUp?.afterDays && !note.followUp?.date ? { followUp: { ...note.followUp, afterDays: r.followUpDays } } : {}),
    });
    if (r.items.length > 0) setItems([...items.filter((i) => i.genericName.trim()), ...r.items]);
  };
  // Fetch the saved copy FIRST, then refill the boxes from it. Refilling from the copy loaded before the save would blank the text just typed.
  const resync = async (part: "note" | "rx" | "all") => { await reload(); setSynced((x) => ({ note: part === "rx" ? x.note : null, rx: part === "note" ? x.rx : null })); };

  const saveNote = useMutation({ mutationFn: () => api.put<{ version: number }>(`/encounters/${id}/consultation`, { content: clean(note), ...(doc ? { version: doc.version } : {}) }), onSuccess: () => resync("note") });
  const saveRx = useMutation({ mutationFn: () => api.put(`/encounters/${id}/prescription`, { items: items.filter((i) => i.genericName.trim()).map(toPayload) }), onSuccess: () => resync("rx") });
  const addDx = useMutation({
    mutationFn: () => api.post(`/encounters/${id}/diagnoses`, { text: dx.text, type: dx.type, ...(dx.code ? { code: dx.code } : {}) }),
    onSuccess: () => { setDx({ text: "", code: "", type: "PROVISIONAL" }); void reload(); },
  });
  const rmDx = useMutation({ mutationFn: (dxId: string) => api.post(`/diagnoses/${dxId}/remove`, { reason: "Removed by clinician" }), onSuccess: () => void reload() });
  const sign = useMutation({
    mutationFn: async (acknowledge: boolean) => {
      const saved = await api.put<{ version: number }>(`/encounters/${id}/consultation`, { content: clean(note), ...(doc ? { version: doc.version } : {}) });
      if (items.some((i) => i.genericName.trim())) await api.put(`/encounters/${id}/prescription`, { items: items.filter((i) => i.genericName.trim()).map(toPayload) });
      return api.post(`/encounters/${id}/consultation/sign`, { version: saved.version, ...(acknowledge ? { acknowledgeAllergyWarnings: true } : {}) });
    },
    onSuccess: () => { setAck(null); setAckChecked(false); resync("all"); },
    // The note is saved before the prescription and the signature, so a failure part-way leaves the server ahead of this page: refetch (without resetting what the doctor typed) so a retry carries the current note version.
    onError: (e) => { void reload(); if (e instanceof ApiError && e.code === "ALLERGY_CONFLICT") setAck(((e.details as { allergyWarnings?: Warning[] } | undefined)?.allergyWarnings) ?? []); },
  });

  // Keyboard shortcuts (set further down once the screen knows what the doctor may do); one listener for the life of the page.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const on = (e: KeyboardEvent): void => keys.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  if (ws.isLoading) return <Spinner />;
  if (ws.error || !ws.data) return <ErrorNote error={ws.error ?? new Error("Visit not found")} />;
  const h = ws.data.header;
  const canWrite = can("CONSULTATION_CREATE") && !signed && h.visitStatus === "ACTIVE";
  const rxWarnings = c?.prescription?.allergyWarnings ?? [];
  // Mirrors the server's signing rules so the doctor is told what is missing in plain words; the server still enforces them.
  const needComplaint = !note.chiefComplaint?.trim();
  const needDiagnosis = (c?.diagnoses.length ?? 0) === 0;
  const signBlocker = hasHandwritten ? null : needComplaint && needDiagnosis ? "Before you can sign: add the chief complaint and at least one diagnosis." : needComplaint ? "Before you can sign: add the chief complaint." : needDiagnosis ? "Before you can sign: add at least one diagnosis." : null;
  const hasMedicines = items.some((i) => i.genericName.trim());

  const vitalChips = Object.entries(ws.data.latestVitals).map(([k, v]) => `${k.replace(/_/g, " ").toLowerCase()} ${v.value} ${v.unit}`);
  const hasTests = [note.investigationsAdvised, note.otherTestsAdvised, note.cardiologyAdvised, note.proceduresAdvised].some((x) => (x?.length ?? 0) > 0);
  const canSign = canWrite && can("CONSULTATION_SIGN");
  const saving = saveNote.isPending || saveRx.isPending;
  // Saves the note and then the prescription, in that order, so neither overwrites the other's version.
  const saveAll = async (): Promise<void> => { await saveNote.mutateAsync(); if (items.some((i) => i.genericName.trim())) await saveRx.mutateAsync(); };
  // Signing while a draft save is still running would send the version from before that save, so the sign buttons and Ctrl/Cmd+Enter wait for the save.
  // Ctrl/Cmd+S saves the draft; Ctrl/Cmd+Enter starts signing (and confirms it when the question is already showing). Same for every doctor.
  keys.current = (e) => {
    if (!(e.metaKey || e.ctrlKey) || !canWrite) return;
    if (e.key.toLowerCase() === "s") { e.preventDefault(); if (!saving) void saveAll().catch(() => undefined); }
    else if (e.key === "Enter" && canSign && !signBlocker && !ack && !saving) { e.preventDefault(); if (confirmSign) { setConfirmSign(false); sign.mutate(false); } else setConfirmSign(true); }
  };

  const fold = (title: string, body: ReactNode, open = false) => (
    <details open={open} className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-slate-800">{title}</summary>
      <div className="space-y-4 border-t border-slate-100 p-3">{body}</div>
    </details>
  );
  const btn = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50";

  return (
    <Gate anyOf={["CONSULTATION_READ"]}>
      {/* Who, what they are allergic to and their latest vitals stay on screen while the doctor works: nothing to scroll back for. */}
      <div className="sticky top-0 z-20 -mx-4 mb-3 border-b border-slate-200 bg-white/95 px-4 py-2 backdrop-blur md:-mx-6 md:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-lg font-semibold text-slate-900">{h.name}</h1>
          <span className="text-sm text-slate-500">{`MRN ${h.mrn ?? "—"} · ${h.gender.toLowerCase()}${ageText(h.age) ? `, ${ageText(h.age)}` : ""}${h.bloodGroup ? ` · ${h.bloodGroup.replace("_POS", "+").replace("_NEG", "−")}` : ""} · ${h.encounterNumber} · ${dateTime(h.startedAt)}`}</span>
          {h.consultedByVideo && <Badge tone="blue">Consulted by video</Badge>}
          <StatusBadge value={signed ? "SIGNED" : h.visitStatus} />
          {signed && <span className="text-xs text-green-700">signed by {doc?.signedByName ?? "doctor"}, {dateTime(doc?.signedAt)}</span>}
          {signed && can("CONSULTATION_AMEND") && <Button className="ml-auto" variant="secondary" onClick={() => setAmending(true)}>Amend…</Button>}
        </div>
        {(ws.data.allergies.length > 0 || vitalChips.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            {ws.data.allergies.length > 0 && <span role="alert" className="flex flex-wrap items-center gap-1.5"><strong className="text-red-800">Allergies</strong>{ws.data.allergies.map((a) => <span key={a.id} className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 font-medium text-red-900">{a.allergen} ({a.severity.toLowerCase().replace("_", " ")})</span>)}</span>}
            {vitalChips.length > 0 && <span className="flex flex-wrap items-center gap-1.5"><strong className="text-slate-600">Vitals</strong>{vitalChips.map((v) => <span key={v} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">{v}</span>)}</span>}
          </div>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Card>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Chief complaints / symptoms"><Textarea autoFocus={canWrite} rows={2} disabled={!canWrite} value={note.chiefComplaint ?? ""} onChange={(e) => setNote({ ...note, chiefComplaint: e.target.value })} /></Field>
              <Field label="Medical history (present illness)"><Textarea rows={2} disabled={!canWrite} value={note.historyOfPresentIllness ?? ""} onChange={(e) => setNote({ ...note, historyOfPresentIllness: e.target.value })} /></Field>
              <Field label="Past medical history (illnesses, surgeries, current medicines)"><Textarea rows={2} disabled={!canWrite} value={note.pastHistory ?? ""} onChange={(e) => setNote({ ...note, pastHistory: e.target.value })} /></Field>
              <Field label="Examination"><Textarea rows={2} disabled={!canWrite} value={note.examination ?? ""} onChange={(e) => setNote({ ...note, examination: e.target.value })} /></Field>
            </div>

            <div className="mt-3 border-t border-slate-100 pt-3">
              <div className="mb-1.5 text-sm font-medium text-slate-700">Diagnosis</div>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {c?.diagnoses.map((d) => (
                  <span key={d.id} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-50 px-2.5 py-0.5 text-sm"><span className="font-medium">{d.text}</span><span className="text-xs text-slate-500">{d.code ? `${d.code} · ` : ""}{d.type.toLowerCase()}</span>
                    {canWrite && <button aria-label={`Remove ${d.text}`} className="text-slate-500 hover:text-red-700" onClick={() => rmDx.mutate(d.id)}>✕</button>}</span>
                ))}
                {c?.diagnoses.length === 0 && <span className="text-sm text-slate-500">No diagnosis recorded yet.</span>}
              </div>
              {canWrite && (
                <form className="grid grid-cols-[minmax(0,1fr)_96px_130px_auto] gap-2" onSubmit={(e) => { e.preventDefault(); if (dx.text.trim().length >= 2) addDx.mutate(); }}>
                  <Input placeholder="Diagnosis, then Enter" aria-label="Diagnosis" value={dx.text} onChange={(e) => setDx({ ...dx, text: e.target.value })} />
                  <Input placeholder="ICD code" aria-label="Code" value={dx.code} onChange={(e) => setDx({ ...dx, code: e.target.value })} />
                  <Select aria-label="Type" value={dx.type} onChange={(e) => setDx({ ...dx, type: e.target.value })}><option value="PROVISIONAL">Provisional</option><option value="FINAL">Final</option><option value="SECONDARY">Secondary</option></Select>
                  <Button type="submit" variant="secondary" loading={addDx.isPending}>Add</Button>
                  <div className="col-span-4"><ErrorNote error={addDx.error ?? rmDx.error} /></div>
                </form>
              )}
            </div>

            <div className="mt-3 border-t border-slate-100 pt-3">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium text-slate-700">Prescription</span>{rxOrder?.orderNumber && <Badge tone="gray">{rxOrder.orderNumber}</Badge>}</div>
              {rxWarnings.length > 0 && !signed && <div className="mb-2"><Notice tone="warn">Allergy alert: {rxWarnings.map((w) => `${w.matchedItem} matches ${w.allergen}`).join("; ")}</Notice></div>}
              {canWrite && (
                <details className="mb-2">
                  <summary className="cursor-pointer select-none text-sm text-brand-700">Use or save a template</summary>
                  <div className="mt-2"><TemplatesBar note={note} items={items} disabled={!canWrite} onApply={(parts, tplItems) => {
              setNote({ ...note, investigationsAdvised: [...new Set([...(note.investigationsAdvised ?? []), ...(parts.investigationsAdvised ?? [])])].slice(0, 20), ...(parts.advice ? { advice: [note.advice?.trim(), parts.advice].filter(Boolean).join("\n") } : {}), ...(parts.dietAdvice ? { dietAdvice: [note.dietAdvice?.trim(), parts.dietAdvice].filter(Boolean).join("\n") } : {}), ...(parts.referral && !note.referral?.trim() ? { referral: parts.referral } : {}) });
              setItems([...items.filter((i) => i.genericName.trim()), ...tplItems]);
            }} /></div>
                </details>
              )}
              <RxRows items={items} setItems={setItems} disabled={!canWrite} />
              {canWrite && <div className="mt-2"><Button variant="secondary" onClick={() => setItems([...items, blankItem()])}>Add medicine</Button></div>}
            </div>

            <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 md:grid-cols-2">
              <Field label="Doctor's advice and recommendations"><Textarea rows={2} disabled={!canWrite} value={note.advice ?? ""} onChange={(e) => setNote({ ...note, advice: e.target.value })} /></Field>
              <Field label="Diet advice"><Textarea rows={2} disabled={!canWrite} value={note.dietAdvice ?? ""} onChange={(e) => setNote({ ...note, dietAdvice: e.target.value })} /></Field>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_120px_150px_1fr]">
              <Field label="Referral (optional)"><Input disabled={!canWrite} placeholder="e.g. Cardiologist" value={note.referral ?? ""} onChange={(e) => setNote({ ...note, referral: e.target.value })} /></Field>
              <Field label="Follow up after (days)"><Input disabled={!canWrite} inputMode="numeric" value={note.followUp?.afterDays ?? ""} onChange={(e) => setNote({ ...note, followUp: { ...(note.followUp ?? {}), afterDays: e.target.value ? Number(e.target.value) : undefined } })} /></Field>
              <Field label="or on this date"><Input type="date" disabled={!canWrite} value={note.followUp?.date ?? ""} onChange={(e) => setNote({ ...note, followUp: { ...(note.followUp ?? {}), date: e.target.value || undefined } })} /></Field>
              <Field label="Follow-up instructions (optional)"><Input disabled={!canWrite} placeholder="e.g. Bring the blood test reports" value={note.followUp?.notes ?? ""} onChange={(e) => setNote({ ...note, followUp: { ...(note.followUp ?? {}), notes: e.target.value } })} /></Field>
            </div>
            <details open={hasTests} className="mt-3 border-t border-slate-100 pt-3">
              <summary className="cursor-pointer select-none text-sm font-medium text-slate-700">Tests and procedures{hasTests ? ` (${[note.investigationsAdvised, note.otherTestsAdvised, note.cardiologyAdvised, note.proceduresAdvised].reduce((n, x) => n + (x?.length ?? 0), 0)})` : ""}</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <Field label="Laboratory investigations" as="div"><InvestigationsPicker disabled={!canWrite} value={note.investigationsAdvised ?? []} onChange={(v) => setNote({ ...note, investigationsAdvised: v })} /></Field>
                <Field label="Radiology / imaging investigations" as="div"><InvestigationsPicker disabled={!canWrite} label="imaging test" example="Chest X-ray" value={note.otherTestsAdvised ?? []} onChange={(v) => setNote({ ...note, otherTestsAdvised: v })} /></Field>
                <Field label="Cardiology investigations" as="div"><InvestigationsPicker disabled={!canWrite} label="cardiology test" example="ECG" value={note.cardiologyAdvised ?? []} onChange={(v) => setNote({ ...note, cardiologyAdvised: v })} /></Field>
                <Field label="Other diagnostic procedures" as="div"><InvestigationsPicker disabled={!canWrite} label="procedure" example="Spirometry" value={note.proceduresAdvised ?? []} onChange={(v) => setNote({ ...note, proceduresAdvised: v })} /></Field>
              </div>
            </details>
          </Card>
          <AdmissionAdviceCard encounterId={id} open={h.visitStatus !== "CANCELLED"} />
          {signed && <Notice tone="success">This consultation is signed. Corrections are recorded as amendments and the original stays on file.{digital.some((o) => o.status === "SIGNED") ? " The prescription has been sent to the pharmacy." : ""}</Notice>}
          {signed && doc && <VersionHistory encounterId={id} versions={doc.versions ?? []} />}
        </div>

        {/* Context sits beside the note, not below it: earlier visits and results are read without scrolling away from what is being written. */}
        <aside className="space-y-3">
          <Card title="Previous visits">
            {ws.data.previousVisits.length === 0 ? <p className="text-sm text-slate-500">No earlier completed visits.</p> : (
              <ul className="space-y-2 text-sm">{ws.data.previousVisits.map((v) => <li key={v.id}><div className="font-medium"><Link className="text-brand-700 hover:underline" href={`/visits/${v.id}`}>{dateTime(v.startedAt)}</Link></div><div className="text-slate-500">{v.practitionerName}{v.diagnoses?.length ? ` · ${v.diagnoses.map((d) => d.text).join(", ")}` : ""}</div><PrintLink className="text-xs text-brand-700 hover:underline" href={printUrl(`prescriptions/${v.id}`)}>Prescription</PrintLink></li>)}</ul>
            )}
          </Card>
          <LimsVisitCard encounterId={id} visitType="OPD" active={h.visitStatus === "ACTIVE"} />
          <VisitLabResults encounterId={id} />
          <VisitRadiology encounterId={id} />
          {fold("Prescription preview", <RxPreview sheet={{
            patient: { name: h.name, mrn: h.mrn, ageGender: [h.gender.toLowerCase(), ageText(h.age)].filter(Boolean).join(", "), visit: `${h.encounterNumber} · ${dateTime(h.startedAt)}` },
            allergies: ws.data.allergies.map((x) => `${x.allergen} (${x.severity.toLowerCase().replace("_", " ")})`),
            vitals: Object.entries(ws.data.latestVitals).map(([k, v]) => `${k.replace(/_/g, " ").toLowerCase()} ${v.value} ${v.unit}`),
            doctor: { name: h.practitionerName, specialty: h.practitionerSpecialty, registrationNo: h.practitionerRegistrationNo, department: h.departmentName },
            complaint: note.chiefComplaint, history: note.historyOfPresentIllness, pastHistory: note.pastHistory, examination: note.examination,
            diagnoses: c?.diagnoses.map((d) => d.text) ?? [], items, note, followUpDays: note.followUp?.afterDays, followUpDate: note.followUp?.date, followUpNotes: note.followUp?.notes,
            signed, signedBy: doc?.signedByName,
          }} />)}
          {fold("Vitals: record or correct", <VitalsCard encounterId={id} open={h.visitStatus === "ACTIVE"} />)}
          {fold("More: follow-up booking, handwritten Rx, AI assist", <>
            <FollowUpCard encounterId={id} practitionerId={h.practitionerId} afterDays={note.followUp?.afterDays} visitStatus={h.visitStatus} />
            <HandwrittenCard encounterId={id} open={h.visitStatus !== "CANCELLED"} onFill={canWrite ? fillFromScan : undefined} />
            <AiAssist encounterId={id} />
            {signed && <ShareCard encounterId={id} />}
            {signed && <StopMedicinesCard orders={digital} canStop={can("PRESCRIPTION_SIGN")} onChanged={() => void reload()} />}
          </>)}
        </aside>
      </div>

      {/* The actions stay at the bottom of the screen: save, sign and print are always one click (or one key) away, never a scroll away. */}
      <div className="sticky bottom-0 z-20 -mx-4 mt-4 border-t border-slate-200 bg-white/95 px-4 py-2.5 backdrop-blur md:-mx-6 md:px-6">
        {canSign && ack && (
          <div className="mb-2 space-y-2">
            <Notice tone="warn">{ack.map((w) => `${w.matchedItem} matches the recorded allergy to ${w.allergen} (${w.severity.toLowerCase().replace("_", " ")})`).join("; ")}</Notice>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} /> I have reviewed the allergy warning and still want to sign.</label>
          </div>
        )}
        {canSign && confirmSign && !signBlocker && !ack && <div className="mb-2"><Notice tone="warn">{hasMedicines ? "Sign now? The note and prescription will be locked and the prescription will be sent to the pharmacy." : hasHandwritten ? "Sign now? The note will be locked. The pharmacy already has your handwritten prescription." : "Sign now? The note will be locked. No medicines are prescribed."}</Notice></div>}
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 text-xs text-slate-500">
            {canSign && signBlocker ? <span className="text-amber-800">{signBlocker}</span> : canWrite ? <span>Ctrl+S saves · Ctrl+Enter signs</span> : signed ? <span>Signed. Corrections are made as amendments.</span> : null}
            <ErrorNote error={saveNote.error ?? saveRx.error} />
            {!ack && <ErrorNote error={sign.error instanceof ApiError && sign.error.code === "ALLERGY_CONFLICT" ? null : sign.error} />}
          </div>
          {signed ? (
            <>
              <PrintLink className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700" href={printUrl(`prescriptions/${id}`)}>Print prescription</PrintLink>
              <a download className={btn} href={`${printUrl(`prescriptions/${id}`)}?format=pdf&download=1`}>PDF</a>
            </>
          ) : (
            <button type="button" disabled title="Sign the consultation to print the prescription." className="cursor-not-allowed rounded-md border border-slate-200 bg-slate-100 px-3 py-1.5 text-sm text-slate-500">Print prescription</button>
          )}
          {canWrite && <Button variant="secondary" loading={saving} onClick={() => void saveAll().catch(() => undefined)}>Save draft</Button>}
          {canSign && (ack ? (
            <><Button disabled={!ackChecked} loading={sign.isPending} onClick={() => sign.mutate(true)}>Sign with acknowledged warning</Button><Button variant="ghost" onClick={() => setAck(null)}>Go back and change</Button></>
          ) : confirmSign && !signBlocker ? (
            <><Button loading={sign.isPending} disabled={saving} onClick={() => { setConfirmSign(false); sign.mutate(false); }}>{hasMedicines ? "Yes, sign and send to pharmacy" : "Yes, sign"}</Button><Button variant="ghost" onClick={() => setConfirmSign(false)}>Cancel</Button></>
          ) : (
            <Button loading={sign.isPending} disabled={signBlocker !== null || saving} onClick={() => setConfirmSign(true)}>Sign consultation</Button>
          ))}
        </div>
      </div>
      {amending && doc && <AmendModal encounterId={id} currentVersion={doc.currentVersion} content={doc.content} diagnoses={c?.diagnoses ?? []} rxItems={(digital.find((o) => o.status === "SIGNED")?.items ?? []).filter((i) => i.status !== "STOPPED")} onClose={() => setAmending(false)} onDone={() => { setAmending(false); resync("all"); }} />}
    </Gate>
  );
}

function clean(c: Content): Content {
  const out: Content = {};
  for (const k of ["chiefComplaint", "historyOfPresentIllness", "pastHistory", "examination", "advice"] as const) { const v = c[k]?.trim(); if (v) out[k] = v; }
  for (const k of ["dietAdvice", "referral"] as const) { const v = c[k]?.trim(); if (v) out[k] = v; }
  if (c.investigationsAdvised?.length) out.investigationsAdvised = c.investigationsAdvised.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 20);
  if (c.cardiologyAdvised?.length) out.cardiologyAdvised = c.cardiologyAdvised.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 20);
  if (c.proceduresAdvised?.length) out.proceduresAdvised = c.proceduresAdvised.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 20);
  if (c.otherTestsAdvised?.length) out.otherTestsAdvised = c.otherTestsAdvised.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 20);
  const notes = c.followUp?.notes?.trim();
  if (c.followUp?.afterDays || c.followUp?.date || notes) out.followUp = { ...(c.followUp?.afterDays ? { afterDays: c.followUp.afterDays } : {}), ...(c.followUp?.date ? { date: c.followUp.date } : {}), ...(notes ? { notes } : {}) };
  return out;
}
