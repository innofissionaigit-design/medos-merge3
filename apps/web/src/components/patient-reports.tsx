"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { VisitLabResults } from "./lab";
import { VisitRadiology } from "./radiology";
import { Card, Spinner } from "./ui";

interface Visit { id: string; encounterNumber: string; type: string; startedAt: string; emergencyCaseId?: string | null }
interface Found { testOrderId: string }

/** One visit's laboratory and imaging reports, with a heading, only when the visit has any. The two cards show nothing for a visit with no tests. */
function VisitReports({ visit }: { visit: Visit }) {
  const { can, dateTime } = useMe();
  // The same requests (and cache entries) as the two cards below, so asking here costs nothing extra.
  const lab = useQuery({ queryKey: ["visit-lab", visit.id], queryFn: () => api.get<Found[]>(`/encounters/${visit.id}/lab-results`), enabled: can("LAB_READ") });
  const rad = useQuery({ queryKey: ["visit-rad", visit.id], queryFn: () => api.get<Found[]>(`/encounters/${visit.id}/radiology`), enabled: can("RAD_READ") });
  if ((lab.data?.length ?? 0) + (rad.data?.length ?? 0) === 0) return null;
  const kind = visit.type === "OPD" ? "Outpatient visit" : visit.emergencyCaseId ? "Emergency visit" : "Admission";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-1 text-sm">
        <span className="font-medium">{kind} {visit.encounterNumber}</span>
        <span className="flex items-center gap-3 text-xs text-slate-500">{dateTime(visit.startedAt)}{visit.emergencyCaseId && can("ER_READ") && <Link className="text-brand-700 hover:underline" href={`/emergency/${visit.emergencyCaseId}`}>Open the emergency case</Link>}</span>
      </div>
      <VisitLabResults encounterId={visit.id} />
      <VisitRadiology encounterId={visit.id} />
    </div>
  );
}

/** Every issued laboratory and imaging report of the patient, newest visit first, on the patient's own page (emergency, outpatient and admitted visits alike). */
export function PatientReports({ patientId }: { patientId: string }) {
  const { can } = useMe();
  const visits = useQuery({ queryKey: ["patient-visits-reports", patientId], queryFn: () => api.page<Visit>(`/patients/${patientId}/encounters`, { pageSize: 20 }), enabled: can("LAB_READ", "RAD_READ"), refetchInterval: 30_000 });
  if (!can("LAB_READ", "RAD_READ")) return null;
  return (
    <Card title="Test reports">
      {visits.isLoading ? <Spinner /> : (
        <div className="space-y-5">
          {visits.data?.data.map((v) => <VisitReports key={v.id} visit={v} />)}
          <p className="text-xs text-slate-500">A report appears here once the laboratory or radiology has issued it.</p>
        </div>
      )}
    </Card>
  );
}
