"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ClaimsList, InsurersTab } from "@/components/claims";
import { Gate } from "@/components/gate";
import { PageHeader, Tabs } from "@/components/ui";

export default function ClaimsPage() {
  const open = useSearchParams().get("open");
  const [tab, setTab] = useState<"claims" | "insurers">("claims");
  return (
    <Gate anyOf={["CLAIM_READ"]}>
      <PageHeader title="Insurance claims" />
      <Tabs tabs={[{ id: "claims", label: "Claims" }, { id: "insurers", label: "Insurers and TPAs" }]} value={tab} onChange={setTab} />
      {tab === "claims" && <ClaimsList initialOpen={open} />}
      {tab === "insurers" && <InsurersTab />}
    </Gate>
  );
}
