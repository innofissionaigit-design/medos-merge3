"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { type AgeValue } from "@/lib/format";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Notice, Select, Table, Td, Textarea } from "./ui";

export interface IcuRow {
  id: string; admissionNumber: string; encounterId: string; bed: string | null; doctorName: string; calledByMe: boolean; inIcuSince: string; fromEmergency: string | null;
  patient: { id: string; name: string; mrn: string | null; gender: string; age: AgeValue };
  schedule: { intervalMinutes: number | null; nextDueAt: string | null; overdue: boolean; minutesLate: number; lastVitalsAt: string | null };
  latest: Record<string, { value: string; unit: string; at: string }>; openInstructions: number; urgentInstructions: number; pendingTests: number;
}
export const intervalText = (m: number | null): string => (m === null ? "not set" : m < 60 ? `every ${m} min` : m === 60 ? "every hour" : `every ${m / 60} hours`);
export const vital = (l: IcuRow["latest"], k: string): string => (l[k] ? `${Number(l[k].value)}` : "—");

interface Reading { at: string; by: string | null; phase: "ICU" | "BEFORE"; values: Record<string, { value: string; unit: string }> }
interface Instruction { id: string; text: string; urgent: boolean; status: "OPEN" | "DONE"; createdAt: string; createdBy: string | null; doneAt: string | null; doneBy: string | null; doneNote: string | null }
interface DayNote { id: string; text: string; plan: string | null; author: string | null; createdAt: string }
interface Day { day: string; dayNumber: number; notes: DayNote[]; vitals: { count: number; pulse: [number, number] | null; systolic: [number, number] | null; spo2: [number, number] | null }; instructionsGiven: number; instructionsDone: number; testsOrdered: number }
export interface IcuStay {
  id: string; admissionNumber: string; encounterId: string; reason: string | null; admittedAt: string; inIcuSince: string; bed: string | null; doctorName: string; calledByMe: boolean;
  patient: { id: string; name: string; mrn: string | null; gender: string; age: AgeValue; bloodGroup: string | null };
  schedule: { intervalMinutes: number | null; nextDueAt: string | null; overdue: boolean; minutesLate: number; lastVitalsAt: string | null; setBy: string | null; setAt: string | null; reason: string | null; history: { intervalMinutes: number; setAt: string; setBy: string | null; reason: string | null }[] };
  equipment: { id: string; name: string; pricePerDay: string; startedAt: string; startedBy: string | null; stoppedAt: string | null; stoppedBy: string | null; active: boolean }[];
  billing: { pendingTotal: string; items: { id: string; type: string; description: string; quantity: string; unitPrice: string; lineTotal: string; status: string; chargedAt: string; source: "BED" | "EQUIPMENT" | "TEST" | "MEDICINE" | "OTHER" }[] };
  latest: Record<string, { value: string; unit: string; at: string }>; readings: Reading[]; instructions: Instruction[]; days: Day[]; allergies: { allergen: string; severity: string; reaction: string | null }[]; tests: { total: number; pending: number };
  fromEmergency: null | { caseId: string | null; caseNumber: string; complaint: string; arrivedAt: string; arrivalMode: string; doctor: string; handoverNote: string | null; handedOverAt: string | null;
    triages: { level: string; consciousness: string; airwayClear: boolean; breathingOk: boolean; circulationOk: boolean; painScore: number | null; note: string | null; at: string; by: string | null }[]; notes: { kind: string; text: string; diagnosis: string | null; at: string; by: string | null }[] };
}

export const useIcuStay = (id: string) => useQuery({ queryKey: ["icu-stay", id], queryFn: () => api.get<IcuStay>(`/icu/stays/${id}`), refetchInterval: 8_000 });
export function useRefreshIcu() {
  const qc = useQueryClient();
  return () => { for (const k of ["icu-stay", "icu-stays", "icu-alerts", "notif-unread", "notif-list", "lims-visit"]) void qc.invalidateQueries({ queryKey: [k] }); };
}

const OPTIONS = [[5, "Every 5 minutes"], [15, "Every 15 minutes"], [60, "Every hour"], [120, "Every 2 hours"]] as const;
const COLS = [["PULSE", "HR"], ["SYSTOLIC_BP", "SBP"], ["DIASTOLIC_BP", "DBP"], ["SPO2", "SpO₂"], ["TEMPERATURE", "Temp"], ["RESPIRATORY_RATE", "RR"], ["BLOOD_GLUCOSE", "Glucose"]] as const;
const FIELDS = [["SYSTOLIC_BP", "BP systolic (mmHg)"], ["DIASTOLIC_BP", "BP diastolic (mmHg)"], ["PULSE", "Pulse (/min)"], ["SPO2", "SpO₂ (%)"], ["TEMPERATURE", "Temperature (°C)"], ["RESPIRATORY_RATE", "Resp. rate (/min)"], ["BLOOD_GLUCOSE", "Glucose (mg/dL)"]] as const;

/** How often vitals are taken. The ICU doctor picks 5, 15 minutes, 1 or 2 hours; everyone sees what is in force and when the next reading is due. */
export function ScheduleCard({ s, onChange }: { s: IcuStay; onChange: () => void }) {
  const { can, dateTime } = useMe();
  const [reason, setReason] = useState("");
  const set = useMutation({ mutationFn: (m: number) => api.post(`/icu/stays/${s.id}/vitals-schedule`, { intervalMinutes: m, ...(reason.trim().length >= 3 ? { reason: reason.trim() } : {}) }), onSuccess: () => { setReason(""); onChange(); } });
  const c = s.schedule;
  return (
    <Card title="How often vitals are taken" actions={c.intervalMinutes !== null ? <Badge tone={c.overdue ? "red" : "green"}>{intervalText(c.intervalMinutes)}</Badge> : <Badge tone="amber">not set</Badge>}>
      <div className="space-y-3">
        {c.intervalMinutes !== null && (
          <p className="text-sm">{c.overdue ? <span className="font-semibold text-red-700">Vitals are {c.minutesLate} min late.</span> : <>Next vitals due <span className="font-medium">{dateTime(c.nextDueAt)}</span>.</>} Last taken {c.lastVitalsAt ? dateTime(c.lastVitalsAt) : "not yet"}. Set by {c.setBy ?? "—"}{c.reason ? `: ${c.reason}` : ""}.</p>
        )}
        {c.intervalMinutes === null && <Notice tone="warn">The doctor has not said how often vitals are to be taken.</Notice>}
        {s.calledByMe && can("ICU_DOCTOR") && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Vitals interval">
              {OPTIONS.map(([m, l]) => <button key={m} type="button" role="radio" aria-checked={c.intervalMinutes === m} disabled={set.isPending} onClick={() => set.mutate(m)} className={`rounded-md border-2 px-3 py-1.5 text-sm font-semibold ${c.intervalMinutes === m ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-300 bg-white hover:bg-slate-50"}`}>{l}</button>)}
            </div>
            <Input aria-label="Reason for the interval" placeholder="Reason (optional), for example: unstable after intubation" value={reason} onChange={(e) => setReason(e.target.value)} />
            <ErrorNote error={set.error} />
          </div>
        )}
        {c.history.length > 1 && <details className="text-xs text-slate-600"><summary className="cursor-pointer">Earlier settings</summary><ul className="mt-1 space-y-0.5">{c.history.slice(1).map((h, i) => <li key={i}>{dateTime(h.setAt)}: {intervalText(h.intervalMinutes)} · {h.setBy}</li>)}</ul></details>}
      </div>
    </Card>
  );
}

/** The ICU nurse records the vitals here; they are the visit's ordinary readings, so the doctor sees them at once. Every reading stays with the name of who took it. */
export function IcuVitalsCard({ s, onChange }: { s: IcuStay; onChange: () => void }) {
  const { can, dateTime } = useMe();
  const [v, setV] = useState<Record<string, string>>({});
  const add = useMutation({
    mutationFn: () => api.post(`/encounters/${s.encounterId}/observations`, { observations: Object.entries(v).filter(([, x]) => x.trim() !== "").map(([type, x]) => ({ type, value: Number(x) })) }),
    onSuccess: () => { setV({}); onChange(); },
  });
  return (
    <Card title="Vitals" actions={s.schedule.lastVitalsAt ? <span className="text-xs text-slate-500">last {dateTime(s.schedule.lastVitalsAt)}</span> : undefined}>
      {can("ICU_NURSE") && can("VITALS_CREATE") && (
        <form className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          {FIELDS.map(([k, label]) => <Input key={k} inputMode="decimal" placeholder={label} aria-label={label.replace(/ \(.*/, "")} value={v[k] ?? ""} onChange={(e) => setV({ ...v, [k]: e.target.value })} />)}
          <Button type="submit" loading={add.isPending} disabled={!Object.values(v).some((x) => x.trim())}>Record vitals</Button>
          <div className="col-span-2 sm:col-span-4"><ErrorNote error={add.error} /></div>
        </form>
      )}
      {s.readings.length === 0 ? <p className="text-sm text-slate-500">No vitals recorded yet.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-left text-sm" data-testid="vitals-table">
          <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-2 py-1">When</th>{COLS.map(([, l]) => <th key={l} className="px-2 py-1">{l}</th>)}<th className="px-2 py-1">Taken by</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{s.readings.slice(0, 40).map((r, i) => (
            <tr key={i} className={r.phase === "BEFORE" ? "text-slate-500" : ""}>
              <td className="whitespace-nowrap px-2 py-1">{dateTime(r.at)}{r.phase === "BEFORE" && <span className="ml-1 text-xs">(before the ICU)</span>}</td>
              {COLS.map(([k]) => <td key={k} className="px-2 py-1">{r.values[k] ? Number(r.values[k].value) : "—"}</td>)}
              <td className="px-2 py-1">{r.by ?? "—"}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

/** The doctor's instructions for the nurse, and the nurse's record that each was done. */
export function InstructionsCard({ s, onChange }: { s: IcuStay; onChange: () => void }) {
  const { can, dateTime } = useMe();
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [doing, setDoing] = useState<{ id: string; note: string } | null>(null);
  const add = useMutation({ mutationFn: () => api.post(`/icu/stays/${s.id}/instructions`, { text: text.trim(), urgent }), onSuccess: () => { setText(""); setUrgent(false); onChange(); } });
  const done = useMutation({ mutationFn: (d: { id: string; note: string }) => api.post(`/icu/instructions/${d.id}/done`, d.note.trim() ? { note: d.note.trim() } : {}), onSuccess: () => { setDoing(null); onChange(); } });
  return (
    <Card title="Doctor's instructions for the nurse">
      {s.calledByMe && can("ICU_DOCTOR") && (
        <form className="mb-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 3) add.mutate(); }}>
          <Field label="New instruction"><Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: turn the patient two hourly, call me if urine output falls below 30 ml an hour" /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Urgent: shows as an alert to the nurse until it is done</label>
          <ErrorNote error={add.error} />
          <Button type="submit" disabled={text.trim().length < 3} loading={add.isPending}>Give the instruction</Button>
        </form>
      )}
      {s.instructions.length === 0 ? <p className="text-sm text-slate-500">No instructions yet.</p> : (
        <ul className="space-y-2">{s.instructions.map((i) => (
          <li key={i.id} className={`rounded border p-2 text-sm ${i.status === "OPEN" ? (i.urgent ? "border-amber-400 bg-amber-50" : "border-slate-200") : "border-slate-100 text-slate-500"}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">{i.urgent && <Badge tone="amber">urgent</Badge>}<Badge tone={i.status === "DONE" ? "green" : "blue"}>{i.status === "DONE" ? "done" : "to do"}</Badge>{dateTime(i.createdAt)} · {i.createdBy}</div>
            <div className={i.status === "OPEN" ? "font-medium text-slate-900" : ""}>{i.text}</div>
            {i.status === "DONE" && <div className="text-xs">Done {dateTime(i.doneAt)} by {i.doneBy}{i.doneNote ? `: ${i.doneNote}` : ""}</div>}
            {i.status === "OPEN" && can("ICU_NURSE") && (doing?.id === i.id ? (
              <div className="mt-2 flex flex-wrap items-center gap-2"><Input aria-label="Note (optional)" className="min-w-0 flex-1" placeholder="Note (optional)" value={doing.note} onChange={(e) => setDoing({ id: i.id, note: e.target.value })} /><Button loading={done.isPending} onClick={() => done.mutate(doing)}>Mark done</Button><Button variant="ghost" onClick={() => setDoing(null)}>Cancel</Button></div>
            ) : <div className="mt-1"><Button variant="secondary" onClick={() => setDoing({ id: i.id, note: "" })}>Mark done…</Button></div>)}
          </li>
        ))}</ul>
      )}
      <ErrorNote error={done.error} />
    </Card>
  );
}

const range = (r: [number, number] | null): string => (r ? (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`) : "—");

/** The doctor's day-by-day record: today's note at the top, each earlier day below with what happened (vitals taken, instructions, tests). */
export function DaysCard({ s, onChange }: { s: IcuStay; onChange: () => void }) {
  const { can, date, dateTime } = useMe();
  const [text, setText] = useState("");
  const [plan, setPlan] = useState("");
  const add = useMutation({ mutationFn: () => api.post(`/icu/stays/${s.id}/notes`, { text: text.trim(), ...(plan.trim().length >= 3 ? { plan: plan.trim() } : {}) }), onSuccess: () => { setText(""); setPlan(""); onChange(); } });
  return (
    <Card title="Day-by-day record">
      {s.calledByMe && can("ICU_DOCTOR") && (
        <form className="mb-4 space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 3) add.mutate(); }}>
          <Field label="Today's note"><Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="How the patient is, what was done, what changed" /></Field>
          <Field label="Plan for the next day (optional)"><Input value={plan} onChange={(e) => setPlan(e.target.value)} /></Field>
          <ErrorNote error={add.error} />
          <Button type="submit" disabled={text.trim().length < 3} loading={add.isPending}>Save today's note</Button>
          <p className="text-xs text-slate-500">Notes are kept as written; add another note to correct one.</p>
        </form>
      )}
      <div className="space-y-3">
        {s.days.map((d) => (
          <div key={d.day} className="rounded border border-slate-200 p-2 text-sm" data-testid="icu-day">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">Day {d.dayNumber} · {date(d.day)}</span>
              <span className="text-xs text-slate-500">{d.vitals.count} vitals set(s) · HR {range(d.vitals.pulse)} · SBP {range(d.vitals.systolic)} · SpO₂ {range(d.vitals.spo2)} · {d.instructionsGiven} instruction(s), {d.instructionsDone} done · {d.testsOrdered} test(s) ordered</span></div>
            {d.notes.length === 0 ? <p className="text-slate-500">No note for this day.</p> : d.notes.map((n) => (
              <div key={n.id} className="mt-1 border-l-2 border-brand-100 pl-2"><div className="text-xs text-slate-500">{dateTime(n.createdAt)} · {n.author}</div><div className="whitespace-pre-wrap">{n.text}</div>{n.plan && <div className="text-slate-600">Plan: {n.plan}</div>}</div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** What was done in the emergency ward, for the ICU team: the complaint, the triage record, the emergency doctor's notes and the handover reason. */
export function FromEmergencyCard({ e }: { e: NonNullable<IcuStay["fromEmergency"]> }) {
  const { dateTime } = useMe();
  return (
    <Card title={`Handed over from the emergency ward (${e.caseNumber})`}>
      <div className="space-y-2 text-sm">
        <p><span className="font-medium">Came in:</span> {dateTime(e.arrivedAt)}, {e.arrivalMode.replace("_", " ").toLowerCase()}. <span className="font-medium">Complaint:</span> {e.complaint}. <span className="font-medium">Emergency doctor:</span> {e.doctor}.</p>
        {e.handoverNote && <Notice tone="info">Handover: {e.handoverNote}</Notice>}
        {e.triages.length > 0 && <div><div className="text-xs font-semibold uppercase text-slate-500">Triage</div>{e.triages.map((t, i) => <div key={i}>{t.level.toLowerCase()} · {t.consciousness.toLowerCase()}{t.painScore !== null ? ` · pain ${t.painScore}/10` : ""} · airway {t.airwayClear ? "clear" : "at risk"}, breathing {t.breathingOk ? "normal" : "abnormal"}, circulation {t.circulationOk ? "good" : "poor"}{t.note ? ` — ${t.note}` : ""} <span className="text-xs text-slate-500">({dateTime(t.at)}, {t.by})</span></div>)}</div>}
        {e.notes.length > 0 && <div><div className="text-xs font-semibold uppercase text-slate-500">Emergency doctor's notes</div>{e.notes.map((n, i) => <div key={i} className="mt-1 border-l-2 border-slate-200 pl-2">{n.diagnosis && <div className="font-medium">Diagnosis: {n.diagnosis}</div>}<div className="whitespace-pre-wrap">{n.text}</div><div className="text-xs text-slate-500">{dateTime(n.at)} · {n.by}</div></div>)}</div>}
      </div>
    </Card>
  );
}

/** Equipment in use on the patient (ventilator, monitor, pumps) from the price list. The nurse or the doctor starts and stops each; every day it is in use is charged. */
export function EquipmentCard({ s, onChange }: { s: IcuStay; onChange: () => void }) {
  const { can, dateTime, money } = useMe();
  const [pick, setPick] = useState("");
  const catalogue = useQuery({ queryKey: ["icu-equipment"], queryFn: () => api.get<{ id: string; name: string; pricePerDay: string }[]>("/icu/equipment") });
  const start = useMutation({ mutationFn: () => api.post(`/icu/stays/${s.id}/equipment`, { serviceId: pick }), onSuccess: () => { setPick(""); onChange(); } });
  const stop = useMutation({ mutationFn: (id: string) => api.post(`/icu/equipment/${id}/stop`), onSuccess: onChange });
  const mayHandle = can("ICU_NURSE") || (s.calledByMe && can("ICU_DOCTOR"));
  const inUse = new Set(s.equipment.filter((e) => e.active).map((e) => e.name));
  return (
    <Card title="Equipment in use" actions={<Badge tone="blue">{`${inUse.size} in use`}</Badge>}>
      {mayHandle && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select aria-label="Equipment" className="min-w-0 flex-1" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Start equipment…</option>
            {catalogue.data?.filter((c) => !inUse.has(c.name)).map((c) => <option key={c.id} value={c.id}>{`${c.name} · ${money(c.pricePerDay)} a day`}</option>)}
          </Select>
          <Button disabled={!pick} loading={start.isPending} onClick={() => start.mutate()}>Start</Button>
        </div>
      )}
      <ErrorNote error={start.error ?? stop.error} />
      <Table head={["Equipment", "Per day", "Started", "Stopped", ""]} {...(s.equipment.length === 0 ? { empty: "No equipment in use." } : {})}>
        {s.equipment.map((e) => (
          <tr key={e.id}>
            <Td>{e.name}</Td>
            <Td>{money(e.pricePerDay)}</Td>
            <Td>{dateTime(e.startedAt)}<div className="text-xs text-slate-500">{e.startedBy}</div></Td>
            <Td>{e.stoppedAt ? <>{dateTime(e.stoppedAt)}<div className="text-xs text-slate-500">{e.stoppedBy}</div></> : <Badge tone="green">in use</Badge>}</Td>
            <Td>{e.active && mayHandle && <Button variant="secondary" loading={stop.isPending && stop.variables === e.id} onClick={() => stop.mutate(e.id)}>Stop</Button>}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

const SOURCE_LABEL: Record<string, string> = { BED: "ICU bed", EQUIPMENT: "Equipment", TEST: "Test", MEDICINE: "Medicine", OTHER: "Other" };

/** Everything charged to this stay so far: the ICU bed for each day, equipment for each day in use, tests, medicines and charges added by hand. It is paid with the final bill at discharge. */
export function IcuBillingCard({ s, onChange }: { s: IcuStay; onChange: () => void }) {
  const { can, dateTime, money } = useMe();
  const [serviceId, setServiceId] = useState("");
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.page<{ id: string; name: string; price: string; category: string }>("/services", { pageSize: 100 }), enabled: can("CHARGE_CREATE") });
  const add = useMutation({ mutationFn: () => api.post(`/admissions/${s.id}/charges`, { type: "SERVICE", serviceId, quantity: 1 }), onSuccess: () => { setServiceId(""); onChange(); } });
  const total = (src: string) => s.billing.items.filter((c) => c.source === src).reduce((n, c) => n + Math.round(Number(c.lineTotal) * 100), 0) / 100;
  return (
    <Card title="Billing for this stay" actions={<span className="text-sm text-slate-600">{`Waiting to be billed ${money(s.billing.pendingTotal)}`}</span>}>
      <div className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" data-testid="icu-billing-totals">
        {(["BED", "EQUIPMENT", "TEST", "MEDICINE"] as const).map((k) => <div key={k} className="rounded border border-slate-200 p-2"><div className="text-xs text-slate-500">{SOURCE_LABEL[k]}</div><div className="font-semibold">{money(total(k))}</div></div>)}
      </div>
      {can("CHARGE_CREATE") && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select aria-label="Charge" className="min-w-0 flex-1" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Add a procedure or service…</option>
            {services.data?.data.filter((x) => !["ROOM_BED", "INVESTIGATION", "CONSULTATION"].includes(x.category)).map((x) => <option key={x.id} value={x.id}>{`${x.name} · ${money(x.price)}`}</option>)}
          </Select>
          <Button disabled={!serviceId} loading={add.isPending} onClick={() => add.mutate()}>Add to the bill</Button>
        </div>
      )}
      <ErrorNote error={add.error} />
      <Table head={["When", "Charge", "Type", "Amount"]} {...(s.billing.items.length === 0 ? { empty: "Nothing charged yet." } : {})}>
        {s.billing.items.map((c) => <tr key={c.id}><Td>{dateTime(c.chargedAt)}</Td><Td>{c.description}</Td><Td>{SOURCE_LABEL[c.source]}</Td><Td>{money(c.lineTotal)}</Td></tr>)}
      </Table>
      <p className="mt-2 text-xs text-slate-500">The bed and the equipment are charged for every calendar day, the first day from the moment the patient arrives. Tests are added when the report is issued and medicines when the pharmacy gives them.</p>
    </Card>
  );
}
