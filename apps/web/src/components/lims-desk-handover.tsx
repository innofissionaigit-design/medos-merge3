"use client";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, newKey, type Query } from "@/lib/api";
import { localeFor, useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { Icon, TONE } from "./dashboard-kit";
import { type Req, useRefreshLims, useRequests } from "./lims-common";
import { ErrorNote, useDebounced } from "./ui";

/**
 * Reception's report dispatch desk: issued outpatient reports waiting to be collected, one card per patient so every report of that patient goes out
 * together, and the reports handed over today. Reception finds the patient (name, MRN or request number), prints the reports, records who collected
 * them, and hands them over in one step. Each handover is recorded and audited per report on the server.
 */

const WHO = { SELF: "Patient", FAMILY: "Family member", OTHER: "Someone else" } as const;
type Who = keyof typeof WHO;
const STALE_DAYS = 2;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
const pill = "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium";
const reportUrl = (r: Req) => `/api/proxy/lims/requests/${r.id}/report`;

/** One patient's ready reports and the handover form for them. */
function PatientReports({ patient, rows, onOpen }: { patient: Req["patient"]; rows: Req[]; onOpen: (r: Req) => void }) {
  const { me, dateTime } = useMe();
  const { lang, t } = useI18n();
  const refresh = useRefreshLims();
  const [who, setWho] = useState<Who>("SELF");
  const [name, setName] = useState(patient.name);
  useEffect(() => { setName(who === "SELF" ? patient.name : ""); }, [who, patient.name]);
  const receivedBy = who === "SELF" ? name.trim() : name.trim() ? `${name.trim()} (${WHO[who].toLowerCase()})` : "";
  // Hands over every report of this patient, one by one; stops at the first refusal and says which.
  const hand = useMutation({
    mutationFn: async () => { for (const r of rows) await api.post(`/lims/requests/${r.id}/handover`, { receivedBy }, newKey()); },
    onSettled: refresh,
  });
  const ageDays = (r: Req) => (r.stamps.issuedAt ? (Date.now() - new Date(r.stamps.issuedAt).getTime()) / 86_400_000 : 0);
  const waited = (r: Req) => {
    if (!r.stamps.issuedAt) return "";
    const d = ageDays(r);
    return d < 1 ? `${t("Ready")} ${new Intl.DateTimeFormat(localeFor(lang), { timeZone: me.facility?.timezone ?? me.tenant.timezone, timeStyle: "short" }).format(new Date(r.stamps.issuedAt))}` : `${t("Waiting")} ${Math.floor(d)} ${Math.floor(d) === 1 ? t("day") : t("days")}`;
  };
  const stale = rows.some((r) => ageDays(r) >= STALE_DAYS);
  return (
    <article className={clsx("flex flex-col rounded-xl border bg-white", stale ? "border-amber-200" : "border-slate-200")}>
      <header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700">{initials(patient.name)}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-slate-900">{patient.name}</p>
          <p className="text-xs text-slate-500">{patient.mrn} · {patient.gender.toLowerCase()}</p>
        </div>
        <span className={clsx(pill, TONE.violet.pill)}>{rows.length} {rows.length === 1 ? t("report") : t("reports")}</span>
      </header>
      <ul className="divide-y divide-slate-100 px-4">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 py-2">
            <span className={clsx("grid h-8 w-8 shrink-0 place-items-center rounded-md", r.department === "RADIOLOGY" ? TONE.violet.chip : TONE.sky.chip)}><Icon name={r.department === "RADIOLOGY" ? "pulse" : "flask"} className="h-4 w-4" /></span>
            <button type="button" onClick={() => onOpen(r)} className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm font-medium text-slate-800 hover:text-brand-700">{r.test}</span>
              <span className="block text-xs text-slate-500">{r.requestNumber} · <span title={r.stamps.issuedAt ? dateTime(r.stamps.issuedAt) : undefined} className={ageDays(r) >= STALE_DAYS ? "font-medium text-amber-700" : ""}>{waited(r)}</span></span>
            </button>
            <a href={reportUrl(r)} target="_blank" rel="noreferrer" title={t("Print report")} aria-label={`${t("Print report")}: ${r.test}`} className="grid h-8 w-8 place-items-center rounded-md border border-slate-200 text-slate-600 hover:border-brand-500 hover:text-brand-700"><Icon name="print" className="h-4 w-4" /></a>
          </li>
        ))}
      </ul>
      <footer className="mt-auto space-y-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-600">{t("Collected by")}</span>
          <div className="flex rounded-md border border-slate-300 bg-white p-0.5 text-xs" role="radiogroup" aria-label={t("Collected by")}>
            {(Object.keys(WHO) as Who[]).map((w) => <button key={w} type="button" role="radio" aria-checked={who === w} onClick={() => setWho(w)} className={clsx("rounded px-2 py-1 font-medium", who === w ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50")}>{t(WHO[w])}</button>)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label={t("Name of the person collecting")} placeholder={t("Name of the person collecting")}
            className="min-w-[10rem] flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
          <button type="button" disabled={receivedBy.length < 2 || hand.isPending} onClick={() => hand.mutate()} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300">
            {hand.isPending ? t("Handing over…") : rows.length > 1 ? `${t("Hand over all")} ${rows.length}` : t("Hand over")}
          </button>
        </div>
        {who !== "SELF" && <p className="text-xs text-slate-500">{t("Check the person's ID and their relation to the patient before handing over.")}</p>}
        <ErrorNote error={hand.error} />
      </footer>
    </article>
  );
}

export function LimsDeskHandover({ onOpen }: { onOpen: (r: Req) => void }) {
  const { me } = useMe();
  const { lang, t } = useI18n();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const locale = localeFor(lang);
  const [view, setView] = useState<"ready" | "done">("ready");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const find: Query = q.length >= 2 ? { q } : {};
  const ready = useRequests({ origin: "OPD", status: "ISSUED", sort: "newest", pageSize: 100, ...find }, { every: 20_000 });
  const done = useRequests({ origin: "OPD", status: "HANDED_OVER", sort: "newest", pageSize: 100, ...find }, { every: 30_000 });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const isToday = (iso: string | null) => !!iso && new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso)) === today;
  const handedToday = (done.data?.items ?? []).filter((r) => isToday(r.stamps.handedOverAt)).sort((a, b) => (b.stamps.handedOverAt ?? "").localeCompare(a.stamps.handedOverAt ?? ""));

  const byPatient = new Map<string, Req[]>();
  for (const r of ready.data?.items ?? []) byPatient.set(r.patient.id, [...(byPatient.get(r.patient.id) ?? []), r]);
  // Patients who have waited longest come first.
  const groups = [...byPatient.values()].sort((a, b) => Math.min(...a.map((r) => +new Date(r.stamps.issuedAt ?? r.createdAt))) - Math.min(...b.map((r) => +new Date(r.stamps.issuedAt ?? r.createdAt))));
  const staleCount = (ready.data?.items ?? []).filter((r) => r.stamps.issuedAt && Date.now() - new Date(r.stamps.issuedAt).getTime() >= STALE_DAYS * 86_400_000).length;

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="space-y-3 border-b border-slate-100 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{t("Reports to Hand Over")}</h2>
            <p className="text-sm text-slate-500">{t("Issued reports waiting at the desk. All of a patient's reports go out together.")}</p>
          </div>
          {/* Today at the desk, in one line */}
          <dl className="flex divide-x divide-slate-200 rounded-lg border border-slate-200 text-center">
            <div className="px-4 py-1.5"><dt className="text-[11px] uppercase tracking-wide text-slate-500">{t("Waiting")}</dt><dd className="text-lg font-semibold text-slate-900">{ready.data ? `${groups.length} / ${ready.data.total}` : "…"}</dd><dd className="text-[11px] text-slate-500">{t("patients / reports")}</dd></div>
            <div className="px-4 py-1.5"><dt className="text-[11px] uppercase tracking-wide text-slate-500">{t(`Over ${STALE_DAYS} days`)}</dt><dd className={clsx("text-lg font-semibold", staleCount ? "text-amber-600" : "text-slate-900")}>{ready.data ? staleCount : "…"}</dd><dd className="text-[11px] text-slate-500">{t("reports")}</dd></div>
            <div className="px-4 py-1.5"><dt className="text-[11px] uppercase tracking-wide text-slate-500">{t("Handed over")}</dt><dd className="text-lg font-semibold text-emerald-600">{done.data ? handedToday.length : "…"}</dd><dd className="text-[11px] text-slate-500">{t("today")}</dd></div>
          </dl>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[16rem] flex-1">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search by patient name, MRN or request no.")} aria-label={t("Search reports")}
              className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-9 pr-8 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
            {search && <button type="button" aria-label={t("Clear search")} onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-slate-500 hover:text-slate-700">✕</button>}
          </label>
          <div className="flex rounded-md border border-slate-300 p-0.5 text-sm" role="tablist" aria-label={t("Show")}>
            <button type="button" role="tab" aria-selected={view === "ready"} onClick={() => setView("ready")} className={clsx("rounded px-3 py-1 font-medium", view === "ready" ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50")}>{t("Ready to hand over")}</button>
            <button type="button" role="tab" aria-selected={view === "done"} onClick={() => setView("done")} className={clsx("rounded px-3 py-1 font-medium", view === "done" ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50")}>{t("Handed over today")}</button>
          </div>
        </div>
      </div>

      {view === "ready" ? (
        groups.length === 0 ? <p className="px-4 py-12 text-center text-sm text-slate-500">{ready.isLoading ? t("Loading…") : q ? t("No ready report matches the search.") : t("No reports are waiting at the desk.")}</p> : (
          <div className="grid gap-3 p-4 lg:grid-cols-2 2xl:grid-cols-3">
            {groups.map((rows) => <PatientReports key={rows[0]!.patient.id} patient={rows[0]!.patient} rows={rows} onOpen={onOpen} />)}
          </div>
        )
      ) : handedToday.length === 0 ? <p className="px-4 py-12 text-center text-sm text-slate-500">{done.isLoading ? t("Loading…") : t("No reports handed over today yet.")}</p> : (
        <ol className="divide-y divide-slate-100">
          {handedToday.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="w-16 shrink-0 text-sm font-medium text-slate-700">{r.stamps.handedOverAt ? new Intl.DateTimeFormat(locale, { timeZone: tz, timeStyle: "short" }).format(new Date(r.stamps.handedOverAt)) : ""}</span>
              <span className={clsx(pill, TONE.emerald.pill)}><Icon name="check" className="h-3.5 w-3.5" />{t("Handed over")}</span>
              <button type="button" onClick={() => onOpen(r)} className="min-w-0 flex-1 text-left text-sm"><span className="font-medium text-slate-900">{r.patient.name}</span> <span className="text-slate-500">· {r.patient.mrn} · {r.test} · {r.requestNumber}</span></button>
              <a href={reportUrl(r)} target="_blank" rel="noreferrer" className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">{t("Print again")}</a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
