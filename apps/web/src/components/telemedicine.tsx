"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CANCEL_REASONS, ReasonSelect } from "@/components/reason-select";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Icon, type IconName } from "./desk-ui";
import { DoctorPicker } from "./doctor-picker";
import { PatientPicker, todayIn, type PickedPatient } from "./pickers";
import { Badge, Button, ErrorNote, Field, Input, Modal, Spinner } from "./ui";

interface Row { id: string; patient: string; mrn: string | null; doctor: string; scheduledAt: string; status: string; consented: boolean; doctorJoined: boolean; patientJoined: boolean; patientWaiting: boolean; identityChecked: boolean; feeStatus: string; feeDue: string; canJoin: boolean; windowOpensAt: string }
const STEPS = ["Booked", "Waiting", "In call", "Done"] as const;
const STATUS_PILL: Record<string, { label: string; tone: string; dot: string; pulse?: boolean }> = {
  SCHEDULED: { label: "Scheduled", tone: "bg-slate-100 text-slate-700", dot: "bg-slate-400" },
  WAITING: { label: "Patient waiting", tone: "bg-amber-50 text-amber-800 ring-1 ring-amber-200", dot: "bg-amber-500", pulse: true },
  IN_PROGRESS: { label: "In progress", tone: "bg-blue-50 text-blue-700 ring-1 ring-blue-200", dot: "bg-blue-500", pulse: true },
  COMPLETED: { label: "Completed", tone: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200", dot: "bg-emerald-500" },
  CANCELLED: { label: "Cancelled", tone: "bg-rose-50 text-rose-700 ring-1 ring-rose-200", dot: "bg-rose-500" },
};
const STEP: Record<string, number> = { SCHEDULED: 0, IN_PROGRESS: 2, COMPLETED: 3, CANCELLED: -1 };
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?[ap]m$/i, "");
const ampm = (iso: string) => (new Date(iso).toLocaleTimeString("en-IN", { hour12: true }).match(/[ap]m/i)?.[0] ?? "").toUpperCase();

/** The button on an appointment row that makes it a video consultation. */
export function MakeVideoButton({ appointmentId }: { appointmentId: string }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const [done, setDone] = useState(false);
  const make = useMutation({ mutationFn: () => api.post("/teleconsults", { appointmentId }), onSuccess: () => { setDone(true); void qc.invalidateQueries({ queryKey: ["teleconsults"] }); } });
  if (!can("TELE_MANAGE")) return null;
  if (done) return <Badge tone="blue">video</Badge>;
  return <><Button variant="ghost" loading={make.isPending} onClick={() => make.mutate()}>Make video</Button>{make.error ? <span className="text-xs text-red-700">{make.error instanceof Error ? make.error.message : "Could not make it"}</span> : null}</>;
}

interface Slot { startAt: string; endAt: string; available: boolean }
const PARTS: [string, string][] = [["MORNING", "Morning"], ["AFTERNOON", "Afternoon"], ["EVENING", "Evening"]];

/**
 * Books a video consultation in one step: the patient, a doctor, a day and a free time. It makes the appointment and the video call together, so the front desk
 * does not book an appointment first and then press "Make video" on it. Seeing a free time uses the doctor's own schedule, like the Book appointment window.
 */
function NewVideoConsult({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { me, dateTime } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const today = todayIn(tz);
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [doc, setDoc] = useState("");
  const [day, setDay] = useState(today);
  const [slot, setSlot] = useState("");
  const [part, setPart] = useState("ALL");
  const [made, setMade] = useState<{ appointmentId: string } | null>(null);
  const [key] = useState(newKey);
  const slots = useQuery({ queryKey: ["slots", doc, day], queryFn: () => api.get<Slot[]>(`/practitioners/${doc}/availability`, { date: day }), enabled: !!doc });
  const partOf = (iso: string) => { const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(iso))); return h < 12 ? "MORNING" : h < 17 ? "AFTERNOON" : "EVENING"; };
  const free = (slots.data ?? []).filter((x) => x.available);
  const book = useMutation({
    mutationFn: async () => {
      const chosen = slots.data?.find((x) => x.startAt === slot);
      const minutes = chosen ? Math.round((new Date(chosen.endAt).getTime() - new Date(chosen.startAt).getTime()) / 60_000) : undefined;
      // The appointment first (once: a retry returns the same one), then the video call on it.
      let appointmentId = made?.appointmentId;
      if (!appointmentId) {
        const a = await api.post<{ id: string }>("/appointments", { patientId: patient!.id, practitionerId: doc, startAt: slot, ...(minutes ? { durationMinutes: minutes } : {}) }, key);
        appointmentId = a.id;
        setMade({ appointmentId });
      }
      return api.post("/teleconsults", { appointmentId });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["teleconsults"] }); void qc.invalidateQueries({ queryKey: ["appointments"] }); onClose(); },
    onError: async (e) => { if ((e as { code?: string }).code === "SLOT_UNAVAILABLE") { await qc.invalidateQueries({ queryKey: ["slots"] }); setSlot(""); } },
  });
  const shown = (slots.data ?? []).filter((x) => part === "ALL" || partOf(x.startAt) === part);
  return (
    <Modal title="Book video consultation" onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field as="div" label="Patient"><PatientPicker value={patient} onPick={setPatient} autoFocus /></Field></div>
        <DoctorPicker value={doc} onChange={(id) => { setDoc(id); setSlot(""); }} />
        <Field label="Date"><Input type="date" min={today} value={day} onChange={(e) => { setDay(e.target.value); setSlot(""); }} /></Field>
        <div className="sm:col-span-2">
          <div className="mb-1 flex items-center justify-between text-sm font-medium text-slate-700"><span>Time</span>{slots.data && slots.data.length > 0 && <span className="text-xs font-normal text-slate-500">{free.length} free · {slots.data.length - free.length} taken</span>}</div>
          {doc && slots.data && slots.data.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Part of the day">
              {([["ALL", "All times"], ...PARTS] as [string, string][]).map(([v, label]) => <button key={v} type="button" aria-pressed={part === v} onClick={() => setPart(v)} className={`rounded-full border px-3 py-1 text-xs font-medium ${part === v ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>{label} <span className="tabular-nums">{free.filter((x) => v === "ALL" || partOf(x.startAt) === v).length}</span></button>)}
            </div>
          )}
          {!doc ? <p className="text-sm text-slate-500">Choose a department and a doctor to see free times.</p> : slots.isLoading ? <Spinner /> : slots.data?.length === 0 ? <p className="text-sm text-slate-500">This doctor does not see patients on that day.</p> : (
            <div className="flex flex-wrap gap-1.5">
              {shown.map((x) => (
                <button key={x.startAt} type="button" disabled={!x.available} onClick={() => setSlot(x.startAt)} className={`rounded border px-2 py-1 text-sm ${slot === x.startAt ? "border-brand-600 bg-brand-600 text-white" : x.available ? "border-slate-300 hover:bg-brand-50" : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-500 line-through"}`}>{dateTime(x.startAt).split(", ").pop()}</button>
              ))}
              {part !== "ALL" && shown.every((x) => !x.available) && <p className="w-full text-sm text-amber-800">No free time in the {part.toLowerCase()} on this day. Choose All times, or another day.</p>}
            </div>
          )}
        </div>
        {slot && <p className="rounded-lg bg-violet-50 p-2.5 text-sm text-violet-900 sm:col-span-2">Video consultation on <b>{dateTime(slot)}</b>. The patient joins from the patient app, and the doctor can open the call from 15 minutes before.</p>}
        <div className="sm:col-span-2">
          <ErrorNote error={book.error} />
          {made && book.error ? <p className="mt-1 text-xs text-slate-600">The appointment is already booked. You can try again here, or press <b>Make video</b> on it later under Appointments.</p> : null}
        </div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!patient || !doc || !slot} loading={book.isPending} onClick={() => book.mutate()}>Book video consultation</Button></div>
      </div>
    </Modal>
  );
}

/** Video consultations: for the doctor, their own with a Join button inside the time window; for the front desk, everything with a way to cancel. */
export function VideoConsults() {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["teleconsults"], queryFn: () => api.get<{ items: Row[] }>("/teleconsults", { pageSize: 50 }), refetchInterval: 5_000 });
  const [reason, setReason] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [method, setMethod] = useState("KNOWN_PATIENT");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["teleconsults"] }); };
  const join = useMutation({ mutationFn: (v: { id: string; identityMethod?: string }) => api.post<{ url: string; patientJoined: boolean }>(`/teleconsults/${v.id}/join`, v.identityMethod ? { identityMethod: v.identityMethod } : {}, newKey()), onSuccess: (r) => { setChecking(null); window.open(r.url, "_blank", "noopener,noreferrer"); refresh(); } });
  const end = useMutation({ mutationFn: (id: string) => api.post(`/teleconsults/${id}/end`, {}, newKey()), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/teleconsults/${id}/cancel`, { reason: reason[id]?.trim() }), onSuccess: refresh });
  const [statusFilter, setStatusFilter] = useState("");
  const [booking, setBooking] = useState(false);
  const [find, setFind] = useState("");
  const all = list.data?.items ?? [];
  const needle = find.trim().toLowerCase();
  const shown = all.filter((r) => (!statusFilter || r.status === statusFilter) && (!needle || `${r.patient} ${r.mrn ?? ""} ${r.doctor}`.toLowerCase().includes(needle)));
  const dayLabel = (iso: string) => {
    const d = new Date(iso); const today = new Date(); const tomorrow = new Date(today.getTime() + 86_400_000);
    const same = (x: Date, y: Date) => x.toDateString() === y.toDateString();
    const text = d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });
    return same(d, today) ? `Today · ${text}` : same(d, tomorrow) ? `Tomorrow · ${text}` : text;
  };
  const groups = [...shown].sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt)).reduce<[string, Row[]][]>((acc, r) => { const l = dayLabel(r.scheduledAt); const last = acc[acc.length - 1]; if (last && last[0] === l) last[1].push(r); else acc.push([l, [r]]); return acc; }, []);
  const n = (st: string) => all.filter((r) => r.status === st).length;
  const waiting = all.filter((r) => r.patientWaiting && r.status === "SCHEDULED");
  const FILTERS: [string, string][] = [["", "All"], ["SCHEDULED", "Scheduled"], ["IN_PROGRESS", "In progress"], ["COMPLETED", "Completed"], ["CANCELLED", "Cancelled"]];
  const tiles: { label: string; sub: string; value: number; filter: string; tone: string; icon: IconName; live?: boolean }[] = [
    { label: "Scheduled", sub: "Booked, not started", value: n("SCHEDULED"), filter: "SCHEDULED", tone: "bg-sky-50 text-sky-600", icon: "calendar" },
    { label: "Patient waiting", sub: "Joined, waiting for the doctor", value: waiting.length, filter: "SCHEDULED", tone: waiting.length > 0 ? "bg-amber-50 text-amber-600" : "bg-slate-50 text-slate-400", icon: "users", live: waiting.length > 0 },
    { label: "In progress", sub: "Call is on now", value: n("IN_PROGRESS"), filter: "IN_PROGRESS", tone: "bg-blue-50 text-blue-600", icon: "video", live: n("IN_PROGRESS") > 0 },
    { label: "Completed", sub: "Call ended", value: n("COMPLETED"), filter: "COMPLETED", tone: "bg-emerald-50 text-emerald-600", icon: "check" },
  ];
  const CARD = "rounded-2xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_4px_16px_-6px_rgba(16,24,40,0.08)]";
  const GRID = "md:grid md:grid-cols-[96px_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.25fr)_auto] md:items-center md:gap-4";
  return (
    <div className="mx-auto max-w-[1280px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-blue-600"><span className="h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden />Telemedicine</div>
          <h1 className="mt-1.5 text-[26px] font-semibold leading-tight tracking-tight text-slate-900">Video consultations</h1>
          <p className="mt-1 text-sm text-slate-500">Calls booked with patients, and who is waiting.</p>
        </div>
        <div className="flex items-center gap-3">
          {waiting.length > 0 && <span role="status" className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" /></span>{waiting.map((r) => r.patient).join(", ")} {waiting.length === 1 ? "is" : "are"} waiting</span>}
          {can("TELE_MANAGE") && <Button className="gap-2 rounded-xl bg-blue-600 px-4 py-2.5 shadow-sm shadow-blue-600/20 hover:bg-blue-700" onClick={() => setBooking(true)}><Icon name="plus" />Book video consultation</Button>}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((x) => {
          const active = statusFilter === x.filter && (x.label !== "Patient waiting");
          return (
            <button key={x.label} type="button" onClick={() => setStatusFilter(statusFilter === x.filter ? "" : x.filter)} aria-pressed={active} className={`${CARD} group p-5 text-left transition hover:-translate-y-0.5 hover:shadow-[0_8px_24px_-8px_rgba(37,99,235,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${active ? "ring-2 ring-blue-500/70" : ""}`}>
              <span className="flex items-start justify-between gap-3">
                <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${x.tone}`}><Icon name={x.icon} className="h-5 w-5" /></span>
                {x.live && <span className="relative mt-1 flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60 text-blue-500" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" /></span>}
              </span>
              <span className="mt-4 block text-3xl font-semibold tracking-tight tabular-nums text-slate-900">{list.data ? x.value : <span className="text-slate-300">–</span>}</span>
              <span className="mt-1 block text-sm font-medium text-slate-700">{x.label}</span>
              <span className="block text-xs text-slate-500">{x.sub}</span>
            </button>
          );
        })}
      </div>

      <details className={`${CARD} group`} open={all.length === 0}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-3 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2.5"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50 text-blue-600"><Icon name="video" /></span>How a video consultation works</span>
          <span className="text-xs font-medium text-blue-600 group-open:hidden">Show steps</span><span className="hidden text-xs font-medium text-blue-600 group-open:inline">Hide steps</span>
        </summary>
        <ol className="grid gap-5 border-t border-slate-100 p-5 sm:grid-cols-3">
          {[
            ["Book", "Reception books a time and the video call together. A request paid in the patient app is booked from Appointments."],
            ["Patient joins", "The patient agrees in the patient app and presses I am here. You see them waiting."],
            ["Doctor starts", "The doctor starts the call from 15 minutes before the time, after checking who the patient is. Notes and prescription go on the visit as usual."],
          ].map(([title, text], i) => (
            <li key={title} className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">{i + 1}</span>
              <div><div className="text-sm font-semibold text-slate-900">{title}</div><p className="mt-1 text-xs leading-relaxed text-slate-500">{text}</p></div>
            </li>
          ))}
        </ol>
      </details>

      <ErrorNote error={join.error ?? end.error ?? cancel.error} />

      <section className={`${CARD} overflow-hidden`}>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex flex-wrap items-center gap-1 rounded-xl bg-slate-100/80 p-1" role="tablist" aria-label="Status">
            {FILTERS.map(([v, label]) => {
              const count = v ? all.filter((r) => r.status === v).length : all.length;
              return <button key={v} type="button" role="tab" aria-selected={statusFilter === v} onClick={() => setStatusFilter(v)} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${statusFilter === v ? "bg-white text-blue-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{label}<span className={`rounded-full px-1.5 text-[10px] tabular-nums ${statusFilter === v ? "bg-blue-50 text-blue-700" : "bg-slate-200/70 text-slate-500"}`}>{count}</span></button>;
            })}
          </div>
          <label className="relative block w-full sm:w-72">
            <span className="sr-only">Search video consultations</span>
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400"><Icon name="search" /></span>
            <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search patient, ID or doctor" className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/70 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-blue-100" />
          </label>
        </header>

        {list.isLoading ? <div className="p-6"><Spinner /></div> : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><Icon name="video" className="h-6 w-6" /></span>
            <p className="max-w-sm text-sm text-slate-600">{all.length === 0 ? "No video consultations yet. Press Book video consultation to book the first one." : "Nothing matches this filter."}</p>
            {all.length === 0 ? (can("TELE_MANAGE") ? <Button onClick={() => setBooking(true)}>Book video consultation</Button> : <Link href="/appointments" className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700">Open appointments</Link>) : <button type="button" className="rounded-xl border border-slate-300 px-3.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={() => { setStatusFilter(""); setFind(""); }}>Show all</button>}
          </div>
        ) : (
          <div role="table" aria-label="Video consultations">
            <div role="row" className={`hidden border-b border-slate-100 bg-slate-50/60 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 ${GRID}`}>
              <div role="columnheader">Time</div><div role="columnheader">Patient</div><div role="columnheader">Doctor</div><div role="columnheader">Status</div><div role="columnheader" className="text-right">Action</div>
            </div>
            {groups.map(([label, rows]) => (
              <div key={label} role="rowgroup">
                <div className="flex items-center gap-2 border-b border-slate-100 bg-white px-5 pb-1.5 pt-4 text-xs font-semibold text-slate-900">{label}<span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">{rows.length}</span></div>
                {rows.map((r) => {
                  const step = r.status === "SCHEDULED" ? (r.patientWaiting || r.patientJoined ? 1 : 0) : (STEP[r.status] ?? 0);
                  const live = r.status === "IN_PROGRESS";
                  const ready = r.status === "SCHEDULED" && r.patientWaiting;
                  const pill = STATUS_PILL[ready ? "WAITING" : r.status] ?? STATUS_PILL.SCHEDULED!;
                  return (
                    <div key={r.id} role="row" className={`flex flex-col gap-3 border-b border-slate-100 px-5 py-4 transition last:border-b-0 hover:bg-blue-50/30 ${GRID} ${ready ? "bg-amber-50/40" : live ? "bg-blue-50/40" : ""}`}>
                      <div role="cell" className="flex items-baseline gap-1.5 md:block">
                        <div className="text-lg font-semibold tabular-nums tracking-tight text-slate-900">{timeOf(r.scheduledAt)}</div>
                        <div className="text-[11px] font-medium uppercase text-slate-400">{ampm(r.scheduledAt)}</div>
                      </div>
                      <div role="cell" className="flex min-w-0 items-center gap-3">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-sm font-semibold text-white shadow-sm" aria-hidden>{initials(r.patient)}</span>
                        <div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-900">{r.patient}</div><div className="truncate text-xs text-slate-500">{r.mrn}</div></div>
                      </div>
                      <div role="cell" className="flex items-center gap-2 text-sm text-slate-700"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600" aria-hidden>{initials(r.doctor.replace(/^Dr\.?\s*/i, ""))}</span><span className="truncate">{r.doctor}</span></div>
                      <div role="cell" className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${pill.tone}`}><span className={`h-1.5 w-1.5 rounded-full ${pill.dot} ${pill.pulse ? "animate-pulse" : ""}`} aria-hidden />{pill.label}</span>
                          {r.feeStatus === "PENDING" && r.status === "SCHEDULED" ? <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">Fee ₹{r.feeDue} due</span> : r.feeStatus === "PAID" || r.feeStatus === "SKIPPED" ? <span className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">Fee paid</span> : null}
                        </div>
                        {r.status !== "CANCELLED" && (
                          <div className="flex items-center gap-2" role="img" aria-label={`Progress: ${STEPS[Math.min(step, 3)]}`}>
                            <div className="flex w-28 gap-1">{STEPS.map((name, i) => <span key={name} title={name} className={`h-1.5 flex-1 rounded-full ${r.status === "COMPLETED" || i < step ? "bg-blue-600" : i === step ? "bg-blue-300" : "bg-slate-200"}`} />)}</div>
                            <span className="text-[11px] text-slate-500">{r.status === "COMPLETED" ? "Done" : r.patientJoined && live ? "Patient in call" : r.status === "SCHEDULED" && !r.patientWaiting ? (r.canJoin ? "Open now" : `Opens ${dateTime(r.windowOpensAt)}`) : STEPS[Math.min(step, 3)]}{r.identityChecked ? " · ID checked" : ""}</span>
                          </div>
                        )}
                      </div>
                      <div role="cell" className="flex flex-wrap items-center gap-2 md:justify-end">
                        {r.canJoin && !r.doctorJoined && checking !== r.id && <Button className="gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-700" onClick={() => { setChecking(r.id); setMethod("KNOWN_PATIENT"); }}><Icon name="video" />Start call</Button>}
                        {r.canJoin && !r.doctorJoined && checking === r.id && (
                          <div className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-blue-100 bg-blue-50/50 p-2.5 md:w-auto">
                            <label className="text-xs font-medium text-slate-600" htmlFor={`idm-${r.id}`}>Who is the patient?</label>
                            <select id={`idm-${r.id}`} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs" value={method} onChange={(e) => setMethod(e.target.value)}>
                              <option value="KNOWN_PATIENT">I know this patient</option><option value="PHOTO_ID_SHOWN">Photo ID shown on camera</option><option value="APP_SIGN_IN">Signed in to the patient app</option><option value="OTHER">Other</option>
                            </select>
                            <Button loading={join.isPending && join.variables?.id === r.id} onClick={() => join.mutate({ id: r.id, identityMethod: method })}>Confirm and start</Button>
                            <Button variant="ghost" onClick={() => setChecking(null)}>Back</Button>
                          </div>
                        )}
                        {r.canJoin && r.doctorJoined && <Button className="gap-1.5 rounded-xl" loading={join.isPending && join.variables?.id === r.id} onClick={() => join.mutate({ id: r.id })}><Icon name="video" />Rejoin call</Button>}
                        {r.status === "IN_PROGRESS" && can("TELE_CONDUCT") && <Button variant="secondary" className="rounded-xl" onClick={() => end.mutate(r.id)}>End call</Button>}
                        {r.status === "SCHEDULED" && can("TELE_MANAGE") && (
                          <details className="relative">
                            <summary className="cursor-pointer list-none rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 [&::-webkit-details-marker]:hidden">Cancel…</summary>
                            <div className="absolute right-0 z-10 mt-1 flex w-72 items-end gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                              <ReasonSelect reasons={CANCEL_REASONS.video} label="Reason to cancel" className="flex-1 space-y-1" onChange={(v) => setReason((all) => ({ ...all, [r.id]: v }))} />
                              <Button variant="secondary" disabled={(reason[r.id]?.trim().length ?? 0) < 5} onClick={() => cancel.mutate(r.id)}>Cancel call</Button>
                            </div>
                          </details>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </section>
      {booking && <NewVideoConsult onClose={() => setBooking(false)} />}
    </div>
  );
}
