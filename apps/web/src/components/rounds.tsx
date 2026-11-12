"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, Notice, Select, Spinner, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

export interface Slot { id: string; label: string; time: string; time12: string; minutesOfDay: number; practitionerId: string | null; doctor: string | null; forAllDoctors: boolean; status: "ACTIVE" | "INACTIVE" }
export interface RoundRow { id: string; slotId: string; label: string; scheduledAt: string; status: "NOTIFIED" | "STARTED" | "COMPLETED" | "MISSED"; startedAt: string | null; completedAt: string | null; patientsSeen: number | null; patientsTotal: number | null; doctor?: string | null; seenNow?: number }
export interface MyRounds { doctor: string; today: string; timezone: string; admittedPatients: number; timings: (Slot & { scheduledAt: string; round: string | null })[]; rounds: RoundRow[] }

export const ROUND_TONE = { NOTIFIED: "amber", STARTED: "blue", COMPLETED: "green", MISSED: "red" } as const;
export const ROUND_WORD = { NOTIFIED: "due now", STARTED: "in progress", COMPLETED: "finished", MISSED: "not started in time" } as const;

/** The doctor's round times, set by the ward coordinator: what the doctor's profile shows. */
export function MyRoundTimes() {
  const { dateTime } = useMe();
  const q = useQuery({ queryKey: ["rounds-mine"], queryFn: () => api.get<MyRounds>("/rounds/mine"), refetchInterval: 30_000 });
  return (
    <Card title="My round times" actions={q.data ? <Badge tone="gray">{`${q.data.admittedPatients} admitted patient${q.data.admittedPatients === 1 ? "" : "s"}`}</Badge> : undefined}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : (
        <>
          <p className="mb-3 text-sm text-slate-600">The ward coordinator sets these times. When a time comes you are told and can start the round.</p>
          {q.data!.timings.length === 0 ? <p className="text-sm text-slate-500">No round times are set.</p> : (
            <ul className="space-y-2 text-sm">
              {q.data!.timings.map((s) => {
                const r = q.data!.rounds.find((x) => x.id === s.round);
                return (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                    <span><b className="text-base">{s.time12}</b> <span className="text-slate-600">{s.label}{s.forAllDoctors ? "" : " (only for you)"}</span></span>
                    {r ? <span className="flex items-center gap-2"><Badge tone={ROUND_TONE[r.status]}>{ROUND_WORD[r.status]}</Badge>{r.status !== "COMPLETED" && <Link className="text-brand-700 hover:underline" href={`/rounds/${r.id}`}>{r.status === "STARTED" ? "Continue" : "Start the round"}</Link>}{r.status === "COMPLETED" && <span className="text-xs text-slate-500">{`${r.patientsSeen ?? 0} of ${r.patientsTotal ?? 0} seen, ${dateTime(r.completedAt)}`}</span>}</span>
                      : <span className="text-xs text-slate-500">{new Date(s.scheduledAt).getTime() > Date.now() ? "later today" : "no patients to see at this time"}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/** The ward coordinator sets the times of the doctors' rounds. */
export function RoundTimesEditor() {
  const qc = useQueryClient();
  const { can } = useMe();
  const slots = useQuery({ queryKey: ["round-slots"], queryFn: () => api.get<Slot[]>("/rounds/slots") });
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<{ id: string; displayName: string }[]>("/practitioners"), enabled: can("ROUND_MANAGE") });
  const [f, setF] = useState({ time: "", label: "", practitionerId: "" });
  const [edit, setEdit] = useState<{ id: string; time: string } | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["round-slots"] }); void qc.invalidateQueries({ queryKey: ["ward-board"] }); void qc.invalidateQueries({ queryKey: ["rounds-mine"] }); };
  const add = useMutation({ mutationFn: () => api.post("/rounds/slots", { time: f.time, ...(f.label.trim() ? { label: f.label.trim() } : {}), ...(f.practitionerId ? { practitionerId: f.practitionerId } : {}) }), onSuccess: () => { setF({ time: "", label: "", practitionerId: "" }); refresh(); } });
  const change = useMutation({ mutationFn: (v: { id: string; body: Record<string, unknown> }) => api.patch(`/rounds/slots/${v.id}`, v.body), onSuccess: () => { setEdit(null); refresh(); } });
  const manage = can("ROUND_MANAGE");
  return (
    <Card title="Doctors' round times" actions={<Badge tone="gray">Set here, shown in each doctor's profile</Badge>}>
      {slots.isLoading ? <Spinner /> : (
        <ul className="mb-3 space-y-2 text-sm">
          {slots.data?.map((s) => (
            <li key={s.id} className={clsx("flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2", s.status === "ACTIVE" ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 text-slate-400")}>
              <span>
                {edit?.id === s.id ? <Input type="time" aria-label="New time" className="inline-block w-32" value={edit.time} onChange={(e) => setEdit({ id: s.id, time: e.target.value })} /> : <b className="text-base">{s.time12}</b>}
                <span className="ml-2">{s.label}</span>
                <span className="ml-2 text-xs text-slate-500">{s.forAllDoctors ? "all doctors" : s.doctor}</span>
              </span>
              {manage && (
                <span className="flex items-center gap-2">
                  {edit?.id === s.id ? <><Button variant="secondary" loading={change.isPending} disabled={!edit.time} onClick={() => change.mutate({ id: s.id, body: { time: edit.time } })}>Save the time</Button><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></>
                    : <><Button variant="ghost" onClick={() => setEdit({ id: s.id, time: s.time })}>Change time</Button>{s.status === "ACTIVE" ? <ConfirmButton label="Switch off" confirmLabel="Yes, switch off" variant="secondary" onConfirm={() => change.mutate({ id: s.id, body: { status: "INACTIVE" } })} /> : <Button variant="ghost" onClick={() => change.mutate({ id: s.id, body: { status: "ACTIVE" } })}>Switch on</Button>}</>}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={change.error} />
      {manage && (
        <form className="grid gap-2 sm:grid-cols-[130px_1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (f.time) add.mutate(); }}>
          <Field label="New round at"><Input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
          <Field label="Name (optional)"><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. Evening round" /></Field>
          <Field label="For"><Select value={f.practitionerId} onChange={(e) => setF({ ...f, practitionerId: e.target.value })}><option value="">All doctors</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select></Field>
          <Button type="submit" loading={add.isPending} disabled={!f.time}>Add round time</Button>
        </form>
      )}
      <ErrorNote error={add.error} />
    </Card>
  );
}

export interface PatientSnap {
  admissionId: string; admissionNumber: string; patientName: string; gender: string; mrn: string | null; bed: string | null; ward: string | null; reason: string | null; admittedAt: string; seenThisRound: boolean;
  vitals: { at: string | null; bp: string | null; pulse: string | null; temperature: string | null; spo2: string | null; late: boolean };
  medicines: { active: number; names: string[]; withoutSchedule: number; dueNow: number; overdue: number; givenLast24h: number };
  tasks: { pending: number; overdue: number }; tests: { open: number; resultsLast24h: number }; procedures: number;
  lastNote: { at: string; condition: string | null; note: string; plan: string | null } | null; charges: { pendingCount: number; pendingTotal: string };
}

/** What is going on with one patient, in one glance: this is the clinical review the doctor makes the round with. */
export function SnapshotBody({ p }: { p: PatientSnap }) {
  const { dateTime, money } = useMe();
  return (
    <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <div><div className="text-xs uppercase text-slate-500">Vitals</div>{p.vitals.at ? <>{[p.vitals.bp && `BP ${p.vitals.bp}`, p.vitals.pulse && `pulse ${p.vitals.pulse}`, p.vitals.temperature && `${p.vitals.temperature} °C`, p.vitals.spo2 && `SpO₂ ${p.vitals.spo2}%`].filter(Boolean).join(" · ") || "recorded"}<div className="text-xs text-slate-500">{dateTime(p.vitals.at)}{p.vitals.late ? " · late" : ""}</div></> : <Badge tone="amber">none recorded</Badge>}</div>
      <div><div className="text-xs uppercase text-slate-500">Medicines</div>{p.medicines.active === 0 ? "none ordered" : p.medicines.names.join(", ")}<div className="mt-0.5 flex flex-wrap gap-1">{p.medicines.overdue > 0 && <Badge tone="red">{`${p.medicines.overdue} dose overdue`}</Badge>}{p.medicines.dueNow > 0 && <Badge tone="amber">{`${p.medicines.dueNow} due`}</Badge>}{p.medicines.withoutSchedule > 0 && <Badge tone="amber">{`${p.medicines.withoutSchedule} waiting for the nurse's schedule`}</Badge>}{p.medicines.active > 0 && <Badge tone="gray">{`${p.medicines.givenLast24h} given in 24 h`}</Badge>}</div></div>
      <div><div className="text-xs uppercase text-slate-500">Nurses' tasks</div>{p.tasks.pending === 0 ? "none pending" : `${p.tasks.pending} pending`}{p.tasks.overdue > 0 && <> <Badge tone="red">{`${p.tasks.overdue} overdue`}</Badge></>}</div>
      <div><div className="text-xs uppercase text-slate-500">Tests</div>{p.tests.open === 0 && p.tests.resultsLast24h === 0 ? "none" : <>{p.tests.open > 0 && <Badge tone="amber">{`${p.tests.open} waiting`}</Badge>} {p.tests.resultsLast24h > 0 && <Badge tone="green">{`${p.tests.resultsLast24h} result(s) in 24 h`}</Badge>}</>}</div>
      <div><div className="text-xs uppercase text-slate-500">Procedures and charges</div>{`${p.procedures} procedure(s) · ${money(p.charges.pendingTotal)} charged, not billed`}</div>
      <div className="sm:col-span-2 lg:col-span-3"><div className="text-xs uppercase text-slate-500">Last note</div>{p.lastNote ? <><span className="text-xs text-slate-500">{dateTime(p.lastNote.at)} </span>{p.lastNote.condition && <Badge tone={CONDITION_TONE[p.lastNote.condition as keyof typeof CONDITION_TONE] ?? "gray"}>{p.lastNote.condition.toLowerCase()}</Badge>} {p.lastNote.note}{p.lastNote.plan ? <div className="text-slate-600"><b>Plan then:</b> {p.lastNote.plan}</div> : null}</> : <span className="text-slate-500">no note yet</span>}</div>
    </div>
  );
}

// ───────────────────────── doctor's notes on an admission ─────────────────────────

export interface RoundNoteRow { id: string; roundId: string | null; round: string | null; condition: string | null; note: string; plan: string | null; instructions: string[] | null; addendumOfId: string | null; status: "ACTIVE" | "ENTERED_IN_ERROR"; errorReason: string | null; createdAt: string; authorName: string | null }
const CONDITION_TONE = { IMPROVING: "green", STABLE: "blue", WORSENING: "amber", CRITICAL: "red" } as const;

/** The doctor's round notes for an admission, and (for the doctor in charge) the form for a new note. */
export function RoundNotesCard({ admissionId, open, roundId, onDone }: { admissionId: string; open: boolean; roundId?: string; onDone?: () => void }) {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["round-notes", admissionId], queryFn: () => api.get<RoundNoteRow[]>(`/admissions/${admissionId}/round-notes`) });
  const [f, setF] = useState({ condition: "", note: "", plan: "", ins: [] as { text: string; due: string }[] });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["round-notes", admissionId] }); void qc.invalidateQueries({ queryKey: ["round"] }); void qc.invalidateQueries({ queryKey: ["ward-board"] }); void qc.invalidateQueries({ queryKey: ["worklist"] }); onDone?.(); };
  const save = useMutation({
    mutationFn: () => api.post(`/admissions/${admissionId}/round-notes`, { ...(roundId ? { roundId } : {}), ...(f.condition ? { condition: f.condition } : {}), note: f.note.trim(), ...(f.plan.trim() ? { plan: f.plan.trim() } : {}), instructions: f.ins.filter((i) => i.text.trim().length >= 3).map((i) => ({ text: i.text.trim(), dueInMinutes: Number(i.due) || 60 })) }),
    onSuccess: () => { setF({ condition: "", note: "", plan: "", ins: [] }); refresh(); },
  });
  const wrong = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.post(`/round-notes/${v.id}/enter-in-error`, { reason: v.reason }), onSuccess: refresh });
  const mayWrite = open && can("ROUND_DO");
  return (
    <Card title="Doctor's round notes">
      {mayWrite && (
        <div className="mb-4 space-y-3 rounded-md border border-slate-200 p-3">
          <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
            <Field label="How is the patient?"><Select value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })}><option value="">Not stated</option><option value="IMPROVING">Improving</option><option value="STABLE">Stable</option><option value="WORSENING">Worsening</option><option value="CRITICAL">Critical</option></Select></Field>
            <Field label="Note (findings, what the patient says)"><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          </div>
          <Field label="Plan (optional)"><Input value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })} placeholder="e.g. Continue antibiotics, repeat blood count tomorrow" /></Field>
          <div>
            <div className="mb-1 text-sm font-medium text-slate-700">Instructions for the nurses (each goes on their task list)</div>
            {f.ins.map((i, n) => (
              <div key={n} className="mb-2 grid grid-cols-[1fr_110px_auto] gap-2">
                <Input aria-label="Instruction" value={i.text} onChange={(e) => setF({ ...f, ins: f.ins.map((x, k) => (k === n ? { ...x, text: e.target.value } : x)) })} placeholder="e.g. Check temperature every 4 hours" />
                <Input aria-label="Due in minutes" inputMode="numeric" value={i.due} onChange={(e) => setF({ ...f, ins: f.ins.map((x, k) => (k === n ? { ...x, due: e.target.value.replace(/\D/g, "") } : x)) })} placeholder="due in min" />
                <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => setF({ ...f, ins: f.ins.filter((_, k) => k !== n) })}>remove</button>
              </div>
            ))}
            <Button variant="secondary" disabled={f.ins.length >= 10} onClick={() => setF({ ...f, ins: [...f.ins, { text: "", due: "60" }] })}>Add an instruction</Button>
          </div>
          <ErrorNote error={save.error} />
          <Button loading={save.isPending} disabled={f.note.trim().length < 3} onClick={() => save.mutate()}>Save the note</Button>
        </div>
      )}
      {list.isLoading ? <Spinner /> : (list.data?.length ?? 0) === 0 ? <p className="text-sm text-slate-500">No round notes yet.</p> : (
        <ul className="space-y-3">
          {list.data!.map((n) => (
            <li key={n.id} className={clsx("rounded-md border p-3 text-sm", n.status === "ENTERED_IN_ERROR" ? "border-slate-100 bg-slate-50 text-slate-400 line-through" : "border-slate-200")}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>{dateTime(n.createdAt)}</span><span>{n.authorName}</span>{n.round && <Badge tone="gray">{n.round}</Badge>}{n.addendumOfId && <Badge tone="gray">addendum</Badge>}
                {n.condition && <Badge tone={CONDITION_TONE[n.condition as keyof typeof CONDITION_TONE] ?? "gray"}>{n.condition.toLowerCase()}</Badge>}
              </div>
              <div>{n.note}</div>
              {n.plan && <div className="mt-1 text-slate-700"><b>Plan:</b> {n.plan}</div>}
              {n.instructions && n.instructions.length > 0 && <div className="mt-1 text-slate-700"><b>For the nurses:</b> {n.instructions.join("; ")}</div>}
              {n.status === "ENTERED_IN_ERROR" ? <div className="mt-1 text-xs no-underline">{`Entered in error: ${n.errorReason ?? ""}`}</div> : can("ROUND_DO") && open && (
                <div className="mt-1"><ConfirmButton label="Entered in error" confirmLabel="Yes, mark it" variant="secondary" onConfirm={() => wrong.mutate({ id: n.id, reason: "Entered by mistake" })} /></div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={wrong.error} />
    </Card>
  );
}

// ───────────────────────── procedures ─────────────────────────

export interface ProcedureRow { id: string; name: string; performedAt: string; outcome: string; status: "ACTIVE" | "ENTERED_IN_ERROR"; errorReason: string | null; performedByName: string | null; charged: { quantity: string; unitPrice: string; status: string } | null }

/** Procedures done on the patient, with their charge, and (for doctors) the form to record one. */
export function ProceduresCard({ admissionId, open }: { admissionId: string; open: boolean }) {
  const { can, dateTime, money } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["procedures", admissionId], queryFn: () => api.get<ProcedureRow[]>(`/admissions/${admissionId}/procedures`) });
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.page<{ id: string; name: string; price: string }>("/services", { pageSize: 100 }), enabled: can("PROCEDURE_RECORD") });
  const [f, setF] = useState({ name: "", serviceId: "", outcome: "" });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["procedures", admissionId] }); void qc.invalidateQueries({ queryKey: ["charges", admissionId] }); void qc.invalidateQueries({ queryKey: ["ward-board"] }); };
  const save = useMutation({ mutationFn: () => api.post(`/admissions/${admissionId}/procedures`, { name: f.name.trim(), ...(f.serviceId ? { serviceId: f.serviceId } : {}), outcome: f.outcome.trim() }), onSuccess: () => { setF({ name: "", serviceId: "", outcome: "" }); refresh(); } });
  const wrong = useMutation({ mutationFn: (id: string) => api.post(`/procedures/${id}/enter-in-error`, { reason: "Entered by mistake" }), onSuccess: refresh });
  return (
    <Card title="Procedures">
      {open && can("PROCEDURE_RECORD") && (
        <div className="mb-4 grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-2">
          <Field label="What was done"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Dressing of the abdominal wound" /></Field>
          <Field label="Charge it as (optional)"><Select value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: e.target.value })}><option value="">No charge</option>{services.data?.data.map((s) => <option key={s.id} value={s.id}>{`${s.name} · ${money(s.price)}`}</option>)}</Select></Field>
          <div className="sm:col-span-2"><Field label="What was found, how it went"><Textarea rows={2} value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} /></Field></div>
          <div className="sm:col-span-2"><ErrorNote error={save.error} /><Button loading={save.isPending} disabled={f.name.trim().length < 3 || f.outcome.trim().length < 3} onClick={() => save.mutate()}>Record the procedure</Button></div>
        </div>
      )}
      {list.isLoading ? <Spinner /> : (list.data?.length ?? 0) === 0 ? <p className="text-sm text-slate-500">No procedures recorded.</p> : (
        <ul className="space-y-2 text-sm">
          {list.data!.map((p) => (
            <li key={p.id} className={clsx("rounded-md border p-3", p.status === "ENTERED_IN_ERROR" ? "border-slate-100 bg-slate-50 text-slate-400 line-through" : "border-slate-200")}>
              <div className="flex flex-wrap items-center justify-between gap-2"><b>{p.name}</b><span className="text-xs text-slate-500">{`${dateTime(p.performedAt)} · ${p.performedByName ?? ""}`}</span></div>
              <div>{p.outcome}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                {p.charged ? <Badge tone={p.charged.status === "VOIDED" ? "gray" : "blue"}>{`Charged ${money(p.charged.unitPrice)} · ${p.charged.status.toLowerCase()}`}</Badge> : <span className="text-slate-500">not charged</span>}
                {p.status === "ENTERED_IN_ERROR" && <span>{`Entered in error: ${p.errorReason ?? ""}`}</span>}
                {p.status === "ACTIVE" && open && can("PROCEDURE_RECORD") && <ConfirmButton label="Entered in error" confirmLabel="Yes, mark it" variant="secondary" onConfirm={() => wrong.mutate(p.id)} />}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={wrong.error} />
      {!open && <div className="mt-2"><Notice tone="info">This admission has ended, so no new procedure can be recorded.</Notice></div>}
    </Card>
  );
}
