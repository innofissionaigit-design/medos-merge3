"use client";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Gate } from "@/components/gate";
import { HousekeepingRequests } from "@/components/housekeeping-requests";
import { Badge, Button, Card, ErrorNote, PageHeader, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { T, useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Turnover { id: string; bed: string; ward: string; room: string; stage: "VACATED" | "CLEANING" | "READY"; autoReady: boolean; vacatedAt: string; cleaningStartedAt: string | null; cleaningStartedBy: string | null; readyAt: string | null; readyBy: string | null; minutesToReady: number | null }
interface Job { status: "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED"; priority: "ROUTINE" | "URGENT" }

function Stat({ label, value, sub, tone }: { label: string; value: number | undefined; sub: string; tone: string }) {
  const t = useT();
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <span className={clsx("absolute inset-x-0 top-0 h-1", tone)} aria-hidden />
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{t(label)}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value ?? <span className="text-slate-400">…</span>}</div>
      <div className="mt-0.5 text-xs text-slate-500">{t(sub)}</div>
    </div>
  );
}

/** The three steps of a bed turnaround, with the current one marked: vacated, cleaning, ready. */
function Steps({ stage }: { stage: Turnover["stage"] }): ReactNode {
  const order = ["VACATED", "CLEANING", "READY"] as const;
  const at = order.indexOf(stage);
  return (
    <ol className="flex items-center gap-1.5 text-xs" aria-label="Turnaround progress">
      {order.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className={clsx("rounded-full px-2 py-0.5 font-medium", i < at ? "bg-emerald-50 text-emerald-700" : i === at ? (s === "VACATED" ? "bg-rose-50 text-rose-700" : s === "CLEANING" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700") : "bg-slate-100 text-slate-400")}>{s === "VACATED" ? "Vacated" : s === "CLEANING" ? "Cleaning" : "Ready"}</span>
          {i < order.length - 1 && <span className="text-slate-300" aria-hidden>›</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * Housekeeping (docs/discharge-stages.md, bed turnover): the beds vacated by a discharge, oldest first: start cleaning, then mark ready, which makes the
 * bed available again. Beds only: housekeeping never sees who the patient was. Cleaning and repair requests sit beside them.
 */
export default function HousekeepingPage() {
  const { dateTime, can } = useMe();
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["bed-turnovers"], queryFn: () => api.get<Turnover[]>("/bed-turnovers"), refetchInterval: 15_000, enabled: can("BED_HOUSEKEEPING") });
  const jobs = useQuery({ queryKey: ["housekeeping-requests"], queryFn: () => api.get<Job[]>("/housekeeping/requests"), refetchInterval: 20_000, enabled: can("HOUSEKEEPING_REQUEST", "HOUSEKEEPING_MANAGE") });
  const done = () => { void qc.invalidateQueries({ queryKey: ["bed-turnovers"] }); };
  const start = useMutation({ mutationFn: (id: string) => api.post(`/bed-turnovers/${id}/start`, {}), onSuccess: done });
  const ready = useMutation({ mutationFn: (id: string) => api.post(`/bed-turnovers/${id}/ready`, {}), onSuccess: done });
  const rows = q.data ?? [];
  const open = rows.filter((r) => r.stage !== "READY");
  const recent = rows.filter((r) => r.stage === "READY");
  const openJobs = (jobs.data ?? []).filter((r) => r.status === "OPEN" || r.status === "IN_PROGRESS");
  const urgent = openJobs.filter((r) => r.priority === "URGENT").length;
  const avg = recent.length > 0 ? Math.round(recent.reduce((a, r) => a + (r.minutesToReady ?? 0), 0) / recent.length) : null;
  const ago = (iso: string) => `${Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))} min ago`;
  const bedWork = can("BED_HOUSEKEEPING");
  return (
    <Gate anyOf={["BED_HOUSEKEEPING", "HOUSEKEEPING_REQUEST", "HOUSEKEEPING_MANAGE"]} feature="IPD_ENABLED">
      <PageHeader title="Housekeeping" subtitle="Bed turnaround, cleaning and repair jobs. Beds and places only, never the patient." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {bedWork && <Stat label="Beds to turn around" value={q.data ? open.length : undefined} sub="Vacated or being cleaned" tone="bg-amber-400" />}
        <Stat label="Open jobs" value={jobs.data ? openJobs.length : undefined} sub="Cleaning and repair requests" tone="bg-sky-500" />
        <Stat label="Urgent" value={jobs.data ? urgent : undefined} sub="Do these first" tone="bg-rose-500" />
        {bedWork && <Stat label="Made ready" value={q.data ? recent.length : undefined} sub={avg !== null ? `Average ${avg} min per bed` : "Last 24 hours"} tone="bg-emerald-500" />}
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {bedWork && (
          <div className="space-y-4">
            <Card title={`${t("Beds to turn around")} (${open.length})`}>
              {q.isLoading ? <Spinner /> : open.length === 0 ? (
                <p className="rounded-lg bg-emerald-50 px-4 py-5 text-sm text-emerald-800"><T>No beds waiting. Every vacated bed is ready.</T></p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {open.map((r) => (
                    <li key={r.id} data-testid="turnover-row" className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="space-y-1.5">
                        <div className="font-medium text-slate-900"><b>{r.bed}</b> <span className="font-normal text-slate-500">· {r.ward} · {r.room}</span></div>
                        <Steps stage={r.stage} />
                        <div className="text-xs text-slate-500"><T>Vacated</T> {dateTime(r.vacatedAt)} ({ago(r.vacatedAt)}){r.cleaningStartedBy ? <> · <T>started by</T> {r.cleaningStartedBy}</> : null}</div>
                      </div>
                      {r.stage === "VACATED"
                        ? <Button variant="secondary" loading={start.isPending && start.variables === r.id} onClick={() => start.mutate(r.id)}>Start cleaning</Button>
                        : <Button loading={ready.isPending && ready.variables === r.id} onClick={() => ready.mutate(r.id)}>Mark ready</Button>}
                    </li>
                  ))}
                </ul>
              )}
              <ErrorNote error={start.error ?? ready.error} />
              <p className="mt-3 text-xs text-slate-500"><T>Vacated, cleaning, ready: start the cleaning when you begin, mark the bed ready when it can take the next patient. Ready makes the bed available.</T></p>
            </Card>
            {recent.length > 0 && (
              <Card title={t("Made ready in the last 24 hours")}>
                <ul className="divide-y divide-slate-100">
                  {recent.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                      <span><b>{r.bed}</b> <span className="text-slate-500">· {r.ward} · {r.room}</span></span>
                      <span className="flex items-center gap-2 text-xs text-slate-500">
                        <Badge tone="green">ready</Badge>
                        {r.readyAt ? dateTime(r.readyAt) : "—"}{r.minutesToReady !== null ? ` · ${r.minutesToReady} min` : ""} · {r.autoReady ? "automatic" : r.readyBy ?? "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
        <div className={bedWork ? "" : "lg:col-span-2"}><HousekeepingRequests /></div>
      </div>
    </Gate>
  );
}
