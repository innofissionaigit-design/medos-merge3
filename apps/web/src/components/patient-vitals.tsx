"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { showTemp, useTempUnit } from "@/lib/temperature";
import { TempUnitSwitch } from "./temp-unit";
import { useMe } from "@/lib/me";
import { Card, Spinner, Table, Td } from "./ui";

const LABELS: Record<string, string> = {
  SYSTOLIC_BP: "BP systolic", DIASTOLIC_BP: "BP diastolic", PULSE: "Pulse", TEMPERATURE: "Temperature", SPO2: "SpO₂",
  RESPIRATORY_RATE: "Resp. rate", WEIGHT: "Weight", HEIGHT: "Height", BMI: "BMI", BLOOD_GLUCOSE: "Blood glucose",
};
interface Obs { id: string; type: string; value: string; unit: string; recordedAt: string; recordedByName: string | null }

/** The patient's vitals across all visits: the latest reading of each kind, then the recent history. Read-only; nurses record them from the OPD queue. */
export function PatientVitalsCard({ patientId }: { patientId: string }) {
  const { can, dateTime } = useMe();
  const [tu, setTu] = useTempUnit();
  const val = (o: Obs): string => (o.type === "TEMPERATURE" ? showTemp(o.value, tu) : o.value);
  const unitOf = (o: Obs): string => (o.type === "TEMPERATURE" ? `°${tu}` : o.unit);
  const q = useQuery({ queryKey: ["patient-vitals", patientId], queryFn: () => api.page<Obs>(`/patients/${patientId}/observations`, { pageSize: 40 }), enabled: can("VITALS_READ"), refetchInterval: 15_000 });
  if (!can("VITALS_READ")) return null;
  const rows = q.data?.data ?? [];
  const latest = new Map<string, Obs>();
  for (const o of rows) if (!latest.has(o.type)) latest.set(o.type, o);
  return (
    <Card title="Vitals" actions={<TempUnitSwitch unit={tu} onChange={setTu} />}>
      {q.isLoading ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-slate-500">No vitals recorded yet.</p> : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="latest-vitals">
            {[...latest.values()].map((o) => (
              <div key={o.type} className="rounded-md border border-slate-200 p-2">
                <div className="text-xs text-slate-500">{LABELS[o.type] ?? o.type}</div>
                <div className="text-base font-semibold">{val(o)} <span className="text-xs font-normal text-slate-500">{unitOf(o)}</span></div>
              </div>
            ))}
          </div>
          <Table head={["When", "Reading", "Value", "Recorded by"]}>
            {rows.slice(0, 15).map((o) => <tr key={o.id}><Td>{dateTime(o.recordedAt)}</Td><Td>{LABELS[o.type] ?? o.type}</Td><Td>{val(o)} {unitOf(o)}</Td><Td>{o.recordedByName ?? "—"}</Td></tr>)}
          </Table>
        </>
      )}
    </Card>
  );
}
