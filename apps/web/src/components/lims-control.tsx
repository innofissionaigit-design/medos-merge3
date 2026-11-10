"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { LabTests } from "./lab";
import { TodayBoard } from "./lims-today";
import { useCatalogue } from "./lims-picker";
import { DetailModal, type Req, RequestTable, useRefreshLims, useRequests } from "./lims-common";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td, Tabs, Textarea, useDebounced } from "./ui";

// ───────────────────────── overview ─────────────────────────

interface DeptCounts {
  kind: string; name: string; pendingCollection: number; collected: number; inProcess: number; pendingReview: number; toIssue: number; awaitingHandover: number; issuedToday: number;
  overdue: number; emergencyOpen: number; lateToday: number; collectedToday: number; acceptedToday: number; rejectedToday: number; waitingRecollection: number; avgTatTodayMinutes: number | null;
}
export const minutesText = (m: number | null | undefined): string => (m === null || m === undefined ? "—" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "red" | "amber" }) {
  return <div className="rounded-md border border-slate-200 bg-white p-3"><div className={`text-2xl font-semibold ${tone === "red" && Number(value) > 0 ? "text-red-700" : tone === "amber" && Number(value) > 0 ? "text-amber-700" : "text-slate-900"}`}>{value}</div><div className="text-xs text-slate-500">{label}</div></div>;
}

/** Where every department's work stands right now. */
export function Overview() {
  const dash = useQuery({ queryKey: ["lims-dashboard"], queryFn: () => api.get<{ asOf: string; departments: DeptCounts[] }>("/lims/dashboard"), refetchInterval: 15_000 });
  if (dash.isLoading || !dash.data) return <Spinner />;
  return (
    <div className="space-y-4">
      {dash.data.departments.map((d) => (
        <Card key={d.kind} title={d.name}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            <Stat label="Waiting for sample" value={d.pendingCollection} /><Stat label="Received, to accept" value={d.collected} /><Stat label="In progress" value={d.inProcess} />
            <Stat label="Waiting for review" value={d.pendingReview} tone="amber" /><Stat label="Ready to issue" value={d.toIssue} tone="amber" /><Stat label="Issued today" value={d.issuedToday} />
            <Stat label="Emergencies open" value={d.emergencyOpen} tone="red" /><Stat label="Late (open)" value={d.overdue} tone="red" /><Stat label="Issued late today" value={d.lateToday} tone="amber" />
            <Stat label="Samples taken today" value={d.collectedToday} /><Stat label="Accepted today" value={d.acceptedToday} /><Stat label="Rejected today" value={d.rejectedToday} tone="amber" />
            <Stat label="Waiting for a new sample" value={d.waitingRecollection} tone="amber" /><Stat label="Reports at reception" value={d.awaitingHandover} /><Stat label="Average time today" value={minutesText(d.avgTatTodayMinutes)} />
          </div>
        </Card>
      ))}
      {dash.data.departments.length === 0 && <Notice tone="warn">You cannot see any laboratory department.</Notice>}
    </div>
  );
}

// ───────────────────────── requests ─────────────────────────

const STAGES: [string, string][] = [["", "Every stage"], ["PENDING_COLLECTION", "Waiting for sample"], ["COLLECTED", "Received"], ["IN_PROCESS", "In progress"], ["PENDING_REVIEW", "Waiting for review"], ["PASSED", "Ready to issue"], ["ISSUED,HANDED_OVER", "Issued"], ["CANCELLED", "Cancelled"]];

/** Every request, with filters. A row opens the full history. */
export function RequestsExplorer({ preset, title, columns }: { preset?: Record<string, string>; title?: string; columns?: ("patient" | "test" | "status" | "due" | "who" | "origin")[] }) {
  const [dept, setDept] = useState("");
  const [status, setStatus] = useState("");
  const [origin, setOrigin] = useState("");
  const [priority, setPriority] = useState("");
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const [open, setOpen] = useState<Req | null>(null);
  const list = useRequests({ ...(dept ? { department: dept } : {}), ...(status ? { status } : {}), ...(origin ? { origin } : {}), ...(priority ? { priority } : {}), ...(term.length >= 2 ? { q: term } : {}), ...preset }, { every: 20_000 });
  return (
    <Card title={title ?? "Requests"}>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Department" className="w-40" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">Both departments</option><option value="PATHOLOGY">Pathology</option><option value="RADIOLOGY">Radiology</option></Select>
        {!preset?.["status"] && <Select aria-label="Stage" className="w-52" value={status} onChange={(e) => setStatus(e.target.value)}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}
        <Select aria-label="From" className="w-40" value={origin} onChange={(e) => setOrigin(e.target.value)}><option value="">All patients</option><option value="IPD">Admitted</option><option value="EMERGENCY">Emergency ward</option><option value="OPD">Outpatients</option></Select>
        <Select aria-label="Priority" className="w-36" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">Any priority</option><option value="EMERGENCY">Emergency</option><option value="URGENT">Urgent</option><option value="ROUTINE">Routine</option></Select>
        <Input aria-label="Search" className="min-w-52 flex-1" placeholder="Search name, MRN, request or sample number" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <RequestTable rows={list.data?.items} empty="No requests match." columns={columns ?? ["patient", "test", "status", "due", "who", "origin"]} onOpen={setOpen} />
      {list.data && list.data.total > list.data.items.length && <p className="mt-2 text-xs text-slate-500">Showing the first {list.data.items.length} of {list.data.total}. Narrow the search to see the rest.</p>}
      {open && <DetailModal id={open.id} onClose={() => setOpen(null)} />}
    </Card>
  );
}

/** Late requests and samples that had to be taken again, with their reasons in the history. */
export function DelayedRejected() {
  return (
    <div className="space-y-4">
      <RequestsExplorer title="Late: still open past their deadline" preset={{ overdue: "true" }} columns={["patient", "test", "status", "due", "who"]} />
      <RequestsExplorer title="Samples that were rejected and taken again" preset={{ recollect: "true" }} columns={["patient", "test", "status", "who"]} />
    </div>
  );
}

/** Reports waiting for the specialist to pass, and passed reports waiting for the technician to issue. */
export function ReviewMonitor() {
  return (
    <div className="space-y-4">
      <RequestsExplorer title="Waiting for the pathologist or radiologist" preset={{ status: "PENDING_REVIEW" }} columns={["patient", "test", "status", "due", "who"]} />
      <RequestsExplorer title="Passed, waiting for the technician to issue" preset={{ status: "PASSED" }} columns={["patient", "test", "status", "due", "who"]} />
    </div>
  );
}

// ───────────────────────── quality control and instruments ─────────────────────────

interface Instrument { id: string; name: string; model: string | null; serialNumber: string | null; status: string; department: string; departmentName: string; lastCalibratedAt: string | null; nextCalibrationDue: string | null; calibrationOverdue: boolean; calibrationSoon: boolean; qc30: { runs: number; failed: number; passPercent: number | null; unreviewedFailures: number; lastRunAt: string | null } }
interface Qc { id: string; department: string; instrument: string | null; subject: string; level: string | null; unit: string | null; expected: string | null; observed: string | null; lowLimit: string | null; highLimit: string | null; result: string; note: string | null; recordedAt: string; recordedBy: string | null; reviewedAt: string | null; reviewedBy: string | null; reviewNote: string | null; actionRequired: boolean }

function QcForm({ onClose }: { onClose: () => void }) {
  const { can } = useMe();
  const refresh = useRefreshLims();
  const ins = useQuery({ queryKey: ["lims-instruments"], queryFn: () => api.get<Instrument[]>("/lims/instruments") });
  const [department, setDepartment] = useState(can("LAB_RESULT") ? "PATHOLOGY" : can("RAD_PERFORM") ? "RADIOLOGY" : "PATHOLOGY");
  const [instrumentId, setInstrumentId] = useState("");
  const [subject, setSubject] = useState("");
  const [level, setLevel] = useState("");
  const [numeric, setNumeric] = useState(true);
  const [f, setF] = useState({ expected: "", observed: "", lowLimit: "", highLimit: "", unit: "" });
  const [result, setResult] = useState("PASS");
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () => api.post("/lims/qc", {
      department, subject: subject.trim(), ...(instrumentId ? { instrumentId } : {}), ...(level.trim() ? { level: level.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      ...(numeric ? { ...(f.unit.trim() ? { unit: f.unit.trim() } : {}), ...(f.expected.trim() !== "" ? { expected: Number(f.expected) } : {}), observed: Number(f.observed), lowLimit: Number(f.lowLimit), highLimit: Number(f.highLimit) } : { result }),
    }, newKey()),
    onSuccess: () => { refresh(); onClose(); },
  });
  const valid = subject.trim().length >= 2 && (!numeric || (f.observed !== "" && f.lowLimit !== "" && f.highLimit !== ""));
  return (
    <Modal title="Record a quality-control run" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Department"><Select value={department} onChange={(e) => { setDepartment(e.target.value); setInstrumentId(""); }}>{(can("LAB_RESULT", "LIMS_MANAGE")) && <option value="PATHOLOGY">Pathology</option>}{(can("RAD_PERFORM", "LIMS_MANAGE")) && <option value="RADIOLOGY">Radiology</option>}</Select></Field>
          <Field label="Instrument"><Select value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)}><option value="">Not tied to one instrument</option>{ins.data?.filter((i) => i.department === department).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></Field>
          <Field label="Level (optional)"><Input value={level} onChange={(e) => setLevel(e.target.value)} placeholder="Level 1" /></Field>
        </div>
        <Field label="What was checked"><Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="For example Haemoglobin control, or Daily image-quality check" /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={numeric} onChange={(e) => setNumeric(e.target.checked)} /> Measured value with limits (the result is worked out)</label>
        {numeric ? (
          <div className="grid gap-2 sm:grid-cols-5">
            <Field label="Unit"><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
            <Field label="Expected"><Input inputMode="decimal" value={f.expected} onChange={(e) => setF({ ...f, expected: e.target.value })} /></Field>
            <Field label="Measured"><Input inputMode="decimal" value={f.observed} onChange={(e) => setF({ ...f, observed: e.target.value })} /></Field>
            <Field label="Lowest allowed"><Input inputMode="decimal" value={f.lowLimit} onChange={(e) => setF({ ...f, lowLimit: e.target.value })} /></Field>
            <Field label="Highest allowed"><Input inputMode="decimal" value={f.highLimit} onChange={(e) => setF({ ...f, highLimit: e.target.value })} /></Field>
          </div>
        ) : <Field label="Result"><Select value={result} onChange={(e) => setResult(e.target.value)}><option value="PASS">Passed</option><option value="FAIL">Failed</option></Select></Field>}
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorNote error={save.error} />
        <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>Save run</Button>
      </div>
    </Modal>
  );
}

function InstrumentForm({ onClose }: { onClose: () => void }) {
  const refresh = useRefreshLims();
  const [department, setDepartment] = useState("PATHOLOGY");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [serial, setSerial] = useState("");
  const [last, setLast] = useState("");
  const [next, setNext] = useState("");
  const save = useMutation({
    mutationFn: () => api.post("/lims/instruments", { department, name: name.trim(), ...(model.trim() ? { model: model.trim() } : {}), ...(serial.trim() ? { serialNumber: serial.trim() } : {}), ...(last ? { lastCalibratedAt: last } : {}), ...(next ? { nextCalibrationDue: next } : {}) }, newKey()),
    onSuccess: () => { refresh(); onClose(); },
  });
  return (
    <Modal title="Add an instrument" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Department"><Select value={department} onChange={(e) => setDepartment(e.target.value)}><option value="PATHOLOGY">Pathology</option><option value="RADIOLOGY">Radiology</option></Select></Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example Haematology analyser" /></Field>
          <Field label="Model (optional)"><Input value={model} onChange={(e) => setModel(e.target.value)} /></Field>
          <Field label="Serial number (optional)"><Input value={serial} onChange={(e) => setSerial(e.target.value)} /></Field>
          <Field label="Last calibrated"><Input type="date" value={last} onChange={(e) => setLast(e.target.value)} /></Field>
          <Field label="Next calibration due"><Input type="date" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        </div>
        <ErrorNote error={save.error} />
        <Button disabled={name.trim().length < 2} loading={save.isPending} onClick={() => save.mutate()}>Add instrument</Button>
      </div>
    </Modal>
  );
}

/** Quality-control runs and the instruments they belong to. Technicians record runs; the LIMS manager reviews them and keeps the instruments. */
export function QcPanel() {
  const { can, date, dateTime } = useMe();
  const refresh = useRefreshLims();
  const [recording, setRecording] = useState(false);
  const [adding, setAdding] = useState(false);
  const [unreviewed, setUnreviewed] = useState(false);
  const [review, setReview] = useState<Qc | null>(null);
  const [note, setNote] = useState("");
  const [action, setAction] = useState(false);
  const ins = useQuery({ queryKey: ["lims-instruments"], queryFn: () => api.get<Instrument[]>("/lims/instruments"), refetchInterval: 60_000 });
  const qc = useQuery({ queryKey: ["lims-qc", unreviewed], queryFn: () => api.get<Qc[]>("/lims/qc", unreviewed ? { unreviewed: "true" } : {}), refetchInterval: 30_000 });
  const setStatus = useMutation({ mutationFn: (v: { id: string; status: string }) => api.put(`/lims/instruments/${v.id}`, { status: v.status }), onSuccess: refresh });
  const doReview = useMutation({ mutationFn: () => api.post(`/lims/qc/${review!.id}/review`, { actionRequired: action, note: note.trim() }, newKey()), onSuccess: () => { setReview(null); setNote(""); setAction(false); refresh(); } });
  return (
    <div className="space-y-4">
      <Card title="Instruments" actions={<>{can("LIMS_QC") && <Button variant="secondary" onClick={() => setRecording(true)}>Record a quality-control run</Button>}{can("LIMS_MANAGE") && <Button onClick={() => setAdding(true)}>Add instrument</Button>}</>}>
        <ErrorNote error={setStatus.error} />
        {ins.isLoading ? <Spinner /> : (
          <Table head={["Instrument", "Department", "Status", "Last 30 days", "Calibration", ""]} {...(ins.data?.length === 0 ? { empty: "No instruments have been added yet." } : {})}>
            {ins.data?.map((i) => (
              <tr key={i.id}>
                <Td><span className="font-medium">{i.name}</span>{i.model && <span className="text-slate-500"> · {i.model}</span>}</Td><Td>{i.departmentName}</Td>
                <Td><Badge tone={i.status === "ACTIVE" ? "green" : i.status === "MAINTENANCE" ? "amber" : "red"}>{i.status.replace("_", " ").toLowerCase()}</Badge></Td>
                <Td>{i.qc30.runs === 0 ? "No runs" : `${i.qc30.passPercent}% passed (${i.qc30.runs} runs)`}{i.qc30.unreviewedFailures > 0 && <> <Badge tone="red">{i.qc30.unreviewedFailures} failure to review</Badge></>}</Td>
                <Td>{i.nextCalibrationDue ? date(i.nextCalibrationDue) : "—"}{i.calibrationOverdue && <> <Badge tone="red">overdue</Badge></>}{i.calibrationSoon && <> <Badge tone="amber">due soon</Badge></>}</Td>
                <Td>{can("LIMS_MANAGE") && (i.status === "ACTIVE" ? <Button variant="secondary" loading={setStatus.isPending} onClick={() => setStatus.mutate({ id: i.id, status: "MAINTENANCE" })}>Take out of use</Button> : <Button variant="secondary" loading={setStatus.isPending} onClick={() => setStatus.mutate({ id: i.id, status: "ACTIVE" })}>Back in use</Button>)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Quality-control runs" actions={<label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={unreviewed} onChange={(e) => setUnreviewed(e.target.checked)} /> Failures not yet reviewed</label>}>
        {qc.isLoading ? <Spinner /> : (
          <Table head={["When", "Checked", "Instrument", "Measured", "Result", "Review", ""]} {...(qc.data?.length === 0 ? { empty: "No runs recorded." } : {})}>
            {qc.data?.map((r) => (
              <tr key={r.id}>
                <Td>{dateTime(r.recordedAt)}<div className="text-xs text-slate-500">{r.recordedBy}</div></Td><Td>{r.subject}{r.level ? ` · ${r.level}` : ""}</Td><Td>{r.instrument ?? "—"}</Td>
                <Td>{r.observed !== null ? `${r.observed} ${r.unit ?? ""} (${r.lowLimit}–${r.highLimit})` : "—"}</Td>
                <Td><Badge tone={r.result === "PASS" ? "green" : "red"}>{r.result === "PASS" ? "passed" : "failed"}</Badge></Td>
                <Td>{r.reviewedAt ? <span className="text-sm">{r.reviewedBy}: {r.reviewNote}{r.actionRequired && <> <Badge tone="amber">action</Badge></>}</span> : <span className="text-slate-400">—</span>}</Td>
                <Td>{!r.reviewedAt && can("LIMS_MANAGE") && <Button variant="secondary" onClick={() => setReview(r)}>Review</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {recording && <QcForm onClose={() => setRecording(false)} />}
      {adding && <InstrumentForm onClose={() => setAdding(false)} />}
      {review && (
        <Modal title={`Review: ${review.subject}`} onClose={() => setReview(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Recorded by {review.recordedBy}: {review.result === "PASS" ? "passed" : "failed"}.</p>
            {review.result === "FAIL" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={action} onChange={(e) => setAction(e.target.checked)} /> This failure needs action. Take the instrument out of use until it is fixed.</label>}
            <Field label="Your note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <ErrorNote error={doReview.error} />
            <Button disabled={note.trim().length < 3} loading={doReview.isPending} onClick={() => doReview.mutate()}>Save review</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ───────────────────────── exceptions ─────────────────────────

interface Exc { id: string; kind: string; reason: string; status: string; raisedAt: string; raisedBy: string | null; decidedBy: string | null; decisionNote: string | null; request: { id: string; requestNumber: string; test: string; status: string; priority: string; department: string } }
const EXC_LABEL: Record<string, string> = { QUEUE_JUMP: "Go ahead of the queue", COMPROMISED_SAMPLE: "Use a sample that is not ideal", DELAYED_REPORT: "Explain a delayed report", OTHER: "Something else" };

/** One-off departures from the usual rules, decided by the LIMS manager under the hospital's policy. */
export function Exceptions() {
  const { can, dateTime } = useMe();
  const refresh = useRefreshLims();
  const [status, setStatus] = useState("PENDING");
  const [deciding, setDeciding] = useState<Exc | null>(null);
  const [note, setNote] = useState("");
  const list = useQuery({ queryKey: ["lims-exceptions", status], queryFn: () => api.get<Exc[]>("/lims/exceptions", status ? { status } : {}), refetchInterval: 20_000 });
  const decide = useMutation({ mutationFn: (decision: string) => api.post(`/lims/exceptions/${deciding!.id}/decide`, { decision, note: note.trim() }, newKey()), onSuccess: () => { setDeciding(null); setNote(""); refresh(); void list.refetch(); } });
  return (
    <Card title="Exceptions" actions={<Select aria-label="Show" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="PENDING">Waiting</option><option value="APPROVED">Approved</option><option value="DENIED">Denied</option><option value="">All</option></Select>}>
      {list.isLoading ? <Spinner /> : (
        <Table head={["Request", "Kind", "Reason", "Raised", "Decision", ""]} {...(list.data?.length === 0 ? { empty: "No exceptions." } : {})}>
          {list.data?.map((x) => (
            <tr key={x.id}>
              <Td>{x.request.test} <span className="text-xs text-slate-500">({x.request.requestNumber})</span></Td><Td>{EXC_LABEL[x.kind] ?? x.kind}</Td><Td>{x.reason}</Td><Td>{x.raisedBy}<div className="text-xs text-slate-500">{dateTime(x.raisedAt)}</div></Td>
              <Td><Badge tone={x.status === "APPROVED" ? "green" : x.status === "DENIED" ? "red" : "amber"}>{x.status.toLowerCase()}</Badge>{x.decisionNote && <span className="text-sm text-slate-600"> {x.decidedBy}: {x.decisionNote}</span>}</Td>
              <Td>{x.status === "PENDING" && can("LIMS_MANAGE") && <Button variant="secondary" onClick={() => setDeciding(x)}>Decide</Button>}</Td>
            </tr>
          ))}
        </Table>
      )}
      {deciding && (
        <Modal title="Decide the exception" onClose={() => setDeciding(null)}>
          <div className="space-y-3">
            <p className="text-sm"><span className="font-medium">{EXC_LABEL[deciding.kind]}</span> for {deciding.request.test} ({deciding.request.requestNumber}): {deciding.reason}</p>
            {deciding.kind === "QUEUE_JUMP" && <Notice>Approving makes the request urgent.</Notice>}
            {deciding.kind === "COMPROMISED_SAMPLE" && <Notice tone="warn">Approving records that the sample was accepted by exception; the technician and the specialist will see it.</Notice>}
            <Field label="Your decision and the policy it follows"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <ErrorNote error={decide.error} />
            <div className="flex gap-2"><Button disabled={note.trim().length < 3} loading={decide.isPending && decide.variables === "APPROVED"} onClick={() => decide.mutate("APPROVED")}>Approve</Button><Button variant="secondary" disabled={note.trim().length < 3} loading={decide.isPending && decide.variables === "DENIED"} onClick={() => decide.mutate("DENIED")}>Deny</Button></div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

// ───────────────────────── reports ─────────────────────────

interface Perf {
  from: string; to: string; totals: { ordered: number; issued: number; open: number; pendingReview: number; cancelled: number };
  departments: { kind: string; name: string; ordered: number; performed: number; reported: number; issued: number; open: number; cancelled: number; overdueOpen: number; lateIssued: number; tat: { averageMinutes: number | null; medianMinutes: number | null; p90Minutes: number | null; withinTargetPercent: number | null }; stages: Record<string, number | null>; samples: { collected: number; rejected: number; rejectionPercent: number | null }; returnedForCorrection: number; priority: { emergency: number; urgent: number; routine: number }; origin: { opd: number; ipd: number; emergency?: number } }[];
  days: { date: string; ordered: number; issued: number }[]; technicians: { id: string; name: string; accepted: number; issued: number }[];
}
interface AdmittedCharge { requestNumber: string; test: string; department: string; patient: string; admissionNumber: string | null; status: string; amount: string }
interface BillingSummary { from: string; to: string; admittedCharges: AdmittedCharge[]; totals: { tests: number; billed: number; notBilled: number; issuedNotBilled: number; billedAmount: string }; departments: { kind: string; name: string; tests: number; billed: number; notBilled: number; billedAmount: string; reportsIssued: number; issuedNotBilled: number; chargedToAdmissions: number }[] }

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function Period({ from, to, set }: { from: string; to: string; set: (f: string, t: string) => void }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-2">
      <Field label="From"><Input type="date" value={from} onChange={(e) => set(e.target.value, to)} /></Field>
      <Field label="To"><Input type="date" value={to} onChange={(e) => set(from, e.target.value)} /></Field>
      <Button variant="secondary" onClick={() => set(daysAgo(6), today())}>Last 7 days</Button><Button variant="secondary" onClick={() => set(daysAgo(29), today())}>Last 30 days</Button><Button variant="secondary" onClick={() => set(today(), today())}>Today</Button>
    </div>
  );
}

/** Tests performed, workload, turnaround, rejection and per-technician figures for a period. */
export function Performance() {
  const [range, setRange] = useState({ from: daysAgo(29), to: today() });
  const q = useQuery({ queryKey: ["lims-performance", range], queryFn: () => api.get<Perf>("/lims/reports/performance", range), enabled: range.from <= range.to });
  return (
    <div className="space-y-4">
      <Period from={range.from} to={range.to} set={(from, to) => setRange({ from, to })} />
      <ErrorNote error={q.error} />
      {q.isLoading || !q.data ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5"><Stat label="Tests ordered" value={q.data.totals.ordered} /><Stat label="Reports issued" value={q.data.totals.issued} /><Stat label="Still open" value={q.data.totals.open} /><Stat label="Waiting for review" value={q.data.totals.pendingReview} tone="amber" /><Stat label="Cancelled" value={q.data.totals.cancelled} /></div>
          <Card title="By department">
            <Table head={["Department", "Ordered", "Performed", "Issued", "Open", "Late open", "Issued late", "Average time", "Middle", "Slowest 1 in 10", "On time", "Samples rejected", "Sent back"]}>
              {q.data.departments.map((d) => (
                <tr key={d.kind}><Td className="font-medium">{d.name}</Td><Td>{d.ordered}</Td><Td>{d.performed}</Td><Td>{d.issued}</Td><Td>{d.open}</Td><Td>{d.overdueOpen}</Td><Td>{d.lateIssued}</Td>
                  <Td>{minutesText(d.tat.averageMinutes)}</Td><Td>{minutesText(d.tat.medianMinutes)}</Td><Td>{minutesText(d.tat.p90Minutes)}</Td><Td>{d.tat.withinTargetPercent === null ? "—" : `${d.tat.withinTargetPercent}%`}</Td>
                  <Td>{d.samples.rejected}{d.samples.rejectionPercent !== null ? ` (${d.samples.rejectionPercent}%)` : ""}</Td><Td>{d.returnedForCorrection}</Td></tr>
              ))}
            </Table>
          </Card>
          <Card title="Where the time goes (average)">
            <Table head={["Department", "Queue to sample", "Sample to accepted", "Accepted to sent for review", "Review", "Passed to issued"]}>
              {q.data.departments.map((d) => <tr key={d.kind}><Td className="font-medium">{d.name}</Td><Td>{minutesText(d.stages["queueToCollectedMinutes"])}</Td><Td>{minutesText(d.stages["collectedToAcceptedMinutes"])}</Td><Td>{minutesText(d.stages["acceptedToSubmittedMinutes"])}</Td><Td>{minutesText(d.stages["submittedToPassedMinutes"])}</Td><Td>{minutesText(d.stages["passedToIssuedMinutes"])}</Td></tr>)}
            </Table>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Per day"><Table head={["Date", "Ordered", "Issued"]} {...(q.data.days.length === 0 ? { empty: "Nothing in this period." } : {})}>{q.data.days.map((d) => <tr key={d.date}><Td>{d.date}</Td><Td>{d.ordered}</Td><Td>{d.issued}</Td></tr>)}</Table></Card>
            <Card title="Per technician"><Table head={["Technician", "Accepted", "Issued"]} {...(q.data.technicians.length === 0 ? { empty: "No technician work in this period." } : {})}>{q.data.technicians.map((t) => <tr key={t.id}><Td>{t.name}</Td><Td>{t.accepted}</Td><Td>{t.issued}</Td></tr>)}</Table></Card>
          </div>
        </>
      )}
    </div>
  );
}

/** What has been billed for the laboratory and what has been done but not billed. Billing itself is done at the cashier. */
export function BillingMonitor() {
  const { money } = useMe();
  const [range, setRange] = useState({ from: daysAgo(29), to: today() });
  const q = useQuery({ queryKey: ["lims-billing", range], queryFn: () => api.get<BillingSummary>("/lims/reports/billing", range), enabled: range.from <= range.to });
  return (
    <div className="space-y-4">
      <Period from={range.from} to={range.to} set={(from, to) => setRange({ from, to })} />
      <ErrorNote error={q.error} />
      {q.isLoading || !q.data ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5"><Stat label="Tests" value={q.data.totals.tests} /><Stat label="Billed" value={q.data.totals.billed} /><Stat label="Not billed yet" value={q.data.totals.notBilled} tone="amber" /><Stat label="Reports issued but not billed" value={q.data.totals.issuedNotBilled} tone="red" /><Stat label="Billed amount" value={money(q.data.totals.billedAmount)} /></div>
          <Card title="By department"><Table head={["Department", "Tests", "Billed", "Not billed", "Billed amount", "Reports issued", "Issued, not billed"]}>{q.data.departments.map((d) => <tr key={d.kind}><Td className="font-medium">{d.name}</Td><Td>{d.tests}</Td><Td>{d.billed}</Td><Td>{d.notBilled}</Td><Td>{money(d.billedAmount)}</Td><Td>{d.reportsIssued}</Td><Td>{d.issuedNotBilled}</Td></tr>)}</Table></Card>
          <Card title="Charged to admitted patients' bills (added when the report is issued)">
            <Table head={["Request", "Patient", "Admission", "Test", "Charge", "Status"]} {...(q.data.admittedCharges.length === 0 ? { empty: "No laboratory charge has been added to an admitted patient's bill in this period." } : {})}>
              {q.data.admittedCharges.map((c) => <tr key={c.requestNumber}><Td>{c.requestNumber}</Td><Td>{c.patient}</Td><Td>{c.admissionNumber ?? "—"}</Td><Td>{c.test}</Td><Td>{money(c.amount)}</Td><Td><Badge tone={c.status === "BILLED" ? "green" : "amber"}>{c.status === "BILLED" ? "on the final bill" : "waiting for the final bill"}</Badge></Td></tr>)}
            </Table>
          </Card>
          <Notice>An outpatient's tests are billed when the patient reports at reception (the advance is used first). An admitted patient's test is added to the admission's bill when its report is issued. Work in the laboratory never waits for billing.</Notice>
        </>
      )}
    </div>
  );
}

// ───────────────────────── lab load ─────────────────────────

interface Pressure {
  today: string;
  departments: { kind: string; name: string; capacityPerHour: number; openMinute: number; closeMinute: number; waitingNow: number; open: { waitingForSample: number; inLab: number; withSpecialist: number; toIssue: number }; days: { date: string; capacity: number; booked: number; backlog: number; percent: number }[]; nextFreeAt: string | null }[];
}
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** How full each lab is, day by day. The date an outpatient is given comes from this: the next hour in which the lab has room. */
export function LabLoad() {
  const { dateTime, can } = useMe();
  const q = useQuery({ queryKey: ["lims-pressure"], queryFn: () => api.get<Pressure>("/lims/reports/pressure", { days: 7 }), refetchInterval: 30_000 });
  if (q.isLoading || !q.data) return <Spinner />;
  return (
    <div className="space-y-4">
      <Notice>Outpatients are given the first hour in which every lab they need has room, so the more work is waiting or booked, the later the date. {can("LIMS_DEPARTMENTS") ? "Change what a lab can take in an hour under Departments." : "The administrator sets what a lab can take in an hour."}</Notice>
      {q.data.departments.map((d) => (
        <Card key={d.kind} title={`${d.name}: ${d.capacityPerHour} an hour, ${hhmm(d.openMinute)} to ${hhmm(d.closeMinute)}`}>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Waiting for sample now" value={d.open.waitingForSample} tone="amber" /><Stat label="In the lab" value={d.open.inLab} /><Stat label="With the specialist" value={d.open.withSpecialist} /><Stat label="Ready to issue" value={d.open.toIssue} />
            <Stat label="Next outpatient place" value={d.nextFreeAt ? dateTime(d.nextFreeAt) : "None in 14 days"} />
          </div>
          <Table head={["Day", "Booked", "Waiting now", "Room for", "Full"]}>
            {d.days.map((x) => (
              <tr key={x.date}>
                <Td className="font-medium">{x.date}{x.date === q.data.today ? " (today)" : ""}</Td><Td>{x.booked}</Td><Td>{x.date === q.data.today ? x.backlog : "—"}</Td><Td>{x.capacity}</Td>
                <Td><div className="flex items-center gap-2"><div className="h-2 w-28 overflow-hidden rounded bg-slate-100" aria-hidden><div className={`h-2 ${x.percent >= 90 ? "bg-red-500" : x.percent >= 60 ? "bg-amber-500" : "bg-green-500"}`} style={{ width: `${x.percent}%` }} /></div><span className={x.percent >= 90 ? "font-medium text-red-700" : ""}>{x.percent}%</span></div></Td>
              </tr>
            ))}
          </Table>
        </Card>
      ))}
    </div>
  );
}

// ───────────────────────── departments ─────────────────────────

interface Dept { id: string; kind: string; name: string; status: string; routineTatMinutes: number; urgentTatMinutes: number; emergencyTatMinutes: number; defaultInstructions: string | null; capacityPerHour: number; openMinute: number; closeMinute: number; openRequests: number | null }

function DeptEditor({ d, onClose }: { d: Dept; onClose: () => void }) {
  const refresh = useRefreshLims();
  const [name, setName] = useState(d.name);
  const [active, setActive] = useState(d.status === "ACTIVE");
  const [routine, setRoutine] = useState(String(d.routineTatMinutes / 60));
  const [urgent, setUrgent] = useState(String(d.urgentTatMinutes / 60));
  const [emergency, setEmergency] = useState(String(d.emergencyTatMinutes / 60));
  const [text, setText] = useState(d.defaultInstructions ?? "");
  const [capacity, setCapacity] = useState(String(d.capacityPerHour));
  const [opens, setOpens] = useState(hhmm(d.openMinute));
  const [closes, setCloses] = useState(d.closeMinute >= 1440 ? "23:59" : hhmm(d.closeMinute));
  const mins = (h: string) => Math.round(Number(h) * 60);
  const clock = (v: string) => { const [h, m] = v.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const save = useMutation({
    mutationFn: () => api.put(`/lims/departments/${d.kind.toLowerCase()}`, { name: name.trim(), status: active ? "ACTIVE" : "INACTIVE", routineTatMinutes: mins(routine), urgentTatMinutes: mins(urgent), emergencyTatMinutes: mins(emergency), defaultInstructions: text.trim() || null, capacityPerHour: Number(capacity), openMinute: clock(opens), closeMinute: closes === "23:59" ? 1440 : clock(closes) }),
    onSuccess: () => { refresh(); onClose(); },
  });
  return (
    <Modal title={`Edit ${d.name}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Routine report within (hours)"><Input inputMode="decimal" value={routine} onChange={(e) => setRoutine(e.target.value)} /></Field>
          <Field label="Urgent within (hours)"><Input inputMode="decimal" value={urgent} onChange={(e) => setUrgent(e.target.value)} /></Field>
          <Field label="Emergency within (hours)"><Input inputMode="decimal" value={emergency} onChange={(e) => setEmergency(e.target.value)} /></Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Outpatient tests it can take in an hour"><Input inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value.replace(/[^0-9]/g, ""))} /></Field>
          <Field label="Opens"><Input type="time" value={opens} onChange={(e) => setOpens(e.target.value)} /></Field>
          <Field label="Closes"><Input type="time" value={closes} onChange={(e) => setCloses(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-slate-500">The date an outpatient is given comes from these figures and the work already waiting: when the lab is busy the date moves later.</p>
        <Field label="What patients are told to do before coming (when a test has no instructions of its own)"><Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> This department takes new requests</label>
        <ErrorNote error={save.error} />
        <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
    </Modal>
  );
}

/** The laboratory departments: Pathology and Radiology. The administrator sets their names, targets and default patient instructions. */
export function Departments() {
  const { can } = useMe();
  const [edit, setEdit] = useState<Dept | null>(null);
  const list = useQuery({ queryKey: ["lims-departments"], queryFn: () => api.get<Dept[]>("/lims/departments") });
  return (
    <Card title="Laboratory departments">
      {list.isLoading ? <Spinner /> : (
        <Table head={["Department", "Status", "Routine", "Urgent", "Emergency", "Takes an hour", "Open now", ""]}>
          {list.data?.map((d) => (
            <tr key={d.id}><Td className="font-medium">{d.name}</Td><Td><Badge tone={d.status === "ACTIVE" ? "green" : "gray"}>{d.status.toLowerCase()}</Badge></Td><Td>{minutesText(d.routineTatMinutes)}</Td><Td>{minutesText(d.urgentTatMinutes)}</Td><Td>{minutesText(d.emergencyTatMinutes)}</Td><Td>{d.capacityPerHour} tests</Td><Td>{d.openRequests ?? "—"}</Td>
              <Td>{can("LIMS_DEPARTMENTS") && <Button variant="secondary" onClick={() => setEdit(d)}>Edit</Button>}</Td></tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-xs text-slate-500">Tests and their normal ranges are set up by the pathologist (Laboratory, Tests and ranges). Staff and their permissions are kept under Administration, Users.</p>
      {edit && <DeptEditor d={edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

// ───────────────────────── which department runs each test ─────────────────────────

/** The test list grouped between Pathology and Radiology. The administrator or the pathologist moves a test; it decides which technician a test ordered from the list reaches. */
export function TestGrouping() {
  const { can } = useMe();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const cat = useCatalogue();
  const set = useMutation({ mutationFn: (v: { id: string; department: string }) => api.put(`/lims/catalogue/${v.id}`, { department: v.department }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["lims-catalogue"] }); } });
  const editable = can("LIMS_DEPARTMENTS", "LAB_MASTERS");
  const term = q.trim().toLowerCase();
  const rows = (cat.data ?? []).filter((i) => !term || i.name.toLowerCase().includes(term) || i.code.toLowerCase().includes(term));
  return (
    <Card title="Which department runs each test" actions={<Input aria-label="Search tests" className="w-48" placeholder="Search tests" value={q} onChange={(e) => setQ(e.target.value)} />}>
      <ErrorNote error={set.error} />
      {cat.isLoading ? <Spinner /> : (
        <Table head={["Test", "Code", "Department"]} {...(rows.length === 0 ? { empty: "No tests. Add investigations to the price list first." } : {})}>
          {rows.map((i) => (
            <tr key={i.serviceId}><Td>{i.name}</Td><Td className="text-slate-500">{i.code}</Td>
              <Td>{editable ? <Select aria-label={`Department of ${i.name}`} className="w-48" value={i.department} onChange={(e) => set.mutate({ id: i.serviceId, department: e.target.value })}><option value="PATHOLOGY">Pathology (laboratory)</option><option value="RADIOLOGY">Radiology (imaging)</option></Select> : i.department === "PATHOLOGY" ? "Pathology" : "Radiology"}</Td></tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-xs text-slate-500">A test chosen from this list goes to the technician of its department. New investigations are grouped by their name (imaging words such as X-ray, ultrasound, CT and MRI go to Radiology); change any that are wrong. Requests already in the queue are not moved.</p>
    </Card>
  );
}

// ───────────────────────── the control room ─────────────────────────

type Tab = "overview" | "load" | "today" | "requests" | "late" | "review" | "qc" | "exceptions" | "performance" | "billing" | "departments";

/** The LIMS manager's control room; the administrator and the manager see the same monitoring without the controls they do not hold. */
export function ControlRoom() {
  const { can } = useMe();
  const [tab, setTab] = useState<Tab>("overview");
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" }, ...(can("LIMS_REPORTS") ? [{ id: "load" as const, label: "Lab load" }] : []), { id: "today", label: "Today's patients" }, { id: "requests", label: "All requests" }, { id: "late", label: "Late and rejected" }, { id: "review", label: "Reports pending" },
    { id: "qc", label: "Quality control" }, { id: "exceptions", label: "Exceptions" }, ...(can("LIMS_REPORTS") ? [{ id: "performance" as const, label: "Performance" }] : []),
    ...(can("LIMS_REPORTS") && can("INVOICE_READ", "LIMS_MANAGE") ? [{ id: "billing" as const, label: "Billing" }] : []), { id: "departments", label: "Departments" },
  ];
  return (
    <>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "overview" && <Overview />}
      {tab === "load" && <LabLoad />}
      {tab === "today" && <TodayBoard mode="manager" />}
      {tab === "requests" && <RequestsExplorer />}
      {tab === "late" && <DelayedRejected />}
      {tab === "review" && <ReviewMonitor />}
      {tab === "qc" && <QcPanel />}
      {tab === "exceptions" && <Exceptions />}
      {tab === "performance" && <Performance />}
      {tab === "billing" && <BillingMonitor />}
      {tab === "departments" && <div className="space-y-4"><Departments />{can("LIMS_DEPARTMENTS", "LAB_MASTERS") && <TestGrouping />}{can("LAB_MASTERS") && <LabTests />}</div>}
    </>
  );
}
