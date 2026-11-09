"use client";
import { Gate } from "@/components/gate";
import { LimsPortal } from "@/components/lims";
import { LIMS_PORTAL_PERMISSIONS } from "@/lib/lims-access";

/** The laboratory portal: the LIMS manager's control room, the technicians' and specialists' desks, the nurse's sample list and reception's outpatient requests. */
export default function LimsPage() { return <Gate anyOf={LIMS_PORTAL_PERMISSIONS}><LimsPortal /></Gate>; }
