"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { RegisterPatient } from "@/components/register-patient";
import { patientName, type PatientRow } from "@/components/shell";
import { Icon, PANEL, useDeskKeys } from "@/components/desk-ui";
import { Button, ErrorNote, PageHeader, Spinner, useDebounced } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";
import { ageText } from "@/lib/format";
import { useMe } from "@/lib/me";

const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
// A soft tint per patient (from the name), so rows are easy to tell apart at a glance.
const TINTS = ["bg-teal-50 text-teal-700", "bg-blue-50 text-blue-700", "bg-indigo-50 text-indigo-700", "bg-sky-50 text-sky-700", "bg-emerald-50 text-emerald-700"];
const tintOf = (name: string): string => TINTS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % TINTS.length]!;

interface MineEntry { id: string; tokenNumber: number; patientName: string; mrn: string | null; patientId?: string; encounterId?: string | null; waitingMinutes: number | null }
interface MineView { current: MineEntry | null; waiting: MineEntry[]; completed: MineEntry[] }

/**
 * For a doctor, the Patients screen opens on their own patients of the day (who is with them now, who is waiting, who they have seen), so most of the time
 * nothing needs searching. It reads the same request as the doctor's dashboard.
 */
function MyPatientsToday() {
  const t = useT();
  const view = useQuery({ queryKey: ["doctor-view"], queryFn: () => api.get<MineView>("/queue/doctor"), refetchInterval: 20_000 });
  const d = view.data;
  const groups: { label: string; tone: string; rows: MineEntry[]; visit: boolean }[] = [
    { label: "With you now", tone: "bg-blue-100 text-blue-800", rows: d?.current ? [d.current] : [], visit: true },
    { label: "Waiting", tone: "bg-teal-50 text-teal-700", rows: d?.waiting ?? [], visit: false },
    { label: "Seen today", tone: "bg-emerald-50 text-emerald-700", rows: d?.completed ?? [], visit: true },
  ];
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <section className={PANEL}>
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("My patients today")} <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{total}</span></h2><Link href="/queue" className="text-sm font-medium text-brand-600 hover:underline">{t("Open the queue")}</Link></header>
      {view.isLoading ? <div className="p-4"><Spinner /></div> : total === 0 ? <p className="px-4 py-8 text-center text-sm text-slate-500">{t("No patients of yours today yet. Search above to find any patient.")}</p> : (
        <div className="space-y-3 px-4 py-3">
          {groups.filter((g) => g.rows.length > 0).map((g) => (
            <div key={g.label}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-teal-700">{t(g.label)}</div>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100">
                {g.rows.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2.5"><span className={`inline-flex h-8 min-w-[2rem] items-center justify-center rounded-full px-2 text-sm font-semibold tabular-nums ${g.tone}`}>{e.tokenNumber}</span><span className="min-w-0 truncate"><span className="font-semibold text-slate-900">{e.patientName}</span> <span className="text-slate-400">· {e.mrn}</span>{g.label === "Waiting" && e.waitingMinutes !== null ? <span className="ml-2 text-xs text-slate-500">{e.waitingMinutes} {t("min")}</span> : null}</span></span>
                    <span className="flex shrink-0 gap-1.5">
                      {g.visit && e.encounterId && <Link href={`/visits/${e.encounterId}`} className="rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700">{t("Open visit")}</Link>}
                      {e.patientId && <Link href={`/patients/${e.patientId}`} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">{t("Open chart")}</Link>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function PatientsPage() {
  const { can, date } = useMe();
  const t = useT();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  // "Register a new patient" in the appointment booking search opens this page with the form already open.
  useEffect(() => { if (can("PATIENT_CREATE") && new URLSearchParams(window.location.search).get("register") === "1") setAdding(true); }, [can]);
  // N opens the registration form (ignored while typing or when a form is already open).
  useDeskKeys((k, e) => { if (k === "N" && can("PATIENT_CREATE") && !adding) { e.preventDefault(); setAdding(true); } });
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["patients", term], queryFn: () => api.page<PatientRow & { createdAt: string }>("/patients", { q: term, pageSize: 25 }), enabled: term.length >= 2 });
  const rows = res.data?.data ?? [];
  // A doctor sees their own patients of the day before they type anything.
  const doctorView = can("CONSULTATION_CREATE") && can("QUEUE_READ");
  return (
    <Gate anyOf={["PATIENT_READ"]}>
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
        <PageHeader title="Patients" subtitle="Search by MRN, mobile number or name" actions={can("PATIENT_CREATE") ? <Button className="gap-2 rounded-lg px-4 py-2 shadow-sm" onClick={() => setAdding(true)}><Icon name="plus" />Register patient<kbd className="rounded bg-white/20 px-1.5 text-[11px]">N</kbd></Button> : undefined} />
        <div className="relative mb-3">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"><Icon name="search" className="h-[18px] w-[18px]" /></span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Type at least 2 characters…")} aria-label="Search patients" className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-11 pr-10 text-base shadow-[0_1px_3px_rgba(15,23,42,0.06)] placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
          {q && <button type="button" aria-label={t("Clear search")} onClick={() => setQ("")} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">✕</button>}
        </div>
        {term.length < 2 && doctorView ? <MyPatientsToday /> : (
        <section className={PANEL}>
          {term.length < 2 ? (
            <div className="px-4 py-10 text-center">
              <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-teal-50 text-teal-600"><Icon name="patients" className="h-5 w-5" /></span>
              <p className="text-sm font-medium text-slate-800">{t("Start typing to find a patient.")}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs text-slate-500">
                {["Patient ID, e.g. DEMO-000203", "Mobile number", "First name"].map((x) => <span key={x} className="rounded-full bg-slate-100 px-3 py-1">{t(x)}</span>)}
              </div>
            </div>
          ) : res.isLoading ? <div className="p-4"><Spinner /></div> : (
            <>
              <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("Results")} <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{rows.length}</span></h2></header>
              <div className="px-4 py-1"><ErrorNote error={res.error} /></div>
              {rows.length === 0 ? <p className="px-4 py-8 text-center text-sm text-slate-500">{t("No patients match. Check the spelling or register a new patient.")}</p> : (
                <div className="overflow-x-auto px-4 pb-1">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400"><th className="py-2 pr-3 font-medium">{t("Name")}</th><th className="py-2 pr-3 font-medium">{t("MRN")}</th><th className="py-2 pr-3 font-medium">{t("Gender / age")}</th><th className="py-2 pr-3 font-medium">{t("Mobile")}</th><th className="hidden py-2 pr-3 font-medium md:table-cell">{t("Registered")}</th><th className="w-44" /></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((pt) => {
                        const name = patientName(pt);
                        return (
                          <tr key={pt.id} className="hover:bg-slate-50/70">
                            <td className="py-2.5 pr-3"><Link className="flex items-center gap-2.5" href={`/patients/${pt.id}`}><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${tintOf(name)}`}>{initials(name)}</span><span className="font-semibold text-slate-900 hover:text-brand-700 hover:underline">{name}</span></Link></td>
                            <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums text-slate-600">{pt.mrn}</td>
                            <td className="whitespace-nowrap py-2.5 pr-3 text-slate-700">{pt.gender.toLowerCase()}{ageText(pt.age) ? `, ${ageText(pt.age)}` : ""}</td>
                            <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums text-slate-700">{pt.mobile ?? "—"}</td>
                            <td className="hidden whitespace-nowrap py-2.5 pr-3 text-xs text-slate-500 md:table-cell">{date(pt.createdAt)}</td>
                            <td className="py-2.5 text-right">
                              <div className="flex justify-end gap-1.5">
                                {can("INVOICE_CREATE") && <Link href={`/billing?patient=${pt.id}`} className="whitespace-nowrap rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700">{t("New bill")}</Link>}
                                <Link href={`/patients/${pt.id}`} className="whitespace-nowrap rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">{t(doctorView ? "Open chart" : "Open")}</Link>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
        )}
      </div>
      {adding && <RegisterPatient onClose={() => setAdding(false)} />}
    </Gate>
  );
}
