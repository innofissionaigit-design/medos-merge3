"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { ROUND_TONE, ROUND_WORD, RoundNotesCard, SnapshotBody, type PatientSnap, type RoundRow } from "@/components/rounds";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Notice, PageHeader, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface RoundView { round: RoundRow; doctor: string; seen: number; total: number; patients: PatientSnap[] }

export default function RoundPage() {
  const { id } = useParams<{ id: string }>();
  const { dateTime } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["round", id], queryFn: () => api.get<RoundView>(`/rounds/${id}`), refetchInterval: 20_000 });
  const [open, setOpen] = useState<string | null>(null);
  const reload = () => { void qc.invalidateQueries({ queryKey: ["round", id] }); void qc.invalidateQueries({ queryKey: ["rounds-mine"] }); };
  const start = useMutation({ mutationFn: () => api.post<RoundView>(`/rounds/${id}/start`), onSuccess: (r) => { qc.setQueryData(["round", id], r); reload(); } });
  const finish = useMutation({ mutationFn: () => api.post<RoundView>(`/rounds/${id}/complete`), onSuccess: (r) => { qc.setQueryData(["round", id], r); reload(); } });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? new Error("Round not found")} />;
  const r = q.data;
  const running = r.round.status === "STARTED";
  const unseen = r.total - r.seen;
  return (
    <Gate anyOf={["ROUND_DO"]} feature="IPD_ENABLED">
      <PageHeader
        title={r.round.label} subtitle={`${r.doctor} · due ${dateTime(r.round.scheduledAt)} · ${r.seen} of ${r.total} patients seen`}
        actions={<><Badge tone={ROUND_TONE[r.round.status]}>{ROUND_WORD[r.round.status]}</Badge><Link className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href="/rounds">My rounds</Link></>}
      />
      {(r.round.status === "NOTIFIED" || r.round.status === "MISSED") && (
        <div className="mb-4 space-y-2">
          <Notice tone={r.round.status === "MISSED" ? "warn" : "info"}>{r.round.status === "MISSED" ? "This round was not started in time. You can still start it now." : "The round is due. Start it when you go to the ward."}</Notice>
          <Button loading={start.isPending} onClick={() => start.mutate()}>Start the round</Button><ErrorNote error={start.error} />
        </div>
      )}
      {running && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <ConfirmButton variant="primary" label={unseen > 0 ? `Finish the round (${unseen} not seen)` : "Finish the round"} confirmLabel="Yes, finish the round" loading={finish.isPending} onConfirm={() => finish.mutate()} />
          <ErrorNote error={finish.error} />
        </div>
      )}
      {r.round.status === "COMPLETED" && <div className="mb-4"><Notice tone="success">{`Round finished ${dateTime(r.round.completedAt)}: ${r.round.patientsSeen ?? 0} of ${r.round.patientsTotal ?? 0} patients seen.`}</Notice></div>}
      {r.patients.length === 0 ? <Card><p className="text-sm text-slate-500">You have no admitted patients.</p></Card> : (
        <div className="space-y-3">
          {r.patients.map((p) => (
            <Card key={p.admissionId} title={<span className="flex flex-wrap items-center gap-2">{p.patientName}<span className="text-xs font-normal text-slate-500">{`${p.mrn ?? ""} · ${p.admissionNumber} · ${p.ward ?? ""} ${p.bed ?? ""}`}</span>{p.seenThisRound && <Badge tone="green">seen this round</Badge>}</span>}
              actions={<span className="flex items-center gap-2"><Link className="text-sm text-brand-700 hover:underline" href={`/ipd/${p.admissionId}`}>Open the chart</Link><Button variant={open === p.admissionId ? "ghost" : "secondary"} onClick={() => setOpen(open === p.admissionId ? null : p.admissionId)}>{open === p.admissionId ? "Close" : p.seenThisRound ? "Add to the note" : "Write the note"}</Button></span>}>
              {p.reason && <p className="mb-2 text-sm text-slate-600">{p.reason}</p>}
              <SnapshotBody p={p} />
              {open === p.admissionId && <div className="mt-3"><RoundNotesCard admissionId={p.admissionId} open={r.round.status !== "COMPLETED"} roundId={id} onDone={reload} /></div>}
            </Card>
          ))}
        </div>
      )}
    </Gate>
  );
}
