"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Badge, Card, ErrorNote, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface WorkItem { testOrderId: string; test: string; state: string; accessionNumber: string | null; patient: string; mrn: string | null; critical: boolean; limsStatus?: string | null; visitNumber?: string }
type State = "WAITING_SAMPLE" | "SAMPLE_TAKEN" | "REPORTED" | "CRITICAL";

const CARDS: { id: State; label: string; sub: string; tone: string; icon: "scan" | "eye" | "check" | "alert"; empty: string }[] = [
  { id: "WAITING_SAMPLE", label: "Samples to take", sub: "Billed, no sample yet", tone: "bg-brand-500", icon: "scan", empty: "No sample is waiting to be taken. Billed laboratory tests appear here." },
  { id: "SAMPLE_TAKEN", label: "In the lab", sub: "Sample taken, report not final", tone: "bg-violet-500", icon: "eye", empty: "No test is in progress." },
  { id: "REPORTED", label: "Reported", sub: "Verified by the pathologist", tone: "bg-emerald-500", icon: "check", empty: "No verified report yet." },
  { id: "CRITICAL", label: "Critical results", sub: "Not yet acknowledged", tone: "bg-red-500", icon: "alert", empty: "No critical result is waiting to be acknowledged." },
];

function Icon({ name }: { name: "scan" | "eye" | "check" | "alert" }) {
  const d: Record<string, ReactNode> = {
    scan: <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />,
    eye: <><path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z" /><circle cx="12" cy="12" r="2.800" /></>,
    check: <path d="m5 12.500 4.500 4.500L19 7.500" />,
    alert: <path d="M12 4 2.800 19.500h18.400zM12 10v4.500M12 17.200h.01" />,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d[name]}</svg>;
}

function Tile({ card, active, onSelect }: { card: (typeof CARDS)[number]; active: boolean; onSelect: () => void }) {
  const t = useT();
  const q = useQuery({ queryKey: ["lab-count", card.id], queryFn: () => api.get<{ total: number }>("/lab/worklist", { state: card.id, pageSize: 1 }), refetchInterval: 20_000 });
  const n = q.data?.total;
  const hot = card.id === "CRITICAL" && (n ?? 0) > 0;
  return (
    <button type="button" onClick={onSelect} aria-pressed={active} className={clsx("group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200")}>
      <span className={clsx("absolute inset-x-0 top-0 h-1", card.tone)} aria-hidden />
      <span className="flex items-center justify-between gap-2 text-slate-500"><span className="text-xs font-medium uppercase tracking-wide">{t(card.label)}</span><span className={clsx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", hot ? "bg-red-50 text-red-600" : active ? "bg-brand-50 text-brand-700" : "bg-slate-50 group-hover:bg-slate-100")}><Icon name={card.icon} /></span></span>
      <span className={clsx("mt-2 block text-3xl font-semibold tracking-tight", hot ? "text-red-600" : "text-slate-900")}>{n ?? <span className="text-slate-400">…</span>}</span>
      <span className="mt-0.5 block text-xs text-slate-500">{t(card.sub)}</span>
    </button>
  );
}

/** What the technician does next on an open test, from where it stands in the laboratory. */
function nextStep(r: WorkItem): { tone: "amber" | "blue" | "green" | "gray"; label: string; action: string } {
  if (r.state === "WAITING_SAMPLE") return { tone: "amber", label: "Sample to take", action: "Take sample" };
  if (r.state === "REPORTED") return { tone: "green", label: "Reported", action: "Open" };
  if (r.limsStatus === "COLLECTED") return { tone: "amber", label: "Accept the sample", action: "Accept sample" };
  if (r.limsStatus === "PENDING_REVIEW") return { tone: "blue", label: "With the pathologist", action: "Open" };
  return { tone: "blue", label: "Enter the results", action: "Enter results" };
}

/**
 * The laboratory technician's own start screen: samples to take, tests in the lab with the next step for each, verified reports, and any critical result nobody has acknowledged yet.
 * The cards filter the list in place; the work itself (sample, results, review) is done on the LIS work list, with all its checks.
 */
export function LabTechDashboard() {
  const t = useT();
  const { me, dateTime } = useMe();
  const [state, setState] = useState<State>("WAITING_SAMPLE");
  const card = CARDS.find((c) => c.id === state)!;
  const list = useQuery({ queryKey: ["lab-dash", state], queryFn: () => api.get<{ items: WorkItem[]; total: number }>("/lab/worklist", { state, pageSize: 25 }), refetchInterval: 20_000 });
  const critical = useQuery({ queryKey: ["lab-count", "CRITICAL"], queryFn: () => api.get<{ total: number }>("/lab/worklist", { state: "CRITICAL", pageSize: 1 }), refetchInterval: 20_000 });
  const crit = critical.data?.total ?? 0;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{`${t("Welcome")}, ${me.fullName}`}</h1>
          <p className="text-sm text-slate-500">{`${me.tenant.name} · ${t("Laboratory")} · ${dateTime(new Date().toISOString())}`}</p>
        </div>
        <Link className="whitespace-nowrap rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700" href="/lis">{t("Open the work list")}</Link>
      </div>
      <ErrorNote error={list.error} />

      {crit > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900" role="alert">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600"><Icon name="alert" /></span>
          <span><b>{crit === 1 ? "1 critical result is not yet acknowledged." : `${crit} critical results are not yet acknowledged.`}</b></span>
          <button type="button" className="ml-auto whitespace-nowrap rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50" onClick={() => setState("CRITICAL")}>{t("Show them")}</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {CARDS.map((c) => <Tile key={c.id} card={c} active={state === c.id} onSelect={() => setState(c.id)} />)}
      </div>

      <Card title={`${t(card.label)}${list.data ? ` · ${list.data.total}` : ""}`} className="mt-5">
        {list.isLoading ? <Spinner /> : (
          <Table head={["Patient", "Test", "Sample no.", "Next step", ""]} {...((list.data?.items.length ?? 0) === 0 ? { empty: card.empty } : {})}>
            {list.data?.items.map((r) => (
              <tr key={r.testOrderId} className="hover:bg-slate-50">
                <Td><span className="font-medium text-slate-900">{r.patient}</span><div className="text-xs text-slate-500">{r.mrn}</div></Td>
                <Td>{r.test}</Td>
                <Td className="text-xs text-slate-600">{r.accessionNumber ?? "—"}</Td>
                <Td>{r.critical ? <Badge tone="red">Critical</Badge> : <Badge tone={nextStep(r).tone}>{t(nextStep(r).label)}</Badge>}</Td>
                <Td><Link className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50" href="/lis">{t(nextStep(r).action)}</Link></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
