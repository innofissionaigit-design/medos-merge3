"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Alert { id: string; caseNumber: string; patientName: string | null; chiefComplaint: string; triageLevel: string | null; arrivedAt: string; action: "TRIAGE" | "ACCEPT" }

/**
 * The red alert (docs/emergency.md). It stays at the top of every page, for the emergency nurses and for the doctor who was called, until they act: the nurse by saving the triage
 * record, the doctor by accepting the patient. Nobody else sees it.
 */
export function EmergencyAlertBar() {
  const { can } = useMe();
  const q = useQuery({ queryKey: ["er-alerts"], queryFn: () => api.get<Alert[]>("/emergency/alerts"), enabled: can("ER_TRIAGE", "ER_TREAT"), refetchInterval: 8_000 });
  const rows = q.data ?? [];
  if (rows.length === 0) return null;
  return (
    <div role="alert" data-testid="emergency-alert" className="border-b-2 border-red-800 bg-red-600 px-4 py-2 text-white">
      <ul className="space-y-1">
        {rows.slice(0, 3).map((r) => (
          <li key={`${r.id}:${r.action}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="animate-pulse font-bold tracking-wide">🚨 EMERGENCY</span>
            <span className="font-semibold">{r.patientName ?? r.caseNumber}</span>
            <span className="min-w-0 truncate">{r.chiefComplaint}</span>
            <span className="rounded bg-white/20 px-2 py-0.5 text-xs">{r.action === "TRIAGE" ? "Needs triage" : "Waiting for you to accept"}</span>
            <Link href={`/emergency/${r.id}`} className="ml-auto rounded bg-white px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">Open the case</Link>
          </li>
        ))}
      </ul>
      {rows.length > 3 && <p className="mt-1 text-xs">and {rows.length - 3} more waiting. <Link href="/emergency" className="underline">Open the emergency board</Link></p>}
    </div>
  );
}
