"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { todayIn } from "@/components/pickers";
import { PlanBadge, STATUS_LABEL, type PlanRow } from "@/components/planned";
import { Card, ErrorNote, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

const OTHER_TEAMS = ["DOCTOR_REVIEW", "AWAITING_PATIENT", "TARIFF_PAYER", "PREAUTH", "DEPOSIT", "BED_ALLOCATION"] as const;

function Tile({ label, value, tone, href }: { label: string; value: number | undefined; tone?: string; href?: string }) {
  const t = useT();
  const body = (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-brand-500">
      <div className="text-xs uppercase tracking-wide text-slate-500">{t(label)}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone ?? "text-slate-900"}`}>{value ?? <span className="text-slate-500">…</span>}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

/**
 * The admission desk's own start screen (docs/planned-admission.md): who arrives today and can be admitted, the requests whose details the desk must verify,
 * the beds and money still being arranged by other teams, and the coming days. It reads the planned-admission queue; verifying and admitting are done on the request, with all their checks.
 */
export function AdmissionDeskDashboard() {
  const t = useT();
  const { me, can, date } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const today = todayIn(tz);
  const summary = useQuery({ queryKey: ["planned-summary"], queryFn: () => api.get<{ open: number; counts: Record<string, number> }>("/planned-admissions/summary"), refetchInterval: 20_000 });
  const ready = useQuery({ queryKey: ["ad-ready"], queryFn: () => api.page<PlanRow>("/planned-admissions", { status: "READY", pageSize: 100 }), refetchInterval: 20_000 });
  const verify = useQuery({ queryKey: ["ad-verify"], queryFn: () => api.page<PlanRow>("/planned-admissions", { status: "DESK_REVIEW", pageSize: 50 }), refetchInterval: 20_000 });
  const adm = useQuery({ queryKey: ["dash-adm"], queryFn: () => api.page<unknown>("/admissions", { status: "ADMITTED", pageSize: 1 }), enabled: can("ADMISSION_READ") });

  const rows = ready.data?.data ?? [];
  const arriving = rows.filter((r) => r.proposedDate !== null && r.proposedDate.slice(0, 10) <= today);
  const later = rows.filter((r) => r.proposedDate === null || r.proposedDate.slice(0, 10) > today);
  const late = arriving.filter((r) => (r.proposedDate ?? "").slice(0, 10) < today).length;
  const counts = summary.data?.counts ?? {};

  return (
    <>
      <PageHeader title={`${t("Welcome")}, ${me.fullName}`} subtitle={`${me.tenant.name} · ${t("Planned admissions")}`} actions={<Link className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700" href="/planned">{t("Open the queue")}</Link>} />
      <ErrorNote error={ready.error ?? verify.error ?? summary.error} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Arriving today" value={ready.data ? arriving.length : undefined} tone={arriving.length > 0 ? "text-brand-700" : undefined} href="/planned" />
        <Tile label="Details to verify" value={verify.data?.meta.total} tone={verify.data && verify.data.meta.total > 0 ? "text-amber-700" : undefined} href="/planned" />
        <Tile label="Planned admissions open" value={summary.data?.open} href="/planned" />
        <Tile label="Admitted patients" value={adm.data?.meta.total} href="/ipd" />
      </div>

      <Card title={t("Arriving today: admit the patient")} className="mt-4">
        {ready.isLoading ? <Spinner /> : (
          <Table head={["Request", "Patient", "Doctor", "Bed", "Day", ""]} {...(arriving.length === 0 ? { empty: "Nobody is due today. Requests with a held bed and a cleared deposit appear here on their day." } : {})}>
            {arriving.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td><Link className="font-medium text-brand-700 hover:underline" href={`/planned/${r.id}`}>{r.requestNumber}</Link></Td>
                <Td>{r.patient.name}<div className="text-xs text-slate-500">{r.patient.mrn}</div></Td>
                <Td>{r.consultant.name}</Td>
                <Td><span className="rounded bg-purple-50 px-2 py-0.5 text-sm font-medium text-purple-700">{r.bed ?? "—"}</span></Td>
                <Td>{r.proposedDate && r.proposedDate.slice(0, 10) < today ? <span className="text-red-700">{`${date(r.proposedDate)} (${t("late")})`}</span> : t("Today")}</Td>
                <Td>{can("PLANNED_DESK") && can("ADMISSION_CREATE") ? <Link className="whitespace-nowrap rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700" href={`/planned/${r.id}`}>{t("Admit now")}</Link> : null}</Td>
              </tr>
            ))}
          </Table>
        )}
        {late > 0 && <p className="mt-2 text-xs text-red-700">{`${late} ${t("request(s) passed their day without the patient being admitted. Admit, move the day, or record a no-show.")}`}</p>}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={t("Verify the details")}>
          {verify.isLoading ? <Spinner /> : verify.data?.data.length === 0 ? <p className="text-sm text-slate-500">{t("No request is waiting for the desk.")}</p> : (
            <ul className="divide-y divide-slate-100">
              {verify.data?.data.map((r) => (
                <li key={r.id}>
                  <Link href={`/planned/${r.id}`} className="flex items-center justify-between gap-3 py-2 hover:bg-slate-50">
                    <span className="min-w-0"><span className="font-medium">{r.patient.name}</span><span className="block text-xs text-slate-500">{`${r.requestNumber} · ${r.consultant.name}${r.proposedDate ? ` · ${date(r.proposedDate)}` : ""}`}</span></span>
                    <span className="whitespace-nowrap rounded-md border border-brand-200 px-2.5 py-1 text-sm font-medium text-brand-700">{t("Verify")}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t("With other teams")}>
          <ul className="divide-y divide-slate-100 text-sm">
            {OTHER_TEAMS.map((s) => (
              <li key={s} className="flex items-center justify-between py-1.5"><span>{t(STATUS_LABEL[s] ?? s)}</span><span className={`font-semibold ${(counts[s] ?? 0) > 0 ? "text-slate-900" : "text-slate-400"}`}>{counts[s] ?? 0}</span></li>
            ))}
          </ul>
          {later.length > 0 && (
            <div className="mt-3 border-t border-slate-100 pt-2">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{t("Coming days")}</div>
              <ul className="space-y-1 text-sm">
                {later.slice(0, 5).map((r) => <li key={r.id}><Link className="hover:underline" href={`/planned/${r.id}`}>{`${r.patient.name} · ${r.proposedDate ? date(r.proposedDate) : "no day"}`}</Link> <PlanBadge status={r.status} /></li>)}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {[["/planned", "Planned admissions"], ["/ipd", "Admissions and bed board"], ["/patients", "Patients"], ["/appointments", "Appointments"]].map(([href, label]) => (
          <Link key={href} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50" href={href!}>{t(label!)}</Link>
        ))}
      </div>
    </>
  );
}
