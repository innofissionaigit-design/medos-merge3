"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { MyRoundTimes, ROUND_TONE, ROUND_WORD, type MyRounds } from "@/components/rounds";
import { Badge, Card, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

/** The doctor's rounds: the times the ward coordinator set, and today's rounds (docs/ward-rounds.md). */
export default function RoundsPage() {
  const { dateTime } = useMe();
  const q = useQuery({ queryKey: ["rounds-mine"], queryFn: () => api.get<MyRounds>("/rounds/mine"), refetchInterval: 30_000 });
  return (
    <Gate anyOf={["ROUND_DO"]} feature="IPD_ENABLED">
      <PageHeader title="My rounds" subtitle="You are told when a round time comes. Open the round, see each of your admitted patients, write a note and instructions for the nurses." />
      <div className="grid gap-4 lg:grid-cols-2">
        <MyRoundTimes />
        <Card title="Today's rounds">
          {q.isLoading ? <Spinner /> : (
            <Table head={["Round", "Time", "Status", "Patients seen", ""]} {...(q.data?.rounds.length === 0 ? { empty: "No round has come due yet today." } : {})}>
              {q.data?.rounds.map((r) => (
                <tr key={r.id}>
                  <Td>{r.label}</Td><Td>{dateTime(r.scheduledAt).split(", ").pop()}</Td><Td><Badge tone={ROUND_TONE[r.status]}>{ROUND_WORD[r.status]}</Badge></Td>
                  <Td>{r.status === "COMPLETED" ? `${r.patientsSeen ?? 0} of ${r.patientsTotal ?? 0}` : "—"}</Td>
                  <Td><Link className="text-brand-700 hover:underline" href={`/rounds/${r.id}`}>{r.status === "COMPLETED" ? "View" : r.status === "STARTED" ? "Continue" : "Start the round"}</Link></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </Gate>
  );
}
