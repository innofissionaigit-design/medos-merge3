"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Spinner, Table, Td } from "./ui";

interface Delivery { id: string; channel: "EMAIL" | "WHATSAPP" | "SMS"; to: string; trigger: "AUTO" | "MANUAL"; status: "PENDING" | "SENT" | "FAILED"; attempts: number; createdAt: string; sentAt: string | null; sentForReal: boolean; error: string | null; by: string | null }
interface Config { autoSend: boolean; channels: string[]; messagesConnected: boolean; emailConnected: boolean; emailEnabled: boolean }
const LABEL: Record<string, string> = { EMAIL: "Email", WHATSAPP: "WhatsApp", SMS: "SMS" };

/** The soft copy of a bill: it is sent to the patient automatically when the bill is paid; here staff see what was sent and can send it again. */
export function BillCopyCard({ invoiceId }: { invoiceId: string }) {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const enabled = can("INVOICE_READ");
  const cfg = useQuery({ queryKey: ["bill-copy-config"], queryFn: () => api.get<Config>("/invoice-deliveries/config"), enabled });
  const list = useQuery({
    queryKey: ["bill-copies", invoiceId], queryFn: () => api.get<Delivery[]>(`/invoices/${invoiceId}/deliveries`), enabled,
    refetchInterval: (q) => ((q.state.data as Delivery[] | undefined)?.some((d) => d.status === "PENDING") ? 4_000 : 20_000),
  });
  const send = useMutation({ mutationFn: () => api.post<Delivery[]>(`/invoices/${invoiceId}/deliveries`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["bill-copies", invoiceId] }) });
  const retry = useMutation({ mutationFn: (id: string) => api.post<Delivery>(`/invoice-deliveries/${id}/retry`), onSuccess: () => qc.invalidateQueries({ queryKey: ["bill-copies", invoiceId] }) });
  if (!enabled) return null;
  const rows = list.data ?? [];
  const nothingConnected = cfg.data && !cfg.data.messagesConnected && !cfg.data.emailConnected;
  return (
    <Card title="Soft copy of the bill">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-600">
          {cfg.data?.autoSend ? "When the bill is fully paid, the patient is sent a private link to it by" : "Send the patient a private link to the bill by"} {(cfg.data?.channels ?? []).map((c) => LABEL[c] ?? c).join(", ") || "message"} (each one the patient has an address or number for).
        </p>
        <Button variant="secondary" loading={send.isPending} onClick={() => send.mutate()}>Send soft copy now</Button>
      </div>
      {nothingConnected && <p className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">No email or message service is connected yet, so nothing leaves the server: each copy is only recorded as “not sent for real”.</p>}
      <ErrorNote error={send.error ?? retry.error} />
      {list.isLoading ? <Spinner /> : rows.length === 0 ? <p className="mt-3 text-xs text-slate-500">Nothing sent yet.</p> : (
        <Table head={["Channel", "To", "How", "Status", "When"]}>
          {rows.map((d) => (
            <tr key={d.id} data-testid="bill-copy-row">
              <Td>{LABEL[d.channel] ?? d.channel}</Td><Td>{d.to}</Td><Td>{d.trigger === "AUTO" ? "After payment" : `By ${d.by ?? "staff"}`}</Td>
              <Td>
                {d.status === "SENT" ? <Badge tone={d.sentForReal ? "green" : "amber"}>{d.sentForReal ? "Sent" : "Recorded, not sent for real"}</Badge> : d.status === "PENDING" ? <Badge tone="amber">Sending…</Badge> : (
                  <span className="flex flex-wrap items-center gap-2"><Badge tone="red">Failed</Badge><span className="text-xs text-slate-500">{d.error}</span><button className="text-xs text-brand-700 underline" onClick={() => retry.mutate(d.id)}>Try again</button></span>
                )}
              </Td>
              <Td>{dateTime(d.sentAt ?? d.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
