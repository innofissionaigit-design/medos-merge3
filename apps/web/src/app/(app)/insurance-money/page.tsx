"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { Icon, type IconName, PANEL } from "@/components/desk-ui";
import { FollowUpTab, InsuranceReports, OverpaymentTab, OwedTab, PaymentTab, WriteOffTab } from "@/components/insurance-money";
import { PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

type Tab = "owed" | "pay" | "follow" | "writeoff" | "over" | "reports";
interface InsurerRow { claims: number; claimed: string; received: string; owed: string; awaitingDecision: string; refundDue: string }

/** Insurance money (docs/insurance-money.md): what insurers owe, the payments they make matched to claims, follow-ups, write-offs, overpayments and the reports. */
export default function InsuranceMoneyPage() {
  const { can, money } = useMe();
  const t = useT();
  const [tab, setTab] = useState<Tab>("owed");
  // The same request the "What insurers owe" tab makes (one shared copy), summed for the tiles above the tabs.
  const ledger = useQuery({ queryKey: ["insurance-ledger"], queryFn: () => api.get<InsurerRow[]>("/insurance/ledger"), refetchInterval: 60_000 });
  const sum = (f: (r: InsurerRow) => string): string => ((ledger.data ?? []).reduce((n, r) => n + Math.round(Number(f(r)) * 100), 0) / 100).toFixed(2);
  const owed = Number(sum((r) => r.owed));
  const tiles: { label: string; value: string; icon: IconName; tone: string }[] = [
    { label: "Claims sent", value: ledger.data ? String((ledger.data ?? []).reduce((n, r) => n + r.claims, 0)) : "—", icon: "queue", tone: "bg-teal-50 text-teal-700" },
    { label: "Claimed", value: ledger.data ? money(sum((r) => r.claimed)) : "—", icon: "chart", tone: "bg-blue-50 text-blue-700" },
    { label: "Received", value: ledger.data ? money(sum((r) => r.received)) : "—", icon: "check", tone: "bg-teal-50 text-teal-700" },
    { label: "Still owed", value: ledger.data ? money(sum((r) => r.owed)) : "—", icon: "alert", tone: owed > 0 ? "bg-amber-50 text-amber-700" : "bg-teal-50 text-teal-700" },
  ];
  const tabs: { id: Tab; label: string }[] = [
    { id: "owed", label: "What insurers owe" },
    ...(can("CLAIM_SETTLE") ? [{ id: "pay" as const, label: "Record a payment" }] : []),
    { id: "follow", label: "Follow-ups" }, { id: "writeoff", label: "Write-offs" }, { id: "over", label: "Overpayments" },
    ...(can("REPORT_READ", "REPORT_FINANCE") ? [{ id: "reports" as const, label: "Reports" }] : []),
  ];
  return (
    <Gate anyOf={["CLAIM_READ"]}>
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
        <PageHeader title="Insurance money" subtitle="What insurers owe, their payments, follow-ups and write-offs" />
        <div className="mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {tiles.map((x) => (
            <div key={x.label} className={`${PANEL} flex items-center gap-2.5 px-3.5 py-2`}>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${x.tone}`}><Icon name={x.icon} /></span>
              <div className="min-w-0">
                <div className="text-[10.5px] font-medium uppercase leading-tight tracking-wider text-slate-500">{t(x.label)}</div>
                <div className="break-words text-[15px] font-semibold tabular-nums leading-tight text-slate-900 sm:text-lg">{x.value}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mb-3 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5" role="tablist">
          {tabs.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)} className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${tab === x.id ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{t(x.label)}</button>
          ))}
        </div>
        {/* The tabs' own cards and tables take the same soft look, without changing what they show or do. */}
        <div className="space-y-4 [&_section]:rounded-xl [&_section]:border-slate-100 [&_section]:shadow-[0_1px_3px_rgba(15,23,42,0.06)] [&_section>header]:border-slate-100 [&_thead]:border-slate-100 [&_thead]:text-[11px] [&_thead]:tracking-wider [&_thead]:text-slate-400 [&_tbody_tr:hover]:bg-slate-50/70">
          {tab === "owed" && <OwedTab />}
          {tab === "pay" && <PaymentTab />}
          {tab === "follow" && <FollowUpTab />}
          {tab === "writeoff" && <WriteOffTab />}
          {tab === "over" && <OverpaymentTab />}
          {tab === "reports" && <InsuranceReports />}
        </div>
      </div>
    </Gate>
  );
}
