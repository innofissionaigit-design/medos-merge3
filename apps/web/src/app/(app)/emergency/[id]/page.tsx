"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Gate } from "@/components/gate";
import { AcceptBanner, BedCard, BillCard, CancelArrival, DecisionCard, isOpen, NotesCard, patientLine, TriageBadge, TriageCard, useErCase, useRefreshEmergency } from "@/components/emergency";
import { VitalsCard } from "@/components/ipd-extras";
import { VisitLabResults } from "@/components/lab";
import { LimsVisitCard } from "@/components/lims-order";
import { MedicationOrders } from "@/components/medication-orders";
import { OrderRequests } from "@/components/requests";
import { VisitRadiology } from "@/components/radiology";
import { ErrorNote, KV, Notice, PageHeader, Spinner, StatusBadge } from "@/components/ui";
import { useMe } from "@/lib/me";

const VITAL_LABEL: Record<string, string> = { SYSTOLIC_BP: "BP systolic", DIASTOLIC_BP: "BP diastolic", PULSE: "Pulse", TEMPERATURE: "Temperature", SPO2: "SpO₂", RESPIRATORY_RATE: "Resp. rate", WEIGHT: "Weight", BLOOD_GLUCOSE: "Glucose" };

/** One emergency patient: triage, vitals, the doctor's notes, medicines, tests, the bill and the decision, each shown to the people whose job it is. */
export default function EmergencyCasePage() {
  const { id } = useParams<{ id: string }>();
  const { can, dateTime, money } = useMe();
  const q = useErCase(id);
  const refresh = useRefreshEmergency();
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? new Error("Emergency case not found")} />;
  const c = q.data;
  const open = isOpen(c.status);
  const vitals = c.vitals ?? [];
  const bp = vitals.find((v) => v.type === "SYSTOLIC_BP") && vitals.find((v) => v.type === "DIASTOLIC_BP") ? `${vitals.find((v) => v.type === "SYSTOLIC_BP")?.value}/${vitals.find((v) => v.type === "DIASTOLIC_BP")?.value}` : null;
  const strip = [...(bp ? [{ k: "BP", v: `${bp} mmHg`, t: vitals.find((v) => v.type === "SYSTOLIC_BP")?.recordedAt ?? "" }] : []), ...vitals.filter((v) => !["SYSTOLIC_BP", "DIASTOLIC_BP", "BMI", "HEIGHT"].includes(v.type)).map((v) => ({ k: VITAL_LABEL[v.type] ?? v.type, v: `${v.value} ${v.unit}`, t: v.recordedAt }))];
  const nurseView = can("ER_TRIAGE");
  return (
    <Gate anyOf={["ER_READ"]}>
      <PageHeader title={c.patient?.name ?? c.caseNumber} subtitle={`${c.caseNumber} · ${patientLine(c.patient)} · arrived ${dateTime(c.arrivedAt)} · ${c.doctorName}`}
        actions={<><TriageBadge level={c.triageLevel} /><StatusBadge value={c.status} />{c.patient && can("PATIENT_READ") && <Link href={`/patients/${c.patientId}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Patient record</Link>}</>} />
      <div className="mb-3"><KV label="Complaint">{c.chiefComplaint}{c.broughtBy ? ` · brought by ${c.broughtBy}` : ""} · {c.arrivalMode.replace("_", " ").toLowerCase()}{c.patient?.emergencyContactName ? ` · relative: ${c.patient.emergencyContactName}${c.patient.emergencyContactMobile ? ` ${c.patient.emergencyContactMobile}` : ""}` : ""}</KV></div>
      {c.allergies.length > 0 && <div className="mb-3"><Notice tone="error">Allergies: {c.allergies.map((a) => `${a.allergen} (${a.severity.toLowerCase()}${a.reaction ? `, ${a.reaction}` : ""})`).join("; ")}</Notice></div>}
      <AcceptBanner c={c} onChange={refresh} />
      {open && c.needsTriage && nurseView && <div className="mb-3"><Notice tone="warn">This patient has not been triaged. Save the triage record, then take the vitals.</Notice></div>}
      <div className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" data-testid="case-progress">
        <div className="rounded-md border border-slate-200 bg-white p-2"><div className="text-xs text-slate-500">Doctor</div><div className="font-medium">{c.doctorAccepted ? `${c.doctorName}: accepted` : `${c.doctorName}: not accepted yet`}</div></div>
        <div className="rounded-md border border-slate-200 bg-white p-2"><div className="text-xs text-slate-500">Medicines</div><div className="font-medium">{c.medicines.prescribed === 0 ? "none prescribed" : `${c.medicines.prescribed} prescribed, ${c.medicines.pendingAtPharmacy} waiting at the pharmacy`}</div></div>
        <div className="rounded-md border border-slate-200 bg-white p-2"><div className="text-xs text-slate-500">Tests</div><div className="font-medium">{c.tests.total === 0 ? "none ordered" : `${c.tests.issued} reported, ${c.tests.pending} pending`}</div></div>
        <div className="rounded-md border border-slate-200 bg-white p-2"><div className="text-xs text-slate-500">Bill</div><div className="font-medium">{`${money(c.bill.openTotal)} open · ${money(c.bill.dueTotal)} due`}</div></div>
      </div>
      {strip.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="latest-vitals">
          {strip.map((s) => <div key={s.k} className="rounded-md border border-slate-200 bg-white p-2"><div className="text-xs text-slate-500">{s.k}</div><div className="text-lg font-semibold">{s.v}</div><div className="text-[11px] text-slate-500">{dateTime(s.t)}</div></div>)}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <TriageCard c={c} onChange={refresh} />
          <BedCard c={c} onChange={refresh} />
          {can("VITALS_READ") && <VitalsCard encounterId={c.encounterId} open={open} onChange={refresh} />}
          <OrderRequests encounterId={c.encounterId} open={open} area="ER" mayDecide={c.calledByMe && can("ER_TREAT")} rxKey={c.encounterId} />
          <NotesCard c={c} onChange={refresh} />
          {can("PRESCRIPTION_READ") && <MedicationOrders encounterId={c.encounterId} open={open} cacheKey={c.encounterId} />}
          {can("LIMS_READ") && (
            <div className="space-y-4">
              <LimsVisitCard encounterId={c.encounterId} visitType="EMERGENCY" active={open} />
              <VisitLabResults encounterId={c.encounterId} />
              <VisitRadiology encounterId={c.encounterId} />
            </div>
          )}
        </div>
        <div className="space-y-4">
          <DecisionCard c={c} onChange={refresh} />
          <BillCard c={c} onChange={refresh} />
          <CancelArrival c={c} onChange={refresh} />
        </div>
      </div>
    </Gate>
  );
}
