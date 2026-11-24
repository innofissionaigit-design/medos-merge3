"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Badge, Button, Card, ErrorNote, PageHeader, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { localeFor, useI18n, useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Turnover { id: string; bed: string; ward: string; room: string; stage: "VACATED" | "CLEANING" | "READY"; vacatedAt: string; cleaningStartedBy: string | null; readyAt: string | null; minutesToReady: number | null }
interface Req { id: string; kind: string; priority: "ROUTINE" | "URGENT"; location: string; description: string | null; status: "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED"; requestedAt: string }

const KIND: Record<string, string> = { CLEANING: "Cleaning", MAINTENANCE: "Repair or maintenance", WASTE: "Waste pick-up", LINEN: "Linen", OTHER: "Something else" };

function Icon({ name }: { name: "bed" | "broom" | "alert" | "check" }) {
  const d: Record<string, ReactNode> = {
    bed: <path d="M3 18V7M3 14h18v4M21 14v-2.5A3.5 3.5 0 0 0 17.5 8H11v6M7 11.5h.01" />,
    broom: <path d="M14 3l7 7M12.5 8.5 4 17l3 3 8.5-8.5M6 15l3 3" />,
    alert: <><path d="M12 4 3 20h18L12 4z" /><path d="M12 10v4M12 17.5h.01" /></>,
    check: <path d="m5 12 4.5 4.5L19 7" />,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d[name]}</svg>;
}

function Tile({ label, value, sub, icon, tone, href }: { label: string; value: number | undefined; sub: string; icon: "bed" | "broom" | "alert" | "check"; tone: string; href: string }) {
  const t = useT();
  return (
    <Link href={href} className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
      <span className={clsx("absolute inset-x-0 top-0 h-1", tone)} aria-hidden />
      <span className="flex items-center justify-between text-slate-500"><span className="text-xs font-medium uppercase tracking-wide">{t(label)}</span><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-50 group-hover:bg-slate-100"><Icon name={icon} /></span></span>
      <span className="mt-2 block text-3xl font-semibold tracking-tight text-slate-900">{value ?? <span className="text-slate-400">…</span>}</span>
      <span className="mt-0.5 block text-xs text-slate-500">{t(sub)}</span>
    </Link>
  );
}

/**
 * The housekeeping staff's own start screen: how many beds are waiting to be turned around, how many cleaning and repair jobs are open (urgent first),
 * what was made ready today, and the work to do now with its action beside it. Beds and places only: housekeeping never sees a patient.
 */
export function HousekeepingDashboard() {
  const t = useT();
  const { lang } = useI18n();
  const { me, can, dateTime } = useMe();
  const qc = useQueryClient();
  const bedWork = can("BED_HOUSEKEEPING");
  const jobWork = can("HOUSEKEEPING_MANAGE");
  const beds = useQuery({ queryKey: ["bed-turnovers"], queryFn: () => api.get<Turnover[]>("/bed-turnovers"), refetchInterval: 15_000, enabled: bedWork });
  const reqs = useQuery({ queryKey: ["housekeeping-requests"], queryFn: () => api.get<Req[]>("/housekeeping/requests"), refetchInterval: 20_000, enabled: can("HOUSEKEEPING_REQUEST", "HOUSEKEEPING_MANAGE") });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["bed-turnovers"] }); void qc.invalidateQueries({ queryKey: ["housekeeping-requests"] }); };
  const startBed = useMutation({ mutationFn: (id: string) => api.post(`/bed-turnovers/${id}/start`, {}), onSuccess: refresh });
  const readyBed = useMutation({ mutationFn: (id: string) => api.post(`/bed-turnovers/${id}/ready`, {}), onSuccess: refresh });
  const startJob = useMutation({ mutationFn: (id: string) => api.post(`/housekeeping/requests/${id}/start`, {}), onSuccess: refresh });
  const doneJob = useMutation({ mutationFn: (id: string) => api.post(`/housekeeping/requests/${id}/done`, {}), onSuccess: refresh });

  const turnovers = beds.data ?? [];
  const openBeds = turnovers.filter((r) => r.stage !== "READY");
  const readyBeds = turnovers.filter((r) => r.stage === "READY");
  const jobs = (reqs.data ?? []).filter((r) => r.status === "OPEN" || r.status === "IN_PROGRESS");
  const urgent = jobs.filter((r) => r.priority === "URGENT");
  const avg = readyBeds.length > 0 ? Math.round(readyBeds.reduce((a, r) => a + (r.minutesToReady ?? 0), 0) / readyBeds.length) : null;
  const ago = (iso: string) => `${Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))} min ago`;
  const today = new Intl.DateTimeFormat(localeFor(lang), { dateStyle: "full", timeZone: me.facility?.timezone ?? me.tenant.timezone }).format(new Date());
  const loading = (bedWork && beds.isLoading) || reqs.isLoading;
  const nothing = openBeds.length === 0 && jobs.length === 0;

  return (
    <>
      <PageHeader title={`${t("Welcome,")} ${me.fullName}`} subtitle={`${me.facility?.name ?? ""} · ${today}`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {bedWork && <Tile label="Beds to turn around" value={beds.data ? openBeds.length : undefined} sub="Vacated or being cleaned" icon="bed" tone="bg-amber-400" href="/housekeeping" />}
        <Tile label="Open jobs" value={reqs.data ? jobs.length : undefined} sub="Cleaning and repair requests" icon="broom" tone="bg-sky-500" href="/housekeeping" />
        <Tile label="Urgent" value={reqs.data ? urgent.length : undefined} sub="Do these first" icon="alert" tone="bg-rose-500" href="/housekeeping" />
        {bedWork && <Tile label="Made ready" value={beds.data ? readyBeds.length : undefined} sub={avg !== null ? `Average ${avg} min per bed` : "Last 24 hours"} icon="check" tone="bg-emerald-500" href="/housekeeping" />}
      </div>

      <Card title={t("Work to do now")} className="mt-4" actions={<Link href="/housekeeping" className="text-sm text-brand-700 hover:underline">{t("Open housekeeping")}</Link>}>
        {loading ? <Spinner /> : nothing ? (
          <div className="flex items-center gap-3 rounded-lg bg-emerald-50 px-4 py-6 text-emerald-800">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100"><Icon name="check" /></span>
            <div><div className="font-medium">{t("All clear")}</div><div className="text-sm text-emerald-700">{t("No beds waiting and no open jobs. New work appears here by itself.")}</div></div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {bedWork && openBeds.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-700"><Icon name="bed" /></span>
                  <div>
                    <div className="font-medium text-slate-900">{t("Bed")} {r.bed} <span className="font-normal text-slate-500">· {r.ward} · {r.room}</span></div>
                    <div className="text-xs text-slate-500">{t("Vacated")} {dateTime(r.vacatedAt)} ({ago(r.vacatedAt)}){r.cleaningStartedBy ? ` · ${t("started by")} ${r.cleaningStartedBy}` : ""}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {r.stage === "VACATED" ? <Badge tone="red">vacated</Badge> : <Badge tone="amber">cleaning</Badge>}
                  {r.stage === "VACATED"
                    ? <Button variant="secondary" loading={startBed.isPending && startBed.variables === r.id} onClick={() => startBed.mutate(r.id)}>Start cleaning</Button>
                    : <Button loading={readyBed.isPending && readyBed.variables === r.id} onClick={() => readyBed.mutate(r.id)}>Mark ready</Button>}
                </div>
              </li>
            ))}
            {jobs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-3">
                  <span className={clsx("flex h-10 w-10 items-center justify-center rounded-lg", r.priority === "URGENT" ? "bg-rose-50 text-rose-700" : "bg-sky-50 text-sky-700")}><Icon name="broom" /></span>
                  <div>
                    <div className="font-medium text-slate-900">{t(KIND[r.kind] ?? r.kind)} <span className="font-normal text-slate-500">· {r.location}</span></div>
                    <div className="text-xs text-slate-500">{r.description ? `${r.description} · ` : ""}{t("Asked")} {dateTime(r.requestedAt)} ({ago(r.requestedAt)})</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {r.priority === "URGENT" && <Badge tone="red">urgent</Badge>}
                  <Badge tone={r.status === "OPEN" ? "red" : "amber"}>{r.status === "IN_PROGRESS" ? "in progress" : "open"}</Badge>
                  {jobWork && (r.status === "OPEN"
                    ? <Button variant="secondary" loading={startJob.isPending && startJob.variables === r.id} onClick={() => startJob.mutate(r.id)}>Start</Button>
                    : <Button loading={doneJob.isPending && doneJob.variables === r.id} onClick={() => doneJob.mutate(r.id)}>Done</Button>)}
                </div>
              </li>
            ))}
          </ul>
        )}
        <ErrorNote error={startBed.error ?? readyBed.error ?? startJob.error ?? doneJob.error} />
        <p className="mt-3 text-xs text-slate-500">{t("Housekeeping sees beds and places only, never the patient.")}</p>
      </Card>

      {bedWork && readyBeds.length > 0 && (
        <Card title={t("Made ready in the last 24 hours")} className="mt-4">
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {readyBeds.slice(0, 6).map((r) => (
              <li key={r.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span><b>{r.bed}</b> <span className="text-slate-500">· {r.ward}</span></span>
                <span className="text-xs text-emerald-700">{r.readyAt ? dateTime(r.readyAt) : ""}{r.minutesToReady !== null ? ` · ${r.minutesToReady} min` : ""}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
