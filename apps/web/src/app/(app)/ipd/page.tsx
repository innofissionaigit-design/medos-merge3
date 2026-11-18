"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Gate } from "@/components/gate";
import { PatientPicker, useAvailableBeds, type PickedPatient } from "@/components/pickers";
import { Badge, Button, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge } from "@/components/ui";
import { Icon, type IconName, PANEL } from "@/components/desk-ui";
import { api, newKey } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Bed { id: string; code: string; status: string; dailyRate: string; occupant: { admissionId: string; admissionNumber: string; patientName: string; mrn: string | null; since: string; awaitingDeparture?: boolean } | null }
interface Board { wards: { id: string; name: string; rooms: { id: string; name: string; beds: Bed[] }[] }[]; summary: Record<string, number> }
interface AdmissionRow { id: string; admissionNumber: string; patientName: string; mrn: string | null; consultantName: string; reason: string | null; admittedAt: string; lengthOfStayDays: number; bed: { code: string; ward: string; room: string } | null; status: string }

/** Each bed state has one muted colour: a left edge, a soft tint and a dot, so the board reads at a glance. */
const BED_STYLE: Record<string, { card: string; dot: string }> = {
  AVAILABLE: { card: "border-l-emerald-500 bg-emerald-50/50", dot: "bg-emerald-500" },
  OCCUPIED: { card: "border-l-blue-500 bg-blue-50/50", dot: "bg-blue-500" },
  CLEANING: { card: "border-l-amber-500 bg-amber-50/60", dot: "bg-amber-500" },
  RESERVED: { card: "border-l-indigo-400 bg-indigo-50/50", dot: "bg-indigo-400" },
  MAINTENANCE: { card: "border-l-slate-400 bg-slate-100/70 text-slate-500", dot: "bg-slate-400" },
};
const STATUS_FILTERS: [string, string][] = [["", "All"], ["AVAILABLE", "Available"], ["OCCUPIED", "Occupied"], ["CLEANING", "Cleaning"], ["RESERVED", "Reserved"], ["MAINTENANCE", "Maintenance"]];

function Admit({ initial, onClose }: { initial: PickedPatient | null; onClose: () => void }) {
  const router = useRouter();
  const { money } = useMe();
  const [patient, setPatient] = useState<PickedPatient | null>(initial);
  const [doc, setDoc] = useState("");
  const [bed, setBed] = useState("");
  const [reason, setReason] = useState("");
  const [key] = useState(newKey);
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<{ id: string; displayName: string }[]>("/practitioners") });
  const beds = useAvailableBeds();
  const m = useMutation({ mutationFn: () => api.post<{ id: string }>("/admissions", { patientId: patient!.id, consultantId: doc, bedId: bed, ...(reason ? { reason } : {}) }, key), onSuccess: (a) => router.push(`/ipd/${a.id}`) });
  return (
    <Modal title="Admit patient" onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field as="div" label="Patient"><PatientPicker value={patient} onPick={setPatient} autoFocus={!initial} /></Field></div>
        <Field label="Consultant"><Select value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">Choose…</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select></Field>
        <Field label="Bed"><Select value={bed} onChange={(e) => setBed(e.target.value)}><option value="">Choose an available bed…</option>{beds.data?.map((b) => <option key={b.id} value={b.id}>{b.label} — {money(b.dailyRate)}/day</option>)}</Select></Field>
        <div className="sm:col-span-2"><Field label="Reason for admission"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
        <div className="sm:col-span-2"><ErrorNote error={m.error} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!patient || !doc || !bed} loading={m.isPending} onClick={() => m.mutate()}>Admit</Button></div>
      </div>
    </Modal>
  );
}

function IpdInner() {
  const { can, dateTime } = useMe();
  const t = useT();
  const qc = useQueryClient();
  const params = useSearchParams();
  const pre = params.get("admit");
  const [tab, setTab] = useState<"board" | "list">("board");
  const [admit, setAdmit] = useState(!!pre);
  const planned = useQuery({ queryKey: ["planned-summary"], queryFn: () => api.get<{ open: number; counts: Record<string, number> }>("/planned-admissions/summary"), enabled: can("PLANNED_READ"), refetchInterval: 30_000 });
  const [stateFilter, setStateFilter] = useState("");
  const [find, setFind] = useState("");
  const preP = useQuery({ queryKey: ["pre-patient", pre], queryFn: () => api.get<{ id: string; mrn: string | null; firstName: string; lastName: string | null }>(`/patients/${pre}`), enabled: !!pre });
  // The board is read on both tabs: its counts head the page, and it refreshes by itself.
  const board = useQuery({ queryKey: ["board"], queryFn: () => api.get<Board>("/beds/board"), refetchInterval: 30_000 });
  const list = useQuery({ queryKey: ["admissions"], queryFn: () => api.page<AdmissionRow>("/admissions", { status: "ADMITTED", pageSize: 100 }), enabled: tab === "list" });
  const setStatus = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api.post(`/beds/${id}/status`, { status }), onSuccess: () => qc.invalidateQueries({ queryKey: ["board"] }) });
  const sum = board.data?.summary ?? {};
  const total = sum["total"] ?? 0;
  const occupied = sum["OCCUPIED"] ?? sum["occupied"] ?? 0;
  const needle = find.trim().toLowerCase();
  const bedShown = (b: Bed): boolean => (!stateFilter || b.status === stateFilter) && (!needle || `${b.code} ${b.occupant?.patientName ?? ""} ${b.occupant?.mrn ?? ""}`.toLowerCase().includes(needle));
  const tiles: { label: string; value: string; tone: string; icon: IconName }[] = [
    { label: "Total beds", value: String(total), tone: "bg-slate-100 text-slate-600", icon: "bed" },
    { label: "Available", value: String(sum["AVAILABLE"] ?? sum["available"] ?? 0), tone: "bg-emerald-50 text-emerald-700", icon: "check" },
    { label: "Occupied", value: String(occupied), tone: "bg-blue-50 text-blue-700", icon: "users" },
    { label: "Cleaning / maintenance", value: String((sum["CLEANING"] ?? sum["cleaning"] ?? 0) + (sum["MAINTENANCE"] ?? sum["maintenance"] ?? 0)), tone: "bg-amber-50 text-amber-700", icon: "alert" },
  ];
  const nav = "rounded-md px-3 py-1.5 text-sm font-medium transition";
  return (
    <Gate anyOf={["ADMISSION_READ"]} feature="IPD_ENABLED">
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
        <PageHeader title="Admissions and beds" subtitle={total ? `${occupied} of ${total} beds occupied (${Math.round((occupied / total) * 100)}%)` : undefined} actions={<>{can("PLANNED_READ") && <Link href="/planned" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50">{`${t("Planned admissions")}${planned.data ? ` (${planned.data.counts.READY ?? 0} ready, ${planned.data.open} open)` : ""}`}</Link>}{can("ADMISSION_CREATE") && <Button className="gap-2 rounded-lg px-4 py-2 shadow-sm" onClick={() => setAdmit(true)}><Icon name="plus" />Admit patient</Button>}</>} />
        <div className="mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {tiles.map((x) => (
            <div key={x.label} className={`${PANEL} flex items-center gap-2.5 px-3.5 py-2`}>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${x.tone}`}><Icon name={x.icon} /></span>
              <div className="min-w-0">
                <div className="text-[10.5px] font-medium uppercase leading-tight tracking-wider text-slate-500">{t(x.label)}</div>
                <div className="text-lg font-semibold tabular-nums leading-tight text-slate-900">{board.data ? x.value : "—"}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5" role="tablist">
            {([["board", "Bed board"], ["list", "Admitted patients"]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`${nav} ${tab === id ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{t(label)}</button>)}
          </div>
          {tab === "board" && (
            <div className="flex flex-wrap gap-1" role="group" aria-label={t("Bed status")}>
              {STATUS_FILTERS.map(([v, label]) => (
                <button key={v} type="button" aria-pressed={stateFilter === v} onClick={() => setStateFilter(v)} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${stateFilter === v ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
                  {v && <span className={`h-2 w-2 rounded-full ${BED_STYLE[v]?.dot}`} />}{t(label)}{v ? <span className="tabular-nums text-slate-500">{sum[v] ?? sum[v.toLowerCase()] ?? 0}</span> : null}
                </button>
              ))}
            </div>
          )}
          <div className="ml-auto w-56"><Input aria-label="Find a bed or patient" placeholder="Bed, patient or ID" value={find} onChange={(e) => setFind(e.target.value)} /></div>
        </div>
        {tab === "board" && (board.isLoading ? <Spinner /> : board.data && (
          <div className="space-y-3">
            <ErrorNote error={setStatus.error} />
            {board.data.wards.map((w) => {
              const rooms = w.rooms.map((r) => ({ ...r, beds: r.beds.filter(bedShown) })).filter((r) => r.beds.length > 0);
              if (rooms.length === 0) return null;
              return (
                <section key={w.id} className={PANEL}>
                  <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{w.name}</h2><span className="text-xs text-slate-500">{rooms.reduce((n, r) => n + r.beds.length, 0)} {t("beds")}</span></header>
                  <div className="space-y-3 p-3">
                    {rooms.map((r) => (
                      <div key={r.id}>
                        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-teal-700">{r.name}</div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                          {r.beds.map((b) => (
                            <div key={b.id} className={clsx("rounded-lg border border-l-4 border-slate-200 p-2.5 text-sm", BED_STYLE[b.status]?.card)}>
                              <div className="flex items-center justify-between"><span className="font-semibold text-slate-900">{b.code}</span><StatusBadge value={b.status} /></div>
                              {b.occupant ? <Link href={`/ipd/${b.occupant.admissionId}`} className="mt-1 block font-medium text-slate-900 hover:text-brand-700 hover:underline">{b.occupant.patientName}<div className="text-xs font-normal text-slate-500">{b.occupant.mrn} · {t("since")} {dateTime(b.occupant.since)}</div>{b.occupant.awaitingDeparture && <div className="mt-0.5"><Badge tone="amber">discharged, awaiting departure</Badge></div>}</Link> : null}
                              {b.status === "CLEANING" && can("NURSING_DOCUMENT", "ADMIN_MASTERS") && <button className="mt-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setStatus.mutate({ id: b.id, status: "AVAILABLE" })}>Mark clean</button>}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
            {board.data.wards.every((w) => w.rooms.every((r) => r.beds.filter(bedShown).length === 0)) && <p className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">{t("No beds match.")}</p>}
          </div>
        ))}
        {tab === "list" && (
          <section className={PANEL}>
            {list.isLoading ? <div className="p-4"><Spinner /></div> : (() => {
              const all = list.data?.data ?? [];
              const rows = needle ? all.filter((a) => `${a.patientName} ${a.mrn ?? ""} ${a.admissionNumber} ${a.consultantName} ${a.bed?.code ?? ""}`.toLowerCase().includes(needle)) : all;
              return rows.length === 0 ? <p className="px-4 py-8 text-center text-sm text-slate-500">{t(needle ? "No patients match." : "No patients are currently admitted.")}</p> : (
                <div className="overflow-x-auto px-4 pb-1">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-500"><th className="py-2 pr-3 font-medium">{t("Patient")}</th><th className="py-2 pr-3 font-medium">{t("Admission")}</th><th className="py-2 pr-3 font-medium">{t("Bed")}</th><th className="py-2 pr-3 font-medium">{t("Consultant")}</th><th className="py-2 pr-3 text-right font-medium">{t("Stay")}</th><th className="py-2 font-medium">{t("Reason")}</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((a) => (
                        <tr key={a.id} className="align-top hover:bg-slate-50/70">
                          <td className="py-2.5 pr-3"><Link className="font-semibold text-slate-900 hover:text-brand-700 hover:underline" href={`/ipd/${a.id}`}>{a.patientName}</Link><div className="text-xs text-slate-500">{a.mrn}</div></td>
                          <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums">{a.admissionNumber}<div className="text-xs text-slate-500">{dateTime(a.admittedAt)}</div></td>
                          <td className="whitespace-nowrap py-2.5 pr-3">{a.bed ? <><span className="font-medium">{a.bed.code}</span><div className="text-xs text-slate-500">{a.bed.ward}</div></> : "—"}</td>
                          <td className="py-2.5 pr-3 text-slate-700">{a.consultantName}</td>
                          <td className="whitespace-nowrap py-2.5 pr-3 text-right tabular-nums">{a.lengthOfStayDays} d</td>
                          <td className="py-2.5 text-slate-600">{a.reason ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </section>
        )}
      </div>
      {admit && <Admit initial={preP.data ? { id: preP.data.id, mrn: preP.data.mrn, name: [preP.data.firstName, preP.data.lastName].filter(Boolean).join(" ") } : null} onClose={() => setAdmit(false)} />}
    </Gate>
  );
}

export default function IpdPage() { return <Suspense fallback={<Spinner />}><IpdInner /></Suspense>; }
