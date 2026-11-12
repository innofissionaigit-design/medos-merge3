"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Gate } from "@/components/gate";
import { NewRequest, PlanBadge, SOURCE_LABEL, STATUS_LABEL, type PlanRow } from "@/components/planned";
import { Button, Card, ErrorNote, Input, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useDebounced } from "@/components/ui";
import { useMe } from "@/lib/me";

const ORDER = ["ADVISED", "DOCTOR_REVIEW", "AWAITING_PATIENT", "DESK_REVIEW", "TARIFF_PAYER", "PREAUTH", "DEPOSIT", "BED_ALLOCATION", "READY", "ADMITTED", "CLOSED"] as const;

/** The planned-admission queue: every request, where it stands and whose turn it is (docs/planned-admission.md). */
export default function PlannedPage() {
  const { can, date } = useMe();
  const [status, setStatus] = useState<string>("OPEN");
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [adding, setAdding] = useState(false);
  const summary = useQuery({ queryKey: ["planned-summary"], queryFn: () => api.get<{ open: number; counts: Record<string, number> }>("/planned-admissions/summary"), refetchInterval: 20_000 });
  const list = useQuery({ queryKey: ["planned-list", status, dq], queryFn: () => api.page<PlanRow>("/planned-admissions", { status, ...(dq.trim().length >= 2 ? { q: dq.trim() } : {}), pageSize: 100 }), refetchInterval: 20_000 });
  const chips: { id: string; label: string; n: number }[] = [{ id: "OPEN", label: "All open", n: summary.data?.open ?? 0 }, ...ORDER.map((s) => ({ id: s, label: STATUS_LABEL[s] ?? s, n: summary.data?.counts[s] ?? 0 })).filter((c) => c.n > 0 || c.id === status)];
  return (
    <Gate anyOf={["PLANNED_READ"]} feature="IPD_ENABLED">
      <PageHeader title="Planned admissions" subtitle="Patients who are to be admitted on a chosen day: request, doctor, admission desk, billing, insurance, deposit, bed, nursing." actions={can("PLANNED_REQUEST") ? <Button onClick={() => setAdding(true)}>New request</Button> : undefined} />
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by step">
        {chips.map((c) => (
          <button key={c.id} type="button" onClick={() => setStatus(c.id)} aria-pressed={status === c.id} className={clsx("rounded-full px-3 py-1 text-sm ring-1", status === c.id ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50")}>{c.label} <b>{c.n}</b></button>
        ))}
        <div className="ml-auto w-full sm:w-64"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, MRN or request no." aria-label="Search" /></div>
      </div>
      <Card>
        <ErrorNote error={list.error} />
        {list.isLoading ? <Spinner /> : (
          <Table head={["Request", "Patient", "Doctor", "Procedure", "Day", "Ward / bed", "Step", "Waiting for"]} {...(list.data?.data.length === 0 ? { empty: "No planned admissions here." } : {})}>
            {list.data?.data.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td><Link className="font-medium text-brand-700 hover:underline" href={`/planned/${r.id}`}>{r.requestNumber}</Link><div className="text-xs text-slate-500">{SOURCE_LABEL[r.source]}</div></Td>
                <Td>{r.patient.name}<div className="text-xs text-slate-500">{r.patient.mrn}</div></Td>
                <Td>{r.consultant.name}</Td>
                <Td>{r.plannedProcedure ?? r.diagnosis ?? "—"}{r.expectedStayDays ? <div className="text-xs text-slate-500">{`${r.expectedStayDays} days`}</div> : null}</Td>
                <Td>{r.proposedDate ? date(r.proposedDate) : "—"}</Td>
                <Td>{r.bed ?? r.ward ?? "—"}</Td>
                <Td><PlanBadge status={r.status} /></Td>
                <Td className="text-xs text-slate-600">{r.status === "CLOSED" || r.status === "ADMITTED" ? "—" : r.waitingFor}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {adding && <NewRequest onClose={() => setAdding(false)} />}
    </Gate>
  );
}
