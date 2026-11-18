"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ErrorNote, PageHeader, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { todayIn } from "@/components/pickers";
import { Dispense, type QOrder } from "./pharmacy-dispense";
import { Icon, type IconName, KBD, PANEL, useDeskKeys } from "./desk-ui";

interface LowRow { medicineId: string; medicine: string; quantity: number; reorderLevel: number }
interface ExpiryRow { batchId: string; place: string; medicine: string; batchNo: string; expiryDate: string; quantity: number; expired: boolean }
interface SalesReport { totals: { dispenses: number; gross: string; returns: string; net: string } }

/** Muted accent per shortcut: the icon chip and the hover highlight. Full class names so Tailwind keeps them. */
const ACCENTS: Record<string, { chip: string; hover: string }> = {
  sale: { chip: "bg-blue-50 text-blue-600", hover: "hover:border-blue-300" },
  medicine: { chip: "bg-teal-50 text-teal-600", hover: "hover:border-teal-300" },
  inventory: { chip: "bg-indigo-50 text-indigo-600", hover: "hover:border-indigo-300" },
  low: { chip: "bg-amber-50 text-amber-600", hover: "hover:border-amber-300" },
  expiry: { chip: "bg-rose-50 text-rose-600", hover: "hover:border-rose-300" },
  reports: { chip: "bg-emerald-50 text-emerald-600", hover: "hover:border-emerald-300" },
};

/**
 * The pharmacist's own start screen: what needs attention now (prescriptions waiting, stock running low, stock expiring), one-key shortcuts to the
 * places used most, and the three short lists behind those numbers. It only reads what the pharmacy screens already show; nothing new is stored.
 */
export function PharmacyDashboard() {
  const t = useT();
  const router = useRouter();
  const { me, can, money, date, dateTime } = useMe();
  const qc = useQueryClient();
  const [dispensing, setDispensing] = useState<QOrder | null>(null);
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const today = todayIn(tz);
  const reports = can("REPORT_READ", "REPORT_PHARMACY");
  const queue = useQuery({ queryKey: ["pharmacy-queue"], queryFn: () => api.page<QOrder>("/pharmacy/queue", { pageSize: 50 }), enabled: can("PRESCRIPTION_READ", "PHARMACY_READ"), refetchInterval: 20_000 });
  const low = useQuery({ queryKey: ["ph-low"], queryFn: () => api.get<{ rows: LowRow[] }>("/reports/pharmacy/low-stock"), enabled: reports, refetchInterval: 60_000 });
  const expiry = useQuery({ queryKey: ["ph-expiry"], queryFn: () => api.get<{ withinDays: number; rows: ExpiryRow[] }>("/reports/pharmacy/near-expiry"), enabled: reports, refetchInterval: 60_000 });
  const sales = useQuery({ queryKey: ["ph-sales", today], queryFn: () => api.get<SalesReport>("/reports/pharmacy/sales", { from: today, to: today }), enabled: reports, refetchInterval: 60_000 });

  const orders = queue.data?.data ?? [];
  const allergy = orders.filter((o) => o.allergyWarnings.length > 0).length;
  const lowRows = low.data?.rows ?? [];
  const expRows = expiry.data?.rows ?? [];
  const expired = expRows.filter((r) => r.expired);
  const soon = expRows.filter((r) => !r.expired);

  const SHORTCUTS: { id: string; href: string; label: string; key: string; icon: IconName; show: boolean }[] = [
    { id: "sale", href: "/pharmacy?tab=queue", label: "New sale", key: "S", icon: "cart", show: can("PHARMACY_DISPENSE") },
    { id: "medicine", href: "/pharmacy?tab=medicines&add=1", label: "Add medicine", key: "M", icon: "plus", show: can("PHARMACY_MASTERS") },
    { id: "inventory", href: "/pharmacy?tab=stock", label: "Inventory", key: "I", icon: "box", show: true },
    { id: "low", href: "/pharmacy?tab=stock&low=1", label: "Low stock", key: "L", icon: "alert", show: true },
    { id: "expiry", href: "/reports?report=expiry", label: "Expiry alerts", key: "E", icon: "hourglass", show: reports },
    { id: "reports", href: "/reports?report=sales", label: "Reports", key: "R", icon: "chart", show: reports },
  ];
  const shortcuts = SHORTCUTS.filter((s) => s.show);
  useDeskKeys((k, e) => { const s = shortcuts.find((x) => x.key === k); if (s) { e.preventDefault(); router.push(s.href); } });

  const stats: { label: string; value: string | number; sub?: string; icon: IconName; tone: string }[] = [
    { label: "To dispense", value: orders.length, icon: "pill", tone: "bg-teal-50 text-teal-700" },
    { label: "Low stock", value: lowRows.length, icon: "alert", tone: lowRows.length > 0 ? "bg-amber-50 text-amber-700" : "bg-teal-50 text-teal-700" },
    { label: "Expiring soon", value: soon.length, icon: "hourglass", tone: soon.length > 0 ? "bg-amber-50 text-amber-700" : "bg-teal-50 text-teal-700" },
    { label: "Expired", value: expired.length, icon: "alert", tone: expired.length > 0 ? "bg-red-50 text-red-700" : "bg-teal-50 text-teal-700" },
    { label: "Sales today", value: sales.data ? money(sales.data.totals.net) : "—", ...(sales.data ? { sub: `${sales.data.totals.dispenses} ${t("sales")}` } : {}), icon: "cart", tone: "bg-blue-50 text-blue-700" },
  ];

  // What needs attention right now, most serious first; the strip is hidden when there is nothing to say.
  const alerts: { tone: "red" | "amber"; text: string; href: string }[] = [
    ...(expired.length > 0 ? [{ tone: "red" as const, text: `${expired.length} ${t(expired.length === 1 ? "batch has expired: do not dispense it" : "batches have expired: do not dispense them")}`, href: "/reports?report=expiry" }] : []),
    ...(allergy > 0 ? [{ tone: "red" as const, text: `${allergy} ${t(allergy === 1 ? "waiting prescription has an allergy alert" : "waiting prescriptions have allergy alerts")}`, href: "/pharmacy?tab=queue" }] : []),
    ...(lowRows.length > 0 ? [{ tone: "amber" as const, text: `${lowRows.length} ${t(lowRows.length === 1 ? "medicine is below its reorder level" : "medicines are below their reorder level")}`, href: "/pharmacy?tab=stock&low=1" }] : []),
  ];
  const loading = queue.isLoading && reports && low.isLoading;

  return (
    <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
      <PageHeader title={`${t("Welcome,")} ${me.fullName}`} subtitle={`${me.facility?.name ?? ""} · ${date(new Date().toISOString())}`} />
      <ErrorNote error={queue.error ?? low.error ?? expiry.error ?? sales.error} />
      {loading ? <Spinner /> : (
        <div className="space-y-3">
          {/* The day at a glance. */}
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">
            {stats.map((x) => (
              <div key={x.label} className={`${PANEL} flex items-center gap-2.5 px-3.5 py-2`}>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${x.tone}`}><Icon name={x.icon} /></span>
                <div className="min-w-0">
                  <div className="truncate text-[10.5px] font-medium uppercase tracking-wider text-slate-500">{t(x.label)}</div>
                  <div className="truncate text-lg font-semibold tabular-nums leading-tight text-slate-900">{x.value}{x.sub && <span className="ml-1.5 text-xs font-normal text-slate-500">{x.sub}</span>}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            {/* The prescription queue is the main work of the day, so it leads the screen: who is waiting, what for, and one click to dispense. */}
            <div className="space-y-3 lg:col-span-2">
              <section className={PANEL}>
                <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
                  <h2 className="text-sm font-semibold text-slate-800">{t("Prescription queue")} <span className="ml-1 rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700">{orders.length}</span></h2>
                  <Link href="/pharmacy?tab=queue" className="text-sm font-medium text-brand-600 hover:underline">{t("Open full queue")}</Link>
                </header>
                <div className="px-4 py-0.5">
                  {orders.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">{t("No prescriptions waiting.")}</p> : (
                    <ul className="divide-y divide-slate-100">
                      {orders.slice(0, 8).map((o) => (
                        <li key={o.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className="font-semibold text-slate-900">{o.patientName}</span>
                              <span className="text-slate-500">{o.mrn}</span>
                              {o.allergyWarnings.length > 0 && <Badge tone="red">allergy alert</Badge>}
                              {o.status === "PARTIAL" && <Badge tone="amber">partial</Badge>}
                              {o.source === "HANDWRITTEN" && <Badge tone="blue">handwritten</Badge>}
                            </div>
                            <div className="truncate text-xs text-slate-500">{o.orderNumber} · {o.doctorName ?? t("doctor")} · {dateTime(o.signedAt)}</div>
                            <div className="mt-0.5 truncate text-[13px] text-slate-700">{o.items.slice(0, 3).map((i) => `${i.brandName ?? i.genericName}${i.strength ? ` ${i.strength}` : ""}`).join(", ")}{o.items.length > 3 ? ` +${o.items.length - 3}` : ""}</div>
                          </div>
                          {can("PHARMACY_DISPENSE") && <Button className="shrink-0" onClick={() => setDispensing(o)}>Dispense</Button>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            {alerts.length > 0 && (
              <div className="space-y-1.5" role="alert">
                {alerts.map((a) => (
                  <Link key={a.text} href={a.href} className={`flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2 text-sm font-medium transition hover:shadow-sm ${a.tone === "red" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                    <span className="flex items-center gap-2"><Icon name="alert" />{a.text}</span>
                    <span className="text-xs font-semibold underline">{t("Review")}</span>
                  </Link>
                ))}
              </div>
            )}

            {/* Quick access: six places, one key each, in one row. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label={t("Quick access")}>
              {shortcuts.map((s) => {
                const a = ACCENTS[s.id]!;
                return (
                  <Link key={s.id} href={s.href} className={`group flex items-center gap-2.5 rounded-xl border border-slate-100 bg-white px-3 py-2 shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition hover:shadow-md ${a.hover}`}>
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${a.chip}`}><Icon name={s.icon} className="h-[17px] w-[17px]" /></span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-800">{t(s.label)}</span>
                    <kbd className={KBD}>{s.key}</kbd>
                  </Link>
                );
              })}
            </div>
            </div>

            <div className="space-y-3">
              <section className={PANEL}>
                <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("Low stock")}</h2><Link href="/pharmacy?tab=stock&low=1" className="text-sm font-medium text-brand-600 hover:underline">{t("View all")}</Link></header>
                <div className="px-4 py-2">
                  {lowRows.length === 0 ? <p className="text-sm text-slate-500">{t("Nothing is running low.")}</p> : (
                    <ul className="space-y-1.5 text-sm">
                      {lowRows.slice(0, 4).map((r) => (
                        <li key={r.medicineId} className="flex items-center justify-between gap-2"><span className="truncate text-slate-800">{r.medicine}</span><span className="shrink-0 tabular-nums text-amber-700">{r.quantity} <span className="text-slate-400">/ {r.reorderLevel}</span></span></li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
              <section className={PANEL}>
                <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("Expiring soon")}</h2><Link href="/reports?report=expiry" className="text-sm font-medium text-brand-600 hover:underline">{t("View all")}</Link></header>
                <div className="px-4 py-2">
                  {expRows.length === 0 ? <p className="text-sm text-slate-500">{t("No stock is close to expiry.")}</p> : (
                    <ul className="space-y-1.5 text-sm">
                      {[...expired, ...soon].slice(0, 4).map((r) => (
                        <li key={r.batchId} className="flex items-center justify-between gap-2"><span className="truncate text-slate-800">{r.medicine} <span className="text-slate-400">· {r.batchNo}</span></span><span className={`shrink-0 tabular-nums ${r.expired ? "font-medium text-red-700" : "text-slate-600"}`}>{r.expired ? t("expired") : date(r.expiryDate)}</span></li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </div>
          </div>

        </div>
      )}
      {dispensing && <Dispense order={dispensing} onClose={() => { setDispensing(null); void qc.invalidateQueries({ queryKey: ["pharmacy-queue"] }); void qc.invalidateQueries({ queryKey: ["ph-low"] }); void qc.invalidateQueries({ queryKey: ["ph-expiry"] }); void qc.invalidateQueries({ queryKey: ["ph-sales"] }); }} />}
    </div>
  );
}
