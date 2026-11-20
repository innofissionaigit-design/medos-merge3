"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CANCEL_REASONS, ReasonSelect } from "@/components/reason-select";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Icon, type IconName, PANEL } from "./desk-ui";
import { Badge, Button, ErrorNote, Input, Spinner } from "./ui";

interface Row { id: string; patient: string; mrn: string | null; doctor: string; scheduledAt: string; status: string; consented: boolean; doctorJoined: boolean; patientJoined: boolean; patientWaiting: boolean; identityChecked: boolean; feeStatus: string; feeDue: string; canJoin: boolean; windowOpensAt: string }
const TONE: Record<string, "gray" | "blue" | "green" | "red"> = { SCHEDULED: "gray", IN_PROGRESS: "blue", COMPLETED: "green", CANCELLED: "red" };

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
  const [find, setFind] = useState("");
  const all = list.data?.items ?? [];
  const needle = find.trim().toLowerCase();
  const shown = all.filter((r) => (!statusFilter || r.status === statusFilter) && (!needle || `${r.patient} ${r.mrn ?? ""} ${r.doctor}`.toLowerCase().includes(needle)));
  const n = (st: string) => all.filter((r) => r.status === st).length;
  const waiting = all.filter((r) => r.patientWaiting && r.status === "SCHEDULED");
  const FILTERS: [string, string][] = [["", "All"], ["SCHEDULED", "Scheduled"], ["IN_PROGRESS", "In progress"], ["COMPLETED", "Completed"], ["CANCELLED", "Cancelled"]];
  const tiles: { label: string; sub: string; value: number; filter: string; bar: string; tone: string; icon: IconName }[] = [
    { label: "Scheduled", sub: "Booked, not started", value: n("SCHEDULED"), filter: "SCHEDULED", bar: "bg-teal-500", tone: "bg-teal-50 text-teal-700", icon: "calendar" },
    { label: "Patient waiting", sub: "Joined, waiting for the doctor", value: waiting.length, filter: "SCHEDULED", bar: waiting.length > 0 ? "bg-emerald-500" : "bg-slate-300", tone: waiting.length > 0 ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600", icon: "users" },
    { label: "In progress", sub: "Call is on now", value: n("IN_PROGRESS"), filter: "IN_PROGRESS", bar: "bg-brand-500", tone: "bg-blue-50 text-blue-700", icon: "video" },
    { label: "Completed", sub: "Call ended", value: n("COMPLETED"), filter: "COMPLETED", bar: "bg-emerald-500", tone: "bg-emerald-50 text-emerald-700", icon: "check" },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((x) => {
          const active = statusFilter === x.filter;
          return (
            <button key={x.label} type="button" onClick={() => setStatusFilter(active ? "" : x.filter)} aria-pressed={active} className={`group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200"}`}>
              <span className={`absolute inset-x-0 top-0 h-1 ${x.bar}`} aria-hidden />
              <span className="flex items-center justify-between gap-2 text-slate-500">
                <span className="text-xs font-medium uppercase tracking-wide">{x.label}</span>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${x.tone}`}><Icon name={x.icon} /></span>
              </span>
              <span className="mt-2 block text-3xl font-semibold tracking-tight tabular-nums text-slate-900">{list.data ? x.value : <span className="text-slate-400">…</span>}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{x.sub}</span>
            </button>
          );
        })}
      </div>
      {waiting.length > 0 && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-sm font-medium text-emerald-800">
          <Icon name="video" />{waiting.map((r) => r.patient).join(", ")} {waiting.length === 1 ? "is" : "are"} waiting for the call.
        </div>
      )}
      <div className={`${PANEL} grid gap-3 p-4 sm:grid-cols-3`}>
        {[
          ["1", "Book it", "On a booked appointment, press Make video. The appointment becomes a video consultation with a link."],
          ["2", "Patient agrees and joins", "The patient agrees to a video consultation and joins from the patient app. You see when they are waiting."],
          ["3", "Doctor starts the call", "The doctor can open the call from 15 minutes before the time. Notes and prescription are written on the visit as usual."],
        ].map(([n, title, text]) => (
          <div key={n} className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">{n}</span>
            <div><div className="text-sm font-semibold text-slate-800">{title}</div><p className="mt-0.5 text-xs leading-relaxed text-slate-500">{text}</p></div>
          </div>
        ))}
      </div>
      <ErrorNote error={join.error ?? end.error ?? cancel.error} />
      <section className={PANEL}>
        <header className="space-y-2.5 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">Video consultations <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{shown.length}</span></h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5" role="tablist" aria-label="Status">
              {FILTERS.map(([v, label]) => <button key={v} type="button" role="tab" aria-selected={statusFilter === v} onClick={() => setStatusFilter(v)} className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${statusFilter === v ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{label}</button>)}
            </div>
            <div className="ml-auto w-52"><Input aria-label="Search video consultations" placeholder="Patient, ID or doctor" value={find} onChange={(e) => setFind(e.target.value)} /></div>
          </div>
        </header>
        {list.isLoading ? <div className="p-4"><Spinner /></div> : shown.length === 0 ? <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500"><Icon name="video" /></span>
            <p className="max-w-sm text-sm text-slate-600">{all.length === 0 ? "No video consultations yet. Open Appointments and press Make video on a booked appointment." : "Nothing matches this filter."}</p>
            {all.length === 0 ? <Link href="/appointments" className="rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">Open appointments</Link> : <button type="button" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={() => { setStatusFilter(""); setFind(""); }}>Clear the filter</button>}
          </div> : (
          <div className="overflow-x-auto px-4 pb-1">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-500"><th className="py-2 pr-3 font-medium">When</th><th className="py-2 pr-3 font-medium">Patient</th><th className="py-2 pr-3 font-medium">Doctor</th><th className="py-2 pr-3 font-medium">Status</th><th className="py-2 text-right font-medium">Actions</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((r) => (
                  <tr key={r.id} className={`align-top hover:bg-slate-50/70 ${r.patientWaiting && r.status === "SCHEDULED" ? "bg-emerald-50/50" : r.status === "IN_PROGRESS" ? "bg-blue-50/40" : ""}`}>
                    <td className="whitespace-nowrap py-2.5 pr-3 font-semibold tabular-nums text-slate-900">{dateTime(r.scheduledAt)}</td>
                    <td className="py-2.5 pr-3"><span className="font-semibold text-slate-900">{r.patient}</span><div className="text-xs text-slate-500">{r.mrn}</div></td>
                    <td className="py-2.5 pr-3 text-slate-700">{r.doctor}</td>
                    <td className="py-2.5 pr-3"><Badge tone={TONE[r.status] ?? "gray"}>{r.status.replace("_", " ").toLowerCase()}</Badge><div className="text-xs text-slate-500">{r.patientJoined ? "patient is in the call" : r.patientWaiting ? <span className="font-semibold text-green-800">patient is waiting</span> : r.consented ? "patient agreed" : r.status === "SCHEDULED" ? `opens ${dateTime(r.windowOpensAt)}` : ""}</div>{r.feeStatus === "PENDING" && r.status === "SCHEDULED" && <div className="text-xs text-amber-800">fee {r.feeDue} to pay</div>}{r.identityChecked && <div className="text-xs text-slate-500">identity checked</div>}</td>
              <td className="whitespace-nowrap py-2.5 text-right">
                {r.canJoin && !r.doctorJoined && checking !== r.id && <Button onClick={() => { setChecking(r.id); setMethod("KNOWN_PATIENT"); }}>Start call</Button>}
                {r.canJoin && !r.doctorJoined && checking === r.id && (
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <label className="text-xs text-slate-600" htmlFor={`idm-${r.id}`}>I have confirmed who the patient is:</label>
                    <select id={`idm-${r.id}`} className="rounded border border-slate-300 px-1 py-1 text-xs" value={method} onChange={(e) => setMethod(e.target.value)}>
                      <option value="KNOWN_PATIENT">I know this patient</option><option value="PHOTO_ID_SHOWN">Photo ID shown on camera</option><option value="APP_SIGN_IN">Signed in to the patient app</option><option value="OTHER">Other</option>
                    </select>
                    <Button loading={join.isPending && join.variables?.id === r.id} onClick={() => join.mutate({ id: r.id, identityMethod: method })}>Confirm and start</Button>
                    <Button variant="ghost" onClick={() => setChecking(null)}>Back</Button>
                  </span>
                )}
                {r.canJoin && r.doctorJoined && <Button loading={join.isPending && join.variables?.id === r.id} onClick={() => join.mutate({ id: r.id })}>Rejoin call</Button>}
                {r.status === "IN_PROGRESS" && can("TELE_CONDUCT") && <> <Button variant="secondary" onClick={() => end.mutate(r.id)}>End call</Button></>}
                {r.status === "SCHEDULED" && can("TELE_MANAGE") && <span className="inline-flex items-center gap-1"><ReasonSelect reasons={CANCEL_REASONS.video} label="Reason to cancel" className="w-56 space-y-1" onChange={(v) => setReason((all) => ({ ...all, [r.id]: v }))} /><Button variant="secondary" disabled={(reason[r.id]?.trim().length ?? 0) < 5} onClick={() => cancel.mutate(r.id)}>Cancel</Button></span>}
              </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
