"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { LEVELS, TriageBadge, type Level } from "@/components/emergency";
import { Badge, Card, ErrorNote, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Overview {
  asOf: string;
  emergency: {
    inWard: number; notTriaged: number; waitingForDoctor: number; longestWaitMinutes: number; byLevel: Record<Level, number>; arrivalsToday: number; decisionsToday: { OT: number; ICU: number; DISCHARGE: number };
    beds: { total: number; free: number; withoutBed: number }; billDue: string;
    cases: { id: string; caseNumber: string; patientName: string | null; triageLevel: Level | null; status: string; doctorName: string; bed: string | null; minutesInWard: number; doctorAccepted: boolean; billDue: string }[];
  };
  icu: {
    patients: number; beds: { total: number; free: number }; vitalsOverdue: number; urgentInstructionsOpen: number; pendingTests: number; equipmentInUse: number; chargesSoFar: string;
    stays: { id: string; admissionNumber: string; patientName: string; bed: string | null; doctorName: string; since: string; vitalsOverdue: boolean; minutesLate: number; openInstructions: number; pendingTests: number; chargesSoFar: string }[];
  };
  billing: {
    invoicedToday: { count: number; total: string }; collectedToday: { total: string; byMethod: { method: string; amount: string }[] };
    outstanding: { total: string; count: number; byKind: { kind: string; count: number; total: string }[] }; admittedChargesNotBilled: { patients: number; total: string };
  };
}

const KIND: Record<string, string> = { EMERGENCY: "Emergency", IPD: "Admitted patients", OPD: "Outpatients", PHARMACY: "Pharmacy", OTHER: "Other", REGISTRATION: "Registration" };
const METHOD: Record<string, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", BANK_TRANSFER: "Bank transfer", OTHER: "Other" };

function Tile({ label, value, tone, sub }: { label: string; value: string | number; tone?: "red" | "amber"; sub?: string }) {
  const bar = tone === "red" ? "bg-red-500" : tone === "amber" ? "bg-amber-500" : "bg-slate-300";
  return (
    <div className={`relative overflow-hidden rounded-xl border bg-white p-3.5 shadow-sm ${tone === "red" ? "border-red-200" : tone === "amber" ? "border-amber-200" : "border-slate-200"}`}>
      <span className={`absolute inset-x-0 top-0 h-1 ${bar}`} aria-hidden />
      <div className="text-[11px] font-medium uppercase leading-tight tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums tracking-tight ${tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : "text-slate-900"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

/** What the manager should look at first: only conditions that are true right now. */
function attention(o: Overview): { tone: "red" | "amber"; text: string }[] {
  const items: { tone: "red" | "amber"; text: string }[] = [];
  if (o.emergency.beds.withoutBed > 0) items.push({ tone: "red", text: `${o.emergency.beds.withoutBed} emergency ${o.emergency.beds.withoutBed === 1 ? "patient has" : "patients have"} no bed` });
  if (o.icu.vitalsOverdue > 0) items.push({ tone: "red", text: `ICU vitals running late for ${o.icu.vitalsOverdue} ${o.icu.vitalsOverdue === 1 ? "patient" : "patients"}` });
  if (o.emergency.notTriaged > 0) items.push({ tone: "amber", text: `${o.emergency.notTriaged} waiting for triage` });
  if (o.emergency.waitingForDoctor > 0) items.push({ tone: "amber", text: `${o.emergency.waitingForDoctor} not yet seen by a doctor` });
  if (o.icu.urgentInstructionsOpen > 0) items.push({ tone: "amber", text: `${o.icu.urgentInstructionsOpen} urgent ICU ${o.icu.urgentInstructionsOpen === 1 ? "instruction" : "instructions"} open` });
  if (o.billing.admittedChargesNotBilled.patients > 0) items.push({ tone: "amber", text: `Charges of ${o.billing.admittedChargesNotBilled.patients} admitted ${o.billing.admittedChargesNotBilled.patients === 1 ? "patient" : "patients"} not yet billed` });
  return items;
}

const waited = (m: number): string => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

/** The hospital manager's status board: what is happening in the emergency ward, the ICU and billing right now. Read only: it follows the work and does not direct it. */
export default function OverviewPage() {
  const { money, dateTime } = useMe();
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/overview"), refetchInterval: 15_000 });
  const o = q.data;
  return (
    <Gate anyOf={["OVERVIEW_READ"]}>
      <PageHeader title="Hospital status" actions={<span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />Live · refreshes every 15 seconds</span>} subtitle={o ? `As of ${dateTime(o.asOf)}. This page refreshes by itself and only shows the state; the work is done by the teams.` : "The emergency ward, the ICU and billing at a glance."} />
      {q.isLoading ? <Spinner /> : <ErrorNote error={q.error} />}
      {o && (
        <div className="space-y-4">
          {(() => {
            const items = attention(o);
            return items.length === 0 ? (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800" role="status"><span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />Nothing needs attention right now.</div>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" role="status" aria-label="Needs attention now">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" /></span>Needs attention now</div>
                <div className="flex flex-wrap gap-2">{items.map((i) => <span key={i.text} className={`rounded-full px-3 py-1 text-sm font-medium ${i.tone === "red" ? "bg-red-50 text-red-800 ring-1 ring-red-200" : "bg-amber-50 text-amber-800 ring-1 ring-amber-200"}`}>{i.text}</span>)}</div>
              </div>
            );
          })()}
          <Card title="Emergency ward" actions={<Link href="/emergency" className="text-sm text-brand-700 hover:underline">Open the emergency board</Link>}>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" data-testid="overview-emergency">
              <Tile label="In the ward now" value={o.emergency.inWard} />
              <Tile label="Waiting for triage" value={o.emergency.notTriaged} {...(o.emergency.notTriaged > 0 ? { tone: "amber" as const } : {})} />
              <Tile label="Not yet seen by the doctor" value={o.emergency.waitingForDoctor} {...(o.emergency.waitingForDoctor > 0 ? { tone: "amber" as const } : {})} />
              <Tile label="Longest wait for a doctor" value={o.emergency.waitingForDoctor > 0 ? waited(o.emergency.longestWaitMinutes) : "—"} />
              <Tile label="Beds free" value={`${o.emergency.beds.free} of ${o.emergency.beds.total}`} {...(o.emergency.beds.withoutBed > 0 ? { tone: "red" as const } : {})} />
              <Tile label="Bill due" value={money(o.emergency.billDue)} />
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              {(Object.keys(LEVELS) as Level[]).filter((l) => o.emergency.byLevel[l] > 0).map((l) => <span key={l} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${LEVELS[l].chip}`}>{LEVELS[l].label} {o.emergency.byLevel[l]}</span>)}
              <span className="text-slate-600">Arrived today {o.emergency.arrivalsToday} · sent to the OT {o.emergency.decisionsToday.OT} · to the ICU {o.emergency.decisionsToday.ICU} · home {o.emergency.decisionsToday.DISCHARGE}</span>
              {o.emergency.beds.withoutBed > 0 && <Badge tone="red">{`${o.emergency.beds.withoutBed} without a bed`}</Badge>}
            </div>
            <Table head={["Level", "Patient", "Bed", "Doctor", "In the ward", "Bill due", ""]} {...(o.emergency.cases.length === 0 ? { empty: "Nobody in the emergency ward." } : {})}>
              {o.emergency.cases.map((c) => (
                <tr key={c.id}>
                  <Td><TriageBadge level={c.triageLevel} /></Td>
                  <Td className="font-medium">{c.patientName ?? c.caseNumber}</Td>
                  <Td>{c.bed ?? <span className="text-amber-800">no bed</span>}</Td>
                  <Td>{c.doctorName}{!c.doctorAccepted && <div className="text-xs text-red-700">not accepted yet</div>}</Td>
                  <Td>{waited(c.minutesInWard)}</Td>
                  <Td>{Number(c.billDue) > 0 ? money(c.billDue) : "—"}</Td>
                  <Td><Link href={`/emergency/${c.id}`} className="text-sm text-brand-700 hover:underline">View</Link></Td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Intensive care unit" actions={<Link href="/icu" className="text-sm text-brand-700 hover:underline">Open the ICU board</Link>}>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" data-testid="overview-icu">
              <Tile label="Patients in the ICU" value={o.icu.patients} />
              <Tile label="Beds free" value={`${o.icu.beds.free} of ${o.icu.beds.total}`} />
              <Tile label="Vitals running late" value={o.icu.vitalsOverdue} {...(o.icu.vitalsOverdue > 0 ? { tone: "red" as const } : {})} />
              <Tile label="Urgent instructions open" value={o.icu.urgentInstructionsOpen} {...(o.icu.urgentInstructionsOpen > 0 ? { tone: "amber" as const } : {})} />
              <Tile label="Tests waiting" value={o.icu.pendingTests} />
              <Tile label="Equipment in use" value={o.icu.equipmentInUse} />
            </div>
            <Table head={["Patient", "Bed", "Doctor", "In the ICU since", "Vitals", "Charged so far", ""]} {...(o.icu.stays.length === 0 ? { empty: "Nobody in the ICU." } : {})}>
              {o.icu.stays.map((s) => (
                <tr key={s.id}>
                  <Td><div className="font-medium">{s.patientName}</div><div className="text-xs text-slate-500">{s.admissionNumber}</div></Td>
                  <Td>{s.bed ?? "—"}</Td>
                  <Td>{s.doctorName}</Td>
                  <Td>{dateTime(s.since)}</Td>
                  <Td>{s.vitalsOverdue ? <Badge tone="red">{`${s.minutesLate} min late`}</Badge> : <Badge tone="green">on time</Badge>}</Td>
                  <Td>{money(s.chargesSoFar)}</Td>
                  <Td><Link href={`/icu/${s.id}`} className="text-sm text-brand-700 hover:underline">View</Link></Td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Billing" actions={<Link href="/billing" className="text-sm text-brand-700 hover:underline">Open billing</Link>}>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="overview-billing">
              <Tile label={`Billed today (${o.billing.invoicedToday.count} bills)`} value={money(o.billing.invoicedToday.total)} />
              <Tile label="Collected today" value={money(o.billing.collectedToday.total)} />
              <Tile label={`Outstanding (${o.billing.outstanding.count} bills)`} value={money(o.billing.outstanding.total)} />
              <Tile label={`Admitted patients' charges not yet billed (${o.billing.admittedChargesNotBilled.patients})`} value={money(o.billing.admittedChargesNotBilled.total)} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Table head={["Collected today by", "Amount"]} {...(o.billing.collectedToday.byMethod.length === 0 ? { empty: "Nothing collected yet today." } : {})}>
                {o.billing.collectedToday.byMethod.map((m) => <tr key={m.method}><Td>{METHOD[m.method] ?? m.method}</Td><Td>{money(m.amount)}</Td></tr>)}
              </Table>
              <Table head={["Outstanding on", "Bills", "Amount"]} {...(o.billing.outstanding.byKind.length === 0 ? { empty: "Nothing outstanding." } : {})}>
                {o.billing.outstanding.byKind.map((k) => <tr key={k.kind}><Td>{KIND[k.kind] ?? k.kind}</Td><Td>{k.count}</Td><Td>{money(k.total)}</Td></tr>)}
              </Table>
            </div>
          </Card>
        </div>
      )}
    </Gate>
  );
}
