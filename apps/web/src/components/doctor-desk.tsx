"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ErrorNote, PageHeader, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { visibleNav } from "@/lib/nav";
import { Icon, type IconName, useDeskKeys } from "./desk-ui";

interface Entry { id: string; tokenNumber: number; priority: "NORMAL" | "PRIORITY" | "EMERGENCY"; status: string; patientName: string; mrn: string | null; patientId?: string; encounterId?: string | null; waitingMinutes: number | null }
interface DoctorView { practitioner: { id: string; displayName: string }; current: Entry | null; next: Entry | null; waiting: Entry[]; completed: Entry[] }

/** A doctor's frequently used places: one key each, shown on the tile so nobody has to learn them from a manual. */
/** One muted accent per shortcut: the icon chip and the hover highlight. Full class names so Tailwind keeps them. */
const ACCENTS: Record<string, { chip: string; hover: string }> = {
  "/queue": { chip: "bg-blue-50 text-blue-600", hover: "hover:border-blue-300" },
  "/patients": { chip: "bg-teal-50 text-teal-600", hover: "hover:border-teal-300" },
  "/appointments": { chip: "bg-indigo-50 text-indigo-600", hover: "hover:border-indigo-300" },
  "/ipd": { chip: "bg-amber-50 text-amber-600", hover: "hover:border-amber-300" },
  "/teleconsult": { chip: "bg-rose-50 text-rose-600", hover: "hover:border-rose-300" },
  "/reports": { chip: "bg-emerald-50 text-emerald-600", hover: "hover:border-emerald-300" },
  "/emergency": { chip: "bg-red-50 text-red-600", hover: "hover:border-red-300" },
  "/rounds": { chip: "bg-cyan-50 text-cyan-600", hover: "hover:border-cyan-300" },
};

const SHORTCUTS: { href: string; label: string; key: string; icon: IconName }[] = [
  { icon: "queue", href: "/queue", label: "OPD queue", key: "Q" },
  { icon: "patients", href: "/patients", label: "Patients", key: "P" },
  { icon: "calendar", href: "/appointments", label: "Appointments", key: "A" },
  { icon: "bed", href: "/ipd", label: "Admissions", key: "I" },
  { icon: "video", href: "/teleconsult", label: "Video calls", key: "V" },
  { icon: "alert", href: "/emergency", label: "Emergency", key: "E" },
  { icon: "clock", href: "/rounds", label: "My rounds", key: "O" },
  { icon: "chart", href: "/reports", label: "Reports", key: "R" },
];

const PRIORITY_TONE = { NORMAL: "gray", PRIORITY: "amber", EMERGENCY: "red" } as const;

/**
 * The doctor's own start screen, the same for every doctor: who is next (one key to start), who is waiting, and the places a doctor goes most.
 * Everything a doctor does here is one click or one key, and nothing is hidden behind a menu.
 */
export function DoctorDashboard() {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const { me, can, features, dateTime } = useMe();
  const view = useQuery({ queryKey: ["doctor-view"], queryFn: () => api.get<DoctorView>("/queue/doctor"), refetchInterval: 15_000 });
  const allowed = new Set(visibleNav(new Set(me.permissions), features, me.roles).map((n) => n.href));
  const shortcuts = SHORTCUTS.filter((s) => allowed.has(s.href));
  const start = useMutation({
    mutationFn: (id: string) => api.post<{ encounterId?: string | null }>(`/queue/${id}/start`),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ["doctor-view"] }); if (r?.encounterId) router.push(`/visits/${r.encounterId}`); },
  });
  const d = view.data;
  const focus = d?.current ?? d?.next ?? null;
  const resume = !!d?.current;
  const go = (): void => {
    if (!focus) return;
    if (resume && focus.encounterId) router.push(`/visits/${focus.encounterId}`); else start.mutate(focus.id);
  };

  useDeskKeys((k, e) => {
    if (k === "N") { e.preventDefault(); go(); return; }
    const s = shortcuts.find((x) => x.key === k);
    if (s) { e.preventDefault(); router.push(s.href); }
  });

  const queueBusy = (d?.waiting.length ?? 0) > 0;
  const longest = Math.max(0, ...(d?.waiting.map((e) => e.waitingMinutes ?? 0) ?? []));
  const stats: { label: string; value: string | number; icon: IconName }[] = [
    { label: "Waiting", value: d?.waiting.length ?? 0, icon: "users" },
    { label: "In consultation", value: d?.current ? 1 : 0, icon: "play" },
    { label: "Seen today", value: d?.completed.length ?? 0, icon: "check" },
    { label: "Longest wait", value: queueBusy ? `${longest} ${t("min")}` : "—", icon: "clock" },
  ];
  const searchPatient = (): void => document.querySelector<HTMLInputElement>('input[aria-label="Search patients"]')?.focus();
  const kbd = "rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] font-medium text-slate-500";
  const panel = "rounded-xl border border-slate-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06),0_1px_2px_rgba(15,23,42,0.04)]";
  return (
    // A white canvas for the doctor's desk (the rest of the app keeps its light grey).
    <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
      <PageHeader title={`${t("Welcome,")} ${me.fullName}`} subtitle={`${me.facility?.name ?? ""} · ${dateTime(new Date().toISOString())}`} />
      <ErrorNote error={view.error ?? start.error} />
      {view.isLoading ? <Spinner /> : (
        <div className="space-y-3">
          {/* The day at a glance. */}
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {stats.map((x) => (
              <div key={x.label} className={`${panel} flex items-center gap-2.5 px-3.5 py-2`}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700"><Icon name={x.icon} className="h-4 w-4" /></span>
                <div>
                  <div className="text-[10.5px] font-medium uppercase tracking-wider text-slate-500">{t(x.label)}</div>
                  <div className="text-lg font-semibold tabular-nums leading-tight text-slate-900">{x.value}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Important actions: the patient to see next, and finding anyone else. */}
          <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto]">
            <section className={`${panel} flex flex-wrap items-center justify-between gap-3 border-teal-100 bg-gradient-to-r from-teal-50/60 to-white px-4 py-3`}>
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-teal-700">{t(resume ? "In consultation now" : "Next patient")}</div>
                {focus ? (
                  <>
                    <div className="mt-0.5 truncate text-lg font-semibold text-slate-900"><span className="mr-2 tabular-nums text-teal-700">#{focus.tokenNumber}</span>{focus.patientName}</div>
                    <div className="text-sm text-slate-500">{focus.mrn}{focus.waitingMinutes !== null && !resume ? ` · ${t("waiting")} ${focus.waitingMinutes} ${t("min")}` : ""} {focus.priority !== "NORMAL" && <Badge tone={PRIORITY_TONE[focus.priority]}>{focus.priority.toLowerCase()}</Badge>}</div>
                  </>
                ) : <div className="mt-0.5 text-sm text-slate-500">{t("Nobody is waiting right now.")}</div>}
              </div>
              {focus && <Button className="gap-2 rounded-lg px-5 py-2.5 shadow-sm" loading={start.isPending} onClick={go}><Icon name="play" />{resume ? "Resume consultation" : "Start consultation"}<kbd className="rounded bg-white/20 px-1.5 text-[11px]">N</kbd></Button>}
            </section>
            <button type="button" onClick={searchPatient} className={`${panel} flex items-center gap-2 px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-brand-500 hover:text-brand-700`}>
              <Icon name="search" className="h-4 w-4 text-teal-600" />{t("Find a patient")}<kbd className={kbd}>/</kbd>
            </button>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <section className={`${panel} lg:col-span-2`}>
              <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
                <h2 className="text-sm font-semibold text-slate-800">{t("Waiting")} <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{d?.waiting.length ?? 0}</span></h2>
                <Link href="/queue" className="text-sm font-medium text-brand-600 hover:underline">{t("Full queue")}</Link>
              </header>
              <div className="px-4 py-0.5">
                {!queueBusy ? <p className="py-4 text-sm text-slate-500">{t("The queue is empty.")}</p> : (
                  <ul className="divide-y divide-slate-100">
                    {d!.waiting.slice(0, 6).map((e) => (
                      <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className="min-w-0 truncate"><span className="mr-2 inline-block w-7 font-semibold tabular-nums text-teal-700">#{e.tokenNumber}</span>{e.patientId ? <Link className="font-medium text-slate-900 hover:text-brand-600 hover:underline" href={`/patients/${e.patientId}`}>{e.patientName}</Link> : e.patientName} <span className="text-slate-500">· {e.waitingMinutes ?? 0} {t("min")}</span> {e.priority !== "NORMAL" && <Badge tone={PRIORITY_TONE[e.priority]}>{e.priority.toLowerCase()}</Badge>}</span>
                        {!resume && can("CONSULTATION_CREATE") && <Button variant="secondary" loading={start.isPending && start.variables === e.id} onClick={() => start.mutate(e.id)}>Start</Button>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <div className="order-first space-y-3 lg:order-none">
              <section className={panel}>
                <header className="border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("Frequently used")}</h2></header>
                <div className="grid grid-cols-3 gap-2 p-3">
                  {shortcuts.map((s) => {
                    const a = ACCENTS[s.href] ?? ACCENTS["/queue"]!;
                    return (
                      <Link key={s.href} href={s.href} className={`group flex flex-col gap-2 rounded-xl border border-slate-100 bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition hover:shadow-md ${a.hover}`}>
                        <div className="flex items-center justify-between">
                          <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${a.chip}`}><Icon name={s.icon} className="h-[17px] w-[17px]" /></span>
                          <kbd className={kbd}>{s.key}</kbd>
                        </div>
                        <span className="truncate text-[13px] font-medium text-slate-800">{t(s.label)}</span>
                      </Link>
                    );
                  })}
                </div>
              </section>
              <section className={panel}>
                <header className="border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("Seen today")}</h2></header>
                <div className="px-4 py-2.5">
                  {(d?.completed.length ?? 0) === 0 ? <p className="text-sm text-slate-500">{t("No completed visits yet.")}</p> : (
                    <ul className="space-y-1.5 text-sm">
                      {d!.completed.slice(0, 4).map((e) => (
                        <li key={e.id} className="flex justify-between gap-2"><span className="truncate"><span className="mr-1.5 tabular-nums text-teal-700">#{e.tokenNumber}</span>{e.patientName}</span>{e.encounterId && <Link className="font-medium text-brand-600 hover:underline" href={`/visits/${e.encounterId}`}>{t("Open")}</Link>}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
