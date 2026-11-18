"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Card, Input, Spinner, Table, Td } from "./ui";

interface Row { encounterId: string; visitNumber: string | null; token: number | null; takenAt: string; patientId: string; patientName: string; mrn: string | null; doctor: string | null; status: "NOT_BILLED" | "UNPAID" | "PART_PAID" | "PAID"; total: string; paid: string; due: string; invoiceId: string | null }
interface Ledger { date: string; rows: Row[]; totals: { visits: number; notBilled: number; toCollect: number; billed: string; collected: string; outstanding: string } }
const todayIn = (tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** The cashier's ledger of the OPD visits reception took: reception takes no money, the cashier makes the bill and collects here. */
export function OpdLedgerCard() {
  const { can, me, money, dateTime } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const [day, setDay] = useState(todayIn(tz));
  const q = useQuery({ queryKey: ["opd-ledger", day], queryFn: () => api.get<Ledger>("/opd-ledger", { date: day }), enabled: can("INVOICE_READ"), refetchInterval: 15_000 });
  const t = q.data?.totals;
  return (
    <Card title="OPD visits taken" actions={<Input type="date" aria-label="Day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />}>
      {q.isLoading ? <Spinner /> : (
        <>
          {t && (
            <p className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600" data-testid="opd-ledger-totals">
              <span><b>{t.visits}</b> visits</span><span><b>{t.notBilled}</b> to bill</span><span><b>{t.toCollect}</b> to collect</span>
              <span>Billed {money(t.billed)}</span><span>Collected {money(t.collected)}</span><span className={Number(t.outstanding) > 0 ? "font-medium text-red-700" : ""}>Outstanding {money(t.outstanding)}</span>
            </p>
          )}
          <Table head={["Token", "Patient", "Doctor", "Taken at", "Bill", "Status", ""]} {...(q.data?.rows.length === 0 ? { empty: "No OPD visits were taken on this day." } : {})}>
            {q.data?.rows.map((r) => (
              <tr key={r.encounterId} data-testid="opd-ledger-row" className="hover:bg-slate-50">
                <Td>{r.token ?? "—"}</Td>
                <Td><b>{r.patientName}</b><div className="text-xs text-slate-500">{r.mrn ?? ""} {r.visitNumber ? `· ${r.visitNumber}` : ""}</div></Td>
                <Td>{r.doctor ?? "—"}</Td><Td>{dateTime(r.takenAt)}</Td>
                <Td>{r.status === "NOT_BILLED" ? "—" : <>{money(r.total)}{Number(r.due) > 0 && <div className="text-xs text-red-700">due {money(r.due)}</div>}</>}</Td>
                <Td><Badge tone={r.status === "PAID" ? "green" : r.status === "NOT_BILLED" ? "gray" : "amber"}>{r.status === "PAID" ? "Paid" : r.status === "NOT_BILLED" ? "To bill" : r.status === "PART_PAID" ? "Part paid" : "To collect"}</Badge></Td>
                <Td>
                  {r.status === "NOT_BILLED" && can("INVOICE_CREATE") ? <Link className="font-medium text-brand-700 hover:underline" href={`/billing?patient=${r.patientId}`}>Make bill</Link>
                    : r.invoiceId ? <Link className="font-medium text-brand-700 hover:underline" href={`/billing/${r.invoiceId}`}>{r.status === "PAID" ? "View bill" : "Collect payment"}</Link> : null}
                </Td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </Card>
  );
}
