"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { PlanBadge, type PlanRow } from "@/components/planned";
import { Badge, Card, ErrorNote, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface ClaimRow { id: string; claimNumber: string; type: string; status: string; claimedAmount: string | null; approvedAmount: string | null; outstanding: string | null; updatedAt: string; patient: string; mrn: string | null; insurer: string; policyNumber: string }
interface Summary { insurerId: string; insurer: string; claims: number; waitingForDecision: string; toReceive: string }
type Filter = "PLANNED" | "PREAUTH_PENDING" | "QUERY" | "SUBMITTED" | "APPROVED" | null;

const TONE: Record<string, "gray" | "blue" | "amber" | "green" | "red"> = { DRAFT: "gray", PREAUTH_PENDING: "amber", PREAUTH_APPROVED: "blue", SUBMITTED: "blue", QUERY: "amber", APPROVED: "green", REJECTED: "red", SETTLED: "green", CLOSED: "gray" };
const label = (s: string): string => s.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const FILTER_TITLE: Record<Exclude<Filter, null>, string> = { PLANNED: "Planned admissions", PREAUTH_PENDING: "Pre-authorisations with the insurer", QUERY: "Insurer queries to answer", SUBMITTED: "Claims waiting for the insurer's decision", APPROVED: "Approved: money to receive" };

function Icon({ name }: { name: "bed" | "shield" | "help" | "send" | "coin" }) {
  const d: Record<string, ReactNode> = {
    bed: <path d="M3 18V7M3 14h18v4M21 14v-2.5A3.5 3.5 0 0 0 17.5 8H11v6M7 11.5h.01" />,
    shield: <path d="M12 3 5 6v5c0 4.500 3 8 7 10 4-2 7-5.500 7-10V6zM9 12l2 2 4-4" />,
    help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.500 9.500a2.500 2.500 0 1 1 3.500 2.300c-.700.400-1 .900-1 1.700M12 17h.01" /></>,
    send: <path d="M4 12 20 4l-4 16-4.500-6.500zM11.500 13.500 20 4" />,
    coin: <><circle cx="12" cy="12" r="8.500" /><path d="M14.500 9.200c-.500-.800-1.400-1.200-2.500-1.200-1.400 0-2.500.700-2.500 1.800 0 2.600 5.200 1.200 5.200 3.800 0 1.100-1.100 1.900-2.700 1.900-1.200 0-2.200-.500-2.700-1.400M12 6.500V8m0 8v1.500" /></>,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d[name]}</svg>;
}

function Tile({ id, label: text, value, sub, icon, tone, hot, active, onSelect }: { id: Exclude<Filter, null>; label: string; value: number | string | undefined; sub: string; icon: "bed" | "shield" | "help" | "send" | "coin"; tone: string; hot?: boolean; active: boolean; onSelect: (f: Exclude<Filter, null>) => void }) {
  const t = useT();
  return (
    <button type="button" onClick={() => onSelect(id)} aria-pressed={active} className={clsx("group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200")}>
      <span className={clsx("absolute inset-x-0 top-0 h-1", tone)} aria-hidden />
      <span className="flex items-center justify-between text-slate-500"><span className="text-xs font-medium uppercase tracking-wide">{t(text)}</span><span className={clsx("flex h-8 w-8 items-center justify-center rounded-lg", hot ? "bg-amber-50 text-amber-600" : active ? "bg-brand-50 text-brand-700" : "bg-slate-50 group-hover:bg-slate-100")}><Icon name={icon} /></span></span>
      <span className="mt-2 block text-3xl font-semibold tracking-tight text-slate-900">{value ?? <span className="text-slate-400">…</span>}</span>
      <span className="mt-0.5 block text-xs text-slate-500">{t(sub)}</span>
    </button>
  );
}

/**
 * The insurance desk's own start screen: the planned admissions waiting for the payer check or the insurer's approval, the claims by what they wait for (pre-authorisation, a query to
 * answer, the insurer's decision, money to receive), and what each insurer owes. The tiles filter the list in place; working a claim is done in the claim itself, with all its checks.
 */
export function TpaDashboard() {
  const t = useT();
  const { me, money, date, dateTime } = useMe();
  const [filter, setFilter] = useState<Filter>(null);
  const planned = useQuery({ queryKey: ["tpa-planned"], queryFn: async () => {
    const [a, b] = await Promise.all([api.page<PlanRow>("/planned-admissions", { status: "TARIFF_PAYER", pageSize: 50 }), api.page<PlanRow>("/planned-admissions", { status: "PREAUTH", pageSize: 50 })]);
    return [...b.data, ...a.data];
  }, refetchInterval: 20_000 });
  const useCount = (status: string) => useQuery({ queryKey: ["tpa-count", status], queryFn: () => api.get<{ total: number }>("/claims", { status, pageSize: 1 }), refetchInterval: 30_000 });
  const pre = useCount("PREAUTH_PENDING"), qry = useCount("QUERY"), sub = useCount("SUBMITTED"), apr = useCount("APPROVED");
  const summary = useQuery({ queryKey: ["claims-summary"], queryFn: () => api.get<Summary[]>("/claims/summary"), refetchInterval: 60_000 });
  const shownStatus = filter && filter !== "PLANNED" ? filter : null;
  const claims = useQuery({ queryKey: ["tpa-claims", shownStatus ?? "recent"], queryFn: () => api.get<{ items: ClaimRow[] }>("/claims", { ...(shownStatus ? { status: shownStatus } : {}), pageSize: 12 }), refetchInterval: 30_000, enabled: filter !== "PLANNED" });
  const toReceive = (summary.data ?? []).reduce((n, s) => n + Number(s.toReceive), 0);
  const waitingMoney = (summary.data ?? []).reduce((n, s) => n + Number(s.waitingForDecision), 0);
  const pick = (f: Exclude<Filter, null>) => setFilter((cur) => (cur === f ? null : f));
  const plans = planned.data ?? [];

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{`${t("Welcome")}, ${me.fullName}`}</h1>
          <p className="text-sm text-slate-500">{`${me.tenant.name} · ${t("Insurance and TPA desk")} · ${dateTime(new Date().toISOString())}`}</p>
        </div>
        <Link className="whitespace-nowrap rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700" href="/claims">{t("Insurance claims")}</Link>
      </div>
      <ErrorNote error={planned.error ?? summary.error} />

      {(qry.data?.total ?? 0) > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700"><Icon name="help" /></span>
          <span><b>{qry.data!.total === 1 ? "1 insurer query needs an answer." : `${qry.data!.total} insurer queries need an answer.`}</b></span>
          <button type="button" className="ml-auto whitespace-nowrap rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100" onClick={() => setFilter("QUERY")}>{t("Show the queries")}</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile id="PLANNED" label="Planned admissions" value={planned.data ? plans.length : undefined} sub="At the insurance step" icon="bed" tone="bg-brand-500" active={filter === "PLANNED"} onSelect={pick} />
        <Tile id="PREAUTH_PENDING" label="Pre-authorisations" value={pre.data?.total} sub="With the insurer" icon="shield" tone="bg-amber-400" active={filter === "PREAUTH_PENDING"} onSelect={pick} />
        <Tile id="QUERY" label="Queries" value={qry.data?.total} sub="Need your answer" icon="help" tone="bg-rose-400" hot={(qry.data?.total ?? 0) > 0} active={filter === "QUERY"} onSelect={pick} />
        <Tile id="SUBMITTED" label="Awaiting decision" value={sub.data?.total} sub={waitingMoney > 0 ? `${money(String(waitingMoney))} claimed` : "Claims sent"} icon="send" tone="bg-slate-500" active={filter === "SUBMITTED"} onSelect={pick} />
        <Tile id="APPROVED" label="To receive" value={summary.data ? money(String(toReceive)) : undefined} sub={`${apr.data?.total ?? 0} approved claims`} icon="coin" tone="bg-emerald-500" active={filter === "APPROVED"} onSelect={pick} />
      </div>

      {(filter === null || filter === "PLANNED") && (
        <Card title={t("Planned admissions waiting for insurance")} className="mt-5">
          {planned.isLoading ? <Spinner /> : (
            <Table head={["Request", "Patient", "Doctor", "Day", "Step", ""]} {...(plans.length === 0 ? { empty: "No planned admission is waiting for the payer check or the insurer's approval." } : {})}>
              {plans.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td><Link className="font-medium text-brand-700 hover:underline" href={`/planned/${r.id}`}>{r.requestNumber}</Link></Td>
                  <Td>{r.patient.name}<div className="text-xs text-slate-500">{r.patient.mrn}</div></Td>
                  <Td>{r.consultant.name}</Td>
                  <Td>{r.proposedDate ? date(r.proposedDate) : "—"}</Td>
                  <Td><PlanBadge status={r.status} /></Td>
                  <Td><Link className="whitespace-nowrap rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700" href={`/planned/${r.id}`}>{r.status === "PREAUTH" ? t("Record the insurer's answer") : t("Check the payer")}</Link></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {filter !== "PLANNED" && (
        <Card title={t(filter ? FILTER_TITLE[filter] : "Latest claims")} className="mt-5" actions={filter ? <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setFilter(null)}>{t("Show all")}</button> : undefined}>
          {claims.isLoading ? <Spinner /> : (
            <Table head={["Claim", "Patient", "Insurer", "Status", "Claimed", "To receive", ""]} {...((claims.data?.items.length ?? 0) === 0 ? { empty: filter ? "Nothing here. You're all caught up." : "No claims yet." } : {})}>
              {claims.data?.items.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <Td><span className="font-medium">{c.claimNumber}</span><div className="text-xs text-slate-500">{c.type.toLowerCase()}</div></Td>
                  <Td>{c.patient}<div className="text-xs text-slate-500">{c.mrn}</div></Td>
                  <Td>{c.insurer}<div className="text-xs text-slate-500">{`Policy ${c.policyNumber}`}</div></Td>
                  <Td><Badge tone={TONE[c.status] ?? "gray"}>{label(c.status)}</Badge></Td>
                  <Td>{c.claimedAmount ? money(c.claimedAmount) : "—"}</Td>
                  <Td>{c.outstanding ? money(c.outstanding) : "—"}</Td>
                  <Td><Link className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50" href={`/claims?open=${c.id}`}>{t("Open")}</Link></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {(summary.data?.length ?? 0) > 0 && (
        <Card title={t("Owed by insurers")} className="mt-5">
          <ul className="divide-y divide-slate-100">
            {summary.data?.map((s) => {
              const max = Math.max(...(summary.data ?? []).map((x) => Number(x.toReceive) + Number(x.waitingForDecision)), 1);
              const a = (Number(s.toReceive) / max) * 100, b = (Number(s.waitingForDecision) / max) * 100;
              return (
                <li key={s.insurerId} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm"><span className="font-medium text-slate-900">{s.insurer}</span><span className="text-xs text-slate-500">{`${s.claims} ${t("open claims")} · ${t("to receive")} ${money(s.toReceive)} · ${t("waiting for a decision")} ${money(s.waitingForDecision)}`}</span></div>
                  <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${s.insurer}: ${money(s.toReceive)} to receive, ${money(s.waitingForDecision)} waiting for a decision`}>
                    <i className="bg-emerald-500" style={{ width: `${a}%` }} /><i className="bg-amber-400" style={{ width: `${b}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex gap-4 text-xs text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />{t("Approved, to receive")}</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400" />{t("Waiting for a decision")}</span></div>
        </Card>
      )}
    </>
  );
}
