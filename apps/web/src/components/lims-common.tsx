"use client";
import clsx from "clsx";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey, type Query } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { Badge, Button, ConfirmButton, ErrorNote, Field, Input, KV, Modal, Notice, Select, Spinner, Table, Td, Textarea } from "./ui";

export interface Req {
  id: string; requestNumber: string; status: string; priority: "EMERGENCY" | "URGENT" | "ROUTINE"; origin: "OPD" | "IPD" | "EMERGENCY"; department: "PATHOLOGY" | "RADIOLOGY"; departmentName: string;
  test: string; testOrderId: string; patient: { id: string; name: string; gender: string; mrn: string | null }; encounterId: string; visitNumber: string; doctor: string | null; batchId: string;
  createdAt: string; scheduledFor: string | null; arrivedAt: string | null; bed: { code: string; ward: string } | null; dueAt: string; delayed: boolean; assignedNurse: { id: string; name: string | null } | null; assignedTech: { id: string; name: string | null } | null;
  needsRecollection: boolean; recollectCount: number; returnedCount: number; compromisedSampleApproved: boolean; instructions: string | null; clinicalNote: string | null; billed: boolean; version: number;
  accessionNumber: string | null; resultId: string | null; resultVersion: number | null; studyId: string | null; critical: boolean;
  stamps: { collectedAt: string | null; acceptedAt: string | null; submittedAt: string | null; passedAt: string | null; issuedAt: string | null; handedOverAt: string | null };
}
export interface Detail extends Req {
  timeline: { kind: string; from: string | null; to: string | null; at: string; by: string | null; note: string | null }[];
  exceptions: { id: string; kind: string; reason: string; status: string; raisedAt: string; raisedBy: string | null; decidedBy: string | null; decisionNote: string | null }[];
}
export interface Staff { nurses: { id: string; fullName: string }[]; technicians: { id: string; fullName: string; department: string }[] }

/** Is a typed number outside its printed range ("12.0 - 15.5", "< 5", "> 2")? Text results and ranges that cannot be read give null (nothing to flag). */
export function flagOf(value: string, rangeText: string): "LOW" | "HIGH" | null {
  const n = Number(value.trim());
  if (value.trim() === "" || !Number.isFinite(n)) return null;
  const nums = rangeText.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (/^\s*[<≤]/.test(rangeText) && nums.length === 1) return n > nums[0]! ? "HIGH" : null;
  if (/^\s*[>≥]/.test(rangeText) && nums.length === 1) return n < nums[0]! ? "LOW" : null;
  if (nums.length !== 2) return null;
  return n < nums[0]! ? "LOW" : n > nums[1]! ? "HIGH" : null;
}

/** A small "low" / "high" mark beside a result that is outside its normal range. */
export function RangeMark({ value, rangeText }: { value: string; rangeText: string }) {
  const f = flagOf(value, rangeText);
  return f ? <Badge tone="amber">{f === "LOW" ? "low ↓" : "high ↑"}</Badge> : null;
}

/**
 * The order in which a nurse takes samples:
 * 1. emergencies (those who can be sampled now before an emergency who has not reached reception),
 * 2. outpatients who have reported at reception and been billed, the one who arrived first on top (urgent before routine),
 * 3. admitted patients' tests, 4. outpatients who have not arrived yet.
 */
export function collectionRank(r: Pick<Req, "origin" | "arrivedAt" | "priority">): number {
  const notHere = r.origin === "OPD" && !r.arrivedAt;
  if (r.priority === "EMERGENCY") return notHere ? 1 : 0;
  const urgent = r.priority === "URGENT" ? 0 : 0.5;
  if (notHere) return 4 + urgent;
  return (r.origin === "OPD" ? 2 : 3) + urgent;
}
/** Sorts requests into collection order; within a group the earliest arrival (or, for the admitted, the earliest due) comes first. */
export const byCollection = (a: Req, b: Req): number => collectionRank(a) - collectionRank(b) || (a.arrivedAt ?? a.dueAt).localeCompare(b.arrivedAt ?? b.dueAt);

/** The names staff see for each step. Imaging has no sample: the nurse gets the patient ready. */
export function stageLabel(r: Pick<Req, "status" | "department" | "needsRecollection">): string {
  const rad = r.department === "RADIOLOGY";
  switch (r.status) {
    case "PENDING_COLLECTION": return r.needsRecollection ? "Waiting for a new sample" : rad ? "Waiting for the patient to be made ready" : "Waiting for sample";
    case "COLLECTED": return rad ? "Patient ready for the scan" : "Sample received";
    case "IN_PROCESS": return "In progress";
    case "PENDING_REVIEW": return rad ? "Waiting for the radiologist" : "Waiting for the pathologist";
    case "PASSED": return "Ready to issue";
    case "ISSUED": return "Issued";
    case "HANDED_OVER": return "Handed over";
    case "CANCELLED": return "Cancelled";
    default: return r.status;
  }
}
const STATUS_TONE: Record<string, "gray" | "blue" | "amber" | "green" | "red" | "purple"> = { PENDING_COLLECTION: "gray", COLLECTED: "blue", IN_PROCESS: "blue", PENDING_REVIEW: "purple", PASSED: "amber", ISSUED: "green", HANDED_OVER: "green", CANCELLED: "red" };
export const StageBadge = ({ r }: { r: Req }) => <Badge tone={r.needsRecollection ? "amber" : STATUS_TONE[r.status] ?? "gray"}>{stageLabel(r)}</Badge>;
/** An emergency is solid red wherever it shows (every lab desk, the details, the day boards); urgent is amber. */
export const PriorityBadge = ({ p }: { p: Req["priority"] }) => {
  const t = useT();
  if (p === "ROUTINE") return null;
  if (p === "EMERGENCY") return <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden="true" />{t("Emergency")}</span>;
  return <Badge tone="amber">Urgent</Badge>;
};

/** The row colour that says how urgent a request is, the same on every lab desk: red for an emergency, an amber edge for urgent. */
export const priorityRow = (p: Req["priority"]): string | undefined => (p === "EMERGENCY" ? "bg-red-50 hover:bg-red-100/70" : undefined);
export const priorityEdge = (p: Req["priority"]): string => (p === "EMERGENCY" ? "border-l-4 border-l-red-600 font-semibold text-red-700" : p === "URGENT" ? "border-l-4 border-l-amber-400 text-slate-400" : "border-l-4 border-l-transparent text-slate-400");

export const EVENT_LABEL: Record<string, string> = {
  CREATED: "Entered the queue", PRIORITY_CHANGED: "Priority changed", NURSE_ASSIGNED: "Nurse assigned", TECH_ASSIGNED: "Technician assigned", COLLECTED: "Sample taken / patient ready", SAMPLE_REJECTED: "Sample rejected", SENT_BACK: "Patient sent back",
  ACCEPTED: "Sample accepted", PERFORMED: "Scan performed", SUBMITTED: "Sent for review", RETURNED: "Sent back to the technician", PASSED: "Report passed", ISSUED: "Report issued", AMENDED_AFTER_ISSUE: "Report amended after issue",
  HANDED_OVER: "Handed over at reception", CANCELLED: "Cancelled", EXCEPTION_APPROVED: "Exception approved", ARRIVED: "Patient reported at reception", CHARGED: "Charged to the admission's bill", CHARGE_NOT_POSTED: "Not charged: needs a charge added by hand",
};

/** Refreshes every LIMS list after something changed. */
export function useRefreshLims(): () => void {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("lims") }); };
}

export function useRequests(query: Query, opts: { enabled?: boolean; every?: number } = {}) {
  return useQuery({ queryKey: ["lims-requests", query], queryFn: () => api.get<{ items: Req[]; total: number }>("/lims/requests", { pageSize: 50, ...query }), enabled: opts.enabled ?? true, refetchInterval: opts.every ?? 20_000 });
}

export function useStaff(enabled = true) {
  return useQuery({ queryKey: ["lims-staff"], queryFn: () => api.get<Staff>("/lims/staff"), enabled, staleTime: 60_000 });
}

/** One row per request. `actions` adds the buttons that fit the screen. */
export function RequestTable({ rows, empty, actions, onOpen, columns = ["patient", "test", "status", "due", "who"] }: {
  rows: Req[] | undefined; empty: string; actions?: (r: Req) => ReactNode; onOpen?: (r: Req) => void; columns?: ("patient" | "test" | "status" | "due" | "who" | "origin")[];
}) {
  const { dateTime } = useMe();
  if (!rows) return <Spinner />;
  const head = ["", ...columns.map((c) => ({ patient: "Patient", test: "Test", status: "Stage", due: "Due", who: "Assigned", origin: "From" })[c]), ""];
  return (
    <Table head={head} {...(rows.length === 0 ? { empty } : {})}>
      {rows.map((r, i) => {
        const cell: Record<string, ReactNode> = {
          patient: <Td key="patient"><button className="text-left" onClick={() => onOpen?.(r)}><span className={r.priority === "EMERGENCY" ? "font-semibold text-red-700" : "font-medium"}>{r.patient.name}</span> <span className="text-slate-500">· {r.patient.mrn}{r.bed ? ` · Bed ${r.bed.code} (${r.bed.ward})` : ""}</span></button></Td>,
          test: <Td key="test">{r.test} <span className="text-xs text-slate-500">({r.requestNumber})</span> <PriorityBadge p={r.priority} />{r.critical && <> <Badge tone="red">critical</Badge></>}{r.scheduledFor && r.status === "PENDING_COLLECTION" && <div className="text-xs text-slate-500">Come at {dateTime(r.scheduledFor)}</div>}</Td>,
          origin: <Td key="origin">{r.origin === "IPD" ? "Admitted" : r.origin === "EMERGENCY" ? "Emergency" : "Outpatient"}</Td>,
          status: <Td key="status"><StageBadge r={r} />{r.origin === "OPD" && r.status === "PENDING_COLLECTION" && <> <Badge tone={r.arrivedAt ? "green" : "amber"}>{r.arrivedAt ? "reported at reception" : "not here yet"}</Badge></>}{r.returnedCount > 0 && <> <Badge tone="amber">returned</Badge></>}{r.compromisedSampleApproved && <> <Badge tone="amber">by exception</Badge></>}</Td>,
          due: <Td key="due" className={r.delayed ? "font-medium text-red-700" : ""}>{dateTime(r.dueAt)}{r.delayed && " · late"}</Td>,
          who: <Td key="who" className="text-slate-600">{[r.assignedNurse && `Nurse: ${r.assignedNurse.name ?? "—"}`, r.assignedTech && `Tech: ${r.assignedTech.name ?? "—"}`].filter(Boolean).join(" · ") || "—"}</Td>,
        };
        return (
          <tr key={r.id} className={priorityRow(r.priority)} data-priority={r.priority}>
            <Td className={clsx("w-8", priorityEdge(r.priority))}>{i + 1}</Td>
            {columns.map((c) => cell[c])}
            <Td><div className="flex flex-wrap justify-end gap-1.5">{actions?.(r)}{onOpen && <Button variant="ghost" onClick={() => onOpen(r)}>Details</Button>}</div></Td>
          </tr>
        );
      })}
    </Table>
  );
}

/** The request with its whole history, and what each person may do with it. */
export function DetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { can, dateTime } = useMe();
  const refresh = useRefreshLims();
  const q = useQuery({ queryKey: ["lims-detail", id], queryFn: () => api.get<Detail>(`/lims/requests/${id}`) });
  const staff = useStaff(can("LIMS_ASSIGN"));
  const [nurse, setNurse] = useState("");
  const [tech, setTech] = useState("");
  const [reason, setReason] = useState("");
  const [exKind, setExKind] = useState("QUEUE_JUMP");
  const [exReason, setExReason] = useState("");
  const done = () => { refresh(); void q.refetch(); };
  const assign = useMutation({ mutationFn: () => api.post(`/lims/requests/${id}/assign`, { ...(nurse ? { nurseId: nurse === "none" ? null : nurse } : {}), ...(tech ? { techId: tech === "none" ? null : tech } : {}) }, newKey()), onSuccess: () => { setNurse(""); setTech(""); done(); } });
  const priority = useMutation({ mutationFn: (p: string) => api.post(`/lims/requests/${id}/priority`, { priority: p }, newKey()), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => api.post(`/lims/requests/${id}/cancel`, { reason }, newKey()), onSuccess: () => { setReason(""); done(); } });
  const raise = useMutation({ mutationFn: () => api.post("/lims/exceptions", { requestId: id, kind: exKind, reason: exReason }, newKey()), onSuccess: () => { setExReason(""); done(); } });
  const r = q.data;
  const open = r && ["PENDING_COLLECTION", "COLLECTED", "IN_PROCESS", "PENDING_REVIEW", "PASSED"].includes(r.status);
  return (
    <Modal title={r ? `${r.test}: ${r.patient.name}` : "Request"} onClose={onClose} wide>
      {q.isLoading || !r ? <Spinner /> : (
        <div className="space-y-4">
          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <KV label="Request number">{r.requestNumber}</KV><KV label="Department">{r.departmentName}</KV>
            <KV label="Patient">{r.patient.name} · {r.patient.mrn} · {r.patient.gender.toLowerCase()}</KV><KV label="Visit">{r.visitNumber} ({r.origin === "IPD" ? "admitted" : r.origin === "EMERGENCY" ? "emergency ward" : "outpatient"}){r.doctor ? ` · ${r.doctor}` : ""}</KV>
            <KV label="Stage"><StageBadge r={r} /> <PriorityBadge p={r.priority} /></KV><KV label="Due">{dateTime(r.dueAt)}{r.delayed ? " · late" : ""}</KV>
            <KV label="Nurse">{r.assignedNurse?.name ?? "—"}</KV><KV label="Technician">{r.assignedTech?.name ?? "—"}</KV>
            {r.accessionNumber && <KV label="Sample / study number">{r.accessionNumber}</KV>}
            {r.scheduledFor && <KV label="Patient asked to come at">{dateTime(r.scheduledFor)}</KV>}
            <KV label="Billing">{r.billed ? "Billed" : r.origin === "IPD" ? "Charged to the admission when the report is issued" : r.origin === "EMERGENCY" ? "Added to the emergency bill when the report is issued" : "Not billed yet"}</KV>
            {r.origin === "OPD" && <KV label="At reception">{r.arrivedAt ? dateTime(r.arrivedAt) : "Not here yet"}</KV>}
            {r.bed && <KV label="Bed">{r.bed.code} ({r.bed.ward})</KV>}
            {r.recollectCount > 0 && <KV label="Samples rejected">{r.recollectCount}</KV>}
          </div>
          {r.clinicalNote && <Notice>Reason for the test: {r.clinicalNote}</Notice>}
          {r.instructions && <p className="text-sm text-slate-600">Patient instructions: {r.instructions}</p>}
          <div>
            <h3 className="mb-1 text-sm font-semibold text-slate-800">History</h3>
            <ol className="space-y-1 border-l-2 border-slate-200 pl-3 text-sm">
              {r.timeline.map((e, i) => <li key={i}><span className="font-medium">{EVENT_LABEL[e.kind] ?? e.kind}</span> <span className="text-slate-500">· {dateTime(e.at)} · {e.by ?? "system"}</span>{e.note && <span className="text-slate-600"> — {e.note}</span>}</li>)}
            </ol>
          </div>
          {r.exceptions.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold text-slate-800">Exceptions</h3>
              <ul className="space-y-1 text-sm">{r.exceptions.map((x) => <li key={x.id}><Badge tone={x.status === "APPROVED" ? "green" : x.status === "DENIED" ? "red" : "amber"}>{x.status.toLowerCase()}</Badge> {x.kind.replace(/_/g, " ").toLowerCase()} — {x.reason}{x.decisionNote && <span className="text-slate-500"> (decision: {x.decisionNote})</span>}</li>)}</ul>
            </div>
          )}
          <ErrorNote error={assign.error ?? priority.error ?? cancel.error ?? raise.error} />
          {open && can("LIMS_ASSIGN") && (
            <div className="flex flex-wrap items-end gap-2">
              {r.status === "PENDING_COLLECTION" && <Field label="Nurse to take the sample"><Select value={nurse} onChange={(e) => setNurse(e.target.value)} className="w-52"><option value="">Keep as it is</option>{r.assignedNurse && <option value="none">Unassign</option>}{staff.data?.nurses.map((n) => <option key={n.id} value={n.id}>{n.fullName}</option>)}</Select></Field>}
              <Field label="Technician"><Select value={tech} onChange={(e) => setTech(e.target.value)} className="w-52"><option value="">Keep as it is</option>{r.assignedTech && <option value="none">Unassign</option>}{staff.data?.technicians.filter((u) => u.department === r.department).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select></Field>
              <Button variant="secondary" disabled={!nurse && !tech} loading={assign.isPending} onClick={() => assign.mutate()}>Assign</Button>
            </div>
          )}
          {open && r.status !== "PASSED" && can("LIMS_PRIORITY") && (
            <div className="flex flex-wrap items-center gap-2 text-sm">Priority:
              {(["ROUTINE", "URGENT", "EMERGENCY"] as const).map((p) => <Button key={p} variant={r.priority === p ? "primary" : "secondary"} disabled={r.priority === p || (!can("LIMS_MANAGE") && p === "ROUTINE") || (!can("LIMS_MANAGE") && r.priority === "EMERGENCY")} loading={priority.isPending && priority.variables === p} onClick={() => priority.mutate(p)}>{p === "ROUTINE" ? "Routine" : p === "URGENT" ? "Urgent" : "Emergency"}</Button>)}
            </div>
          )}
          {open && can("LIMS_COLLECT", "LIMS_REQUEST", "LIMS_ISSUE", "LIMS_MANAGE") && (
            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-800">Ask the LIMS manager for an exception</p>
              <div className="flex flex-wrap gap-2">
                <Select aria-label="Kind" className="w-56" value={exKind} onChange={(e) => setExKind(e.target.value)}><option value="QUEUE_JUMP">Go ahead of the queue</option><option value="COMPROMISED_SAMPLE">Use a sample that is not ideal</option><option value="DELAYED_REPORT">Explain a delayed report</option><option value="OTHER">Something else</option></Select>
                <Input aria-label="Why" className="min-w-60 flex-1" placeholder="Why is an exception needed? (5 or more letters)" value={exReason} onChange={(e) => setExReason(e.target.value)} />
                <Button variant="secondary" disabled={exReason.trim().length < 5} loading={raise.isPending} onClick={() => raise.mutate()}>Ask</Button>
              </div>
            </div>
          )}
          {open && ["PENDING_COLLECTION", "COLLECTED", "IN_PROCESS"].includes(r.status) && can("LIMS_MANAGE") && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Cancel this request (reason)" className="min-w-60 flex-1"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <ConfirmButton label="Cancel request" confirmLabel="Yes, cancel it" disabled={reason.trim().length < 3} loading={cancel.isPending} onConfirm={() => cancel.mutate()} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** A small box asking for a reason, used by "send back" and "reject". */
export function ReasonBox({ label, button, onSubmit, loading, error, min = 3 }: { label: string; button: string; onSubmit: (reason: string) => void; loading?: boolean; error?: unknown; min?: number }) {
  const [v, setV] = useState("");
  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <Field label={label}><Textarea rows={2} value={v} onChange={(e) => setV(e.target.value)} /></Field>
      <ErrorNote error={error} />
      <Button variant="danger" disabled={v.trim().length < min} loading={!!loading} onClick={() => onSubmit(v.trim())}>{button}</Button>
    </div>
  );
}
