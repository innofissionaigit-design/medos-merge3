"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Input, Spinner, Table, Td } from "./ui";

export interface RequestRow { mode?: string; paidOnline?: { amount: string; receipt: string | null } | null; id: string; patientId: string; patient: string; mrn: string | null; mobile: string | null; doctor: string | null; practitionerId: string | null; preferredDate: string; timeOfDay: string; reason: string; status: string }

/** Appointment requests from the patient app: the front desk books the appointment the usual way, then answers here so the patient sees it. */
export function AppointmentRequestsCard({ onBook }: { onBook?: (r: RequestRow) => void }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["appointment-requests"], queryFn: () => api.get<{ items: RequestRow[] }>("/appointment-requests", { status: "PENDING", pageSize: 50 }), enabled: can("APPOINTMENT_READ"), refetchInterval: 30_000 });
  const [note, setNote] = useState<Record<string, string>>({});
  const answer = useMutation({
    mutationFn: (a: { id: string; decision: "BOOKED" | "DECLINED" }) => api.post(`/appointment-requests/${a.id}/answer`, { decision: a.decision, ...(note[a.id]?.trim() ? { note: note[a.id]!.trim() } : {}) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["appointment-requests"] }); },
  });
  if (!can("APPOINTMENT_READ") || !q.data || q.data.items.length === 0) return null;
  return (
    <Card title="Requests from the patient app">
      <ErrorNote error={answer.error} />
      {q.isLoading ? <Spinner /> : (
        <Table head={["Patient", "Wants", "Reason", "Your answer to them", ""]}>
          {q.data.items.map((r) => (
            <tr key={r.id}>
              <Td><span className="font-medium">{r.patient}</span><div className="text-xs text-slate-500">{r.mrn} · {r.mobile}</div></Td>
              <Td>{r.preferredDate}<div className="text-xs text-slate-500">{r.timeOfDay.toLowerCase()}{r.doctor ? ` · ${r.doctor}` : ""}</div></Td><Td>{r.mode === "VIDEO" && <span className="mr-1.5 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">Video</span>}{r.reason}{r.paidOnline && <div className="mt-1 inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">Paid ₹{r.paidOnline.amount} online{r.paidOnline.receipt ? ` · ${r.paidOnline.receipt}` : ""}</div>}</Td>
              <Td><Input aria-label="Answer" placeholder="e.g. Booked for Tuesday 10:30" value={note[r.id] ?? ""} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} /></Td>
              <Td className="whitespace-nowrap">{onBook && <Button onClick={() => onBook(r)}>Book a time</Button>} <Button variant={onBook ? "secondary" : "primary"} loading={answer.isPending && answer.variables?.id === r.id} onClick={() => answer.mutate({ id: r.id, decision: "BOOKED" })}>Already booked</Button> <Button variant="secondary" disabled={(note[r.id]?.trim().length ?? 0) < 3} onClick={() => answer.mutate({ id: r.id, decision: "DECLINED" })}>Decline</Button></Td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-2 text-xs text-slate-500"><Badge tone="blue">tip</Badge> Press Book a time to pick a free time for the patient's day and part of the day; the patient is told automatically. If you booked it another way, press Already booked and write the time. A decline needs a reason the patient can read.</p>
    </Card>
  );
}
