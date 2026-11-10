"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { LabCritical, LabTests } from "./lab";
import { RadCritical } from "./radiology";
import { RadImagesCard } from "./rad-images";
import { type Detail, DetailModal, ReasonBox, type Req, RequestTable, StageBadge, useRefreshLims, useRequests, useStaff } from "./lims-common";
import { TestPicker, useCatalogue } from "./lims-picker";
import { TodayBoard } from "./lims-today";
import { AdvanceCard } from "./advance-extras";
import { QcPanel, TestGrouping } from "./lims-control";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td, Tabs, Textarea, useDebounced } from "./ui";

interface Param { id: string; name: string; unit: string | null; type: string; choices?: string[]; rangeText: string }
interface Value { parameterId: string; name: string; unit: string | null; value: string; flag: string; rangeText: string }
interface LabView {
  patient: { name: string; gender: string; mrn: string | null }; sample: { id: string; accessionNumber: string; specimen: string; status: string; rejectReason: string | null } | null;
  resultId: string | null; status: string | null; version: number | null; currentVersion: number; hasCritical: boolean; parameters: Param[]; draft: { values: { parameterId: string; value: string }[]; comment: string };
  reports: { version: number; kind: string; values: Value[]; reason: string | null; comment: string | null; verifiedBy: string | null }[];
}
interface RadView {
  state: string; study: { id: string; accessionNumber: string; modality: string; bodyPart: string; clinicalNotes: string | null; currentVersion: number; hasCritical: boolean } | null;
  reports: { version: number; kind: string; findings: string; impression: string; hasCritical: boolean; reason: string | null; signedBy: string | null }[];
}
const FLAG_TONE: Record<string, "green" | "amber" | "red"> = { NORMAL: "green", LOW: "amber", HIGH: "amber", CRITICAL_LOW: "red", CRITICAL_HIGH: "red" };
const MODALITIES: [string, string][] = [["XRAY", "X-ray"], ["ULTRASOUND", "Ultrasound"], ["CT", "CT scan"], ["MRI", "MRI"], ["MAMMOGRAPHY", "Mammography"], ["OTHER", "Other"]];

const lastReturn = (d: Detail | undefined): string | null => (d ? [...d.timeline].reverse().find((e) => e.kind === "RETURNED")?.note ?? null : null);
const toValues = (m: Record<string, string>) => Object.entries(m).filter(([, v]) => v.trim() !== "").map(([parameterId, value]) => ({ parameterId, value }));

// ───────────────────────── technician ─────────────────────────

/** The technician's work on one request: accept or reject the sample (or perform the scan), prepare the report, send it for review, and issue it once passed. */
function TechModal({ req, onClose }: { req: Req; onClose: () => void }) {
  const { can } = useMe();
  const refresh = useRefreshLims();
  const rad = req.department === "RADIOLOGY";
  const d = useQuery({ queryKey: ["lims-detail", req.id], queryFn: () => api.get<Detail>(`/lims/requests/${req.id}`) });
  const status = d.data?.status ?? req.status;
  const lab = useQuery({ queryKey: ["lims-lab", req.testOrderId], queryFn: () => api.get<LabView>(`/lab/orders/${req.testOrderId}/result`), enabled: !rad && status !== "PENDING_COLLECTION" });
  const study = useQuery({ queryKey: ["lims-rad", req.testOrderId], queryFn: () => api.get<RadView>(`/rad/orders/${req.testOrderId}/study`), enabled: rad && status !== "PENDING_COLLECTION" });
  const [vals, setVals] = useState<Record<string, string> | null>(null);
  const [comment, setComment] = useState<string | null>(null);
  const [modality, setModality] = useState("XRAY");
  const [bodyPart, setBodyPart] = useState("");
  const [notes, setNotes] = useState("");
  const done = (close = false) => { refresh(); void d.refetch(); if (rad) void study.refetch(); else void lab.refetch(); setVals(null); setComment(null); if (close) onClose(); };
  const v = lab.data;
  const current = vals ?? Object.fromEntries((v?.draft.values ?? []).map((x) => [x.parameterId, x.value]));
  const save = useMutation({ mutationFn: () => api.put<{ version: number }>(`/lab/results/${v!.resultId}/draft`, { version: v!.version, values: toValues(current), comment: comment ?? v!.draft.comment }), onSuccess: () => done() });
  const submit = useMutation({
    mutationFn: async () => { if (!rad) await api.put(`/lab/results/${v!.resultId}/draft`, { version: v!.version, values: toValues(current), comment: comment ?? v!.draft.comment }); return api.post(`/lims/requests/${req.id}/submit`, {}, newKey()); },
    onSuccess: () => done(true),
  });
  const accept = useMutation({ mutationFn: () => api.post(`/lims/requests/${req.id}/accept`, {}, newKey()), onSuccess: () => done() });
  const reject = useMutation({ mutationFn: (reason: string) => api.post(`/lims/requests/${req.id}/reject-sample`, { reason }, newKey()), onSuccess: () => done(true) });
  const perform = useMutation({ mutationFn: () => api.post(`/lims/requests/${req.id}/perform`, { modality, bodyPart: bodyPart.trim(), ...(notes.trim() ? { clinicalNotes: notes.trim() } : {}) }, newKey()), onSuccess: () => done() });
  const issue = useMutation({ mutationFn: () => api.post(`/lims/requests/${req.id}/issue`, {}, newKey()), onSuccess: () => done(true) });
  const returned = lastReturn(d.data);
  return (
    <Modal title={`${req.test}: ${req.patient.name}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{req.patient.mrn} · {req.patient.gender.toLowerCase()} · {req.requestNumber} · <StageBadge r={{ ...req, status }} /></p>
        {req.clinicalNote && <Notice>Reason for the test: {req.clinicalNote}</Notice>}
        {req.compromisedSampleApproved && <Notice tone="warn">The LIMS manager approved using this sample although it is not ideal.</Notice>}
        {returned && status === "IN_PROCESS" && <Notice tone="warn">Sent back by the specialist: {returned}</Notice>}
        {d.isLoading && <Spinner />}

        {/* laboratory: the sample arrived */}
        {!rad && status === "COLLECTED" && (
          <div className="space-y-2">
            <Notice>Sample received{lab.data?.sample ? `: ${lab.data.sample.accessionNumber} (${lab.data.sample.specimen})` : ""}. Check it, then accept it or reject it.</Notice>
            <ErrorNote error={accept.error} />
            <Button loading={accept.isPending} onClick={() => accept.mutate()}>Accept sample</Button>
            <ReasonBox label="Reject the sample (why it cannot be used)" button="Reject sample and ask for another" error={reject.error} loading={reject.isPending} onSubmit={(r) => reject.mutate(r)} />
          </div>
        )}
        {/* laboratory: typing the values */}
        {!rad && status === "IN_PROCESS" && v && (
          <div className="space-y-2">
            <Table head={["Test", "Result", "Unit", "Normal range"]}>
              {v.parameters.map((p) => (
                <tr key={p.id}>
                  <Td>{p.name}</Td>
                  <Td>{p.type === "CHOICE" ? <Select aria-label={p.name} value={current[p.id] ?? ""} onChange={(e) => setVals({ ...current, [p.id]: e.target.value })}><option value="">—</option>{p.choices?.map((c) => <option key={c}>{c}</option>)}</Select>
                    : <Input aria-label={p.name} className="w-40" value={current[p.id] ?? ""} onChange={(e) => setVals({ ...current, [p.id]: e.target.value })} />}</Td>
                  <Td>{p.unit ?? ""}</Td><Td>{p.rangeText}</Td>
                </tr>
              ))}
            </Table>
            <Field label="Comment for the pathologist (optional)"><Input value={comment ?? v.draft.comment} onChange={(e) => setComment(e.target.value)} /></Field>
            <ErrorNote error={save.error ?? submit.error} />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate()}>Save values</Button>
              <Button loading={submit.isPending} onClick={() => submit.mutate()}>Send for review</Button>
              {v.sample && <a className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50" href={printUrl(`lab-labels/${v.sample.id}`)} target="_blank" rel="noreferrer">Print sample label</a>}
            </div>
            <ReasonBox label="The sample turns out to be unusable" button="Reject sample and ask for another" error={reject.error} loading={reject.isPending} onSubmit={(r) => reject.mutate(r)} />
          </div>
        )}

        {/* radiology: perform the scan */}
        {rad && status === "COLLECTED" && (
          <div className="space-y-2">
            <Notice>The patient is ready. Perform the scan and record it here.</Notice>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Type of scan"><Select value={modality} onChange={(e) => setModality(e.target.value)}>{MODALITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
              <Field label="Body part"><Input value={bodyPart} onChange={(e) => setBodyPart(e.target.value)} placeholder="For example Chest PA" /></Field>
            </div>
            <Field label="Notes (optional)"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <ErrorNote error={perform.error} />
            <Button disabled={bodyPart.trim().length < 2} loading={perform.isPending} onClick={() => perform.mutate()}>Scan done</Button>
            <ReasonBox label="The patient cannot be scanned now (for example not prepared)" button="Send the patient back" error={reject.error} loading={reject.isPending} onSubmit={(r) => reject.mutate(r)} />
          </div>
        )}
        {rad && status === "IN_PROCESS" && study.data?.study && (
          <div className="space-y-2">
            <p className="text-sm text-slate-700">Study {study.data.study.accessionNumber} · {MODALITIES.find(([k]) => k === study.data!.study!.modality)?.[1]} · {study.data.study.bodyPart}{study.data.study.clinicalNotes ? ` · ${study.data.study.clinicalNotes}` : ""}</p>
            <RadImagesCard studyId={study.data.study.id} canManage={can("RAD_PERFORM")} />
            <ErrorNote error={submit.error} />
            <Button loading={submit.isPending} onClick={() => submit.mutate()}>Send for review</Button>
          </div>
        )}

        {status === "PENDING_REVIEW" && <Notice>{rad ? "With the radiologist." : "With the pathologist."} You will be told if it is sent back.</Notice>}
        {status === "PASSED" && (
          <div className="space-y-2">
            <Notice tone="success">The report has been passed. Issue it to release it to the doctor{req.origin === "OPD" ? " and the reception desk" : ""}.</Notice>
            <ErrorNote error={issue.error} />
            <div className="flex gap-2">
              <Button loading={issue.isPending} onClick={() => issue.mutate()}>Issue report</Button>
              <a className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50" href={printUrl(rad ? `radiology-reports/${req.testOrderId}` : `lab-reports/${req.testOrderId}`)} target="_blank" rel="noreferrer">Preview report</a>
            </div>
          </div>
        )}
        {(status === "ISSUED" || status === "HANDED_OVER") && <Notice tone="success">This report has been issued.</Notice>}
      </div>
    </Modal>
  );
}

const TECH_TABS = [
  { id: "accept", label: "To accept", status: "COLLECTED" }, { id: "work", label: "In progress", status: "IN_PROCESS" }, { id: "review", label: "With the specialist", status: "PENDING_REVIEW" },
  { id: "issue", label: "Ready to issue", status: "PASSED" }, { id: "coming", label: "Coming up", status: "PENDING_COLLECTION" },
] as const;

/** The technician's desk: what has arrived, what they are working on, what has been passed and waits to be issued. */
export function TechDesk() {
  const { can } = useMe();
  const [tab, setTab] = useState<(typeof TECH_TABS)[number]["id"] | "qc">("accept");
  const [open, setOpen] = useState<Req | null>(null);
  const active = TECH_TABS.find((t) => t.id === tab);
  const list = useRequests(active ? { status: active.status } : {}, { enabled: !!active, every: 15_000 });
  const mine = useRequests({ mine: "true", status: "COLLECTED,IN_PROCESS,PENDING_REVIEW,PASSED" }, { every: 30_000 });
  return (
    <>
      {(mine.data?.items.length ?? 0) > 0 && <Notice>{mine.data!.items.length} request(s) are assigned to you.</Notice>}
      <Tabs tabs={[...TECH_TABS.map((t) => ({ id: t.id, label: t.label })), ...(can("LIMS_QC") ? [{ id: "qc" as const, label: "Quality control" }] : [])]} value={tab} onChange={setTab} />
      {tab === "qc" ? <QcPanel /> : (
        <Card title={active?.label ?? ""}>
          <RequestTable rows={list.data?.items} empty="Nothing here." columns={["patient", "test", "status", "due", "who", "origin"]} onOpen={setOpen}
            actions={(r) => <Button variant="secondary" onClick={() => setOpen(r)}>{r.status === "COLLECTED" ? (r.department === "RADIOLOGY" ? "Do the scan" : "Accept") : r.status === "IN_PROCESS" ? "Open" : r.status === "PASSED" ? "Issue" : "View"}</Button>} />
        </Card>
      )}
      {open && (active?.id === "coming" ? <DetailModal id={open.id} onClose={() => setOpen(null)} /> : <TechModal req={open} onClose={() => setOpen(null)} />)}
    </>
  );
}

// ───────────────────────── pathologist / radiologist ─────────────────────────

/** The specialist reviews what the technician prepared, then passes it (verifies or signs it) or sends it back. A released report can be amended with a reason. */
function ReviewModal({ req, onClose }: { req: Req; onClose: () => void }) {
  const refresh = useRefreshLims();
  const rad = req.department === "RADIOLOGY";
  const d = useQuery({ queryKey: ["lims-detail", req.id], queryFn: () => api.get<Detail>(`/lims/requests/${req.id}`) });
  const status = d.data?.status ?? req.status;
  const lab = useQuery({ queryKey: ["lims-lab", req.testOrderId], queryFn: () => api.get<LabView>(`/lab/orders/${req.testOrderId}/result`), enabled: !rad });
  const study = useQuery({ queryKey: ["lims-rad", req.testOrderId], queryFn: () => api.get<RadView>(`/rad/orders/${req.testOrderId}/study`), enabled: rad });
  const [comment, setComment] = useState("");
  const [findings, setFindings] = useState("");
  const [impression, setImpression] = useState("");
  const [critical, setCritical] = useState(false);
  const [amending, setAmending] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [vals, setVals] = useState<Record<string, string> | null>(null);
  const done = (close = false) => { refresh(); void d.refetch(); if (rad) void study.refetch(); else void lab.refetch(); if (close) onClose(); };
  const v = lab.data; const s = study.data;
  const pass = useMutation({ mutationFn: () => api.post(`/lab/results/${v!.resultId}/verify`, { version: v!.version, ...(comment.trim() ? { comment: comment.trim() } : {}) }, newKey()), onSuccess: () => done(true) });
  const sign = useMutation({ mutationFn: () => api.post(`/rad/studies/${s!.study!.id}/report`, { findings: findings.trim(), impression: impression.trim(), critical }, newKey()), onSuccess: () => done(true) });
  const back = useMutation({ mutationFn: (reason: string) => api.post(`/lims/requests/${req.id}/return`, { reason }, newKey()), onSuccess: () => done(true) });
  const amendLab = useMutation({ mutationFn: () => api.post(`/lab/results/${v!.resultId}/amend`, { expectedVersion: v!.currentVersion, reason: amendReason.trim(), values: toValues(vals ?? Object.fromEntries((v!.reports[0]?.values ?? []).map((x) => [x.parameterId, x.value]))) }, newKey()), onSuccess: () => { setAmending(false); setAmendReason(""); setVals(null); done(); } });
  const amendRad = useMutation({ mutationFn: () => api.post(`/rad/studies/${s!.study!.id}/amend`, { expectedVersion: s!.study!.currentVersion, findings: findings.trim(), impression: impression.trim(), critical, reason: amendReason.trim() }, newKey()), onSuccess: () => { setAmending(false); setAmendReason(""); done(); } });
  const latestLab = v?.reports[0]; const latestRad = s?.reports[0];
  const released = !!(latestLab || latestRad);
  const waiting = status === "PENDING_REVIEW";
  return (
    <Modal title={`${req.test}: ${req.patient.name}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{req.patient.mrn} · {req.patient.gender.toLowerCase()} · {req.requestNumber} · <StageBadge r={{ ...req, status }} /></p>
        {req.clinicalNote && <Notice>Reason for the test: {req.clinicalNote}</Notice>}
        {req.compromisedSampleApproved && <Notice tone="warn">The LIMS manager approved using a sample that is not ideal.</Notice>}
        {(lab.isLoading || study.isLoading) && <Spinner />}

        {!rad && v && (
          <>
            {!released || amending ? (
              <Table head={["Test", "Result", "Unit", "Normal range"]}>
                {v.parameters.map((p) => {
                  const given = (amending ? (vals ?? Object.fromEntries((latestLab?.values ?? []).map((x) => [x.parameterId, x.value]))) : Object.fromEntries(v.draft.values.map((x) => [x.parameterId, x.value])))[p.id] ?? "";
                  return <tr key={p.id}><Td>{p.name}</Td><Td>{amending ? <Input aria-label={p.name} className="w-36" value={given} onChange={(e) => setVals({ ...(vals ?? Object.fromEntries((latestLab?.values ?? []).map((x) => [x.parameterId, x.value]))), [p.id]: e.target.value })} /> : <span className="font-medium">{given || "—"}</span>}</Td><Td>{p.unit ?? ""}</Td><Td>{p.rangeText}</Td></tr>;
                })}
              </Table>
            ) : (
              <Table head={["Test", "Result", "Unit", "Normal range", "Flag"]}>
                {latestLab!.values.map((x) => <tr key={x.parameterId}><Td>{x.name}</Td><Td className="font-medium">{x.value}</Td><Td>{x.unit ?? ""}</Td><Td>{x.rangeText}</Td><Td><Badge tone={FLAG_TONE[x.flag] ?? "gray"}>{x.flag.replace("_", " ").toLowerCase()}</Badge></Td></tr>)}
              </Table>
            )}
            {v.draft.comment && <p className="text-sm text-slate-600">Technician's comment: {v.draft.comment}</p>}
            {waiting && (
              <div className="space-y-2">
                <Field label="Your comment on the report (optional)"><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
                <ErrorNote error={pass.error} />
                <Button loading={pass.isPending} onClick={() => pass.mutate()}>Pass report</Button>
              </div>
            )}
          </>
        )}

        {rad && s?.study && (
          <>
            <p className="text-sm text-slate-700">Study {s.study.accessionNumber} · {MODALITIES.find(([k]) => k === s.study!.modality)?.[1]} · {s.study.bodyPart}{s.study.clinicalNotes ? ` · ${s.study.clinicalNotes}` : ""}</p>
            <RadImagesCard studyId={s.study.id} canManage={false} />
            {released && !amending && latestRad && (
              <div className="space-y-1 rounded-md border border-slate-200 p-3 text-sm"><p><span className="font-medium">Findings:</span> {latestRad.findings}</p><p><span className="font-medium">Impression:</span> {latestRad.impression}</p>{latestRad.hasCritical && <Badge tone="red">critical finding</Badge>}</div>
            )}
            {(waiting || amending) && (
              <div className="space-y-2">
                <Field label="Findings"><Textarea rows={5} value={findings} onChange={(e) => setFindings(e.target.value)} /></Field>
                <Field label="Impression"><Textarea rows={2} value={impression} onChange={(e) => setImpression(e.target.value)} /></Field>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} /> This finding needs the doctor straight away</label>
                {!amending && <><ErrorNote error={sign.error} /><Button disabled={findings.trim().length < 3 || impression.trim().length < 3} loading={sign.isPending} onClick={() => sign.mutate()}>Sign report</Button></>}
              </div>
            )}
          </>
        )}

        {waiting && <ReasonBox label="Send back to the technician (what needs to be corrected)" button="Send back" error={back.error} loading={back.isPending} onSubmit={(r) => back.mutate(r)} />}
        {released && !amending && <Button variant="secondary" onClick={() => { setAmending(true); if (rad && latestRad) { setFindings(latestRad.findings); setImpression(latestRad.impression); setCritical(latestRad.hasCritical); } }}>Amend this report</Button>}
        {amending && (
          <div className="space-y-2">
            <Field label="Why is the report being corrected? (kept on the record)"><Textarea rows={2} value={amendReason} onChange={(e) => setAmendReason(e.target.value)} /></Field>
            <ErrorNote error={amendLab.error ?? amendRad.error} />
            <div className="flex gap-2"><Button disabled={amendReason.trim().length < 5} loading={amendLab.isPending || amendRad.isPending} onClick={() => (rad ? amendRad : amendLab).mutate()}>Save amended report</Button><Button variant="ghost" onClick={() => setAmending(false)}>Cancel</Button></div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The pathologist's or radiologist's desk. */
export function SpecialistDesk() {
  const { can } = useMe();
  const [tab, setTab] = useState<"review" | "passed" | "issued" | "critical" | "tests">("review");
  const [open, setOpen] = useState<Req | null>(null);
  const status = tab === "review" ? "PENDING_REVIEW" : tab === "passed" ? "PASSED" : "ISSUED,HANDED_OVER";
  const list = useRequests({ status }, { enabled: tab !== "critical" && tab !== "tests", every: 15_000 });
  return (
    <>
      <Tabs tabs={[{ id: "review", label: "To review" }, { id: "passed", label: "Passed, waiting to be issued" }, { id: "issued", label: "Issued" }, { id: "critical", label: "Critical" }, ...(can("LAB_MASTERS") ? [{ id: "tests" as const, label: "Tests and ranges" }] : [])]} value={tab} onChange={setTab} />
      {tab === "tests" ? <div className="space-y-4"><LabTests /><TestGrouping /></div> : tab === "critical" ? <>{can("LAB_VERIFY") && <LabCritical />}{can("RAD_REPORT") && <RadCritical />}</> : (
        <Card title={tab === "review" ? "Waiting for your review" : tab === "passed" ? "Passed" : "Issued"}>
          <RequestTable rows={list.data?.items} empty="Nothing here." columns={["patient", "test", "status", "due", "origin"]} onOpen={setOpen}
            actions={(r) => <Button variant="secondary" onClick={() => setOpen(r)}>{r.status === "PENDING_REVIEW" ? "Review" : "View"}</Button>} />
        </Card>
      )}
      {open && <ReviewModal req={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ───────────────────────── nurse ─────────────────────────

/** The nurse's list: samples to take (laboratory) and patients to get ready (imaging). Emergencies are on top. */
export function CollectionDesk() {
  const refresh = useRefreshLims();
  const [tab, setTab] = useState<"mine" | "all" | "done">("mine");
  const [open, setOpen] = useState<Req | null>(null);
  const [note, setNote] = useState("");
  const list = useRequests({ status: tab === "done" ? "COLLECTED" : "PENDING_COLLECTION", ...(tab === "mine" ? { mine: "true" } : {}) }, { every: 15_000 });
  const collect = useMutation({ mutationFn: (r: Req) => api.post(`/lims/requests/${r.id}/collect`, note.trim() ? { notes: note.trim() } : {}, newKey()), onSuccess: () => { setOpen(null); setNote(""); refresh(); } });
  const notHere = (r: Req) => r.origin === "OPD" && !r.arrivedAt;
  return (
    <>
      <div className="mb-3"><TodayBoard mode="nurse" /></div>
      <Tabs tabs={[{ id: "mine", label: "Assigned to me" }, { id: "all", label: "All waiting" }, { id: "done", label: "Collected, with the lab" }]} value={tab} onChange={setTab} />
      <Card title={tab === "done" ? "Taken and handed to the lab" : "Samples to take"}>
        <RequestTable rows={list.data?.items} empty={tab === "mine" ? "Nothing is assigned to you." : "Nothing is waiting."} columns={["patient", "test", "status", "origin"]} onOpen={setOpen}
          actions={tab === "done" ? undefined : (r) => (notHere(r) ? <Badge tone="amber">waiting for the patient at reception</Badge> : <Button onClick={() => setOpen(r)}>{r.department === "RADIOLOGY" ? "Patient ready" : "Collect sample"}</Button>)} />
      </Card>
      {open && tab !== "done" && (
        <Modal title={`${open.test}: ${open.patient.name}`} onClose={() => setOpen(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">{open.patient.mrn} · {open.patient.gender.toLowerCase()} · {open.requestNumber}</p>
            {notHere(open) && <Notice tone="warn">This patient has not reported at reception yet. The sample can be taken once reception has taken the patient in.</Notice>}
            {open.bed && <p className="text-sm text-slate-600">Bed {open.bed.code} ({open.bed.ward})</p>}
            {open.needsRecollection && <Notice tone="warn">The earlier sample was rejected. A new sample is needed.</Notice>}
            {open.clinicalNote && <Notice>Reason for the test: {open.clinicalNote}</Notice>}
            {open.instructions && <p className="text-sm text-slate-600">Preparation: {open.instructions}</p>}
            <Field label={open.department === "RADIOLOGY" ? "Note for the radiology technician (optional)" : "Note about the sample (optional)"}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <ErrorNote error={collect.error} />
            <div className="flex gap-2"><Button disabled={notHere(open)} loading={collect.isPending} onClick={() => collect.mutate(open)}>{open.department === "RADIOLOGY" ? "Patient is ready" : "Sample taken"}</Button><Button variant="ghost" onClick={() => setOpen(null)}>Cancel</Button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

// ───────────────────────── reception ─────────────────────────

interface Pending { encounterId: string; visitNumber: string; doctor: string | null; patient: { id: string; name: string; mrn: string | null; hasMobile: boolean }; orderedAt: string; tests: { testOrderId: string; name: string; department: string; billed: boolean; amount: string | null; instructions: string | null; specimen: string | null }[] }
interface Launched { messages: { kind: string; channel: string; to: string; status: string; sentForReal: boolean }[]; requests: { requestNumber: string }[]; scheduledFor?: string | null; autoScheduled?: boolean }

interface Availability { suggestedAt: string; immediate: boolean; departments: { kind: string; name: string; capacityPerHour: number; waiting: number; todayPercent: number; needed: number }[] }

/** What the chosen tests still cost (price list, with tax), before the patient pays. Tests the Cashier has already billed are not counted again. */
function EstimateNote({ amounts, billed = 0 }: { amounts: (string | null)[]; billed?: number }) {
  const { money } = useMe();
  if (amounts.length === 0) return billed > 0 ? <p className="text-sm text-slate-700">{billed === 1 ? "This test is" : "These tests are"} already billed: nothing more to pay for {billed === 1 ? "it" : "them"}.</p> : null;
  const total = amounts.reduce((n, a) => n + Math.round(Number(a ?? 0) * 100), 0) / 100;
  const unpriced = amounts.filter((a) => a === null).length;
  return <p className="text-sm text-slate-700">Cost of {billed > 0 ? "the other tests" : "these tests"}: <span className="font-medium">{money(total)}</span>{billed > 0 ? <span className="text-slate-500"> ({billed} already billed)</span> : null}{unpriced > 0 ? <span className="text-amber-700"> · {unpriced} test{unpriced > 1 ? "s have" : " has"} no price on the price list yet (the cashier must price {unpriced > 1 ? "them" : "it"} before the patient can pay)</span> : null}</p>;
}

/** The date the patient will be given if reception leaves the time empty, from how busy the labs are. */
function AvailabilityNote({ pathology, radiology, priority }: { pathology: number; radiology: number; priority: string }) {
  const { dateTime } = useMe();
  const q = useQuery({ queryKey: ["lims-availability", pathology, radiology, priority], queryFn: () => api.get<Availability>("/lims/opd/availability", { pathology, radiology, priority }), enabled: pathology + radiology > 0, refetchInterval: 30_000 });
  if (pathology + radiology === 0) return null;
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return null;
  return (
    <div className="rounded-md border border-blue-100 bg-blue-50 p-2 text-sm text-slate-700">
      {q.data.immediate ? <p><span className="font-medium">Emergency:</span> the patient comes now.</p> : <p><span className="font-medium">First free time: {dateTime(q.data.suggestedAt)}.</span> The patient is given this time if you leave "Come at" empty.</p>}
      <p className="mt-0.5 text-xs text-slate-500">{q.data.departments.filter((d) => d.needed > 0).map((d) => `${d.name}: ${d.waiting} waiting, ${d.todayPercent}% full today (${d.capacityPerHour} an hour)`).join(" · ")}</p>
    </div>
  );
}



function LaunchedNote({ name, mrn, patientId, result, onClose }: { name: string; mrn: string | null; patientId: string; result: Launched; onClose: () => void }) {
  const { dateTime } = useMe();
  return (
    <Card title={`${name} · ${mrn}`} actions={<Button variant="ghost" onClick={onClose}>Dismiss</Button>}>
      <Notice tone="success">Sent to the lab: {result.requests.map((r) => r.requestNumber).join(", ")}. The patient is now in the queue.</Notice>
      <p className="mt-2 text-sm font-medium text-slate-800">{result.scheduledFor ? `Come on ${dateTime(result.scheduledFor)}${result.autoScheduled ? " (the first free time, from how busy the labs are)" : ""}` : "Come now"}</p>
      {result.messages.length > 0 ? <p className="mt-2 text-sm text-slate-600">{result.messages.map((m) => `${m.channel === "WHATSAPP" ? "WhatsApp" : "SMS"} to ${m.to}: ${m.status.toLowerCase()}${m.status === "PENDING" ? " (goes out within a minute)" : ""}${m.status === "SENT" && !m.sentForReal ? " (no message service is connected, so nothing left the server)" : ""}`).join("; ")}</p>
        : <p className="mt-2 text-sm text-amber-700">No message was queued: the patient has no valid mobile number, has asked not to be messaged, or messages are switched off. Tell the patient when to come and what to do beforehand.</p>}
      <p className="mt-2 text-xs text-slate-500">Take an advance now if the patient pays one. On the day, press "Patient arrived" under Today's patients to take the rest.</p>
      <div className="mt-2"><AdvanceCard patientId={patientId} /></div>
    </Card>
  );
}

function LaunchCard({ g, onLaunched }: { g: Pending; onLaunched: (g: Pending, r: Launched) => void }) {
  const refresh = useRefreshLims();
  const { can } = useMe();
  const staff = useStaff();
  const [picked, setPicked] = useState<Set<string>>(new Set(g.tests.map((t) => t.testOrderId)));
  const [agreed, setAgreed] = useState(false);
  const [mode, setMode] = useState("VERBAL");
  const [priority, setPriority] = useState("ROUTINE");
  const [when, setWhen] = useState("");
  const [nurse, setNurse] = useState("");
  const [instructions, setInstructions] = useState([...new Set(g.tests.map((t) => t.instructions).filter(Boolean))].join(" "));
  const [declining, setDeclining] = useState(false);
  const ids = [...picked];
  const launch = useMutation({
    mutationFn: () => api.post<Launched>("/lims/opd/launch", { encounterId: g.encounterId, consent: true, consentMode: mode, testOrderIds: ids, priority, ...(when ? { scheduledFor: new Date(when).toISOString() } : {}), ...(nurse ? { assignedNurseId: nurse } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}) }, newKey()),
    onSuccess: (r) => { onLaunched(g, r); refresh(); },
  });
  const decline = useMutation({ mutationFn: (reason: string) => api.post("/lims/opd/decline", { encounterId: g.encounterId, testOrderIds: ids, reason }, newKey()), onSuccess: refresh });
  return (
    <Card title={<span>{g.patient.name} <span className="font-normal text-slate-500">· {g.patient.mrn} · visit {g.visitNumber}{g.doctor ? ` · ${g.doctor}` : ""}</span></span>}>
      <div className="space-y-3">
        <ul className="space-y-1 text-sm">
          {g.tests.map((t) => (
            <li key={t.testOrderId}><label className="flex items-center gap-2"><input type="checkbox" checked={picked.has(t.testOrderId)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(t.testOrderId); else n.delete(t.testOrderId); setPicked(n); }} />
              <span className="font-medium">{t.name}</span> <Badge tone={t.department === "PATHOLOGY" ? "blue" : "purple"}>{t.department === "PATHOLOGY" ? "Laboratory" : "Imaging"}</Badge>{t.billed && <Badge tone="green">billed</Badge>}{t.specimen && <span className="text-slate-500">· {t.specimen}</span>}</label></li>
          ))}
        </ul>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Come at (leave empty for the first free time)"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
          <Field label="Priority"><Select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="ROUTINE">Routine</option>{can("LIMS_PRIORITY") && <><option value="URGENT">Urgent</option><option value="EMERGENCY">Emergency</option></>}</Select></Field>
          <Field label="Nurse to take the sample (optional)"><Select value={nurse} onChange={(e) => setNurse(e.target.value)}><option value="">Any nurse</option>{staff.data?.nurses.map((n) => <option key={n.id} value={n.id}>{n.fullName}</option>)}</Select></Field>
        </div>
        <EstimateNote amounts={g.tests.filter((t) => picked.has(t.testOrderId) && !t.billed).map((t) => t.amount)} billed={g.tests.filter((t) => picked.has(t.testOrderId) && t.billed).length} />
        <AvailabilityNote pathology={g.tests.filter((t) => picked.has(t.testOrderId) && t.department === "PATHOLOGY").length} radiology={g.tests.filter((t) => picked.has(t.testOrderId) && t.department === "RADIOLOGY").length} priority={priority} />
        <Field label="What the patient should do before coming (sent to the patient)"><Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="For example: come fasting for 8 hours" /></Field>
        {!g.patient.hasMobile && <Notice tone="warn">This patient has no valid mobile number, so no message can be sent. Tell them when to come and what to do beforehand.</Notice>}
        <label className="flex items-start gap-2 rounded-md bg-slate-50 p-2 text-sm"><input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /><span>The patient has agreed to these tests.
          <Select aria-label="How the patient agreed" className="ml-2 inline-block w-48" value={mode} onChange={(e) => setMode(e.target.value)}><option value="VERBAL">Said so at the desk</option><option value="WRITTEN">Signed a form</option></Select></span></label>
        <ErrorNote error={launch.error ?? decline.error} />
        {declining ? <ReasonBox label="Why does the patient not want the tests done here?" button="The patient declined" error={decline.error} loading={decline.isPending} onSubmit={(r) => decline.mutate(r)} />
          : <div className="flex flex-wrap gap-2"><Button disabled={!agreed || ids.length === 0} loading={launch.isPending} onClick={() => launch.mutate()}>Send to the lab</Button><Button variant="secondary" disabled={ids.length === 0} onClick={() => setDeclining(true)}>Patient does not agree</Button></div>}
      </div>
    </Card>
  );
}

/** Reception books tests for a patient who has no doctor's order: choose the patient and the tests, the patient agrees, and the tests go straight into the queue. */
function BookForm({ onBooked }: { onBooked: (name: string, mrn: string | null, patientId: string, r: Launched) => void }) {
  const refresh = useRefreshLims();
  const { can } = useMe();
  const staff = useStaff();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const found = useQuery({ queryKey: ["lims-book-patients", term], queryFn: () => api.page<{ id: string; mrn: string | null; firstName: string; lastName: string | null; mobile: string | null }>("/patients", { q: term, pageSize: 6 }), enabled: term.length >= 2 });
  const [patient, setPatient] = useState<{ id: string; name: string; mrn: string | null } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const cat = useCatalogue();
  const kindOf = new Map((cat.data ?? []).map((i) => [i.serviceId, i.department]));
  const amountOf = new Map((cat.data ?? []).map((i) => [i.serviceId, i.amount ?? null]));
  const [referredBy, setReferredBy] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [mode, setMode] = useState("VERBAL");
  const [priority, setPriority] = useState("ROUTINE");
  const [when, setWhen] = useState("");
  const [nurse, setNurse] = useState("");
  const [instructions, setInstructions] = useState("");
  const book = useMutation({
    mutationFn: () => api.post<Launched>("/lims/opd/book", { patientId: patient!.id, consent: true, consentMode: mode, tests: [...picked].map((serviceId) => ({ serviceId })), priority, ...(when ? { scheduledFor: new Date(when).toISOString() } : {}), ...(nurse ? { assignedNurseId: nurse } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}), ...(referredBy.trim().length >= 2 ? { referredBy: referredBy.trim() } : {}) }, newKey()),
    onSuccess: (r) => { onBooked(patient!.name, patient!.mrn, patient!.id, r); setPatient(null); setPicked(new Set()); setAgreed(false); setReferredBy(""); setWhen(""); setNurse(""); setInstructions(""); setPriority("ROUTINE"); setQ(""); refresh(); },
  });
  return (
    <Card title="Book tests for a patient">
      <div className="space-y-3">
        {patient ? (
          <div className="flex items-center gap-2 text-sm"><span className="font-medium">{patient.name}</span><span className="text-slate-500">· {patient.mrn}</span><Button variant="ghost" onClick={() => setPatient(null)}>Change patient</Button></div>
        ) : (
          <div className="space-y-1">
            <Input aria-label="Find the patient" className="max-w-sm" placeholder="Find the patient by name, MRN or mobile" value={q} onChange={(e) => setQ(e.target.value)} />
            {term.length >= 2 && (found.data?.data.length === 0 ? <p className="text-sm text-slate-500">No patient found. Register the patient first.</p> : (
              <ul className="max-w-md divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
                {found.data?.data.map((p) => <li key={p.id}><button className="w-full px-3 py-1.5 text-left hover:bg-slate-50" onClick={() => setPatient({ id: p.id, name: [p.firstName, p.lastName].filter(Boolean).join(" "), mrn: p.mrn })}><span className="font-medium">{[p.firstName, p.lastName].filter(Boolean).join(" ")}</span> <span className="text-slate-500">· {p.mrn}{p.mobile ? ` · ${p.mobile}` : ""}</span></button></li>)}
              </ul>
            ))}
          </div>
        )}
        <TestPicker picked={picked} onChange={setPicked} />
        <EstimateNote amounts={[...picked].map((id) => amountOf.get(id) ?? null)} />
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Come at (leave empty for the first free time)"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
          <Field label="Priority"><Select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="ROUTINE">Routine</option>{can("LIMS_PRIORITY") && <><option value="URGENT">Urgent</option><option value="EMERGENCY">Emergency</option></>}</Select></Field>
          <Field label="Nurse to take the sample (optional)"><Select value={nurse} onChange={(e) => setNurse(e.target.value)}><option value="">Any nurse</option>{staff.data?.nurses.map((n) => <option key={n.id} value={n.id}>{n.fullName}</option>)}</Select></Field>
        </div>
        <AvailabilityNote pathology={[...picked].filter((id) => kindOf.get(id) === "PATHOLOGY").length} radiology={[...picked].filter((id) => kindOf.get(id) === "RADIOLOGY").length} priority={priority} />
        <Field label="Sent by an outside doctor (optional)"><Input value={referredBy} onChange={(e) => setReferredBy(e.target.value)} placeholder="For example Dr. S. Roy" /></Field>
        <Field label="What the patient should do before coming (sent to the patient)"><Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Leave empty to use each test's own instructions" /></Field>
        <label className="flex items-start gap-2 rounded-md bg-slate-50 p-2 text-sm"><input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /><span>The patient has agreed to these tests.
          <Select aria-label="How the patient agreed" className="ml-2 inline-block w-48" value={mode} onChange={(e) => setMode(e.target.value)}><option value="VERBAL">Said so at the desk</option><option value="WRITTEN">Signed a form</option></Select></span></label>
        <ErrorNote error={book.error} />
        <Button disabled={!patient || picked.size === 0 || !agreed} loading={book.isPending} onClick={() => book.mutate()}>Book and send to the lab</Button>
      </div>
    </Card>
  );
}

/** Reception: tests the doctors advised for outpatients, booking tests for a patient, the lab queue, and reports waiting to be handed over. */
export function ReceptionDesk() {
  const refresh = useRefreshLims();
  const [tab, setTab] = useState<"advised" | "book" | "today" | "queue" | "handover">("advised");
  const [open, setOpen] = useState<Req | null>(null);
  const [q, setQ] = useState("");
  const [who, setWho] = useState<Record<string, string>>({});
  const [launched, setLaunched] = useState<{ key: string; name: string; mrn: string | null; patientId: string; result: Launched }[]>([]);
  const pending = useQuery({ queryKey: ["lims-pending", q], queryFn: () => api.get<Pending[]>("/lims/opd/pending", q.trim().length >= 2 ? { q: q.trim() } : {}), enabled: tab === "advised", refetchInterval: 20_000 });
  const queue = useRequests({ origin: "OPD", status: "PENDING_COLLECTION,COLLECTED,IN_PROCESS,PENDING_REVIEW,PASSED" }, { enabled: tab === "queue", every: 15_000 });
  const ready = useRequests({ origin: "OPD", status: "ISSUED" }, { enabled: tab === "handover", every: 20_000 });
  const hand = useMutation({ mutationFn: (r: Req) => api.post(`/lims/requests/${r.id}/handover`, { receivedBy: (who[r.id] ?? "").trim() }, newKey()), onSuccess: refresh });
  return (
    <>
      <Tabs tabs={[{ id: "advised", label: "Tests advised" }, { id: "book", label: "Book a test" }, { id: "today", label: "Today's patients" }, { id: "queue", label: "Lab queue" }, { id: "handover", label: "Reports to hand over" }]} value={tab} onChange={setTab} />
      {launched.length > 0 && <div className="mb-3 space-y-3">{launched.map((l) => <LaunchedNote key={l.key} name={l.name} mrn={l.mrn} patientId={l.patientId} result={l.result} onClose={() => setLaunched(launched.filter((x) => x.key !== l.key))} />)}</div>}
      {tab === "book" && <BookForm onBooked={(name, mrn, patientId, result) => setLaunched((cur) => [{ key: `book:${result.requests[0]?.requestNumber ?? Date.now()}`, name, mrn, patientId, result }, ...cur])} />}
      {tab === "today" && <TodayBoard mode="reception" />}
      {tab === "advised" && (
        <div className="space-y-3">
          <Input aria-label="Search" className="max-w-sm" placeholder="Search name, MRN or mobile" value={q} onChange={(e) => setQ(e.target.value)} />
          {pending.isLoading ? <Spinner /> : pending.data?.length === 0 ? <Notice>No outpatient tests are waiting. Tests the doctors advise appear here until they are sent to the lab.</Notice> : pending.data?.map((g) => <LaunchCard key={g.encounterId} g={g} onLaunched={(x, r) => setLaunched((cur) => [{ key: `${x.encounterId}:${r.requests[0]?.requestNumber ?? ""}`, name: x.patient.name, mrn: x.patient.mrn, patientId: x.patient.id, result: r }, ...cur])} />)}
        </div>
      )}
      {tab === "queue" && <Card title="Outpatients in the lab queue"><RequestTable rows={queue.data?.items} empty="Nobody is waiting." columns={["patient", "test", "status", "due"]} onOpen={setOpen} /></Card>}
      {tab === "handover" && (
        <Card title="Reports ready for the patient">
          <ErrorNote error={hand.error} />
          <RequestTable rows={ready.data?.items} empty="No reports are waiting at reception." columns={["patient", "test"]}
            actions={(r) => <>
              <a className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50" href={`/api/proxy/lims/requests/${r.id}/report`} target="_blank" rel="noreferrer">Print report</a>
              <Input aria-label="Received by" className="w-40" placeholder="Received by" value={who[r.id] ?? ""} onChange={(e) => setWho({ ...who, [r.id]: e.target.value })} />
              <Button disabled={(who[r.id] ?? "").trim().length < 2} loading={hand.isPending && hand.variables?.id === r.id} onClick={() => hand.mutate(r)}>Handed over</Button>
            </>} />
        </Card>
      )}
      {open && <DetailModal id={open.id} onClose={() => setOpen(null)} />}
    </>
  );
}
