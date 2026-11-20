"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Gate } from "@/components/gate";
import { todayIn } from "@/components/pickers";
import { NewRequest, PlanBadge, SOURCE_LABEL, STATUS_LABEL, StageDots, dayCount, waitedFor, type PlanRow } from "@/components/planned";
import { Button, Card, ErrorNote, Input, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useDebounced } from "@/components/ui";
import { useMe } from "@/lib/me";

const ORDER = ["ADVISED", "DOCTOR_REVIEW", "AWAITING_PATIENT", "DESK_REVIEW", "TARIFF_PAYER", "PREAUTH", "DEPOSIT", "BED_ALLOCATION", "READY", "ADMITTED", "CLOSED"] as const;

const GROUPS: { id: string; label: string; sub: string; tone: string; statuses: readonly string[] }[] = [
  { id: "ALL", label: "All open", sub: "Not yet admitted", tone: "bg-brand-500", statuses: ORDER.filter((x) => x !== "ADMITTED" && x !== "CLOSED") },
  { id: "DOCTOR", label: "With the doctor", sub: "Review and the patient's reply", tone: "bg-amber-500", statuses: ["ADVISED", "DOCTOR_REVIEW", "AWAITING_PATIENT"] },
  { id: "DESK", label: "Desk, billing, insurance", sub: "Details, estimate, payer, deposit", tone: "bg-violet-500", statuses: ["DESK_REVIEW", "TARIFF_PAYER", "PREAUTH", "DEPOSIT"] },
  { id: "BED", label: "Bed and ready", sub: "Bed held, waiting for the day", tone: "bg-emerald-500", statuses: ["BED_ALLOCATION", "READY"] },
];

function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join(""); }

/** The planned-admission queue: every request, where it stands and whose turn it is (docs/planned-admission.md). */
export default function PlannedPage() {
  const { me, can, date } = useMe();
  const router = useRouter();
  const today = todayIn(me.facility?.timezone ?? me.tenant.timezone);
  /** A request that still waits for the patient's day: due today, or already late. */
  const dayFlag = (r: PlanRow): "today" | "late" | null => {
    if (!r.proposedDate || r.status === "ADMITTED" || r.status === "CLOSED") return null;
    const d = r.proposedDate.slice(0, 10);
    return d < today ? "late" : d === today ? "today" : null;
  };
  const [status, setStatus] = useState<string>("OPEN");
  const [group, setGroup] = useState("ALL");
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [adding, setAdding] = useState(false);
  const summary = useQuery({ queryKey: ["planned-summary"], queryFn: () => api.get<{ open: number; counts: Record<string, number> }>("/planned-admissions/summary"), refetchInterval: 20_000 });
  const list = useQuery({ queryKey: ["planned-list", status, dq], queryFn: () => api.page<PlanRow>("/planned-admissions", { status, ...(dq.trim().length >= 2 ? { q: dq.trim() } : {}), pageSize: 100 }), refetchInterval: 20_000 });
  const chips: { id: string; label: string; n: number }[] = [{ id: "OPEN", label: "All open", n: summary.data?.open ?? 0 }, ...ORDER.map((s) => ({ id: s, label: STATUS_LABEL[s] ?? s, n: summary.data?.counts[s] ?? 0 })).filter((c) => c.n > 0 || c.id === status)];
  const groupCount = (statuses: readonly string[]) => statuses.reduce((n, st) => n + (summary.data?.counts[st] ?? 0), 0);
  const admitted = summary.data?.counts.ADMITTED ?? 0;
  const g = GROUPS.find((x) => x.id === group)!;
  const rows = (list.data?.data ?? []).filter((r) => status !== "OPEN" || group === "ALL" || g.statuses.includes(r.status));
  const due = (list.data?.data ?? []).filter((r) => r.status === "READY" && dayFlag(r) !== null);
  const late = (list.data?.data ?? []).filter((r) => dayFlag(r) === "late");
  return (
    <Gate anyOf={["PLANNED_READ"]} feature="IPD_ENABLED">
      <PageHeader title="Planned admissions" subtitle="Patients who are to be admitted on a chosen day: request, doctor, admission desk, billing, insurance, deposit, bed, nursing." actions={can("PLANNED_REQUEST") ? <Button onClick={() => setAdding(true)}>New request</Button> : undefined} />

      {/* Where the queue stands, by whose turn it is. Clicking a card narrows the list below. */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {GROUPS.map((x) => {
          const active = status === "OPEN" && group === x.id;
          return (
            <button key={x.id} type="button" onClick={() => { setStatus("OPEN"); setGroup(x.id); }} aria-pressed={active} className={clsx("group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200")}>
              <span className={clsx("absolute inset-x-0 top-0 h-1", x.tone)} aria-hidden />
              <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">{x.label}</span>
              <span className="mt-2 block text-3xl font-semibold tracking-tight text-slate-900">{summary.data ? groupCount(x.statuses) : <span className="text-slate-400">…</span>}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{x.sub}</span>
            </button>
          );
        })}
        <button type="button" onClick={() => { setStatus("ADMITTED"); setGroup("ALL"); }} aria-pressed={status === "ADMITTED"} className={clsx("group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", status === "ADMITTED" ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200")}>
          <span className="absolute inset-x-0 top-0 h-1 bg-slate-400" aria-hidden />
          <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">Admitted</span>
          <span className="mt-2 block text-3xl font-semibold tracking-tight text-slate-900">{summary.data ? admitted : <span className="text-slate-400">…</span>}</span>
          <span className="mt-0.5 block text-xs text-slate-500">Came in as planned</span>
        </button>
      </div>

      {due.length > 0 && (
        <div className="mb-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900" role="status">
          <b>{due.length === 1 ? "1 patient is due to be admitted today." : `${due.length} patients are due to be admitted today.`}</b>{" "}
          {due.slice(0, 3).map((r, i) => <span key={r.id}>{i > 0 ? ", " : ""}<Link className="font-medium underline" href={`/planned/${r.id}`}>{r.patient.name}</Link></span>)}{due.length > 3 ? " and more" : ""}
        </div>
      )}
      {late.length > 0 && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">
          <b>{late.length === 1 ? "1 request has passed its planned day." : `${late.length} requests have passed their planned day.`}</b>{" "}
          {late.slice(0, 3).map((r, i) => <span key={r.id}>{i > 0 ? ", " : ""}<Link className="font-medium underline" href={`/planned/${r.id}`}>{r.patient.name}</Link></span>)}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by step">
        {chips.map((c) => (
          <button key={c.id} type="button" onClick={() => { setStatus(c.id); setGroup("ALL"); }} aria-pressed={status === c.id && (c.id !== "OPEN" || group === "ALL")} className={clsx("rounded-full px-3 py-1 text-sm ring-1", status === c.id && (c.id !== "OPEN" || group === "ALL") ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50")}>{c.label} <b>{c.n}</b></button>
        ))}
        <div className="ml-auto w-full sm:w-64"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, MRN or request no." aria-label="Search" /></div>
      </div>
      <Card>
        <ErrorNote error={list.error} />
        {list.isLoading ? <Spinner /> : (
          <>
          <ul className="divide-y divide-slate-100 lg:hidden" aria-label="Planned admissions">
            {rows.length === 0 && <li className="p-4 text-sm text-slate-500">No planned admissions here.</li>}
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={`/planned/${r.id}`} className="block p-3 hover:bg-slate-50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><div className="truncate font-medium text-slate-900">{r.patient.name}</div><div className="text-xs text-slate-500">{r.patient.mrn} · {r.requestNumber}</div></div>
                    <PlanBadge status={r.status} />
                  </div>
                  <div className="mt-1 text-sm text-slate-700">{r.plannedProcedure ?? r.diagnosis ?? "Procedure to be decided"}{r.expectedStayDays ? ` · ${dayCount(r.expectedStayDays)}` : ""}</div>
                  <div className="mt-1 text-xs text-slate-500">{r.consultant.name} · {r.proposedDate ? date(r.proposedDate) : "no day yet"}{dayFlag(r) === "today" ? " (today)" : dayFlag(r) === "late" ? " (late)" : ""} · {r.bed ?? r.ward ?? "no bed yet"}</div>
                  <div className="mt-2"><StageDots status={r.status} /></div>
                  {r.status !== "CLOSED" && r.status !== "ADMITTED" && <div className="mt-2 rounded bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700">Next: {r.waitingFor}</div>}
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden lg:block">
          <Table head={["Patient", "Request", "Doctor", "Procedure", "Day", "Ward / bed", "Step", "Waiting for"]} {...(rows.length === 0 ? { empty: "No planned admissions here." } : {})}>
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer align-top hover:bg-slate-50" onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) router.push(`/planned/${r.id}`); }}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700" aria-hidden>{initials(r.patient.name)}</span>
                    <div className="min-w-0"><div className="font-medium text-slate-900">{r.patient.name}</div><div className="text-xs text-slate-500">{r.patient.mrn}</div></div>
                  </div>
                </Td>
                <Td className="whitespace-nowrap"><Link className="font-medium text-brand-700 hover:underline" href={`/planned/${r.id}`}>{r.requestNumber}</Link><div className="text-xs text-slate-500">{SOURCE_LABEL[r.source]}</div></Td>
                <Td className="text-sm">{r.consultant.name}</Td>
                <Td className="text-sm">{r.plannedProcedure ?? r.diagnosis ?? <span className="text-slate-400">Not decided yet</span>}{r.expectedStayDays ? <div className="text-xs text-slate-500">{dayCount(r.expectedStayDays)}</div> : null}</Td>
                <Td className="whitespace-nowrap text-sm">{r.proposedDate ? date(r.proposedDate) : <span className="text-slate-400">No day yet</span>}{dayFlag(r) === "today" ? <div className="mt-0.5 inline-block rounded bg-brand-50 px-1.5 text-xs font-medium text-brand-700">Today</div> : dayFlag(r) === "late" ? <div className="mt-0.5 inline-block rounded bg-red-50 px-1.5 text-xs font-medium text-red-700">Late</div> : null}</Td>
                <Td className="text-sm">{r.bed ?? r.ward ?? <span className="text-slate-400">—</span>}</Td>
                <Td><PlanBadge status={r.status} /><div className="mt-1.5"><StageDots status={r.status} /></div></Td>
                <Td className="text-xs text-slate-600">{r.status === "CLOSED" || r.status === "ADMITTED" ? "—" : <><span className="font-medium text-slate-800">{r.waitingFor}</span><div className="mt-0.5 text-slate-400">{`here for ${waitedFor(r.updatedAt)}`}</div></>}</Td>
              </tr>
            ))}
          </Table>
          </div>
          </>
        )}
      </Card>
      {adding && <NewRequest onClose={() => setAdding(false)} />}
    </Gate>
  );
}
