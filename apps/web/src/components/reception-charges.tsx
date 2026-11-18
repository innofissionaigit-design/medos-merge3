"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Badge, Card, ErrorNote, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

/** One booking whose laboratory charge reception took when the patient reported (GET /lims/reception-charges). */
export interface ReceptionCharge {
  batchId: string; patientId: string; patientName: string; mrn: string | null; tests: string[]; amount: string; fromAdvance: string;
  methods: string[]; receipts: string[]; takenAt: string; takenBy: string | null;
}
export interface ReceptionCharges { date: string | null; total: string; collected: string; fromAdvance: string; count: number; rows: ReceptionCharge[] }

/** Today's lab charges taken at reception: the cashier's ledger of them, and the way the patient lists show a charge as taken (so there is no Take payment for it). */
export function useReceptionCharges(enabled = true) {
  return useQuery({ queryKey: ["reception-charges"], queryFn: () => api.get<ReceptionCharges>("/lims/reception-charges"), enabled, refetchInterval: 20_000 });
}

const MODE: Record<string, string> = { CASH: "cash", UPI: "UPI", CARD: "card", BANK_TRANSFER: "bank transfer", OTHER: "other", ADVANCE: "advance" };

/**
 * The cashier's ledger of laboratory charges that reception took when patients reported today. Each is already paid: it shows as Taken, with the amount, how it was paid,
 * the receipt and who took it, and there is no Take payment for it. A patient whose lab charge has not been taken is in the list below with Take payment beside the name.
 */
export function ReceptionChargesLedger() {
  const { money, dateTime } = useMe();
  const q = useReceptionCharges();
  const d = q.data;
  return (
    <Card title={`Lab charges taken at reception today${d && d.count > 0 ? ` (${d.count})` : ""}`}>
      {q.isLoading ? <Spinner /> : !d || d.count === 0 ? <p className="text-sm text-slate-500">Reception has not taken any lab charge today. When it does, it appears here as taken, and you are told.</p> : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="reception-charges-total">
            <span>Taken at reception: <b className="tabular-nums">{money(d.total)}</b></span>
            <span className="text-slate-600">paid now: <span className="tabular-nums">{money(d.collected)}</span></span>
            {Number(d.fromAdvance) > 0 && <span className="text-slate-600">from advances: <span className="tabular-nums">{money(d.fromAdvance)}</span></span>}
          </div>
          <Table head={["Patient", "Tests", "Status", "Amount", "Paid by", "Receipt", "Taken"]}>
            {d.rows.map((r) => (
              <tr key={r.batchId} data-testid="reception-charge">
                <Td><Link className="font-medium text-brand-700 hover:underline" href={`/patients/${r.patientId}`}>{r.patientName}</Link><div className="text-xs text-slate-500">{r.mrn}</div></Td>
                <Td>{r.tests.join(", ")}</Td>
                <Td><Badge tone="green">Taken at reception</Badge></Td>
                <Td className="tabular-nums">{money(r.amount)}</Td>
                <Td>{r.methods.map((m) => MODE[m] ?? m.toLowerCase()).join(", ")}</Td>
                <Td>{r.receipts.join(", ")}</Td>
                <Td>{dateTime(r.takenAt)}{r.takenBy ? <div className="text-xs text-slate-500">by {r.takenBy}</div> : null}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      <ErrorNote error={q.error} />
    </Card>
  );
}
