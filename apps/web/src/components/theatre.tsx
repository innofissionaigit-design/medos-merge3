"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Badge, Card, Pager, Spinner, Tabs } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

type View = "OPEN" | "TODAY" | "DONE" | "CANCELLED" | "ALL";
interface Row {
  id: string; name: string; status: "PLANNED" | "PERFORMED" | "FINALISED" | "CANCELLED"; scheduledAt: string | null; overdue: boolean; surgeonName: string | null; notes: string | null; items: number;
  performedAt: string | null; finalisedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
  patient: { id: string; name: string; mrn: string | null }; admission: { id: string; number: string | null; open: boolean; bed: string | null; ward: string | null };
}
interface Board { summary: { planned: number; performed: number; today: number; finalisedWeek: number }; total: number; rows: Row[] }
interface Bed { id: string; code: string; status: string }
interface WardBoard { wards: { id: string; name: string; code: string; rooms: { name: string; beds: Bed[] }[] }[] }

const PAGE_SIZE = 20;
const TABS: { id: View; label: string }[] = [{ id: "OPEN", label: "To do" }, { id: "TODAY", label: "Today" }, { id: "DONE", label: "Finalised" }, { id: "CANCELLED", label: "Cancelled" }, { id: "ALL", label: "All" }];
const STATUS = { PLANNED: { tone: "amber", label: "planned" }, PERFORMED: { tone: "blue", label: "performed: to finalise" }, FINALISED: { tone: "green", label: "finalised" }, CANCELLED: { tone: "gray", label: "cancelled" } } as const;
const ROOM = { AVAILABLE: ["Free", "border-emerald-300 bg-emerald-50 text-emerald-800"], OCCUPIED: ["In use", "border-slate-300 bg-slate-100 text-slate-700"], CLEANING: ["Cleaning", "border-amber-300 bg-amber-50 text-amber-800"], RESERVED: ["Held", "border-purple-300 bg-purple-50 text-purple-800"], MAINTENANCE: ["Repair", "border-rose-300 bg-rose-50 text-rose-800"] } as Record<string, [string, string]>;

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub: string; tone: string }) {
  const t = useT();
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <span className={clsx("absolute inset-x-0 top-0 h-1", tone)} aria-hidden />
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{t(label)}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{t(sub)}</div>
    </div>
  );
}

/** The theatre rooms: each bed of the operation-theatre ward as a tile in the colour of its status. */
function Rooms() {
  const t = useT();
  const q = useQuery({ queryKey: ["theatre-rooms"], queryFn: () => api.get<WardBoard>("/beds/board"), refetchInterval: 20_000 });
  const beds = (q.data?.wards ?? []).filter((w) => w.code.toUpperCase() === "OT").flatMap((w) => w.rooms.flatMap((r) => r.beds.map((b) => ({ ...b, room: r.name }))));
  return (
    <Card title={t("Theatre rooms")}>
      {q.isLoading ? <Spinner /> : beds.length === 0 ? <p className="text-sm text-slate-500">{t("No theatre rooms are set up.")}</p> : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {beds.map((b) => {
            const [label, cls] = ROOM[b.status] ?? [b.status.toLowerCase(), "border-slate-300 bg-slate-50 text-slate-700"];
            return <li key={b.id} className={clsx("rounded-lg border px-3 py-2.5", cls)}><div className="flex items-center justify-between"><b>{b.code}</b><span className="text-xs font-medium">{t(label)}</span></div><div className="text-xs opacity-80">{b.room}</div></li>;
          })}
        </ul>
      )}
    </Card>
  );
}

export function TheatreBoard() {
  const t = useT();
  const { dateTime } = useMe();
  const [view, setView] = useState<View>("OPEN");
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ["theatre-board", view, page], queryFn: () => api.get<Board>("/procedures", { view, page, pageSize: PAGE_SIZE }), refetchInterval: 20_000 });
  const s = q.data?.summary;
  const rows = q.data?.rows ?? [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Planned" value={s ? s.planned : "…"} sub="Not yet performed" tone="bg-amber-400" />
        <Stat label="To finalise" value={s ? s.performed : "…"} sub="Performed, record open" tone="bg-sky-500" />
        <Stat label="Today" value={s ? s.today : "…"} sub="Scheduled for today" tone="bg-brand-500" />
        <Stat label="Finalised" value={s ? s.finalisedWeek : "…"} sub="In the last 7 days" tone="bg-emerald-500" />
      </div>
      <Rooms />
      <div>
        <Tabs tabs={TABS} value={view} onChange={(v) => { setView(v); setPage(1); }} />
        {q.isLoading ? <Spinner /> : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">{t(view === "OPEN" ? "Nothing is waiting: every planned procedure is finalised." : "No procedures here.")}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => {
              const st = STATUS[r.status];
              return (
                <li key={r.id} data-testid="theatre-row" className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="w-28 shrink-0 text-sm"><div className="font-semibold text-slate-900">{r.scheduledAt ? dateTime(r.scheduledAt) : <span className="font-normal text-slate-500">{t("No time set")}</span>}</div>{r.overdue && <Badge tone="red">late</Badge>}</div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-slate-900">{r.name}</span><Badge tone={st.tone}>{st.label}</Badge>{r.items > 0 && <span className="text-xs text-slate-500">{r.items} {t("item(s) recorded")}</span>}</div>
                      <div className="mt-0.5 text-sm text-slate-700"><Link href={`/patients/${r.patient.id}`} className="font-medium text-brand-700 hover:underline">{r.patient.name}</Link>{r.patient.mrn && <span className="ml-1 text-xs text-slate-500">{r.patient.mrn}</span>}{r.surgeonName && <span className="text-slate-500"> · {t("Surgeon")} {r.surgeonName}</span>}</div>
                      <div className="text-xs text-slate-500">{r.admission.bed ? `${r.admission.bed}${r.admission.ward ? ` · ${r.admission.ward}` : ""}` : t("Not in a bed")}{r.admission.number ? ` · ${r.admission.number}` : ""}</div>
                      {r.notes && <div className="mt-1 text-xs text-slate-600">{r.notes}</div>}
                      {r.status === "CANCELLED" && r.cancelReason && <div className="mt-1 text-xs text-slate-600">{t("Cancelled")}: {r.cancelReason}</div>}
                    </div>
                  </div>
                  <Link href={`/ipd/${r.admission.id}`} className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-brand-400 hover:text-brand-700">{t("Open admission")}</Link>
                </li>
              );
            })}
          </ul>
        )}
        <Pager page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onPage={setPage} />
      </div>
    </div>
  );
}
