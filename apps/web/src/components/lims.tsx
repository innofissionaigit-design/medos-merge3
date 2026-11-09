"use client";
import { useState } from "react";
import { type Desk, DESK_LABEL, desksFor, portalTitle } from "@/lib/lims-access";
import { useMe } from "@/lib/me";
import { ControlRoom } from "./lims-control";
import { CollectionDesk, ReceptionDesk, SpecialistDesk, TechDesk } from "./lims-floor";
import { Notice, PageHeader, Tabs } from "./ui";

/** The LIMS portal. Each person lands on the desk their job needs; someone who holds several jobs gets a tab for each. */
export function LimsPortal() {
  const { can, me } = useMe();
  const { desks, first } = desksFor(can);
  const [picked, setPicked] = useState<Desk | null>(null);
  if (!first) return <Notice tone="warn">You do not have access to the laboratory portal.</Notice>;
  const desk: Desk = picked && desks.includes(picked) ? picked : first;
  return (
    <>
      <PageHeader title="Laboratory (LIMS)" subtitle={`${portalTitle(can)} · ${me.fullName}`} />
      {desks.length > 1 && <Tabs tabs={desks.map((d) => ({ id: d, label: DESK_LABEL[d] }))} value={desk} onChange={setPicked} />}
      {desk === "control" && <ControlRoom />}
      {desk === "technician" && <TechDesk />}
      {desk === "review" && <SpecialistDesk />}
      {desk === "collection" && <CollectionDesk />}
      {desk === "reception" && <ReceptionDesk />}
    </>
  );
}
