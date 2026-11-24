"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { PriorityBadge, stageLabel, useRefreshLims } from "./lims-common";
import { TestPicker } from "./lims-picker";
import { Badge, Button, ErrorNote, Field, Input, Notice, Table, Td, Textarea } from "./ui";

interface Row { id: string; requestNumber: string; test: string; department: "PATHOLOGY" | "RADIOLOGY"; status: string; priority: "EMERGENCY" | "URGENT" | "ROUTINE"; dueAt: string; delayed: boolean; released: boolean; critical: boolean; needsRecollection: boolean }
interface VisitLims { requests: Row[]; waitingAtReception: { testOrderId: string; test: string; department: string | null }[] }

const split = (s: string): string[] => [...new Set(s.split(/[\n,;]+/).map((x) => x.trim().replace(/\s+/g, " ")).filter((x) => x.length >= 2))];

/**
 * The doctor's view of the laboratory and imaging work for one visit: where each test is, an order form (an admitted patient's tests go straight to the laboratory, an
 * emergency comes first in the queue; an outpatient's wait at reception until the patient agrees), and a way to raise the priority of a test already ordered.
 */
export function LimsVisitCard({ encounterId, visitType, active }: { encounterId: string; visitType: "OPD" | "IPD" | "EMERGENCY"; active: boolean }) {
  const { can, dateTime, features } = useMe();
  // With "Tests advised" switched off, an outpatient's tests are not sent through reception: the patient registers for tests at the lab desk instead.
  const viaReception = visitType === "OPD" && !features.LIMS_TESTS_ADVISED_ENABLED;
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
  const waiting = viaReception ? [] : q.data?.waitingAtReception ?? [];
  const nothing = !q.isLoading && rows.length === 0 && waiting.length === 0;
  const total = picked.size + split(lab).length + split(imaging).length;
  const CARD = "rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_4px_16px_-8px_rgba(16,24,40,0.08)]";
  const PRIORITIES = [["ROUTINE", "Routine", "Normal queue"], ...(can("LIMS_PRIORITY") ? [["URGENT", "Urgent", "Ahead of routine"], ["EMERGENCY", "Emergency", "First in the queue"]] : [])] as [string, string, string][];
  const PRI_TONE: Record<string, string> = { ROUTINE: "has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50", URGENT: "has-[:checked]:border-amber-500 has-[:checked]:bg-amber-50", EMERGENCY: "has-[:checked]:border-red-500 has-[:checked]:bg-red-50" };
  return (
    <section className={CARD} aria-label="Laboratory and imaging orders">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-6 py-4">
        <div><h2 className="text-base font-semibold tracking-tight text-slate-900">Laboratory and imaging orders</h2><p className="text-xs text-slate-500">Order tests and follow each one until its report is issued.</p></div>
        {rows.length + waiting.length > 0 && <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-200">{rows.length + waiting.length} ordered</span>}
      </header>
      <div className="space-y-5 p-6">
        {nothing && <div className="flex items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-4 py-3.5 text-sm text-slate-600"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-slate-400 ring-1 ring-slate-200" aria-hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M9 3h6M10 3v6.2L5.2 17.4A2.5 2.5 0 0 0 7.4 21h9.2a2.5 2.5 0 0 0 2.2-3.6L14 9.2V3" /></svg></span>No laboratory or imaging tests have been ordered through the laboratory system for this visit.</div>}
        {(rows.length > 0 || waiting.length > 0) && (
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <Table head={["Test", "Where it stands", "Due", ""]}>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td>{r.test} <span className="text-xs text-slate-500">({r.requestNumber})</span> <PriorityBadge p={r.priority} /></Td>
                  <Td><Badge tone={r.released ? "green" : r.needsRecollection ? "amber" : "blue"}>{r.released ? "Report issued" : stageLabel({ status: r.status, department: r.department, needsRecollection: r.needsRecollection })}</Badge>{r.critical && <> <Badge tone="red">critical</Badge></>}</Td>
                  <Td className={r.delayed ? "text-red-700" : ""}>{r.released || r.status === "CANCELLED" ? "" : dateTime(r.dueAt)}{r.delayed && !r.released ? " · late" : ""}</Td>
                  <Td>{can("LIMS_PRIORITY") && active && ["PENDING_COLLECTION", "COLLECTED", "IN_PROCESS", "PENDING_REVIEW"].includes(r.status) && r.priority !== "EMERGENCY" && <Button variant="secondary" loading={raise.isPending && raise.variables?.id === r.id} onClick={() => raise.mutate({ id: r.id, priority: "EMERGENCY" })}>Make emergency</Button>}</Td>
                </tr>
              ))}
              {waiting.map((w) => <tr key={w.testOrderId}><Td>{w.test}</Td><Td><Badge tone="amber">Waiting at reception for the patient's agreement</Badge></Td><Td /><Td /></tr>)}
            </Table>
          </div>
        )}
        <ErrorNote error={raise.error} />
        {viaReception && can("LIMS_ORDER") && active && <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600">For an outpatient, write the tests on the prescription. The patient registers for them at the lab desk.</p>}
        {can("LIMS_ORDER") && active && !viaReception && (
          <div className="space-y-6 rounded-2xl border border-slate-200 bg-slate-50/40 p-5">
            <div>
              <p className="text-sm font-semibold text-slate-900">Order tests</p>
              <div className="mt-1 space-y-0.5 text-xs text-slate-500">
                {visitType === "OPD" && <p>For an outpatient, reception asks the patient to agree and then sends the tests to the laboratory.</p>}
                {visitType === "EMERGENCY" && <p>An emergency patient's tests go straight to the laboratory, tagged as emergency tests, and are added to the emergency bill when the report is issued.</p>}
                <p>Choose from the hospital's test list. Each test goes to the technician of its department: pathology for laboratory tests, radiology for imaging.</p>
              </div>
            </div>
            <TestPicker picked={picked} onChange={setPicked} />
            <details className="group rounded-xl border border-slate-200 bg-white" open={lab.length > 0 || imaging.length > 0}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden"><span>Not on the list? Type another test</span><span className="text-xs text-blue-600 group-open:hidden">Add</span><span className="hidden text-xs text-blue-600 group-open:inline">Hide</span></summary>
              <div className="border-t border-slate-100 p-4">
                <p className="mb-3 text-xs text-slate-500">A test that is not on the list can be typed here (separate with commas).</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Other laboratory tests"><Textarea rows={2} value={lab} onChange={(e) => setLab(e.target.value)} placeholder="A laboratory test not on the list" /></Field>
                  <Field label="Other imaging"><Textarea rows={2} value={imaging} onChange={(e) => setImaging(e.target.value)} placeholder="An imaging test not on the list" /></Field>
                </div>
              </div>
            </details>
            <div className="space-y-3">
              <div role="radiogroup" aria-label="Priority">
                <p className="mb-1.5 text-sm font-medium text-slate-700">Priority</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {PRIORITIES.map(([v, label, hint]) => (
                    <label key={v} className={`flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 transition hover:border-slate-300 ${PRI_TONE[v] ?? ""}`}>
                      <input type="radio" name="lims-priority" className="h-4 w-4 text-blue-600 focus:ring-blue-500" checked={priority === v} onChange={() => setPriority(v)} />
                      <span><span className="block text-sm font-semibold text-slate-800">{label}</span><span className="block text-xs text-slate-500">{hint}</span></span>
                    </label>
                  ))}
                </div>
              </div>
              <Field label="Why (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for the test, for the laboratory" /></Field>
            </div>
            {priority === "EMERGENCY" && <Notice tone="warn">An emergency comes to the top of the queue and the LIMS manager is told. Use it only when the result cannot wait.</Notice>}
            <ErrorNote error={order.error} />
            {sent && <Notice tone="success">{sent}</Notice>}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
              <span className="text-sm text-slate-500">{total === 0 ? "No tests chosen yet" : `${total} ${total === 1 ? "test" : "tests"} ready to order`}</span>
              <Button className="rounded-xl px-5" disabled={total === 0} loading={order.isPending} onClick={() => order.mutate()}>{total > 1 ? `Order ${total} tests` : "Order test"}</Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
