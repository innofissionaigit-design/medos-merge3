"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Badge, Card, ErrorNote, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Row { admissionId: string; admissionNumber: string; patient: string; mrn: string | null; dischargedAt: string; daysSinceDischarge: number | null; hisStatus: string; recordReady: boolean; recordComplete: boolean; recordFile: string | null; claim: { claimNumber: string; status: string; open: boolean } | null }
type View = "SIGN" | "WAIT" | "PAPER" | "DONE";

const TILES: { id: View; label: string; sub: string; tone: string; icon: "pen" | "clock" | "folder" | "check"; empty: string }[] = [
  { id: "SIGN", label: "Ready to sign off", sub: "Summary signed, departure recorded", tone: "bg-brand-500", icon: "pen", empty: "No record is waiting for your sign-off." },
  { id: "WAIT", label: "Waiting on others", sub: "Summary or departure missing", tone: "bg-amber-500", icon: "clock", empty: "Nothing is held up by another department." },
  { id: "PAPER", label: "Paper record not filed", sub: "File not yet received", tone: "bg-violet-500", icon: "folder", empty: "Every paper record has been received and filed." },
  { id: "DONE", label: "Completed", sub: "Signed off by Medical Records", tone: "bg-emerald-500", icon: "check", empty: "No record has been signed off in the last 90 days." },
];

function Icon({ name }: { name: "pen" | "clock" | "folder" | "check" | "alert" }) {
  const d: Record<string, ReactNode> = {
    pen: <path d="M4 20h4L19 9a2.800 2.800 0 0 0-4-4L4 16zM13.500 6.500l4 4" />,
    clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7.500V12l3 2" /></>,
    folder: <path d="M3.500 7a1.500 1.500 0 0 1 1.500-1.500h4l2 2.500h8A1.500 1.500 0 0 1 20.500 9.500V17A1.500 1.500 0 0 1 19 18.500H5A1.500 1.500 0 0 1 3.500 17z" />,
    check: <path d="m5 12.500 4.500 4.500L19 7.500" />,
    alert: <path d="M12 4 2.800 19.500h18.400zM12 10v4.500M12 17.200h.01" />,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d[name]}</svg>;
}

const inView = (r: Row, v: View) => v === "SIGN" ? r.recordReady && !r.recordComplete : v === "WAIT" ? !r.recordReady && !r.recordComplete : v === "PAPER" ? !r.recordFile : r.recordComplete;

function next(r: Row): { tone: "green" | "amber" | "blue" | "gray"; label: string; action: string } {
  if (r.recordComplete) return { tone: "green", label: "Record complete", action: "Open" };
  if (r.recordReady) return { tone: "blue", label: "Sign off the record", action: "Sign off" };
  return { tone: "amber", label: "Waiting for the ward", action: "Open" };
}

/**
 * The Medical Records Department's start screen: discharged stays whose record is ready for sign-off, which are held up by another department, which paper files have not
 * been received, and what is complete. Records past their retention period are counted too. Signing off and filing are done on the admission, as before.
 */
export function MrdDashboard() {
  const t = useT();
  const { me, can, dateTime } = useMe();
  const [view, setView] = useState<View>("SIGN");
  const q = useQuery({ queryKey: ["mrd-dash"], queryFn: () => api.get<{ items: Row[]; total: number }>("/post-discharge", { show: "ALL" }), refetchInterval: 30_000 });
  const retention = useQuery({ queryKey: ["mrd-retention"], queryFn: () => api.get<{ total: number }>("/records/retention", { show: "DUE", pageSize: 1 }), enabled: can("MRD_RETENTION"), refetchInterval: 60_000 });
  const rows = q.data?.items ?? [];
  const tile = TILES.find((x) => x.id === view)!;
  const shown = rows.filter((r) => inView(r, view));
  const due = retention.data?.total ?? 0;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{`${t("Welcome")}, ${me.fullName}`}</h1>
          <p className="text-sm text-slate-500">{`${me.tenant.name} · ${t("Medical Records")} · ${dateTime(new Date().toISOString())}`}</p>
        </div>
        <Link className="whitespace-nowrap rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700" href="/post-discharge">{t("Open post-discharge")}</Link>
      </div>
      <ErrorNote error={q.error} />

      {due > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700"><Icon name="alert" /></span>
          <span><b>{due === 1 ? "1 record is past its retention period and needs a decision." : `${due} records are past their retention period and need a decision.`}</b></span>
          <Link className="ml-auto whitespace-nowrap rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50" href="/post-discharge">{t("Review them")}</Link>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TILES.map((c) => {
          const active = view === c.id;
          return (
            <button key={c.id} type="button" onClick={() => setView(c.id)} aria-pressed={active} className={clsx("group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200")}>
              <span className={clsx("absolute inset-x-0 top-0 h-1", c.tone)} aria-hidden />
              <span className="flex items-center justify-between gap-2 text-slate-500"><span className="text-xs font-medium uppercase tracking-wide">{t(c.label)}</span><span className={clsx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", active ? "bg-brand-50 text-brand-700" : "bg-slate-50 group-hover:bg-slate-100")}><Icon name={c.icon} /></span></span>
              <span className="mt-2 block text-3xl font-semibold tracking-tight text-slate-900">{q.isLoading ? <span className="text-slate-400">…</span> : rows.filter((r) => inView(r, c.id)).length}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{t(c.sub)}</span>
            </button>
          );
        })}
      </div>

      <Card title={`${t(tile.label)}${q.data ? ` · ${shown.length}` : ""}`} className="mt-5">
        {q.isLoading ? <Spinner /> : (
          <Table head={["Patient", "Discharged", "Paper record", "Claim", "Next step", ""]} {...(shown.length === 0 ? { empty: tile.empty } : {})}>
            {shown.map((r) => {
              const n = next(r);
              return (
                <tr key={r.admissionId} className="hover:bg-slate-50">
                  <Td><span className="font-medium text-slate-900">{r.patient}</span><div className="text-xs text-slate-500">{`${r.mrn ?? ""} · ${r.admissionNumber}`}</div></Td>
                  <Td className="text-sm">{dateTime(r.dischargedAt)}<div className="text-xs text-slate-500">{r.daysSinceDischarge === 0 ? t("Today") : `${r.daysSinceDischarge ?? 0} ${t("days ago")}`}</div></Td>
                  <Td className="text-sm">{r.recordFile ? r.recordFile : <span className="text-slate-400">{t("Not received")}</span>}</Td>
                  <Td className="text-sm">{r.claim ? <span>{r.claim.claimNumber}<div className="text-xs text-slate-500">{r.claim.status.toLowerCase().replace(/_/g, " ")}</div></span> : <span className="text-slate-400">—</span>}</Td>
                  <Td><Badge tone={n.tone}>{t(n.label)}</Badge></Td>
                  <Td><Link className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50" href={`/ipd/${r.admissionId}`}>{t(n.action)}</Link></Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
