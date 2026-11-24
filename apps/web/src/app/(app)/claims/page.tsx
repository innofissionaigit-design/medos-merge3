"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ClaimsList, InsurersTab } from "@/components/claims";
import { Gate } from "@/components/gate";

export default function ClaimsPage() {
  const open = useSearchParams().get("open");
  const [tab, setTab] = useState<"claims" | "insurers">("claims");
  return (
    <Gate anyOf={["CLAIM_READ"]}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Insurance claims</h1>
        <div className="flex gap-1 rounded-xl bg-slate-100/80 p-1" role="tablist" aria-label="Insurance claims">
          {([["claims", "Claims"], ["insurers", "Insurers and TPAs"]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${tab === id ? "bg-white text-blue-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{label}</button>)}
        </div>
      </div>
      {tab === "claims" && <ClaimsList initialOpen={open} />}
      {tab === "insurers" && <InsurersTab />}
    </Gate>
  );
}
