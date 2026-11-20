"use client";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { PlanBadge, type PlanRow } from "@/components/planned";
import { Card, ErrorNote, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Bed { id: string; code: string; status: string; dailyRate: string }
interface Board { wards: { id: string; name: string; code: string; rooms: { name: string; beds: Bed[] }[] }[] }
type Filter = "AVAILABLE" | "OCCUPIED" | "RESERVED" | "ATTENTION" | "WAITING" | null;

/** What each bed status looks like on the bed map: label, tile colours and the dot used in the legend. */
const LOOK: Record<string, { label: string; tile: string; dot: string }> = {
  AVAILABLE: { label: "Free", tile: "border-emerald-300 bg-emerald-50 text-emerald-800", dot: "bg-emerald-500" },
  OCCUPIED: { label: "Occupied", tile: "border-slate-300 bg-slate-100 text-slate-700", dot: "bg-slate-500" },
  RESERVED: { label: "Held for a patient", tile: "border-purple-300 bg-purple-50 text-purple-800", dot: "bg-purple-500" },
  CLEANING: { label: "Being cleaned", tile: "border-amber-300 bg-amber-50 text-amber-800", dot: "bg-amber-400" },
  MAINTENANCE: { label: "Under repair", tile: "border-rose-300 bg-rose-50 text-rose-800", dot: "bg-rose-400" },
};
const matches = (f: Filter, s: string): boolean => f === null || f === "WAITING" || s === f || (f === "ATTENTION" && (s === "CLEANING" || s === "MAINTENANCE"));

function Icon({ name }: { name: "bed" | "check" | "lock" | "tool" | "clock" }) {
  const d: Record<string, ReactNode> = {
    bed: <path d="M3 18V7M3 14h18v4M21 14v-2.5A3.5 3.5 0 0 0 17.5 8H11v6M7 11.5h.01" />,
    check: <path d="m5 12 4.5 4.5L19 7" />,
    lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
    tool: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d[name]}</svg>;
}

function Tile({ id, label, value, sub, icon, tone, active, onSelect }: { id: Exclude<Filter, null>; label: string; value: number | undefined; sub: string; icon: "bed" | "check" | "lock" | "tool" | "clock"; tone: string; active: boolean; onSelect: (f: Exclude<Filter, null>) => void }) {
  const t = useT();
  return (
    <button type="button" onClick={() => onSelect(id)} aria-pressed={active} className={clsx("group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200")}>
      <span className={clsx("absolute inset-x-0 top-0 h-1", tone)} aria-hidden />
      <span className="flex items-center justify-between text-slate-500"><span className="text-xs font-medium uppercase tracking-wide">{t(label)}</span><span className={clsx("flex h-8 w-8 items-center justify-center rounded-lg bg-slate-50 group-hover:bg-slate-100", active && "bg-brand-50 text-brand-700")}><Icon name={icon} /></span></span>
      <span className="mt-2 block text-3xl font-semibold tracking-tight text-slate-900">{value ?? <span className="text-slate-400">…</span>}</span>
      <span className="mt-0.5 block text-xs text-slate-500">{t(sub)}</span>
    </button>
  );
}

/** A ring showing how full the hospital is: the share of beds with a patient in them. */
function Ring({ pct, occupied, total }: { pct: number; occupied: number; total: number }) {
  const r = 42, c = 2 * Math.PI * r;
  return (
    <div className="relative h-32 w-32 shrink-0" role="img" aria-label={`${pct} percent of beds occupied: ${occupied} of ${total}`}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="10" className="stroke-slate-100" />
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="10" strokeLinecap="round" className="stroke-brand-600 transition-all" strokeDasharray={`${(pct / 100) * c} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-3xl font-semibold text-slate-900">{pct}%</span><span className="text-xs text-slate-500">{`${occupied} of ${total} beds`}</span></div>
    </div>
  );
}

/**
 * The bed manager's own start screen: a ring of how full the hospital is, tiles that filter a live bed map (so a click stays here and shows only beds), the planned admissions
 * waiting for a bed (the thing this role must act on) and the beds already held for a coming day. Holding a bed is still done on the request, with all its checks.
 */
export function BedManagerDashboard() {
  const t = useT();
  const { me, date, dateTime } = useMe();
  const [filter, setFilter] = useState<Filter>(null);
  const waitingRef = useRef<HTMLDivElement>(null);
  const board = useQuery({ queryKey: ["bm-board"], queryFn: () => api.get<Board>("/beds/board"), refetchInterval: 20_000 });
  const waiting = useQuery({ queryKey: ["bm-waiting"], queryFn: () => api.page<PlanRow>("/planned-admissions", { status: "BED_ALLOCATION", pageSize: 50 }), refetchInterval: 20_000 });
  const held = useQuery({ queryKey: ["bm-held"], queryFn: () => api.page<PlanRow>("/planned-admissions", { status: "READY", pageSize: 50 }), refetchInterval: 20_000 });

  const counts: Record<string, number> = {};
  board.data?.wards.forEach((w) => w.rooms.forEach((r) => r.beds.forEach((b) => { counts[b.status] = (counts[b.status] ?? 0) + 1; })));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const occupied = counts.OCCUPIED ?? 0;
  const pct = total > 0 ? Math.round((occupied / total) * 100) : 0;
  const waitingN = waiting.data?.meta.total;
  const pick = (f: Exclude<Filter, null>) => {
    setFilter((cur) => (cur === f ? null : f));
    if (f === "WAITING") waitingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const bedsShown = board.data ? board.data.wards.reduce((n, w) => n + w.rooms.reduce((m, r) => m + r.beds.filter((b) => filter !== null && filter !== "WAITING" && matches(filter, b.status)).length, 0), 0) : 0;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{`${t("Welcome")}, ${me.fullName}`}</h1>
          <p className="text-sm text-slate-500">{`${me.tenant.name} · ${t("Beds and planned admissions")} · ${dateTime(new Date().toISOString())}`}</p>
        </div>
        <Link className="whitespace-nowrap rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700" href="/planned">{t("Planned admissions")}</Link>
      </div>
      <ErrorNote error={board.error ?? waiting.error ?? held.error} />

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile id="AVAILABLE" label="Free beds" value={board.data ? counts.AVAILABLE ?? 0 : undefined} sub="Ready for a patient" icon="check" tone="bg-emerald-500" active={filter === "AVAILABLE"} onSelect={pick} />
          <Tile id="OCCUPIED" label="Occupied" value={board.data ? occupied : undefined} sub="With a patient now" icon="bed" tone="bg-slate-500" active={filter === "OCCUPIED"} onSelect={pick} />
          <Tile id="RESERVED" label="Held for a patient" value={board.data ? counts.RESERVED ?? 0 : undefined} sub="For a planned admission" icon="lock" tone="bg-purple-500" active={filter === "RESERVED"} onSelect={pick} />
          <Tile id="ATTENTION" label="Cleaning or repair" value={board.data ? (counts.CLEANING ?? 0) + (counts.MAINTENANCE ?? 0) : undefined} sub="Not usable yet" icon="tool" tone="bg-amber-400" active={filter === "ATTENTION"} onSelect={pick} />
          <Tile id="WAITING" label="Waiting for a bed" value={waitingN} sub="Needs your action" icon="clock" tone="bg-brand-600" active={filter === "WAITING"} onSelect={pick} />
        </div>
        <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:min-w-[19rem]">
          {board.data ? <Ring pct={pct} occupied={occupied} total={total} /> : <Spinner />}
          <div className="text-sm">
            <div className="font-semibold text-slate-900">{t("Bed occupancy")}</div>
            <ul className="mt-2 space-y-1 text-xs text-slate-600">
              {(["AVAILABLE", "OCCUPIED", "RESERVED", "CLEANING", "MAINTENANCE"] as const).map((s) => <li key={s} className="flex items-center gap-2"><i className={clsx("h-2 w-2 rounded-full", LOOK[s]!.dot)} aria-hidden />{`${t(LOOK[s]!.label)}: ${counts[s] ?? 0}`}</li>)}
            </ul>
          </div>
        </div>
      </div>

      <div ref={waitingRef} className="scroll-mt-4">
        <Card title={t("Waiting for a bed")} className={clsx("mt-4", filter === "WAITING" && "ring-2 ring-brand-500/40")}>
          {waiting.isLoading ? <Spinner /> : (
            <Table head={["Request", "Patient", "Doctor", "Room asked", "Day", ""]} {...(waiting.data?.data.length === 0 ? { empty: "No request is waiting for a bed. Billing clears the deposit first, then the request appears here." } : {})}>
              {waiting.data?.data.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td><Link className="font-medium text-brand-700 hover:underline" href={`/planned/${r.id}`}>{r.requestNumber}</Link></Td>
                  <Td>{r.patient.name}<div className="text-xs text-slate-500">{r.patient.mrn}</div></Td>
                  <Td>{r.consultant.name}</Td>
                  <Td>{r.ward ?? "—"}</Td>
                  <Td>{r.proposedDate ? date(r.proposedDate) : "—"}</Td>
                  <Td><Link className="whitespace-nowrap rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700" href={`/planned/${r.id}`}>{t("Hold a bed")}</Link></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card title={t("Bed map")} className="mt-4" actions={filter && filter !== "WAITING" ? <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setFilter(null)}>{`${t("Showing")}: ${filter === "ATTENTION" ? t("Cleaning or repair") : t(LOOK[filter]?.label ?? "")} (${bedsShown}) · ${t("Show all")}`}</button> : undefined}>
        {board.isLoading ? <Spinner /> : (
          <div className="space-y-5">
            {board.data?.wards.map((w) => {
              const beds = w.rooms.flatMap((r) => r.beds.map((b) => ({ ...b, room: r.name })));
              const free = beds.filter((b) => b.status === "AVAILABLE").length;
              return (
                <section key={w.id} aria-label={w.name}>
                  <div className="mb-2 flex items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">{w.name}</h3>
                    <span className="text-xs text-slate-500">{`${free} ${t("free")} · ${beds.length} ${t("beds")}`}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {beds.map((b) => (
                      <span key={b.id} title={`${b.code} · ${b.room} · ${LOOK[b.status]?.label ?? b.status}`} className={clsx("flex h-11 min-w-[3.25rem] flex-col items-center justify-center rounded-lg border px-2 text-xs font-semibold transition", LOOK[b.status]?.tile ?? "border-slate-200 bg-white text-slate-700", filter !== null && filter !== "WAITING" && !matches(filter, b.status) && "opacity-25")}>
                        {b.code}
                        <span className="text-[10px] font-normal opacity-70">{LOOK[b.status]?.label.split(" ")[0]}</span>
                      </span>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </Card>

      <Card title={t("Beds held for a coming day")} className="mt-4">
        {held.isLoading ? <Spinner /> : held.data?.data.length === 0 ? <p className="text-sm text-slate-500">{t("No bed is being held for a planned admission.")}</p> : (
          <ul className="divide-y divide-slate-100">
            {held.data?.data.map((r) => (
              <li key={r.id}>
                <Link href={`/planned/${r.id}`} className="flex items-center justify-between gap-3 py-2 hover:bg-slate-50">
                  <span className="min-w-0"><span className="font-medium">{r.patient.name}</span><span className="block text-xs text-slate-500">{`${r.requestNumber} · ${r.proposedDate ? date(r.proposedDate) : "no day"}`}</span></span>
                  <span className="flex items-center gap-2"><span className="rounded bg-purple-50 px-2 py-0.5 text-sm font-medium text-purple-700">{r.bed ?? "—"}</span><PlanBadge status={r.status} /></span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
