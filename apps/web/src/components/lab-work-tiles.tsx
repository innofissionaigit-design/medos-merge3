"use client";
import { useMe } from "@/lib/me";
import { StatTile } from "./dashboard-kit";
import { useRequests } from "./lims-common";

/**
 * Live laboratory work for the dashboard of anyone who handles samples or reports (nurse, technician, pathologist).
 * Each tile is the count of what is waiting on this person and opens the laboratory page. Shown by permission, never by role name.
 */
export function LabWorkTiles() {
  const { can } = useMe();
  const collect = can("LIMS_COLLECT");
  const tech = can("LIMS_ISSUE");
  const review = can("LAB_VERIFY", "RAD_REPORT");
  const toTake = useRequests({ status: "PENDING_COLLECTION" }, { enabled: collect, every: 15_000 });
  const mine = useRequests({ status: "PENDING_COLLECTION", mine: "true" }, { enabled: collect, every: 15_000 });
  const toAccept = useRequests({ status: "COLLECTED" }, { enabled: tech, every: 15_000 });
  const toIssue = useRequests({ status: "PASSED" }, { enabled: tech, every: 15_000 });
  const toReview = useRequests({ status: "PENDING_REVIEW" }, { enabled: review, every: 15_000 });
  if (!collect && !tech && !review) return null;
  // Patients who have not reached reception yet cannot be sampled: count only those who can be taken now.
  const readyNow = toTake.data?.items.filter((r) => !(r.origin === "OPD" && !r.arrivedAt)).length;
  const emergencies = toTake.data?.items.filter((r) => r.priority === "EMERGENCY").length ?? 0;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {collect && <StatTile icon="tube" tone="rose" value={readyNow} label="Samples to take now" note={emergencies > 0 ? `${emergencies} emergency` : undefined} noteTone="rose" href="/lims" />}
      {collect && <StatTile icon="clipboard" tone="brand" value={mine.data?.total} label="Assigned to me" href="/lims" />}
      {tech && <StatTile icon="flask" tone="violet" value={toAccept.data?.total} label="Samples to accept" href="/lims" />}
      {tech && <StatTile icon="check" tone="emerald" value={toIssue.data?.total} label="Reports ready to issue" href="/lims" />}
      {review && <StatTile icon="hourglass" tone="amber" value={toReview.data?.total} label="Reports to review" href="/lims" />}
    </div>
  );
}
