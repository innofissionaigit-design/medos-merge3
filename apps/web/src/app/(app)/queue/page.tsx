"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { VitalsCard } from "@/components/ipd-extras";
import { Icon, type IconName, PANEL, useDeskKeys } from "@/components/desk-ui";
import { Badge, Button, ErrorNote, Input, Modal, Field, Notice, PageHeader, Spinner, StatusBadge } from "@/components/ui";
import { CANCEL_REASONS, ReasonSelect } from "@/components/reason-select";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Entry {
  id: string; tokenNumber: number; priority: "NORMAL" | "PRIORITY" | "EMERGENCY"; status: string; patientName: string; mrn: string | null; gender: string;
  practitionerName: string; departmentName: string | null; waitingMinutes: number | null; encounterId?: string | null; patientId?: string; tokenDate?: string;
}

const PRIORITY_TONE = { NORMAL: "gray", PRIORITY: "amber", EMERGENCY: "red" } as const;

export default function QueuePage() {
  const router = useRouter();
  const { can, me } = useMe();
  const qc = useQueryClient();
  const [doctor, setDoctor] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  // Nurses record the vitals of an OPD patient from here: they cannot open the doctor's visit page.
  const [vitalsFor, setVitalsFor] = useState<{ encounterId: string; patient: string } | null>(null);
  const [reason, setReason] = useState("");
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: me.facility?.timezone ?? me.tenant.timezone });
  const list = useQuery({ queryKey: ["queue", doctor], queryFn: () => api.get<Entry[]>("/queue", doctor ? { practitionerId: doctor } : undefined), refetchInterval: 15_000 });
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<{ id: string; displayName: string; userId: string | null }[]>("/practitioners") });
  // A doctor opens on their own patients; reception (QUEUE_MANAGE) keeps the all-doctors view. The filter can still be changed.
  const [defaulted, setDefaulted] = useState(false);
  useEffect(() => {
    if (defaulted || !docs.data) return;
    const mine = docs.data.find((d) => d.userId === me.id);
    if (mine && !can("QUEUE_MANAGE")) setDoctor(mine.id);
    setDefaulted(true);
  }, [defaulted, docs.data, me.id, can]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["queue"] });
  // Set when "Complete" is refused because the consultation or its prescription is still unsigned: signing happens on the visit page.
  const [signFirst, setSignFirst] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown; encounterId?: string | null }) => api.post<{ encounterId?: string | null }>(`/queue/${id}/${action}`, body),
    onMutate: () => setSignFirst(null),
    onSuccess: async (r, v) => { await refresh(); if (v.action === "start" && r?.encounterId) router.push(`/visits/${r.encounterId}`); },
    onError: (e, v) => { if (v.action === "complete" && v.encounterId && e instanceof ApiError && e.code === "INVALID_STATE") setSignFirst(v.encounterId); },
  });
  const callNext = useMutation({ mutationFn: () => api.post("/queue/call-next", doctor ? { practitionerId: doctor } : {}), onSuccess: refresh });
  const priority = useMutation({ mutationFn: ({ id, priority }: { id: string; priority: string }) => api.patch(`/queue/${id}/priority`, { priority }), onSuccess: refresh });
  const manage = can("QUEUE_MANAGE");
  const canPrioritise = can("QUEUE_PRIORITY");
  const clinician = can("CONSULTATION_CREATE");

  const all = list.data ?? [];
  const [statusFilter, setStatusFilter] = useState("");
  const [find, setFind] = useState("");
  const needle = find.trim().toLowerCase();
  const count = (...st: string[]) => all.filter((e) => st.includes(e.status)).length;
  const STATUS_FILTERS: [string, string, string[]][] = [["", "All", []], ["WAITING", "Waiting", ["WAITING", "CALLED"]], ["IN_CONSULTATION", "In consultation", ["IN_CONSULTATION"]], ["COMPLETED", "Completed", ["COMPLETED"]], ["SKIPPED", "Skipped / cancelled", ["SKIPPED", "CANCELLED"]]];
  const wanted = STATUS_FILTERS.find(([v]) => v === statusFilter)?.[2] ?? [];
  const shown = all.filter((e) => (wanted.length === 0 || wanted.includes(e.status)) && (!needle || `${e.patientName} ${e.mrn ?? ""} ${e.tokenNumber} ${e.practitionerName}`.toLowerCase().includes(needle)));
  const longest = Math.max(0, ...all.filter((e) => e.status === "WAITING" || e.status === "CALLED").map((e) => e.waitingMinutes ?? 0));
  const tiles: { label: string; value: string; tone: string; icon: IconName }[] = [
    { label: "Waiting", value: String(count("WAITING", "CALLED")), tone: "bg-teal-50 text-teal-700", icon: "users" },
    { label: "In consultation", value: String(count("IN_CONSULTATION")), tone: "bg-blue-50 text-blue-700", icon: "play" },
    { label: "Completed", value: String(count("COMPLETED")), tone: "bg-emerald-50 text-emerald-700", icon: "check" },
    { label: "Longest wait", value: count("WAITING", "CALLED") ? `${longest} min` : "—", tone: "bg-amber-50 text-amber-700", icon: "clock" },
  ];
  // C calls the next patient (ignored while typing, or for people who may not call).
  useDeskKeys((k, e) => { if (k === "C" && (manage || clinician) && !callNext.isPending && !cancelId && !vitalsFor) { e.preventDefault(); callNext.mutate(); } });
  return (
    <Gate anyOf={["QUEUE_READ"]}>
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
        <PageHeader
          title="OPD queue" subtitle="Today’s patients, refreshed automatically"
          actions={(manage || clinician) ? <Button className="gap-2 rounded-lg px-4 py-2 shadow-sm" loading={callNext.isPending} onClick={() => callNext.mutate()}><Icon name="play" />Call next patient<kbd className="rounded bg-white/20 px-1.5 text-[11px]">C</kbd></Button> : undefined}
        />
        <div className="mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {tiles.map((x) => (
            <div key={x.label} className={`${PANEL} flex items-center gap-2.5 px-3.5 py-2`}>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${x.tone}`}><Icon name={x.icon} /></span>
              <div className="min-w-0">
                <div className="text-[10.5px] font-medium uppercase leading-tight tracking-wider text-slate-500">{x.label}</div>
                <div className="text-lg font-semibold tabular-nums leading-tight text-slate-900">{list.data ? x.value : "—"}</div>
              </div>
            </div>
          ))}
        </div>
        {/* Doctor, status and a quick search in one row. */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="w-48"><select aria-label="Filter by doctor" value={doctor} onChange={(e) => setDoctor(e.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
            <option value="">All doctors</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
          </select></div>
          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5" role="tablist" aria-label="Status">
            {STATUS_FILTERS.map(([v, label]) => <button key={v} type="button" role="tab" aria-selected={statusFilter === v} onClick={() => setStatusFilter(v)} className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${statusFilter === v ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{label}</button>)}
          </div>
          <div className="ml-auto w-52"><Input aria-label="Search the queue" placeholder="Patient, ID or token" value={find} onChange={(e) => setFind(e.target.value)} /></div>
        </div>
      {signFirst && (
        <Notice tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>This visit cannot be completed yet. Open the visit, click Sign consultation to send the prescription to the pharmacy, then complete the visit.</span>
            <Button onClick={() => router.push(`/visits/${signFirst}`)}>Open visit to sign</Button>
          </div>
        </Notice>
      )}
      {all.some((e) => e.status === "IN_CONSULTATION" && e.tokenDate && e.tokenDate < todayStr) && (
        <Notice tone="warn">An earlier consultation is still open (marked with its date below). A doctor can only have one open consultation, so new patients cannot be started until it is completed: open the visit, sign it if needed, then press Complete.</Notice>
      )}
        <ErrorNote error={(signFirst ? null : act.error) ?? callNext.error ?? priority.error} />
        <section className={PANEL}>
          {list.isLoading ? <div className="p-4"><Spinner /></div> : shown.length === 0 ? <p className="px-4 py-8 text-center text-sm text-slate-500">{needle || statusFilter ? "Nobody in the queue matches." : "Nobody is in the queue."}</p> : (
            <div className="overflow-x-auto px-4 pb-1">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400"><th className="py-2 pr-3 font-medium">Token</th><th className="py-2 pr-3 font-medium">Patient</th><th className="py-2 pr-3 font-medium">Doctor</th><th className="py-2 pr-3 font-medium">Status</th><th className="py-2 pr-3 text-right font-medium">Waiting</th><th className="py-2 text-right font-medium">Actions</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {shown.map((e) => {
                    const waiting = e.status === "WAITING";
                    const called = e.status === "CALLED";
                    const inConsult = e.status === "IN_CONSULTATION";
                    const wait = e.waitingMinutes;
                    return (
                      <tr key={e.id} className={`align-top hover:bg-slate-50/70 ${e.priority === "EMERGENCY" ? "bg-red-50/60" : inConsult ? "bg-blue-50/40" : ""}`}>
                        <td className="whitespace-nowrap py-2.5 pr-3">
                          <span className={`inline-flex h-9 min-w-[2.25rem] items-center justify-center rounded-full px-2 text-base font-semibold tabular-nums ${inConsult ? "bg-blue-100 text-blue-800" : "bg-teal-50 text-teal-700"}`}>{e.tokenNumber}</span>
                          {e.tokenDate && e.tokenDate < todayStr && <div className="mt-1"><Badge tone="amber">from {e.tokenDate}</Badge></div>}
                          {e.priority !== "NORMAL" && <div className="mt-1"><Badge tone={PRIORITY_TONE[e.priority]}>{e.priority.toLowerCase()}</Badge></div>}
                        </td>
                        <td className="py-2.5 pr-3">{e.patientId ? <Link className="font-semibold text-slate-900 hover:text-brand-700 hover:underline" href={`/patients/${e.patientId}`}>{e.patientName}</Link> : <span className="font-semibold text-slate-900">{e.patientName}</span>}<div className="text-xs text-slate-400">{e.mrn}</div></td>
                        <td className="py-2.5 pr-3"><div className="text-slate-800">{e.practitionerName}</div><div className="text-xs text-slate-500">{e.departmentName}</div></td>
                        <td className="py-2.5 pr-3"><StatusBadge value={e.status} /></td>
                        <td className={`whitespace-nowrap py-2.5 pr-3 text-right tabular-nums ${wait !== null && wait >= 60 && (waiting || called) ? "font-semibold text-amber-700" : "text-slate-600"}`}>{wait !== null ? `${wait} min` : "—"}</td>
                        <td className="py-2.5">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {(waiting || called) && (manage || clinician) && <Button variant="secondary" onClick={() => act.mutate({ id: e.id, action: "call" })}>{called ? "Recall" : "Call"}</Button>}
                      {(waiting || called) && clinician && <Button onClick={() => act.mutate({ id: e.id, action: "start" })}>Start</Button>}
                      {inConsult && e.encounterId && can("CONSULTATION_READ") && <Button onClick={() => router.push(`/visits/${e.encounterId}`)}>Open visit</Button>}
                      {inConsult && clinician && <Button variant="secondary" onClick={() => act.mutate({ id: e.id, action: "complete", encounterId: e.encounterId })}>Complete</Button>}
                      {(waiting || called) && canPrioritise && (
                        <select aria-label={`Priority for ${e.patientName}`} value={e.priority} disabled={priority.isPending} onChange={(ev) => priority.mutate({ id: e.id, priority: ev.target.value })} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
                          <option value="NORMAL">Normal</option><option value="PRIORITY">Priority</option><option value="EMERGENCY">Emergency</option>
                        </select>
                      )}
                      {(waiting || called || inConsult) && e.encounterId && can("VITALS_CREATE") && !can("CONSULTATION_READ") && <Button variant="secondary" onClick={() => setVitalsFor({ encounterId: e.encounterId as string, patient: e.patientName })}>Record vitals</Button>}
                      {(waiting || called) && manage && <Button variant="ghost" onClick={() => act.mutate({ id: e.id, action: "skip" })}>Skip</Button>}
                      {e.status === "SKIPPED" && manage && <Button variant="secondary" onClick={() => act.mutate({ id: e.id, action: "requeue" })}>Requeue</Button>}
                      {(waiting || called || e.status === "SKIPPED") && manage && <Button variant="ghost" onClick={() => { setCancelId(e.id); setReason(""); }}>Cancel</Button>}
                    </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {cancelId && (
        <Modal title="Cancel this visit?" onClose={() => setCancelId(null)}>
          <div className="space-y-3">
            <Field label="Reason"><ReasonSelect reasons={CANCEL_REASONS.visit} onChange={setReason} autoFocus /></Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCancelId(null)}>Keep in queue</Button>
              <Button variant="danger" disabled={reason.trim().length < 3} onClick={() => { act.mutate({ id: cancelId, action: "cancel", body: { reason: reason.trim() } }); setCancelId(null); }}>Cancel visit</Button>
            </div>
          </div>
        </Modal>
      )}
      {vitalsFor && (
        <Modal title={`Vitals: ${vitalsFor.patient}`} onClose={() => setVitalsFor(null)} wide>
          <VitalsCard encounterId={vitalsFor.encounterId} open />
        </Modal>
      )}
    </Gate>
  );
}
