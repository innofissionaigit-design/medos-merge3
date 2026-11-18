"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { RecordRetention } from "@/components/record-retention";
import { Badge, PageHeader, Select, Spinner } from "@/components/ui";
import { Icon, type IconName, PANEL } from "@/components/desk-ui";
import { api } from "@/lib/api";
import { T, useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Row { admissionId: string; admissionNumber: string; patient: string; mrn: string | null; dischargedAt: string; daysSinceDischarge: number | null; status: string; hisStatus: string; recordReady: boolean; recordComplete: boolean; recordFile: string | null; claim: { claimNumber: string; status: string; insurer: string; open: boolean } | null; receivables: { patient: string; insurer: string } }

/**
 * Post-discharge (docs/discharge-stages.md): discharged stays whose record, claim or money is still open, for the Medical Records Department,
 * the TPA desk and finance. Opening a row goes to the admission, where MRD signs the record off.
 */
export default function PostDischargePage() {
  const { money, dateTime, can } = useMe();
  const t = useT();
  const [show, setShow] = useState("OPEN");
  const q = useQuery({ queryKey: ["post-discharge", show], queryFn: () => api.get<{ items: Row[]; total: number; ageing: { bucket: string; patient: string; insurer: string; stays: number }[] }>("/post-discharge", { show }) });
  const rows = q.data?.items ?? [];
  const cents = (v: string) => Math.round(Number(v) * 100);
  const owedByPatients = (q.data?.ageing ?? []).reduce((n, a) => n + cents(a.patient), 0);
  const owedByInsurers = (q.data?.ageing ?? []).reduce((n, a) => n + cents(a.insurer), 0);
  const FILTERS: [string, string][] = [["OPEN", "Anything open"], ["RECORDS", "Records to complete"], ["CLAIMS", "Claims to follow"], ["RECEIVABLES", "Money still owed"], ["ALL", "All (last 90 days)"]];
  const tiles: { label: string; value: string; tone: string; icon: IconName }[] = [
    { label: "Discharged stays", value: String(q.data?.total ?? 0), tone: "bg-teal-50 text-teal-700", icon: "bed" },
    { label: "Patients owe", value: q.data ? money((owedByPatients / 100).toFixed(2)) : "—", tone: owedByPatients > 0 ? "bg-amber-50 text-amber-700" : "bg-teal-50 text-teal-700", icon: "cart" },
    { label: "Insurers owe", value: q.data ? money((owedByInsurers / 100).toFixed(2)) : "—", tone: owedByInsurers > 0 ? "bg-blue-50 text-blue-700" : "bg-teal-50 text-teal-700", icon: "check" },
    { label: "Records to complete", value: String(rows.filter((r) => !r.recordComplete).length), tone: "bg-slate-100 text-slate-600", icon: "queue" },
  ];
  return (
    <Gate anyOf={["MRD_RECORD_COMPLETE", "CLAIM_READ", "REPORT_FINANCE", "MRD_RETENTION"]} feature="IPD_ENABLED">
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
        <PageHeader title="Post-discharge" subtitle="Discharged stays whose record, claim or money is still open" />
        {can("MRD_RETENTION") && <div className="mb-3"><RecordRetention /></div>}
        {/* Where things stand: stays, what patients and insurers still owe, and records waiting. */}
        <div className="mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {tiles.map((x) => (
            <div key={x.label} className={`${PANEL} flex items-center gap-2.5 px-3.5 py-2`}>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${x.tone}`}><Icon name={x.icon} /></span>
              <div className="min-w-0">
                <div className="text-[10.5px] font-medium uppercase leading-tight tracking-wider text-slate-500">{t(x.label)}</div>
                <div className="truncate text-lg font-semibold tabular-nums leading-tight text-slate-900">{x.value}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <section className={`${PANEL} lg:col-span-2`}>
            <header className="space-y-2.5 border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-800">{t("Discharged stays")} <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{q.data?.total ?? 0}</span></h2>
              <div className="hidden flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5 md:flex" role="tablist" aria-label={t("Show")}>
                {FILTERS.map(([v, label]) => <button key={v} type="button" role="tab" aria-selected={show === v} onClick={() => setShow(v)} className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${show === v ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{t(label)}</button>)}
              </div>
              <div className="md:hidden">
                <Select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value)}>
                  {FILTERS.map(([v, label]) => <option key={v} value={v}>{t(label)}</option>)}
                </Select>
              </div>
            </header>
            {q.isLoading ? <div className="p-4"><Spinner /></div> : rows.length === 0 ? <p className="px-4 py-8 text-center text-sm text-slate-500"><T>Nothing here.</T></p> : (
              <div className="overflow-x-auto px-4 pb-1">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400"><th className="py-2 pr-3 font-medium">{t("Patient")}</th><th className="py-2 pr-3 font-medium">{t("Discharged")}</th><th className="py-2 pr-3 font-medium">{t("Records")}</th><th className="py-2 pr-3 font-medium">{t("Claim")}</th><th className="py-2 pr-3 text-right font-medium">{t("Patient owes")}</th><th className="py-2 pr-3 text-right font-medium">{t("Insurer owes")}</th><th className="py-2 font-medium">{t("Stage")}</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((r) => (
                      <tr key={r.admissionId} data-testid="post-discharge-row" className="align-top hover:bg-slate-50/70">
                        <td className="py-2.5 pr-3"><Link className="font-semibold text-slate-900 hover:text-brand-700 hover:underline" href={`/ipd/${r.admissionId}`}>{r.patient}</Link><div className="text-xs text-slate-400">{r.mrn} · {r.admissionNumber}</div></td>
                        <td className="whitespace-nowrap py-2.5 pr-3">{dateTime(r.dischargedAt)}<div className="text-xs text-slate-400">{r.daysSinceDischarge ?? 0} <T>day(s) ago</T></div></td>
                        <td className="py-2.5 pr-3">{r.recordComplete ? <Badge tone="green">complete</Badge> : r.recordReady ? <Badge tone="amber">ready to sign off</Badge> : <Badge tone="red">incomplete</Badge>}<div className="mt-0.5 text-xs text-slate-400">{r.recordFile ?? t("not received")}</div></td>
                        <td className="py-2.5 pr-3">{r.claim ? <><span className="font-medium">{r.claim.claimNumber}</span> <Badge tone={r.claim.open ? "blue" : "gray"}>{r.claim.status.toLowerCase().replace(/_/g, " ")}</Badge><div className="text-xs text-slate-500">{r.claim.insurer}</div></> : <span className="text-slate-400"><T>none</T></span>}</td>
                        <td className={`whitespace-nowrap py-2.5 pr-3 text-right tabular-nums ${r.receivables.patient === "0.00" ? "text-slate-300" : "font-semibold text-amber-700"}`}>{r.receivables.patient === "0.00" ? "—" : money(r.receivables.patient)}</td>
                        <td className={`whitespace-nowrap py-2.5 pr-3 text-right tabular-nums ${r.receivables.insurer === "0.00" ? "text-slate-300" : "font-semibold text-blue-700"}`}>{r.receivables.insurer === "0.00" ? "—" : money(r.receivables.insurer)}</td>
                        <td className="py-2.5 text-xs text-slate-600"><T>{r.hisStatus}</T></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {q.data?.ageing && (
            <section className={`${PANEL} self-start`}>
              <header className="border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("Money still owed, by days since discharge")}</h2></header>
              <div className="px-4 pb-1">
                <table className="w-full text-sm">
                  <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400"><th className="py-2 text-left font-medium">{t("Days")}</th><th className="py-2 text-right font-medium">{t("Patients")}</th><th className="py-2 text-right font-medium">{t("Insurers")}</th><th className="py-2 text-right font-medium">{t("Stays")}</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {q.data.ageing.map((a) => (
                      <tr key={a.bucket} data-testid="ageing-row">
                        <td className="py-2 font-medium text-slate-800">{a.bucket}</td>
                        <td className="py-2 text-right tabular-nums">{a.patient === "0.00" ? <span className="text-slate-300">—</span> : money(a.patient)}</td>
                        <td className="py-2 text-right tabular-nums">{a.insurer === "0.00" ? <span className="text-slate-300">—</span> : money(a.insurer)}</td>
                        <td className="py-2 text-right tabular-nums text-slate-600">{a.stays}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </Gate>
  );
}
