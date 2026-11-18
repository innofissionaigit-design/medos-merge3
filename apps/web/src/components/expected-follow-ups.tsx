"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Card, Select, Spinner, Table, Td } from "./ui";

interface Row { encounterId: string; visitNumber: string | null; patientId: string; patientName: string; mrn: string | null; mobile: string | null; doctor: string | null; seenOn: string; expectedDate: string; overdue: boolean; notes: string | null; booked: { startAt: string; status: string } | null }
const todayIn = (tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const plus = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const RANGES = [{ key: "week", label: "Next 7 days", back: 0, ahead: 7 }, { key: "month", label: "Next 30 days", back: 0, ahead: 30 }, { key: "missed", label: "Missed (last 30 days) and next 30 days", back: 30, ahead: 30 }];

/** The reception's expected follow-ups: patients the doctor asked to come back, with the date worked out from "after N days", and whether they are already booked. */
export function ExpectedFollowUpsCard() {
  const { can, me, date, dateTime } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const [range, setRange] = useState("week");
  const r = RANGES.find((x) => x.key === range) ?? RANGES[0]!;
  const today = todayIn(tz);
  const from = plus(today, -r.back), to = plus(today, r.ahead);
  const q = useQuery({ queryKey: ["expected-follow-ups", from, to], queryFn: () => api.get<Row[]>("/follow-ups/expected", { from, to }), enabled: can("APPOINTMENT_READ"), refetchInterval: 60_000 });
  if (!can("APPOINTMENT_READ")) return null;
  const rows = q.data ?? [];
  return (
    <Card title="Expected follow-ups" actions={<Select aria-label="Period" value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select>}>
      {q.isLoading ? <Spinner /> : (
        <Table head={["Expected on", "Patient", "Doctor", "Seen on", "Mobile", "Status"]} {...(rows.length === 0 ? { empty: "No follow-ups are expected in this period." } : {})}>
          {rows.map((f) => (
            <tr key={f.encounterId} data-testid="expected-follow-up" className="hover:bg-slate-50">
              <Td><b>{date(`${f.expectedDate}T12:00:00Z`)}</b>{f.overdue && <> <Badge tone="red">Overdue</Badge></>}</Td>
              <Td><Link className="font-medium text-brand-700 hover:underline" href={`/patients/${f.patientId}`}>{f.patientName}</Link><div className="text-xs text-slate-500">{f.mrn ?? ""}{f.notes ? ` · ${f.notes}` : ""}</div></Td>
              <Td>{f.doctor ?? "—"}</Td><Td>{date(`${f.seenOn}T12:00:00Z`)}</Td><Td>{f.mobile ?? "—"}</Td>
              <Td>{f.booked ? <Badge tone="green">{`Booked: ${dateTime(f.booked.startAt)}`}</Badge> : <Badge tone="amber">Not booked yet</Badge>}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
