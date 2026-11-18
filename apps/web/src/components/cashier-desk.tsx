"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Badge, ErrorNote, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { visibleNav } from "@/lib/nav";
import { Icon, type IconName, KBD, PANEL, useDeskKeys } from "./desk-ui";

interface InvoiceRow { id: string; invoiceNumber: string | null; status: string; kind: string; patientName: string; mrn: string | null; total: string; balanceDue: string; createdAt: string }
interface Collections { totals: { received: string; refunded: string; net: string }; byMode: { method: string; net: string }[] }
interface Outstanding { total: number; totalDue: string }
interface Shift { openedAt: string; openingCash: string; expectedCash?: string }

/** Muted accent per shortcut: the icon chip and the hover highlight. Full class names so Tailwind keeps them. */
const ACCENTS: Record<string, { chip: string; hover: string }> = {
  billing: { chip: "bg-blue-50 text-blue-600", hover: "hover:border-blue-300" },
  newbill: { chip: "bg-teal-50 text-teal-600", hover: "hover:border-teal-300" },
  search: { chip: "bg-indigo-50 text-indigo-600", hover: "hover:border-indigo-300" },
  payments: { chip: "bg-emerald-50 text-emerald-600", hover: "hover:border-emerald-300" },
  outstanding: { chip: "bg-amber-50 text-amber-600", hover: "hover:border-amber-300" },
  estimate: { chip: "bg-sky-50 text-sky-600", hover: "hover:border-sky-300" },
  claims: { chip: "bg-rose-50 text-rose-600", hover: "hover:border-rose-300" },
  reports: { chip: "bg-slate-100 text-slate-600", hover: "hover:border-slate-300" },
};
const STATUS_TONE: Record<string, "gray" | "blue" | "amber" | "green" | "red"> = { DRAFT: "gray", ISSUED: "blue", PARTIALLY_PAID: "amber", PAID: "green", CANCELLED: "red" };
const MODE_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", BANK_TRANSFER: "Bank transfer", OTHER: "Other" };

/**
 * The cashier's own start screen: the money taken today, what is still owed (each with a one-click Take payment), the latest bills, and one-key shortcuts.
 * It only reads what the billing and report screens already read; payments are still taken on the bill's own page, with all its checks.
 */
export function CashierDashboard() {
  const t = useT();
  const router = useRouter();
  const { me, can, features, money, dateTime } = useMe();
  const finance = can("REPORT_READ", "REPORT_FINANCE");
  const allowed = new Set(visibleNav(new Set(me.permissions), features, me.roles).map((n) => n.href));
  const canPay = can("PAYMENT_CREATE");

  const collections = useQuery({ queryKey: ["cd-collections"], queryFn: () => api.get<Collections>("/reports/collections"), enabled: finance, refetchInterval: 30_000 });
  const outstanding = useQuery({ queryKey: ["cd-outstanding"], queryFn: () => api.get<Outstanding>("/reports/outstanding-invoices", { pageSize: 1 }), enabled: finance, refetchInterval: 30_000 });
  const owed = useQuery({ queryKey: ["cd-owed"], queryFn: () => api.page<InvoiceRow>("/invoices", { outstanding: "true", pageSize: 6 }), enabled: can("INVOICE_READ"), refetchInterval: 30_000 });
  const recent = useQuery({ queryKey: ["cd-recent"], queryFn: () => api.page<InvoiceRow>("/invoices", { pageSize: 6 }), enabled: can("INVOICE_READ"), refetchInterval: 30_000 });
  const shift = useQuery({ queryKey: ["shift"], queryFn: () => api.get<Shift | null>("/shifts/current"), enabled: can("CASHIER_SHIFT_MANAGE") });
  const adm = useQuery({ queryKey: ["dash-adm"], queryFn: () => api.page<unknown>("/admissions", { status: "ADMITTED", pageSize: 1 }), enabled: can("ADMISSION_READ") && features.IPD_ENABLED });
  const pharmacy = useQuery({ queryKey: ["pharmacy-waiting"], queryFn: () => api.page<InvoiceRow>("/invoices", { kind: "PHARMACY", outstanding: "true", pageSize: 1 }), enabled: canPay, refetchInterval: 30_000 });

  const searchPatient = (): void => document.querySelector<HTMLInputElement>('input[aria-label="Search patients"]')?.focus();
  const SHORTCUTS: { id: string; href: string | null; label: string; key: string; icon: IconName; show: boolean }[] = [
    { id: "billing", href: "/billing", label: "Billing", key: "B", icon: "queue", show: allowed.has("/billing") },
    { id: "newbill", href: "/billing?new=1", label: "New invoice", key: "N", icon: "plus", show: can("INVOICE_CREATE") },
    { id: "search", href: null, label: "Patient search", key: "F", icon: "search", show: can("PATIENT_READ") },
    { id: "payments", href: "/billing?status=OUTSTANDING", label: "Payments", key: "P", icon: "cart", show: canPay },
    { id: "outstanding", href: "/billing?status=OUTSTANDING", label: "Outstanding bills", key: "O", icon: "alert", show: allowed.has("/billing") },
    { id: "estimate", href: "/estimate", label: "Estimates", key: "E", icon: "calendar", show: allowed.has("/estimate") },
    { id: "claims", href: "/insurance-money", label: "Insurance claims", key: "C", icon: "check", show: allowed.has("/insurance-money") },
    { id: "reports", href: "/reports", label: "Reports", key: "R", icon: "chart", show: allowed.has("/reports") },
  ];
  const shortcuts = SHORTCUTS.filter((s) => s.show);
  useDeskKeys((k, e) => {
    const s = shortcuts.find((x) => x.key === k);
    if (!s) return;
    e.preventDefault();
    if (s.href) router.push(s.href); else searchPatient();
  });

  const due = outstanding.data?.totalDue;
  const dueCount = outstanding.data?.total ?? owed.data?.meta.total;
  const allStats: { label: string; value: string; sub?: string; icon: IconName; tone: string; show: boolean }[] = [
    { label: "Collected today", value: collections.data ? money(collections.data.totals.net) : "—", icon: "cart", tone: "bg-teal-50 text-teal-700", show: finance },
    { label: "Outstanding bills", value: dueCount !== undefined ? String(dueCount) : "—", ...(due ? { sub: money(due) } : {}), icon: "alert", tone: (dueCount ?? 0) > 0 ? "bg-amber-50 text-amber-700" : "bg-teal-50 text-teal-700", show: can("INVOICE_READ") },
    { label: "Pharmacy bills waiting", value: pharmacy.data ? String(pharmacy.data.meta.total) : "—", icon: "pill", tone: "bg-blue-50 text-blue-700", show: canPay },
    { label: "Admitted patients", value: adm.data ? String(adm.data.meta.total) : "—", icon: "bed", tone: "bg-teal-50 text-teal-700", show: can("ADMISSION_READ") && features.IPD_ENABLED },
    { label: "My cash shift", value: shift.data ? t("Open") : t("Not open"), ...(shift.data?.expectedCash ? { sub: money(shift.data.expectedCash) } : {}), icon: "clock", tone: shift.data ? "bg-teal-50 text-teal-700" : "bg-slate-100 text-slate-600", show: can("CASHIER_SHIFT_MANAGE") && !shift.isLoading },
  ];
  const stats = allStats.filter((x) => x.show);

  const modes = (collections.data?.byMode ?? []).filter((m) => Number(m.net) !== 0);
  const modeTotal = modes.reduce((n, m) => n + Number(m.net), 0);
  const COLORS = ["bg-blue-500", "bg-teal-500", "bg-indigo-400", "bg-sky-400", "bg-slate-400"];

  return (
    <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
      <PageHeader title={`${t("Welcome,")} ${me.fullName}`} subtitle={`${me.facility?.name ?? ""} · ${dateTime(new Date().toISOString())}`} />
      <ErrorNote error={collections.error ?? owed.error ?? recent.error} />
      <div className="space-y-3">
        {/* The money at a glance. */}
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
          <div className="space-y-3 lg:col-span-2">
            {/* Pending bills first, each with a one-click Take payment (it opens the payment form on the bill). */}
            <section className={PANEL}>
              <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
                <h2 className="text-sm font-semibold text-slate-800">{t("Outstanding bills")} <span className="ml-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">{owed.data?.meta.total ?? 0}</span></h2>
                <Link href="/billing?status=OUTSTANDING" className="text-sm font-medium text-brand-600 hover:underline">{t("View all")}</Link>
              </header>
              <div className="px-4 py-0.5">
                {(owed.data?.data.length ?? 0) === 0 ? <p className="py-5 text-center text-sm text-slate-500">{t("No bills are waiting for payment.")}</p> : (
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400"><th className="py-2 font-medium">{t("Bill")}</th><th className="py-2 font-medium">{t("Patient")}</th><th className="py-2 text-right font-medium">{t("Due")}</th><th className="w-32" /></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {owed.data!.data.map((b) => (
                        <tr key={b.id}>
                          <td className="py-2 pr-3 tabular-nums"><Link className="font-medium text-brand-600 hover:underline" href={`/billing/${b.id}`}>{b.invoiceNumber ?? t("Draft")}</Link> <span className="ml-1 text-xs text-slate-400">{b.kind.toLowerCase()}</span></td>
                          <td className="max-w-[12rem] truncate py-2 pr-3 text-slate-800">{b.patientName}<span className="ml-1.5 text-xs text-slate-400">{b.mrn}</span></td>
                          <td className="py-2 text-right font-semibold tabular-nums text-amber-700">{money(b.balanceDue)}</td>
                          <td className="py-2 pl-3 text-right">{canPay && ["ISSUED", "PARTIALLY_PAID"].includes(b.status) ? <Link href={`/billing/${b.id}?pay=1`} className="inline-block whitespace-nowrap rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">{t("Take payment")}</Link> : <Link href={`/billing/${b.id}`} className="inline-block whitespace-nowrap rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50">{t("Open")}</Link>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            {/* Quick access: eight places, one key each. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t("Quick access")}>
              {shortcuts.map((s) => {
                const a = ACCENTS[s.id]!;
                const body = (
                  <>
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${a.chip}`}><Icon name={s.icon} className="h-[17px] w-[17px]" /></span>
                    <span className="min-w-0 flex-1 text-[13px] font-medium leading-tight text-slate-800">{t(s.label)}</span>
                    <kbd className={KBD}>{s.key}</kbd>
                  </>
                );
                const cls = `group flex items-center gap-2.5 rounded-xl border border-slate-100 bg-white px-3 py-2 text-left shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition hover:shadow-md ${a.hover}`;
                return s.href ? <Link key={s.id} href={s.href} className={cls}>{body}</Link> : <button key={s.id} type="button" onClick={searchPatient} className={cls}>{body}</button>;
              })}
            </div>

            <section className={PANEL}>
              <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
                <h2 className="text-sm font-semibold text-slate-800">{t("Recent transactions")}</h2>
                <Link href="/billing" className="text-sm font-medium text-brand-600 hover:underline">{t("All bills")}</Link>
              </header>
              <div className="px-4 py-0.5">
                {(recent.data?.data.length ?? 0) === 0 ? <p className="py-5 text-center text-sm text-slate-500">{t("No bills yet.")}</p> : (
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-slate-100">
                      {recent.data!.data.map((b) => (
                        <tr key={b.id}>
                          <td className="py-2 pr-3 tabular-nums"><Link className="font-medium text-slate-900 hover:text-brand-600 hover:underline" href={`/billing/${b.id}`}>{b.invoiceNumber ?? t("Draft")}</Link></td>
                          <td className="max-w-[12rem] truncate py-2 pr-3 text-slate-700">{b.patientName}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-slate-800">{money(b.total)}</td>
                          <td className="py-2 pr-3"><Badge tone={STATUS_TONE[b.status] ?? "gray"}>{b.status.replace("_", " ").toLowerCase()}</Badge></td>
                          <td className="hidden py-2 text-right text-xs text-slate-400 md:table-cell">{dateTime(b.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </div>

          <div className="space-y-3">
            {/* Patient billing overview: money in against money still owed, and how it was paid. */}
            {finance && (
              <section className={PANEL}>
                <header className="border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("Billing overview")}</h2></header>
                <div className="space-y-3 px-4 py-3 text-sm">
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                    <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">{t("Received")}</dt><dd className="font-semibold tabular-nums text-slate-900">{collections.data ? money(collections.data.totals.received) : "—"}</dd></div>
                    <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">{t("Refunded")}</dt><dd className="font-semibold tabular-nums text-slate-900">{collections.data ? money(collections.data.totals.refunded) : "—"}</dd></div>
                    <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">{t("Still owed")}</dt><dd className="font-semibold tabular-nums text-amber-700">{due ? money(due) : "—"}</dd></div>
                    <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">{t("Net today")}</dt><dd className="font-semibold tabular-nums text-teal-700">{collections.data ? money(collections.data.totals.net) : "—"}</dd></div>
                  </dl>
                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-wider text-slate-500">{t("By payment mode")}</div>
                    {modes.length === 0 ? <p className="text-slate-500">{t("Nothing collected yet today.")}</p> : (
                      <>
                        <div className="flex h-2 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={t("By payment mode")}>
                          {modes.map((m, i) => <span key={m.method} className={COLORS[i % COLORS.length]} style={{ width: `${(Number(m.net) / modeTotal) * 100}%` }} />)}
                        </div>
                        <ul className="mt-2 space-y-1">
                          {modes.map((m, i) => (
                            <li key={m.method} className="flex items-center justify-between"><span className="flex items-center gap-2 text-slate-700"><span className={`h-2 w-2 rounded-full ${COLORS[i % COLORS.length]}`} />{t(MODE_LABEL[m.method] ?? m.method)}</span><span className="tabular-nums text-slate-900">{money(m.net)}</span></li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                </div>
              </section>
            )}
            {can("CASHIER_SHIFT_MANAGE") && (
              <section className={PANEL}>
                <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("My cash shift")}</h2><Link href="/billing" className="text-sm font-medium text-brand-600 hover:underline">{shift.data ? t("Close shift") : t("Open shift")}</Link></header>
                <div className="px-4 py-3 text-sm">
                  {shift.data ? (
                    <ul className="space-y-1">
                      <li className="flex justify-between"><span className="text-slate-500">{t("Open since")}</span><span className="text-slate-800">{dateTime(shift.data.openedAt)}</span></li>
                      <li className="flex justify-between"><span className="text-slate-500">{t("Opening cash")}</span><span className="tabular-nums text-slate-800">{money(shift.data.openingCash)}</span></li>
                      {shift.data.expectedCash && <li className="flex justify-between"><span className="text-slate-500">{t("Expected in drawer")}</span><span className="font-semibold tabular-nums text-teal-700">{money(shift.data.expectedCash)}</span></li>}
                    </ul>
                  ) : <p className="text-slate-500">{t("No cash shift is open. Open one on the Billing page before taking cash.")}</p>}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
