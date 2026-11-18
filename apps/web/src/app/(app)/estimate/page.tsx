"use client";
import { Gate } from "@/components/gate";
import { EstimatePanel } from "@/components/insurance-money";
import { PageHeader } from "@/components/ui";

/** Before admission: what each insurer pays and what the family pays (docs/insurance-money.md). */
export default function EstimatePage() {
  return (
    <Gate anyOf={["CLAIM_READ"]}>
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4 print:m-0 print:p-0">
        <PageHeader title="Estimate for the family" subtitle="What each insurer is expected to pay, and what the family pays" />
        <EstimatePanel />
      </div>
    </Gate>
  );
}
