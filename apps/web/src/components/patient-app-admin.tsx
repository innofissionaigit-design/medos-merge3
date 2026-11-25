"use client";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Pager, Spinner, Table, Td } from "@/components/ui";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Account {
  id: string; username: string; mobile: string; failedAttempts: number; createdAt: string; locked: boolean; lockedUntil: string | null; lastSignInAt: string | null;
  patients: { id: string; name: string; mrn: string | null }[];
}
interface Accounts { total: number; locked: number; rows: Account[] }
interface OnlinePayment { kind: "BILL" | "FEE"; receiptNumber: string; what: string; amount: string; refunded: string; method: string | null; reference: string | null; at: string; patient: { name: string; mrn: string | null }; refund: { kind: "INVOICE" | "ADVANCE"; id: string; refundable: string } | null }
interface OnlinePayments { summary: { count: number; collected: string; refunded: string }; total: number; rows: OnlinePayment[] }
const PAGE_SIZE = 10;

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub: string; tone: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <span className={clsx("absolute inset-x-0 top-0 h-1", tone)} aria-hidden />
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

/** A new temporary password for a patient who has forgotten theirs. The patient is told in person or by phone and changes it in the app. */
function ResetPassword({ account, onClose }: { account: Account; onClose: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const valid = password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
  const reset = useMutation({
    mutationFn: () => api.post<{ sessionsEnded: number }>(`/patient-app/accounts/${account.id}/reset-password`, { password }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["patient-app-accounts"] }); },
  });
  const who = account.patients[0]?.name ?? account.username;
  return (
    <Modal title="Reset the app password" onClose={onClose}>
      {reset.isSuccess ? (
        <div className="space-y-3">
          <p className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">The password for <b>{account.username}</b> is changed. {reset.data.sessionsEnded > 0 ? `${reset.data.sessionsEnded} open sign-in(s) were ended.` : "Nobody was signed in."}</p>
          <p className="text-sm text-slate-600">Tell {who} the new password in person or by phone. Do not send it in a message. They can change it in the app after signing in.</p>
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) reset.mutate(); }}>
          <p className="text-sm text-slate-600">Account <b>{account.username}</b> · mobile {account.mobile}{account.patients.length > 0 ? ` · ${account.patients.map((p) => p.name).join(", ")}` : ""}</p>
          <Field label="New temporary password"><Input type="text" autoComplete="off" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters, with a letter and a number" /></Field>
          <p className="text-xs text-slate-500">This signs the patient out everywhere and clears any lock. The change is recorded with your name.</p>
          <ErrorNote error={reset.error} />
          <div className="flex justify-end gap-2"><Button variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!valid} loading={reset.isPending}>Reset password</Button></div>
        </form>
      )}
    </Modal>
  );
}

/**
 * Gives the money of an online payment back, by the same method it came in (UPI or card). It uses the hospital's ordinary refund (a written reason, a reference, an audit
 * trail with your name), so nothing here is a second way of moving money. The most that can be given back is what has not been refunded or used yet.
 */
function RefundPayment({ payment, onClose }: { payment: OnlinePayment; onClose: () => void }) {
  const qc = useQueryClient();
  const { money } = useMe();
  const target = payment.refund as NonNullable<OnlinePayment["refund"]>;
  const method = payment.method ?? "UPI";
  const [amount, setAmount] = useState(target.refundable);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState(`RF-${payment.reference ?? payment.receiptNumber}`.slice(0, 60));
  const [sure, setSure] = useState(false);
  const n = Number(amount);
  const valid = n > 0 && n <= Number(target.refundable) && reason.trim().length >= 5 && reference.trim().length >= 4 && sure;
  const refund = useMutation({
    mutationFn: () => api.post<{ refund: { refundNumber: string } }>(`/${target.kind === "ADVANCE" ? "advances" : "invoices"}/${target.id}/refunds`, { method, amount: n.toFixed(2), reason: reason.trim(), reference: reference.trim() }, newKey()),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["patient-app-payments"] }); },
  });
  return (
    <Modal title="Refund an online payment" onClose={onClose}>
      {refund.isSuccess ? (
        <div className="space-y-3">
          <p className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">{money(n)} was refunded to {payment.patient.name} by {method}. Refund number <b>{refund.data.refund.refundNumber}</b>.</p>
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) refund.mutate(); }}>
          <p className="text-sm text-slate-600"><b>{payment.patient.name}</b> paid {money(payment.amount)} by {method} ({payment.what}), receipt {payment.receiptNumber}. Up to <b>{money(target.refundable)}</b> can be given back.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount to refund"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} /></Field>
            <Field label={`Reference (${method})`}><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
          </div>
          <Field label="Why is it being refunded?"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the patient cancelled the video visit" /></Field>
          <label className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" className="mt-0.5" checked={sure} onChange={(e) => setSure(e.target.checked)} /> <span>I confirm this money goes back to the patient. It cannot be undone.</span></label>
          <ErrorNote error={refund.error} />
          <div className="flex justify-end gap-2"><Button variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!valid} loading={refund.isPending}>Refund</Button></div>
        </form>
      )}
    </Modal>
  );
}

/**
 * Administration, Patient app: the hospital's side of the patient app. Who has an app login (and who is locked out), a way to unlock them or give a new temporary password,
 * and the money patients paid online with what has been refunded. The patient's password is never shown: only a new one can be set.
 */
export function PatientAppAdmin() {
  const { dateTime, money, can } = useMe();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [lockedOnly, setLockedOnly] = useState(false);
  const [accPage, setAccPage] = useState(1);
  const [payPage, setPayPage] = useState(1);
  const [resetting, setResetting] = useState<Account | null>(null);
  const [refunding, setRefunding] = useState<OnlinePayment | null>(null);
  const accounts = useQuery({ queryKey: ["patient-app-accounts", search, lockedOnly, accPage], queryFn: () => api.get<Accounts>("/patient-app/accounts", { ...(search.trim().length >= 2 ? { search: search.trim() } : {}), ...(lockedOnly ? { status: "LOCKED" } : {}), page: accPage, pageSize: PAGE_SIZE }), refetchInterval: 20_000 });
  const payments = useQuery({ queryKey: ["patient-app-payments", payPage], queryFn: () => api.get<OnlinePayments>("/patient-app/payments", { page: payPage, pageSize: PAGE_SIZE }), refetchInterval: 30_000 });
  const unlock = useMutation({ mutationFn: (a: Account) => api.post(`/patient-app/accounts/${a.id}/unlock`, {}), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["patient-app-accounts"] }); } });
  const rows = accounts.data?.rows ?? [];
  const pays = payments.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="App accounts" value={accounts.data ? accounts.data.total : "…"} sub="Patients with a login" tone="bg-brand-500" />
        <Stat label="Locked out" value={accounts.data ? accounts.data.locked : "…"} sub="Too many wrong passwords" tone="bg-rose-500" />
        <Stat label="Paid online" value={pays ? money(pays.summary.collected) : "…"} sub={pays ? `${pays.summary.count} payment(s) by UPI or card` : "By UPI or card"} tone="bg-emerald-500" />
        <Stat label="Refunded" value={pays ? money(pays.summary.refunded) : "…"} sub="Returned at the counter" tone="bg-amber-400" />
      </div>

      <Card title="Patient app accounts">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="w-full max-w-sm"><Field label="Find an account"><Input value={search} onChange={(e) => { setSearch(e.target.value); setAccPage(1); }} placeholder="Username, patient name or last digits of the mobile" /></Field></div>
          <label className="mb-2 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={lockedOnly} onChange={(e) => { setLockedOnly(e.target.checked); setAccPage(1); }} /> Locked out only</label>
        </div>
        {accounts.isLoading ? <Spinner /> : (
          <Table head={["Patient and username", "Mobile", "Status", "Last signed in", ""]} {...(rows.length === 0 ? { empty: lockedOnly ? "Nobody is locked out." : "No app accounts found." } : {})}>
            {rows.map((a) => (
              <tr key={a.id} data-testid="app-account">
                <Td>{a.patients.length === 0 ? <span className="text-slate-500">—</span> : a.patients.map((p) => <div key={p.id}><b>{p.name}</b>{p.mrn && <span className="ml-1 text-xs text-slate-500">{p.mrn}</span>}</div>)}<div className="max-w-[15rem] break-all font-mono text-xs text-slate-500">{a.username}</div></Td>
                <Td>{a.mobile}</Td>
                <Td>{a.locked ? <><Badge tone="red">locked</Badge>{a.lockedUntil && <div className="text-xs text-slate-500">until {dateTime(a.lockedUntil)}</div>}</> : <><Badge tone="green">active</Badge>{a.failedAttempts > 0 && <div className="text-xs text-slate-500">{a.failedAttempts} wrong try(s)</div>}</>}</Td>
                <Td>{a.lastSignInAt ? dateTime(a.lastSignInAt) : <span className="text-slate-500">never</span>}</Td>
                <Td>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {a.locked && <Button variant="secondary" className="whitespace-nowrap" loading={unlock.isPending && unlock.variables?.id === a.id} onClick={() => unlock.mutate(a)}>Unlock</Button>}
                    <Button variant="ghost" className="whitespace-nowrap" onClick={() => setResetting(a)}>Reset password…</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={accPage} pageSize={PAGE_SIZE} total={accounts.data?.total ?? 0} onPage={setAccPage} />
        <ErrorNote error={unlock.error} />
      </Card>

      <Card title="Paid online in the app">
        {payments.isLoading ? <Spinner /> : (
          <Table head={["When and receipt", "Patient", "What", "Amount", "Refunded", ""]} {...((pays?.rows.length ?? 0) === 0 ? { empty: "Nothing has been paid online yet." } : {})}>
            {pays?.rows.map((p) => (
              <tr key={`${p.kind}-${p.receiptNumber}`} data-testid="online-payment">
                <Td>{dateTime(p.at)}<div className="font-mono text-xs text-slate-500">{p.receiptNumber}</div></Td>
                <Td><b>{p.patient.name}</b>{p.patient.mrn && <div className="text-xs text-slate-500">{p.patient.mrn}</div>}</Td>
                <Td>{p.what}<div className="text-xs text-slate-500">{p.kind === "BILL" ? "Bill" : "Consultation or booking fee"}</div></Td>
                <Td><b>{money(p.amount)}</b><div className="text-xs text-slate-500">{p.method ?? "—"}</div>{p.reference && <div className="max-w-[9rem] break-all font-mono text-[11px] text-slate-400">{p.reference}</div>}</Td>
                <Td>{Number(p.refunded) > 0 ? <span className="text-amber-700">{money(p.refunded)}</span> : <span className="text-slate-400">—</span>}</Td>
                <Td>{can("PAYMENT_REFUND") && p.refund && Number(p.refund.refundable) > 0 && <Button variant="ghost" className="whitespace-nowrap" onClick={() => setRefunding(p)}>Refund…</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={payPage} pageSize={PAGE_SIZE} total={pays?.total ?? 0} onPage={setPayPage} />
        <p className="mt-3 text-xs text-slate-500">This is test-mode money: no real gateway is connected yet. A refund goes back by the same method, needs a written reason and is recorded under your name.</p>
      </Card>

      {resetting && <ResetPassword account={resetting} onClose={() => setResetting(null)} />}
      {refunding?.refund && <RefundPayment payment={refunding} onClose={() => setRefunding(null)} />}
    </div>
  );
}
