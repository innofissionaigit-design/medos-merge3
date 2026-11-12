"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Gate } from "@/components/gate";
import { ROUND_TONE, ROUND_WORD, RoundTimesEditor, type RoundRow, type Slot } from "@/components/rounds";
import { Badge, Card, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface BoardPatient {
  admissionId: string; admissionNumber: string; patientName: string; mrn: string | null; doctor: string; bed: string | null; days: number; reason: string | null;
  discharge: { cleared: number; steps: number };
  vitals: { at: string | null; late: boolean; bp: string | null };
  medicines: { active: number; withoutSchedule: number; dueNow: number; overdue: number };
  tasks: { pending: number; overdue: number }; tests: { open: number; resultsLast24h: number }; procedures: number;
  lastNote: { at: string; condition: string | null } | null; charges: { pendingCount: number; pendingTotal: string };
}
interface Board {
  generatedAt: string; rounds: RoundRow[]; timings: Slot[];
  totals: { admitted: number; vitalsLate: number; doseOverdue: number; tasksOverdue: number; notSeenToday: number; pendingCharges: number };
  wards: { id: string; name: string; code: string; beds: number; occupied: number; available: number; other: number; attention: number; patients: BoardPatient[] }[];
}
interface Activity { at: string; kind: string; text: string; admissionId: string | null; patient: string | null; by: string | null }
const KIND_TONE: Record<string, "gray" | "green" | "amber" | "red" | "blue" | "purple"> = { ROUND_NOTE: "blue", ROUND: "purple", ORDER: "amber", DOSE: "green", TASK: "green", NURSE_NOTE: "gray", TEST: "amber", PROCEDURE: "blue", ADMITTED: "blue", DISCHARGED: "gray" };
const KIND_WORD: Record<string, string> = { ROUND_NOTE: "Doctor's note", ROUND: "Round", ORDER: "Order", DOSE: "Dose", TASK: "Nursing task", NURSE_NOTE: "Nursing note", TEST: "Test", PROCEDURE: "Procedure", ADMITTED: "Admitted", DISCHARGED: "Discharged" };
const COND_TONE = { IMPROVING: "green", STABLE: "blue", WORSENING: "amber", CRITICAL: "red" } as const;

/** The ward coordinator's board: every ward and what is going on, the doctors' rounds, and what people have just done (docs/ward-rounds.md). Read only, except the round times. */
export default function WardBoardPage() {
  const { dateTime, money } = useMe();
  const board = useQuery({ queryKey: ["ward-board"], queryFn: () => api.get<Board>("/ward-board"), refetchInterval: 15_000 });
  const activity = useQuery({ queryKey: ["ward-activity"], queryFn: () => api.get<Activity[]>("/ward-board/activity", { limit: 40 }), refetchInterval: 15_000 });
  const b = board.data;
  const stat = (label: string, n: number | string, warn = false) => <div className={clsx("rounded-lg border px-3 py-2", warn && Number(n) > 0 ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white")}><div className="text-xs uppercase tracking-wide text-slate-500">{label}</div><div className="text-2xl font-semibold">{n}</div></div>;
  return (
    <Gate anyOf={["WARD_BOARD_READ"]} feature="IPD_ENABLED">
      <PageHeader title="Ward board" subtitle="Every ward and what is going on in it. You read here and set the round times; the care is given by the doctors and nurses." />
      {board.isLoading || !b ? <Spinner /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {stat("Admitted", b.totals.admitted)}{stat("Vitals late", b.totals.vitalsLate, true)}{stat("Doses overdue", b.totals.doseOverdue, true)}{stat("Tasks overdue", b.totals.tasksOverdue, true)}{stat("No doctor's note in 24 h", b.totals.notSeenToday, true)}{stat("Charges not billed", b.totals.pendingCharges)}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <RoundTimesEditor />
            <Card title="Today's doctor rounds">
              <Table head={["Round", "Doctor", "Status", "Seen"]} {...(b.rounds.length === 0 ? { empty: "No round has come due yet today." } : {})}>
                {b.rounds.map((r) => (
                  <tr key={r.id}>
                    <Td>{r.label}<div className="text-xs text-slate-500">{dateTime(r.scheduledAt).split(", ").pop()}</div></Td><Td>{r.doctor}</Td>
                    <Td><Badge tone={ROUND_TONE[r.status]}>{ROUND_WORD[r.status]}</Badge></Td>
                    <Td>{r.status === "COMPLETED" ? `${r.patientsSeen ?? 0} of ${r.patientsTotal ?? 0}` : r.status === "STARTED" ? `${r.seenNow ?? 0} so far` : "—"}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>

          {b.wards.map((w) => (
            <Card key={w.id} title={<span className="flex flex-wrap items-center gap-2">{w.name}<span className="text-xs font-normal text-slate-500">{`${w.occupied} of ${w.beds} beds occupied, ${w.available} free`}</span>{w.attention > 0 && <Badge tone="amber">{`${w.attention} need attention`}</Badge>}</span>}>
              {w.patients.length === 0 ? <p className="text-sm text-slate-500">No patients.</p> : (
                <Table head={["Bed", "Patient", "Doctor", "Vitals", "Medicines", "Tasks", "Tests", "Doctor's last note", "Charged", "Discharge"]}>
                  {w.patients.map((p) => (
                    <tr key={p.admissionId} className="align-top hover:bg-slate-50">
                      <Td><b>{p.bed ?? "—"}</b></Td>
                      <Td><Link className="font-medium text-brand-700 hover:underline" href={`/ipd/${p.admissionId}`}>{p.patientName}</Link><div className="text-xs text-slate-500">{`${p.mrn ?? ""} · day ${p.days + 1}`}</div></Td>
                      <Td>{p.doctor}</Td>
                      <Td>{p.vitals.late ? <Badge tone="amber">late</Badge> : <span className="text-xs">{p.vitals.bp ?? "ok"}</span>}</Td>
                      <Td>{p.medicines.overdue > 0 ? <Badge tone="red">{`${p.medicines.overdue} overdue`}</Badge> : p.medicines.dueNow > 0 ? <Badge tone="amber">{`${p.medicines.dueNow} due`}</Badge> : <span className="text-xs text-slate-500">{p.medicines.active === 0 ? "none" : "on time"}</span>} {p.medicines.withoutSchedule > 0 && <Badge tone="amber">new order</Badge>}</Td>
                      <Td>{p.tasks.pending === 0 ? <span className="text-xs text-slate-500">none</span> : <span className="text-xs">{`${p.tasks.pending} pending`}{p.tasks.overdue > 0 && <> <Badge tone="red">{`${p.tasks.overdue} overdue`}</Badge></>}</span>}</Td>
                      <Td>{p.tests.open + p.tests.resultsLast24h === 0 ? <span className="text-xs text-slate-500">none</span> : <span className="text-xs">{p.tests.open > 0 ? `${p.tests.open} waiting` : ""}{p.tests.resultsLast24h > 0 ? ` ${p.tests.resultsLast24h} result(s)` : ""}</span>}</Td>
                      <Td>{p.lastNote ? <span className="text-xs">{dateTime(p.lastNote.at)} {p.lastNote.condition && <Badge tone={COND_TONE[p.lastNote.condition as keyof typeof COND_TONE] ?? "gray"}>{p.lastNote.condition.toLowerCase()}</Badge>}</span> : <Badge tone="amber">no note</Badge>}</Td>
                      <Td><span className="text-xs">{p.charges.pendingCount === 0 ? "—" : money(p.charges.pendingTotal)}</span></Td>
                      <Td><span className="text-xs">{`${p.discharge.cleared} of ${p.discharge.steps}`}</span></Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          ))}

          <Card title="What has just happened">
            {activity.isLoading ? <Spinner /> : (activity.data?.length ?? 0) === 0 ? <p className="text-sm text-slate-500">Nothing yet.</p> : (
              <ul className="divide-y divide-slate-100 text-sm">
                {activity.data!.map((a, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="w-28 shrink-0 text-xs text-slate-500">{dateTime(a.at)}</span>
                    <Badge tone={KIND_TONE[a.kind] ?? "gray"}>{KIND_WORD[a.kind] ?? a.kind}</Badge>
                    {a.patient && (a.admissionId ? <Link className="font-medium text-brand-700 hover:underline" href={`/ipd/${a.admissionId}`}>{a.patient}</Link> : <b>{a.patient}</b>)}
                    <span>{a.text}</span>{a.by && <span className="text-xs text-slate-500">{`· ${a.by}`}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </Gate>
  );
}
