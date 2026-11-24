"use client";
import { Gate } from "@/components/gate";
import { VideoConsults } from "@/components/telemedicine";

export default function TeleconsultPage() {
  return (
    <Gate anyOf={["TELE_READ"]}>
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
        <VideoConsults />
      </div>
    </Gate>
  );
}
