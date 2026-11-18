"use client";
import clsx from "clsx";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Desk } from "@/lib/desk";
import { doctorText } from "@/lib/format";
import { localeFor, useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { hrefOf, kindOf, type NotificationRow } from "./notifications";
import { Empty, Icon, Panel, StatTile, TONE, td, th, useFitToScreen, type IconName, type Tone } from "./dashboard-kit";
import { StatusBadge } from "./ui";
import { WalkIn } from "./walk-in";

/**
 * The front desk's home screen: today's numbers, the common actions, the OPD queue, today's appointments, bed status and notifications.
 * Every panel reads live data and appears only when the user's permissions allow that data; nothing here is decided by role name alone.
 * Reception works at one desk (docs/reception-desks.md): at the OPD desk the inpatient panels are left out and "Start new visit" comes first; at the IPD desk
 * the outpatient panels are left out and the admitted patients and the going-home board come first. With no desk (inpatient care switched off) it shows everything.
 */


// ───────────────────────── data shapes ─────────────────────────

interface QueueRow { id: string; tokenNumber: number; status: string; priority: string; checkedInAt: string; patientId: string; patientName: string; gender: string; mrn: string | null; practitionerName: string; departmentName: string | null }
interface ApptRow { id: string; startAt: string; status: string; patientId: string; patientName: string; mrn: string | null; practitionerName: string; departmentName: string | null }
interface Occupancy { wards: { wardId: string; ward: string; total: number; occupied: number; occupancyPercent: number }[]; total: number; occupied: number; occupancyPercent: number }
interface AdmRow { id: string; admissionNumber: string; patientId: string; patientName: string; mrn: string | null; consultantName: string; admittedAt: string; bed: { code: string; ward: string } | null }
interface RegRow { patientId: string; registeredAt: string; patient: string; mrn: string | null; status: "PAID" | "EXEMPTED" | "PENDING" }

const OPEN_QUEUE = ["IN_CONSULTATION", "CALLED", "WAITING"];
const QUEUE_ORDER: Record<string, number> = { IN_CONSULTATION: 0, CALLED: 1, WAITING: 2 };


// ───────────────────────── the dashboard ─────────────────────────

export function ReceptionDashboard({ desk = null }: { desk?: Desk | null }) {
  const { me, can, features } = useMe();
  const [starting, setStarting] = useState(false);
  const { lang, t } = useI18n();
  const fit = useFitToScreen<HTMLDivElement>();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const locale = localeFor(lang);

  // The clock in the header moves on its own; every panel refreshes on its own interval.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(id); }, []);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const time = (v: string) => new Intl.DateTimeFormat(locale, { timeZone: tz, timeStyle: "short" }).format(new Date(v));
  const ago = (v: string) => {
    const m = Math.max(0, Math.round((now.getTime() - new Date(v).getTime()) / 60_000));
    if (m < 1) return t("Now");
    if (m < 60) return `${m} ${t("min ago")}`;
    if (m < 60 * 24) return `${Math.round(m / 60)} ${t("h ago")}`;
    return new Intl.DateTimeFormat(locale, { timeZone: tz, day: "numeric", month: "short" }).format(new Date(v));
  };

  // The inpatient panels belong to the IPD desk and the outpatient ones to the OPD desk (and to everyone when no desk was chosen).
  const ipd = features.IPD_ENABLED && desk !== "OPD";
  const opdOn = desk !== "IPD";
  const opd = useQuery({ queryKey: ["rd-opd", today], queryFn: () => api.get<{ total: number }>("/reports/opd/daily"), enabled: can("REPORT_READ", "REPORT_OPD") && opdOn, refetchInterval: 60_000 });
  const queue = useQuery({ queryKey: ["rd-queue"], queryFn: () => api.get<QueueRow[]>("/queue"), enabled: can("QUEUE_READ") && opdOn, refetchInterval: 20_000 });
  const appts = useQuery({ queryKey: ["rd-appts", today], queryFn: () => api.page<ApptRow>("/appointments", { date: today, pageSize: 100 }), enabled: can("APPOINTMENT_READ") && opdOn, refetchInterval: 30_000 });
  const admitted = useQuery({ queryKey: ["rd-admitted"], queryFn: () => api.page<unknown>("/admissions", { status: "ADMITTED", pageSize: 1 }), enabled: can("ADMISSION_READ") && ipd, refetchInterval: 60_000 });
  const admDay = useQuery({ queryKey: ["rd-adm-day", today], queryFn: () => api.get<{ totalAdmissions: number; totalDischarges: number }>("/reports/ipd/admissions-discharges"), enabled: can("REPORT_READ", "REPORT_IPD") && ipd, refetchInterval: 60_000 });
  const occ = useQuery({ queryKey: ["rd-occ"], queryFn: () => api.get<Occupancy>("/reports/ipd/bed-occupancy"), enabled: can("REPORT_READ", "REPORT_IPD") && ipd, refetchInterval: 60_000 });
  const admittedNow = useQuery({ queryKey: ["rd-admitted-now"], queryFn: () => api.page<AdmRow>("/admissions", { status: "ADMITTED", pageSize: 5 }), enabled: can("ADMISSION_READ") && ipd && desk === "IPD", refetchInterval: 30_000 });
  const er = useQuery({ queryKey: ["rd-er"], queryFn: () => api.page<unknown>("/emergency/cases", { view: "active", pageSize: 1 }), enabled: can("ER_READ"), refetchInterval: 15_000 });
  const notes = useQuery({ queryKey: ["rd-notes"], queryFn: () => api.page<NotificationRow>("/notifications", { pageSize: 4 }), refetchInterval: 30_000 });
  const regs = useQuery({ queryKey: ["rd-regs", today], queryFn: () => api.get<{ rows: RegRow[] }>("/reports/registrations"), enabled: can("REPORT_READ", "REPORT_FINANCE"), refetchInterval: 30_000 });

  const qRows = queue.data ?? [];
  const openQueue = qRows.filter((q) => OPEN_QUEUE.includes(q.status)).sort((a, b) => (QUEUE_ORDER[a.status] ?? 9) - (QUEUE_ORDER[b.status] ?? 9) || a.tokenNumber - b.tokenNumber);
  const waiting = qRows.filter((q) => q.status === "WAITING" || q.status === "CALLED").length;
  const apptRows = appts.data?.data ?? [];
  const toArrive = apptRows.filter((a) => a.status === "BOOKED").length;
  const upcoming = apptRows.filter((a) => a.status !== "CANCELLED").sort((a, b) => a.startAt.localeCompare(b.startAt));
  const recentCheckIns = [...qRows].sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt)).slice(0, 5);

  const allActions: { label: string; href: string; icon: IconName; tone: Tone; show: boolean; onClick?: () => void }[] = [
    // The one thing the OPD desk does most (docs/reception-desks.md): pick the patient, then a doctor, and put them in that doctor's queue.
    { label: "Start new visit", href: "/queue", icon: "plus", tone: "emerald", show: desk === "OPD" && can("APPOINTMENT_CREATE"), onClick: () => setStarting(true) },
    { label: "New Registration", href: "/patients?register=1", icon: "userPlus", tone: "brand", show: can("PATIENT_CREATE") },
    { label: "Book Appointment", href: "/appointments", icon: "calendarPlus", tone: "violet", show: can("APPOINTMENT_CREATE") && opdOn },
    { label: "OPD Check-in", href: "/queue", icon: "clipboard", tone: "emerald", show: can("QUEUE_MANAGE") && opdOn },
    { label: "Emergency (ER)", href: "/emergency", icon: "siren", tone: "rose", show: can("ER_REGISTER", "ER_READ") },
    { label: "IP Admission", href: "/ipd", icon: "bed", tone: "amber", show: can("ADMISSION_CREATE") && ipd },
    { label: "Billing & Payment", href: "/billing", icon: "receipt", tone: "sky", show: can("INVOICE_READ") },
    { label: "Lab Request", href: "/lims?tab=book", icon: "flask", tone: "violet", show: can("LIMS_REQUEST") },
    { label: "Going home", href: "/discharge-board", icon: "check", tone: "emerald", show: can("ADMISSION_READ") && ipd },
    { label: "Planned Admission", href: "/planned", icon: "calendar", tone: "emerald", show: can("PLANNED_READ") && features.IPD_ENABLED !== false },
  ];
  const actions = allActions.filter((a) => a.show).slice(0, 6);

  const wards = [...(occ.data?.wards ?? [])].filter((w) => w.total > 0).sort((a, b) => b.total - a.total);
  const barTone = (p: number) => (p >= 90 ? "bg-rose-500" : p >= 70 ? "bg-amber-500" : "bg-emerald-500");

  return (
    <div ref={fit.ref} style={fit.height ? { height: fit.height } : undefined} className="flex flex-col gap-3">
      {/* Title and the facility's date and time */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold text-slate-900">{t("Reception Dashboard")}</h1>
          <p className="flex items-center gap-2 text-sm text-slate-600">
            <Icon name="calendar" className="h-4 w-4 text-slate-500" />
            <span>{new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(now)}</span>
            <span className="text-slate-300">|</span>
            <span>{new Intl.DateTimeFormat(locale, { timeZone: tz, timeStyle: "short" }).format(now)}</span>
          </p>
        </div>
        <p className="text-sm text-slate-500">{t("Welcome,")} <span className="font-medium text-slate-700">{me.fullName}</span></p>
      </div>

      {/* Today's numbers */}
      <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {can("REPORT_READ", "REPORT_OPD") && opdOn && <StatTile icon="user" tone="brand" value={opd.data?.total} label={t("OPD Today")} note={queue.data ? `${waiting} ${t("waiting")}` : undefined} noteTone="brand" href="/queue" />}
        {can("APPOINTMENT_READ") && opdOn && <StatTile icon="calendar" tone="violet" value={appts.data?.meta.total} label={t("Appointments")} note={appts.data ? `${toArrive} ${t("to arrive")}` : undefined} noteTone="violet" href="/appointments" />}
        {can("ADMISSION_READ") && ipd && <StatTile icon="bed" tone="rose" value={admitted.data?.meta.total} label={t("IP Admissions")} note={admDay.data ? `${admDay.data.totalAdmissions} ${t("today")}` : undefined} noteTone="rose" href="/ipd" />}
        {can("ER_READ")
          ? <StatTile icon="siren" tone="emerald" value={er.data?.meta.total} label={t("Emergency")} note={t("in the ER now")} noteTone="emerald" href="/emergency" />
          : can("QUEUE_READ") && opdOn && <StatTile icon="pulse" tone="emerald" value={queue.data ? waiting : undefined} label={t("Waiting in OPD")} note={queue.data ? `${qRows.filter((q) => q.status === "IN_CONSULTATION").length} ${t("in consultation")}` : undefined} noteTone="emerald" href="/queue" />}
        {can("REPORT_READ", "REPORT_IPD") && ipd && <StatTile icon="percent" tone="violet" value={occ.data ? `${Math.round(occ.data.occupancyPercent)}%` : undefined} label={t("Bed Occupancy")} note={occ.data ? `${occ.data.occupied} / ${occ.data.total}` : undefined} href="/ipd" />}
      </div>

      <div className="grid gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid min-w-0 gap-3 lg:grid-cols-2 xl:min-h-0 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:grid-rows-2">
          {/* Quick actions */}
          <Panel title={t("Quick Actions")}>
            <div className="grid h-full grid-cols-2 gap-2.5 sm:grid-cols-3 xl:auto-rows-fr">
              {actions.map((a) => {
                const cls = clsx("flex min-h-[4.75rem] flex-col items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-center text-sm font-semibold transition", TONE[a.tone].tile);
                const body = (<><Icon name={a.icon} className="h-6 w-6" /><span className="leading-tight">{t(a.label)}</span></>);
                return a.onClick
                  ? <button key={a.label} type="button" onClick={a.onClick} className={cls}>{body}</button>
                  : <Link key={a.href + a.label} href={a.href} className={cls}>{body}</Link>;
              })}
            </div>
          </Panel>

          {/* The IPD desk's list: who is in the wards now */}
          {desk === "IPD" && can("ADMISSION_READ") && ipd && (
            <Panel title={t("Admitted now")} href="/ipd" viewAll={t("View All")}>
              {(admittedNow.data?.data.length ?? 0) === 0 ? <Empty>{admittedNow.isLoading ? t("Loading…") : t("No one is admitted right now.")}</Empty> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-100"><tr><th className={th}>{t("Patient Name")}</th><th className={th}>{t("Bed")}</th><th className={th}>{t("Doctor")}</th><th className={th}>{t("Admitted")}</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {admittedNow.data?.data.map((a) => (
                        <tr key={a.id}>
                          <td className={td}><Link href={`/patients/${a.patientId}`} className="font-medium text-slate-900 hover:text-brand-600">{a.patientName}</Link><span className="block text-xs text-slate-500">{a.admissionNumber}</span></td>
                          <td className={clsx(td, "text-slate-700")}>{a.bed ? `${a.bed.ward} · ${a.bed.code}` : "—"}</td>
                          <td className={clsx(td, "text-slate-700")}>{doctorText(a.consultantName)}</td>
                          <td className={clsx(td, "whitespace-nowrap text-slate-600")}>{ago(a.admittedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}

          {/* Today's OPD queue */}
          {can("QUEUE_READ") && opdOn && (
            <Panel title={t("Today's Queue – OPD")} href="/queue" viewAll={t("View All")}>
              {openQueue.length === 0 ? <Empty>{queue.isLoading ? t("Loading…") : t("No one is waiting in the OPD queue.")}</Empty> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-100"><tr><th className={th}>#</th><th className={th}>{t("Token")}</th><th className={th}>{t("Patient Name")}</th><th className={th}>{t("Doctor / Department")}</th><th className={th}>{t("Status")}</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {openQueue.slice(0, 5).map((q, i) => (
                        <tr key={q.id}>
                          <td className={clsx(td, "text-slate-500")}>{i + 1}</td>
                          <td className={clsx(td, "font-semibold text-brand-600")}>{String(q.tokenNumber).padStart(3, "0")}</td>
                          <td className={td}><Link href={`/patients/${q.patientId}`} className="font-medium text-slate-900 hover:text-brand-600">{q.patientName}</Link></td>
                          <td className={clsx(td, "text-slate-700")}>{doctorText(q.practitionerName)}{q.departmentName && <span className="text-xs text-slate-500"> ({q.departmentName})</span>}</td>
                          <td className={td}><StatusBadge value={q.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}

          {/* Recent registrations (with the finance report) or, for the front desk, the latest OPD check-ins */}
          {regs.data ? (
            <Panel title={t("Recent Registrations")} href="/patients" viewAll={t("View All")}>
              {regs.data.rows.length === 0 ? <Empty>{t("No patients registered today yet.")}</Empty> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-100"><tr><th className={th}>{t("Patient ID")}</th><th className={th}>{t("Patient Name")}</th><th className={th}>{t("Fee")}</th><th className={th}>{t("Time")}</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {regs.data.rows.slice(0, 5).map((r) => (
                        <tr key={r.patientId}>
                          <td className={clsx(td, "text-slate-600")}>{r.mrn ?? "—"}</td>
                          <td className={td}><Link href={`/patients/${r.patientId}`} className="font-medium text-slate-900 hover:text-brand-600">{r.patient}</Link></td>
                          <td className={td}><StatusBadge value={r.status} /></td>
                          <td className={clsx(td, "whitespace-nowrap text-slate-600")}>{time(r.registeredAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          ) : can("QUEUE_READ") && opdOn && (
            <Panel title={t("Recent Check-ins")} href="/queue" viewAll={t("View All")}>
              {recentCheckIns.length === 0 ? <Empty>{queue.isLoading ? t("Loading…") : t("No patients checked in today yet.")}</Empty> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-100"><tr><th className={th}>{t("Patient")}</th><th className={clsx(th, "whitespace-nowrap")}>{t("Visit Type")}</th><th className={th}>{t("Time")}</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {recentCheckIns.map((q) => (
                        <tr key={q.id}>
                          <td className={td}>
                            <Link href={`/patients/${q.patientId}`} className="font-medium text-slate-900 hover:text-brand-600">{q.patientName}</Link>
                            <span className="block text-xs text-slate-500">{q.mrn ?? "—"}</span>
                          </td>
                          <td className={td}><span className={clsx("rounded-md px-2 py-0.5 text-xs font-medium", q.priority === "EMERGENCY" ? TONE.rose.pill : TONE.emerald.pill)}>{q.priority === "EMERGENCY" ? t("Emergency") : t("OPD")}</span></td>
                          <td className={clsx(td, "whitespace-nowrap text-slate-600")}>{time(q.checkedInAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}

          {/* Today's appointments */}
          {can("APPOINTMENT_READ") && opdOn && (
            <Panel title={t("Appointments – Today")} href="/appointments" viewAll={t("View All")}>
              {upcoming.length === 0 ? <Empty>{appts.isLoading ? t("Loading…") : t("No appointments today.")}</Empty> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-100"><tr><th className={th}>{t("Time")}</th><th className={th}>{t("Patient")}</th><th className={th}>{t("Doctor")}</th><th className={th}>{t("Status")}</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {upcoming.slice(0, 5).map((a) => (
                        <tr key={a.id}>
                          <td className={clsx(td, "whitespace-nowrap text-slate-600")}>{time(a.startAt)}</td>
                          <td className={td}><Link href={`/patients/${a.patientId}`} className="font-medium text-slate-900 hover:text-brand-600">{a.patientName}</Link></td>
                          <td className={clsx(td, "text-slate-700")}>{doctorText(a.practitionerName)}</td>
                          <td className={td}><StatusBadge value={a.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}
        </div>

        {/* Right column: the hospital, bed status and notifications */}
        <aside className="grid min-w-0 content-start gap-3 sm:grid-cols-2 xl:flex xl:min-h-0 xl:flex-col">
          <div className="relative flex shrink-0 items-center gap-3 overflow-hidden rounded-xl bg-gradient-to-br from-brand-600 to-brand-700 px-4 py-3.5 text-white shadow-sm sm:col-span-2">
            <Icon name="hospital" className="absolute -bottom-3 -right-3 h-20 w-20 text-white/10" />
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/15"><Icon name="hospital" className="h-6 w-6" /></span>
            <span className="min-w-0">
              <span className="block truncate font-semibold leading-tight">{me.facility?.name ?? me.tenant.name}</span>
              <span className="block truncate text-xs uppercase tracking-wide text-white/75">{me.facility && me.facility.name !== me.tenant.name ? `${me.tenant.name} · ` : ""}MedOS · {t("Front desk")}</span>
            </span>
          </div>

          {can("REPORT_READ", "REPORT_IPD") && ipd && (
            <Panel title={t("Bed Status (IPD)")} href="/ipd" viewAll={t("View All")} className="xl:flex-1">
              {wards.length === 0 ? <Empty>{occ.isLoading ? t("Loading…") : t("No beds set up yet.")}</Empty> : (
                <div className="space-y-2.5">
                  {wards.map((w) => (
                    <div key={w.wardId}>
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="flex min-w-0 items-center gap-2 text-slate-700"><Icon name="bed" className="h-4 w-4 shrink-0 text-slate-400" /><span className="truncate">{w.ward}</span></span>
                        <span className="shrink-0 font-medium text-slate-900">{w.occupied} / {w.total}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={clsx("h-full rounded-full", barTone(w.occupancyPercent))} style={{ width: `${Math.min(100, w.occupancyPercent)}%` }} /></div>
                    </div>
                  ))}
                  <div className="sticky bottom-0 flex items-center justify-between border-t border-slate-100 bg-white pt-2 text-sm font-semibold text-slate-900"><span>{t("Total")}</span><span>{occ.data?.occupied} / {occ.data?.total}</span></div>
                </div>
              )}
            </Panel>
          )}

          <Panel title={t("Notifications")} className="xl:max-h-[38%] xl:shrink-0">
            {(notes.data?.data.length ?? 0) === 0 ? <Empty>{notes.isLoading ? t("Loading…") : t("No new notifications.")}</Empty> : (
              <ul className="space-y-2.5">
                {notes.data?.data.map((n) => {
                  const k = kindOf(n.type);
                  return (
                    <li key={n.id}>
                      <Link href={hrefOf(n)} className="flex items-start gap-2.5 text-sm hover:text-brand-600">
                        <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", k.critical ? "bg-rose-500" : n.readAt ? "bg-slate-300" : "bg-brand-500")} />
                        <span className="min-w-0 flex-1 text-slate-700">{t(k.text)}</span>
                        <span className="shrink-0 text-xs text-slate-400">{ago(n.createdAt)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </aside>
      </div>
      {starting && <WalkIn title="Start new visit" onClose={() => setStarting(false)} />}
    </div>
  );
}
