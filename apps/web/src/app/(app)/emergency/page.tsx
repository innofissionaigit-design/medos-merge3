"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { isOpen, LEVELS, patientLine, RegisterArrival, TriageBadge, WardMap, type CaseRow, type Level } from "@/components/emergency";
import { Badge, Button, Card, PageHeader, Spinner, StatusBadge, Table, Tabs, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

const minutesAgo = (iso: string): string => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};

/** The emergency board: who is in the emergency ward now, most urgent first, and what each one is waiting for. */
export default function EmergencyBoard() {
  const { can, dateTime, money } = useMe();
  const [view, setView] = useState<"active" | "closed">("active");
  const [reg, setReg] = useState(false);
  const list = useQuery({ queryKey: ["er-cases", view], queryFn: () => api.page<CaseRow>("/emergency/cases", { view, pageSize: 100 }), refetchInterval: 8_000 });
  const rows = list.data?.data ?? [];
  const counts = (Object.keys(LEVELS) as Level[]).map((l) => [l, rows.filter((r) => r.triageLevel === l).length] as const);
  const untriaged = rows.filter((r) => r.needsTriage).length;
  return (
    <Gate anyOf={["ER_READ"]}>
      <PageHeader title="Emergency" subtitle="Patients in the emergency ward, most urgent first. This board refreshes by itself."
        actions={can("ER_REGISTER") ? <Button onClick={() => setReg(true)}>Register an arrival</Button> : undefined} />
      <Tabs tabs={[{ id: "active", label: "In the ward now" }, { id: "closed", label: "Sent on or discharged" }]} value={view} onChange={setView} />
      {view === "active" && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-600">{rows.length} in the ward</span>
          {counts.filter(([, n]) => n > 0).map(([l, n]) => <span key={l} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${LEVELS[l].chip}`}>{LEVELS[l].label} {n}</span>)}
          {untriaged > 0 && <Badge tone="amber">{untriaged} waiting for triage</Badge>}
        </div>
      )}
      {view === "active" && <div className="mb-3"><WardMap /></div>}
      <Card>
        {list.isLoading ? <Spinner /> : (
          <Table head={["Level", "Patient", "Bed", "Complaint", "Arrived", "Doctor", "Where it stands", "Bill due", ""]} {...(rows.length === 0 ? { empty: view === "active" ? "No patient in the emergency ward." : "Nobody yet." } : {})}>
            {rows.map((r) => (
              <tr key={r.id} className={r.triageLevel && isOpen(r.status) ? LEVELS[r.triageLevel].row : ""}>
                <Td><TriageBadge level={r.triageLevel} /></Td>
                <Td><div className="font-medium">{r.patient?.name ?? r.caseNumber}</div><div className="text-xs text-slate-500">{patientLine(r.patient)}</div></Td>
                <Td>{r.bed ? <span className="font-medium">{r.bed.code}</span> : isOpen(r.status) ? <span className="text-xs text-amber-800">no bed</span> : <span className="text-slate-400">—</span>}</Td>
                <Td className="max-w-xs"><div className="truncate" title={r.chiefComplaint}>{r.chiefComplaint}</div><div className="text-xs text-slate-500">{r.arrivalMode.replace("_", " ").toLowerCase()}</div></Td>
                <Td><div>{dateTime(r.arrivedAt)}</div><div className="text-xs text-slate-500">{isOpen(r.status) ? minutesAgo(r.arrivedAt) : ""}</div></Td>
                <Td>{r.doctorName}{isOpen(r.status) && !r.doctorAccepted && <div className="text-xs text-red-700">not accepted yet</div>}</Td>
                <Td>
                  <StatusBadge value={r.status} />
                  {r.disposition && <div className="mt-0.5 text-xs text-slate-600">{r.disposition === "OT" ? "to the operation theatre" : r.disposition === "ICU" ? "to the ICU" : "home"}{r.admission?.bed ? ` · ${r.admission.bed}` : ""}</div>}
                </Td>
                <Td>{Number(r.bill.due) > 0 ? <span className="font-medium text-red-700">{money(r.bill.due)}</span> : Number(r.bill.open) > 0 ? <span className="text-slate-600">{money(r.bill.open)} open</span> : <span className="text-slate-400">—</span>}</Td>
                <Td><Link href={`/emergency/${r.id}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-slate-50">Open</Link></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {reg && <RegisterArrival onClose={() => setReg(false)} />}
    </Gate>
  );
}
