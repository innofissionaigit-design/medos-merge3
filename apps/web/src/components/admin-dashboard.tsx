"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Card } from "@/components/ui";
import { GoToPanel } from "@/components/go-to";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { visibleNav } from "@/lib/nav";

interface Bed { status: string }
interface Board { wards: { id: string; name: string; rooms: { beds: Bed[] }[] }[] }
interface Collections { totals?: { net: string }; days: { net: string }[]; byMode: { method: string; net: string }[] }

const MODE: Record<string, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", BANK_TRANSFER: "Bank transfer", OTHER: "Other" };

function Kpi({ label, value, sub, tone, href }: { label: string; value: string | number | undefined; sub: string; tone: string; href?: string }) {
  const body = (
    <>
      <span className={clsx("absolute inset-x-0 top-0 h-1", tone)} aria-hidden />
      <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      <span className="mt-2 block text-3xl font-semibold tracking-tight tabular-nums text-slate-900">{value ?? <span className="text-slate-400">…</span>}</span>
      <span className="mt-0.5 block truncate text-xs text-slate-500">{sub}</span>
    </>
  );
  const cls = "relative block overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm";
  return href ? <Link href={href} className={clsx(cls, "transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500")}>{body}</Link> : <div className={cls}>{body}</div>;
}

function Attention({ label, detail, count, href, tone }: { label: string; detail: string; count: number | undefined; href: string; tone: "red" | "amber" | "blue" | "green" }) {
  const dot = { red: "bg-red-500", amber: "bg-amber-500", blue: "bg-brand-500", green: "bg-emerald-500" }[tone];
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-slate-50">
      <span className={clsx("h-2.5 w-2.5 shrink-0 rounded-full", count === 0 ? "bg-slate-300" : dot)} aria-hidden />
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-800">{label}</span><span className="block truncate text-xs text-slate-500">{detail}</span></span>
      <span className={clsx("rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums", count ? "bg-slate-100 text-slate-900" : "bg-slate-50 text-slate-400")}>{count ?? "…"}</span>
    </Link>
  );
}

/**
 * The administrator's and manager's start screen: the day's money, what patients still owe, how full the wards are, and the things that need a decision
 * (low stock, planned admissions in the queue, records to complete). Every number links to the page where it is worked on; each panel shows only what the person may read.
 */
export function AdminDashboard() {
  const t = useT();
  const { me, can, money, features, dateTime } = useMe();
  const finance = can("REPORT_READ", "REPORT_FINANCE");
  const col = useQuery({ queryKey: ["adm-col"], queryFn: () => api.get<Collections>("/reports/collections"), enabled: finance, refetchInterval: 30_000 });
  const out = useQuery({ queryKey: ["adm-out"], queryFn: () => api.get<{ total: number; totalDue: string }>("/reports/outstanding-invoices", { pageSize: 1 }), enabled: finance, refetchInterval: 60_000 });
  const opd = useQuery({ queryKey: ["adm-opd"], queryFn: () => api.get<{ total: number }>("/reports/opd/daily"), enabled: can("REPORT_READ", "REPORT_OPD"), refetchInterval: 60_000 });
  const board = useQuery({ queryKey: ["adm-board"], queryFn: () => api.get<Board>("/beds/board"), enabled: can("ADMISSION_READ") && features.IPD_ENABLED !== false, refetchInterval: 30_000 });
  const low = useQuery({ queryKey: ["adm-low"], queryFn: () => api.get<{ rows: unknown[] }>("/reports/pharmacy/low-stock"), enabled: can("REPORT_READ", "REPORT_PHARMACY") && features.PHARMACY_ENABLED !== false });
  const planned = useQuery({ queryKey: ["adm-planned"], queryFn: () => api.get<{ open: number }>("/planned-admissions/summary"), enabled: can("PLANNED_READ"), refetchInterval: 30_000 });
  const records = useQuery({ queryKey: ["adm-records"], queryFn: () => api.get<{ items: { recordComplete: boolean }[] }>("/post-discharge", { show: "RECORDS" }), enabled: can("MRD_RECORD_COMPLETE", "CLAIM_READ", "REPORT_FINANCE") });
  const nav = visibleNav(new Set(me.permissions), features, me.roles).filter((n) => n.href !== "/dashboard");

  const allBeds = (board.data?.wards ?? []).flatMap((w) => w.rooms.flatMap((r) => r.beds));
  const totalBeds = allBeds.length;
  const occupied = allBeds.filter((b) => b.status === "OCCUPIED").length;
  const pct = totalBeds ? Math.round((occupied / totalBeds) * 100) : 0;
  const modes = (col.data?.byMode ?? []).filter((m) => Number(m.net) !== 0);
  const modeMax = Math.max(1, ...modes.map((m) => Number(m.net)));
  const collected = col.data?.days.reduce((n, d) => n + Number(d.net), 0);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{`${t("Welcome")}, ${me.fullName}`}</h1>
          <p className="text-sm text-slate-500">{`${me.facility?.name ?? me.tenant.name} · ${dateTime(new Date().toISOString())}`}</p>
        </div>
        {can("REPORT_READ") && <Link className="whitespace-nowrap rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700" href="/reports">{t("Open reports")}</Link>}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {finance && <Kpi label="Collected today" value={collected === undefined ? undefined : money(collected.toFixed(2))} sub={modes.length ? modes.map((m) => `${MODE[m.method] ?? m.method} ${money(m.net)}`).join(" · ") : "Nothing taken yet"} tone="bg-emerald-500" href="/reports" />}
        {finance && <Kpi label="Outstanding bills" value={out.data ? out.data.total : undefined} sub={out.data ? `${money(out.data.totalDue)} still to collect` : "…"} tone={out.data && out.data.total > 0 ? "bg-amber-500" : "bg-slate-300"} href="/billing" />}
        {can("ADMISSION_READ") && features.IPD_ENABLED !== false && <Kpi label="Bed occupancy" value={board.data ? `${pct}%` : undefined} sub={board.data ? `${occupied} of ${totalBeds} beds occupied` : "…"} tone="bg-brand-500" href="/ipd" />}
        {can("REPORT_READ", "REPORT_OPD") && <Kpi label="OPD visits today" value={opd.data?.total} sub="Patients seen in the outpatient department" tone="bg-violet-500" href="/reports" />}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {board.data && (
          <Card title={t("Beds by ward")} className="lg:col-span-2">
            <ul className="space-y-3">
              {board.data.wards.map((w) => {
                const all = w.rooms.flatMap((r) => r.beds);
                const occ = all.filter((b) => b.status === "OCCUPIED").length;
                const other = all.filter((b) => b.status === "CLEANING" || b.status === "RESERVED" || b.status === "MAINTENANCE").length;
                const share = all.length ? Math.round((occ / all.length) * 100) : 0;
                return (
                  <li key={w.id}>
                    <div className="mb-1 flex items-baseline justify-between text-sm"><span className="font-medium text-slate-800">{w.name}</span><span className="tabular-nums text-slate-500"><b className="text-slate-900">{occ}</b> of {all.length} occupied{other > 0 ? ` · ${other} cleaning or held` : ""}</span></div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${w.name}: ${occ} of ${all.length} beds occupied`}>
                      <span className={clsx("block h-full rounded-full", share >= 90 ? "bg-red-500" : share >= 70 ? "bg-amber-500" : "bg-brand-500")} style={{ width: `${Math.max(share, occ > 0 ? 3 : 0)}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
        <Card title={t("Needs attention")} className={board.data ? "" : "lg:col-span-3"}>
          <div className="-mx-2 divide-y divide-slate-100">
            {finance && <Attention label="Bills still owing" detail={out.data ? `${money(out.data.totalDue)} to collect` : "…"} count={out.data?.total} href="/billing" tone="amber" />}
            {can("REPORT_READ", "REPORT_PHARMACY") && features.PHARMACY_ENABLED !== false && <Attention label="Low-stock medicines" detail="At or below the reorder level" count={low.data?.rows.length} href="/procurement" tone="red" />}
            {can("PLANNED_READ") && <Attention label="Planned admissions open" detail="Not yet admitted" count={planned.data?.open} href="/planned" tone="blue" />}
            {records.data && <Attention label="Records to complete" detail="Discharged stays not signed off" count={records.data.items.filter((r) => !r.recordComplete).length} href="/post-discharge" tone="blue" />}
          </div>
        </Card>
      </div>

      {finance && modes.length > 0 && (
        <Card title={t("Collected today, by payment mode")} className="mt-4">
          <ul className="space-y-2.5">
            {modes.map((m) => (
              <li key={m.method} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-sm text-slate-700">{MODE[m.method] ?? m.method}</span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100"><span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(4, Math.round((Number(m.net) / modeMax) * 100))}%` }} /></span>
                <span className="w-28 shrink-0 text-right text-sm font-semibold tabular-nums text-slate-900">{money(m.net)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <GoToPanel items={nav} />
    </>
  );
}
