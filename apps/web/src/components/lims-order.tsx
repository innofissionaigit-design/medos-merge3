"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { PriorityBadge, stageLabel, useRefreshLims } from "./lims-common";
import { TestPicker } from "./lims-picker";
import { Badge, Button, Card, ErrorNote, Field, Input, Notice, Select, Table, Td, Textarea } from "./ui";

interface Row { id: string; requestNumber: string; test: string; department: "PATHOLOGY" | "RADIOLOGY"; status: string; priority: "EMERGENCY" | "URGENT" | "ROUTINE"; dueAt: string; delayed: boolean; released: boolean; critical: boolean; needsRecollection: boolean }
interface VisitLims { requests: Row[]; waitingAtReception: { testOrderId: string; test: string; department: string | null }[] }

const split = (s: string): string[] => [...new Set(s.split(/[\n,;]+/).map((x) => x.trim().replace(/\s+/g, " ")).filter((x) => x.length >= 2))];

/**
 * The doctor's view of the laboratory and imaging work for one visit: where each test is, an order form (an admitted patient's tests go straight to the laboratory, an
 * emergency comes first in the queue; an outpatient's wait at reception until the patient agrees), and a way to raise the priority of a test already ordered.
 */
export function LimsVisitCard({ encounterId, visitType, active }: { encounterId: string; visitType: "OPD" | "IPD" | "EMERGENCY"; active: boolean }) {
  const { can, dateTime } = useMe();
  const refresh = useRefreshLims();
  const q = useQuery({ queryKey: ["lims-visit", encounterId], queryFn: () => api.get<VisitLims>(`/encounters/${encounterId}/lims`), enabled: can("LIMS_READ"), refetchInterval: 30_000 });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [lab, setLab] = useState("");
  const [imaging, setImaging] = useState("");
  // The tests of a patient in the emergency ward are emergency tests unless the doctor chooses otherwise.
  const baseline = visitType === "EMERGENCY" ? "EMERGENCY" : "ROUTINE";
  const [priority, setPriority] = useState(baseline);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const done = () => { refresh(); void q.refetch(); };
  const order = useMutation({
    mutationFn: () => api.post<{ routedToLab: boolean; tests: unknown[] }>("/lims/orders", {
      encounterId, priority, ...(note.trim() ? { clinicalNote: note.trim() } : {}),
      tests: [...[...picked].map((serviceId) => ({ serviceId })), ...split(lab).map((name) => ({ name, category: "LABORATORY" })), ...split(imaging).map((name) => ({ name, category: "RADIOLOGY" }))],
    }, newKey()),
    onSuccess: (r) => { setSent(r.routedToLab ? `${r.tests.length} test(s) sent to the laboratory.` : `${r.tests.length} test(s) ordered. Reception will ask the patient to agree and then send them to the laboratory.`); setPicked(new Set()); setLab(""); setImaging(""); setNote(""); setPriority(baseline); done(); },
  });
  const raise = useMutation({ mutationFn: (v: { id: string; priority: string }) => api.post(`/lims/requests/${v.id}/priority`, { priority: v.priority }, newKey()), onSuccess: done });
  if (!can("LIMS_READ")) return null;
  const rows = q.data?.requests ?? [];
  const nothing = !q.isLoading && rows.length === 0 && (q.data?.waitingAtReception.length ?? 0) === 0;
  const total = picked.size + split(lab).length + split(imaging).length;
  return (
    <Card title="Laboratory and imaging orders">
      <div className="space-y-3">
        {nothing && <p className="text-sm text-slate-500">No laboratory or imaging tests have been ordered through the laboratory system for this visit.</p>}
        {(rows.length > 0 || (q.data?.waitingAtReception.length ?? 0) > 0) && (
          <Table head={["Test", "Where it stands", "Due", ""]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>{r.test} <span className="text-xs text-slate-500">({r.requestNumber})</span> <PriorityBadge p={r.priority} /></Td>
                <Td><Badge tone={r.released ? "green" : r.needsRecollection ? "amber" : "blue"}>{r.released ? "Report issued" : stageLabel({ status: r.status, department: r.department, needsRecollection: r.needsRecollection })}</Badge>{r.critical && <> <Badge tone="red">critical</Badge></>}</Td>
                <Td className={r.delayed ? "text-red-700" : ""}>{r.released || r.status === "CANCELLED" ? "" : dateTime(r.dueAt)}{r.delayed && !r.released ? " · late" : ""}</Td>
                <Td>{can("LIMS_PRIORITY") && active && ["PENDING_COLLECTION", "COLLECTED", "IN_PROCESS", "PENDING_REVIEW"].includes(r.status) && r.priority !== "EMERGENCY" && <Button variant="secondary" loading={raise.isPending && raise.variables?.id === r.id} onClick={() => raise.mutate({ id: r.id, priority: "EMERGENCY" })}>Make emergency</Button>}</Td>
              </tr>
            ))}
            {q.data?.waitingAtReception.map((w) => <tr key={w.testOrderId}><Td>{w.test}</Td><Td><Badge tone="amber">Waiting at reception for the patient's agreement</Badge></Td><Td /><Td /></tr>)}
          </Table>
        )}
        <ErrorNote error={raise.error} />
        {can("LIMS_ORDER") && active && (
          <div className="space-y-2 rounded-md border border-slate-200 p-3">
            <p className="text-sm font-medium text-slate-800">Order tests</p>
            {visitType === "OPD" && <p className="text-xs text-slate-500">For an outpatient, reception asks the patient to agree and then sends the tests to the laboratory.</p>}
            {visitType === "EMERGENCY" && <p className="text-xs text-slate-500">An emergency patient's tests go straight to the laboratory, tagged as emergency tests, and are added to the emergency bill when the report is issued.</p>}
            <p className="text-xs text-slate-500">Choose from the hospital's test list. Each test goes to the technician of its department: pathology for laboratory tests, radiology for imaging.</p>
            <TestPicker picked={picked} onChange={setPicked} />
            <p className="text-xs text-slate-500">A test that is not on the list can be typed here (separate with commas).</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Other laboratory tests"><Textarea rows={2} value={lab} onChange={(e) => setLab(e.target.value)} placeholder="A laboratory test not on the list" /></Field>
              <Field label="Other imaging"><Textarea rows={2} value={imaging} onChange={(e) => setImaging(e.target.value)} placeholder="An imaging test not on the list" /></Field>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Priority"><Select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="ROUTINE">Routine</option>{can("LIMS_PRIORITY") && <><option value="URGENT">Urgent</option><option value="EMERGENCY">Emergency: first in the queue</option></>}</Select></Field>
              <Field label="Why (optional)" className="sm:col-span-2"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for the test, for the laboratory" /></Field>
            </div>
            {priority === "EMERGENCY" && <Notice tone="warn">An emergency comes to the top of the queue and the LIMS manager is told. Use it only when the result cannot wait.</Notice>}
            <ErrorNote error={order.error} />
            {sent && <Notice tone="success">{sent}</Notice>}
            <Button disabled={total === 0} loading={order.isPending} onClick={() => order.mutate()}>{total > 1 ? `Order ${total} tests` : "Order test"}</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
