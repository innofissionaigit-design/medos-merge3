"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Badge, Card, ErrorNote, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Adm { id: string; admissionNumber: string; patientName: string; mrn: string | null; consultantName: string; reason: string | null; lengthOfStayDays: number; bed: { code: string; ward: string } | null }
interface DischargeView { steps: { step: string; status: string }[]; summary?: { status: string; hisStatus: string } }
type View = "ALL" | "FIT" | "WRITE" | "VERIFY" | "DONE";

const TILES: { id: View; label: string; sub: string; tone: string; icon: "users" | "door" | "pen" | "check" | "shield"; empty: string }[] = [
  { id: "ALL", label: "My patients", sub: "Admitted in my wards", tone: "bg-brand-500", icon: "users", empty: "No patient is admitted in your wards." },
  { id: "FIT", label: "Advised to go home", sub: "Doctor says fit for discharge", tone: "bg-amber-500", icon: "door", empty: "No patient has been advised to go home yet." },
  { id: "WRITE", label: "Summary to write", sub: "Discharge summary not signed", tone: "bg-violet-500", icon: "pen", empty: "No discharge summary is waiting to be written." },
  { id: "VERIFY", label: "To verify", sub: "Signed, waiting for you", tone: "bg-emerald-500", icon: "shield", empty: "No signed summary is waiting for your verification." },
];

function Icon({ name }: { name: "users" | "door" | "pen" | "check" | "shield" }) {
  const d: Record<string, ReactNode> = {
    users: <><circle cx="9" cy="8" r="3.200" /><path d="M3.500 19c0-3 2.500-5 5.500-5s5.500 2 5.500 5M16 5.500a3 3 0 0 1 0 5.500M18 14.500c1.700.7 2.700 2.200 2.700 4.500" /></>,
    door: <path d="M6 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M4 20h16M13 12v.01" />,
    pen: <path d="M4 20h4L19 9a2.800 2.800 0 0 0-4-4L4 16zM13.500 6.500l4 4" />,
    check: <path d="m5 12.500 4.500 4.500L19 7.500" />,
    shield: <path d="M12 3.500 5 6v5.500c0 4.200 2.800 7.200 7 9 4.200-1.800 7-4.800 7-9V6zM9 12l2.200 2.200L15.500 10" />,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d[name]}</svg>;
}

/** Where the discharge stands for one patient, as the RMO sees it. */
function stateOf(d: DischargeView | undefined): { fit: boolean; summary: string } {
  return { fit: d?.steps.find((s) => s.step === "MEDICALLY_FIT")?.status === "CLEARED", summary: d?.summary?.status ?? "NOT_STARTED" };
}

function badge(fit: boolean, summary: string): { tone: "gray" | "amber" | "blue" | "green" | "red"; label: string; action: string } {
  if (summary === "VERIFIED") return { tone: "green", label: "Summary verified", action: "Open" };
  if (summary === "SIGNED" || summary === "AMENDED") return { tone: "blue", label: "Verify the summary", action: "Verify" };
  if (summary === "DRAFT") return { tone: "amber", label: "Draft written, to be signed", action: "Open the summary" };
  if (fit) return { tone: "amber", label: "Write the summary", action: "Write summary" };
  return { tone: "gray", label: "In treatment", action: "Open" };
}

/**
 * The resident medical officer's start screen: the patients in the wards they cover, who the doctor has advised to go home, which discharge summaries still have to be written,
 * and which signed ones are waiting for the RMO's verification. The summary itself is written, signed and verified on the admission's Discharge tab.
 */
export function RmoDashboard() {
  const t = useT();
  const { me, dateTime } = useMe();
  const [view, setView] = useState<View>("ALL");
  const list = useQuery({ queryKey: ["rmo-admissions"], queryFn: () => api.get<Adm[]>("/admissions", { status: "ADMITTED", pageSize: 100 }), refetchInterval: 30_000 });
  const adms = list.data ?? [];
  const status = useQueries({ queries: adms.map((a) => ({ queryKey: ["rmo-discharge", a.id], queryFn: () => api.get<DischargeView>(`/admissions/${a.id}/discharge`), staleTime: 15_000, refetchInterval: 30_000 })) });
  const rows = adms.map((a, i) => ({ a, ...stateOf(status[i]?.data), loaded: !!status[i]?.data }));
  const count = (v: View) => rows.filter((r) => (v === "ALL" ? true : v === "FIT" ? r.fit : v === "WRITE" ? r.fit && ["NOT_STARTED", "DRAFT"].includes(r.summary) : v === "VERIFY" ? ["SIGNED", "AMENDED"].includes(r.summary) : r.summary === "VERIFIED")).length;
  const shown = rows.filter((r) => (view === "ALL" ? true : view === "FIT" ? r.fit : view === "WRITE" ? r.fit && ["NOT_STARTED", "DRAFT"].includes(r.summary) : view === "VERIFY" ? ["SIGNED", "AMENDED"].includes(r.summary) : r.summary === "VERIFIED"));
  const tile = TILES.find((x) => x.id === view)!;
  const verify = count("VERIFY");
  const loading = status.some((s) => s.isLoading);
  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{`${t("Welcome")}, ${me.fullName}`}</h1>
          <p className="text-sm text-slate-500">{`${me.tenant.name} · ${t("Resident medical officer")} · ${dateTime(new Date().toISOString())}`}</p>
        </div>
        <Link className="whitespace-nowrap rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700" href="/ipd">{t("All admissions")}</Link>
      </div>
      <ErrorNote error={list.error} />

      {verify > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900" role="status">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700"><Icon name="shield" /></span>
          <span><b>{verify === 1 ? "1 signed discharge summary is waiting for your verification." : `${verify} signed discharge summaries are waiting for your verification.`}</b></span>
          <button type="button" className="ml-auto whitespace-nowrap rounded-md border border-blue-300 bg-white px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50" onClick={() => setView("VERIFY")}>{t("Show them")}</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TILES.map((c) => {
          const n = c.id === "ALL" ? adms.length : count(c.id);
          const active = view === c.id;
          return (
            <button key={c.id} type="button" onClick={() => setView(c.id)} aria-pressed={active} className={clsx("group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200")}>
              <span className={clsx("absolute inset-x-0 top-0 h-1", c.tone)} aria-hidden />
              <span className="flex items-center justify-between gap-2 text-slate-500"><span className="text-xs font-medium uppercase tracking-wide">{t(c.label)}</span><span className={clsx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", active ? "bg-brand-50 text-brand-700" : "bg-slate-50 group-hover:bg-slate-100")}><Icon name={c.icon} /></span></span>
              <span className="mt-2 block text-3xl font-semibold tracking-tight text-slate-900">{list.isLoading || (c.id !== "ALL" && loading) ? <span className="text-slate-400">…</span> : n}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{t(c.sub)}</span>
            </button>
          );
        })}
      </div>

      <Card title={`${t(tile.label)}${list.data ? ` · ${shown.length}` : ""}`} className="mt-5">
        {list.isLoading ? <Spinner /> : (
          <Table head={["Patient", "Bed", "Consultant", "Stay", "Next step", ""]} {...(shown.length === 0 ? { empty: tile.empty } : {})}>
            {shown.map(({ a, fit, summary, loaded }) => {
              const b = badge(fit, summary);
              return (
                <tr key={a.id} className="hover:bg-slate-50">
                  <Td><span className="font-medium text-slate-900">{a.patientName}</span><div className="text-xs text-slate-500">{`${a.mrn ?? ""} · ${a.admissionNumber}`}</div></Td>
                  <Td>{a.bed ? <span>{a.bed.code}<div className="text-xs text-slate-500">{a.bed.ward}</div></span> : <span className="text-slate-400">—</span>}</Td>
                  <Td className="text-sm">{a.consultantName}</Td>
                  <Td className="text-sm">{`${a.lengthOfStayDays} ${a.lengthOfStayDays === 1 ? t("day") : t("days")}`}</Td>
                  <Td>{loaded ? <Badge tone={b.tone}>{t(b.label)}</Badge> : <span className="text-slate-400">…</span>}</Td>
                  <Td><Link className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50" href={`/ipd/${a.id}`}>{t(b.action)}</Link></Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
