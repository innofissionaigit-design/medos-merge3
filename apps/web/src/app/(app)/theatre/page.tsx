"use client";
import { Gate } from "@/components/gate";
import { TheatreBoard } from "@/components/theatre";
import { PageHeader } from "@/components/ui";

/** The operation theatre board (docs/procedures.md): every procedure of the hospital in one list, with the theatre rooms. Read only; the work is done on the admission. */
export default function TheatrePage() {
  return (
    <Gate anyOf={["THEATRE_READ"]} feature="IPD_ENABLED">
      <PageHeader title="Operation theatre" subtitle="Every planned and finished procedure, and the theatre rooms. You read here; the coordinator performs and finalises on the admission." />
      <TheatreBoard />
    </Gate>
  );
}
