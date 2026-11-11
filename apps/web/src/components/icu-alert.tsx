"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Alert { admissionId: string; patientName: string; bed: string | null; kind: "VITALS_OVERDUE" | "URGENT_INSTRUCTION"; detail: string }

/** For the ICU nurse: vitals that are late and urgent instructions still open, at the top of every page until they are dealt with. */
export function IcuAlertBar() {
  const { can } = useMe();
  const q = useQuery({ queryKey: ["icu-alerts"], queryFn: () => api.get<Alert[]>("/icu/alerts"), enabled: can("ICU_NURSE"), refetchInterval: 10_000 });
  const rows = q.data ?? [];
  if (rows.length === 0) return null;
  return (
    <div role="alert" data-testid="icu-alert" className="border-b-2 border-amber-700 bg-amber-500 px-4 py-2 text-slate-900">
      <ul className="space-y-1">
        {rows.slice(0, 3).map((r) => (
          <li key={`${r.admissionId}:${r.kind}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-bold tracking-wide">ICU</span>
            <span className="font-semibold">{r.patientName}{r.bed ? ` · ${r.bed}` : ""}</span>
            <span>{r.kind === "VITALS_OVERDUE" ? "Vitals are due" : "Urgent instruction"}: {r.detail}</span>
            <Link href={`/icu/${r.admissionId}`} className="ml-auto rounded bg-white px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-50">Open</Link>
          </li>
        ))}
      </ul>
      {rows.length > 3 && <p className="mt-1 text-xs">and {rows.length - 3} more. <Link href="/icu" className="underline">Open the ICU board</Link></p>}
    </div>
  );
}
