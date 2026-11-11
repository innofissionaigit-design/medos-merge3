"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Gate } from "@/components/gate";
import { DaysCard, FromEmergencyCard, InstructionsCard, IcuVitalsCard, ScheduleCard, useIcuStay, useRefreshIcu, vital } from "@/components/icu";
import { VisitLabResults } from "@/components/lab";
import { LimsVisitCard } from "@/components/lims-order";
import { MedicationOrders } from "@/components/medication-orders";
import { VisitRadiology } from "@/components/radiology";
import { ErrorNote, KV, Notice, PageHeader, Spinner } from "@/components/ui";
import { ageText } from "@/lib/format";
import { useMe } from "@/lib/me";

/** One ICU patient: what the doctor decided, what the nurse recorded, and what happened before the ICU, on one page for both. */
export default function IcuStayPage() {
  const { id } = useParams<{ id: string }>();
  const { can, dateTime } = useMe();
  const q = useIcuStay(id);
  const refresh = useRefreshIcu();
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? new Error("ICU stay not found")} />;
  const s = q.data;
  const strip = [["HR", `${vital(s.latest, "PULSE")}`], ["BP", `${vital(s.latest, "SYSTOLIC_BP")}/${vital(s.latest, "DIASTOLIC_BP")}`], ["SpO₂", vital(s.latest, "SPO2")], ["Temp", vital(s.latest, "TEMPERATURE")], ["RR", vital(s.latest, "RESPIRATORY_RATE")]];
  return (
    <Gate anyOf={["ICU_READ"]}>
      <PageHeader title={s.patient.name} subtitle={`${s.admissionNumber} · MRN ${s.patient.mrn ?? "—"} · ${s.patient.gender.toLowerCase()}${ageText(s.patient.age) ? `, ${ageText(s.patient.age)}` : ""} · ${s.bed ?? "no bed"} · in the ICU since ${dateTime(s.inIcuSince)} · ${s.doctorName}`}
        actions={<><Link href={`/ipd/${s.id}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Admission (charges, discharge)</Link>{can("PATIENT_READ") && <Link href={`/patients/${s.patient.id}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Patient record</Link>}</>} />
      {s.reason && <div className="mb-3"><KV label="Reason for admission">{s.reason}</KV></div>}
      {s.allergies.length > 0 && <div className="mb-3"><Notice tone="error">Allergies: {s.allergies.map((a) => `${a.allergen} (${a.severity.toLowerCase()}${a.reaction ? `, ${a.reaction}` : ""})`).join("; ")}</Notice></div>}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="icu-latest">
        {strip.map(([k, v]) => <div key={k} className="rounded-md border border-slate-200 bg-white p-2"><div className="text-xs text-slate-500">{k}</div><div className="text-lg font-semibold">{v}</div></div>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <ScheduleCard s={s} onChange={refresh} />
          <IcuVitalsCard s={s} onChange={refresh} />
          <InstructionsCard s={s} onChange={refresh} />
          {can("LIMS_READ") && (
            <div className="space-y-4">
              <LimsVisitCard encounterId={s.encounterId} visitType="IPD" active />
              <VisitLabResults encounterId={s.encounterId} />
              <VisitRadiology encounterId={s.encounterId} />
            </div>
          )}
        </div>
        <div className="space-y-4">
          <DaysCard s={s} onChange={refresh} />
          {s.fromEmergency && <FromEmergencyCard e={s.fromEmergency} />}
          {can("PRESCRIPTION_READ") && <MedicationOrders encounterId={s.encounterId} open cacheKey={s.id} />}
        </div>
      </div>
    </Gate>
  );
}
