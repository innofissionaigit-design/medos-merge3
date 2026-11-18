"use client";
import clsx from "clsx";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { localeFor, useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { visibleNav } from "@/lib/nav";
import { Empty, Icon, Panel, StatTile, TONE, td, th, useFitToScreen, type IconName, type Tone } from "./dashboard-kit";
import { byCollection, collectionRank, PriorityBadge, type Req, StageBadge, useRequests } from "./lims-common";
import { CollectModal, ReviewModal, TechModal } from "./lims-floor";
import { hrefOf, kindOf, type NotificationRow } from "./notifications";
import { Button } from "./ui";

/**
 * The home screen of laboratory floor staff: the nurse who takes samples, the technician, the pathologist and the radiologist.
 * One screen, no scrolling on a desktop: what is waiting on this person (counts), the next jobs in the order they should be done
 * (open one right here, no page change), shortcuts to the lists used most, and the latest notifications.
 * What each person sees follows their permissions, never a role name. Press N anywhere on the page to open the next job.
 */

type Kind = "collect" | "tech" | "review";
interface Shortcut { href: string; label: string; icon: IconName; tone: Tone; show: boolean }

const notHere = (r: Req) => r.origin === "OPD" && !r.arrivedAt;
const URGENCY = (r: Req) => (r.priority === "EMERGENCY" ? 0 : r.priority === "URGENT" ? 1 : 2);

/** The one thing to do with a request, and which dialog does it. */
function nextStep(r: Req): { label: string; kind: Kind } {
  const rad = r.department === "RADIOLOGY";
  switch (r.status) {
    case "PENDING_COLLECTION": return { label: rad ? "Patient ready" : "Collect sample", kind: "collect" };
    case "COLLECTED": return { label: rad ? "Do the scan" : "Accept sample", kind: "tech" };
    case "IN_PROCESS": return { label: rad ? "Open" : "Enter results", kind: "tech" };
    case "PASSED": return { label: "Issue report", kind: "tech" };
    default: return { label: "Review", kind: "review" };
  }
}

export function LabStaffDashboard() {
  const { me, can, features } = useMe();
  const { lang, t } = useI18n();
  const fit = useFitToScreen<HTMLDivElement>();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const locale = localeFor(lang);
  const collect = can("LIMS_COLLECT");
  const tech = can("LIMS_ISSUE");
  const review = can("LAB_VERIFY", "RAD_REPORT");

  // Counts and the work list. Each query runs only for the job the person holds.
  const toTake = useRequests({ status: "PENDING_COLLECTION" }, { enabled: collect, every: 15_000 });
  const mine = useRequests({ status: "PENDING_COLLECTION", mine: "true" }, { enabled: collect, every: 15_000 });
  const taken = useRequests({ status: "COLLECTED" }, { enabled: collect && !tech, every: 30_000 });
  const techWork = useRequests({ status: "PASSED,COLLECTED,IN_PROCESS" }, { enabled: tech, every: 15_000 });
  const toReview = useRequests({ status: "PENDING_REVIEW" }, { enabled: review, every: 15_000 });
  const passed = useRequests({ status: "PASSED" }, { enabled: review && !tech, every: 30_000 });
  const issued = useRequests({ status: "ISSUED,HANDED_OVER" }, { enabled: review || tech, every: 60_000 });
  const notes = useQuery({ queryKey: ["ld-notes"], queryFn: () => api.page<NotificationRow>("/notifications", { pageSize: 4 }), refetchInterval: 30_000 });

  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(id); }, []);
  const dayOf = (v: string | Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(v));
  const today = dayOf(now);
  const time = (v: string) => new Intl.DateTimeFormat(locale, { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(v));
  const ago = (v: string) => {
    const m = Math.max(0, Math.round((now.getTime() - new Date(v).getTime()) / 60_000));
    return m < 1 ? t("Now") : m < 60 ? `${m} ${t("min ago")}` : m < 1440 ? `${Math.round(m / 60)} ${t("h ago")}` : new Intl.DateTimeFormat(locale, { timeZone: tz, day: "numeric", month: "short" }).format(new Date(v));
  };

  // The list: the person's main job first. A reviewer reviews; a technician closes finished reports first, then new samples, then work in progress; a nurse takes samples.
  const primary: Kind = review ? "review" : tech ? "tech" : "collect";
  const list: Req[] = useMemo(() => {
    const src = primary === "review" ? toReview.data?.items : primary === "tech" ? techWork.data?.items : toTake.data?.items;
    const step = (r: Req) => (r.status === "PASSED" ? 0 : r.status === "COLLECTED" ? 1 : r.status === "IN_PROCESS" ? 2 : 0);
    const rank = (r: Req) => (primary === "collect" ? collectionRank(r) : (primary === "tech" ? step(r) * 0.1 : 0) + URGENCY(r) + (r.critical ? -0.5 : 0));
    return [...(src ?? [])].sort((a, b) => (primary === "collect" ? byCollection(a, b) : rank(a) - rank(b) || a.dueAt.localeCompare(b.dueAt)));
  }, [primary, toReview.data, techWork.data, toTake.data]);
  const loading = primary === "review" ? toReview.isLoading : primary === "tech" ? techWork.isLoading : toTake.isLoading;
  const doable = list.filter((r) => !(r.status === "PENDING_COLLECTION" && notHere(r)));

  const [open, setOpen] = useState<Req | null>(null);
  // N opens the next job, from anywhere on the page, unless the person is typing or a dialog is already open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.ctrlKey || e.metaKey || e.altKey || open) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      if (doable[0]) { e.preventDefault(); setOpen(doable[0]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doable, open]);

  // Tiles: what is waiting on this person, most important first, at most five.
  const readyNow = toTake.data?.items.filter((r) => !notHere(r)).length;
  const emergencies = (primary === "review" ? toReview.data?.items : primary === "tech" ? techWork.data?.items : toTake.data?.items)?.filter((r) => r.priority === "EMERGENCY").length ?? 0;
  const count = (q: { data?: { total: number } }) => q.data?.total;
  const issuedToday = issued.data?.items.filter((r) => r.stamps.issuedAt && dayOf(r.stamps.issuedAt) === today).length;
  const criticalNow = toReview.data?.items.filter((r) => r.critical).length;
  const techBy = (s: string) => techWork.data?.items.filter((r) => r.status === s).length;
  const tiles: { icon: IconName; tone: Tone; value: React.ReactNode; label: string; note?: string; noteTone?: "rose" | "amber"; href: string }[] = [];
  if (review) {
    tiles.push({ icon: "hourglass", tone: "amber", value: count(toReview), label: "Reports to review", note: emergencies ? `${emergencies} emergency` : undefined, noteTone: "rose", href: "/lims?tab=review" });
    tiles.push({ icon: "alarm", tone: "rose", value: criticalNow, label: "Critical results", href: "/lims?tab=critical" });
    if (!tech) tiles.push({ icon: "check", tone: "emerald", value: count(passed), label: "Passed, waiting to be issued", href: "/lims?tab=passed" });
  }
  if (tech) {
    tiles.push({ icon: "check", tone: "emerald", value: techBy("PASSED"), label: "Reports ready to issue", href: "/lims?tab=issue" });
    tiles.push({ icon: "tube", tone: "rose", value: techBy("COLLECTED"), label: "Samples to accept", note: emergencies ? `${emergencies} emergency` : undefined, noteTone: "rose", href: "/lims?tab=accept" });
    tiles.push({ icon: "flask", tone: "violet", value: techBy("IN_PROCESS"), label: "Results to enter", href: "/lims?tab=work" });
  }
  if (collect) {
    tiles.push({ icon: "tube", tone: "rose", value: readyNow, label: "Samples to take now", note: !tech && !review && emergencies ? `${emergencies} emergency` : undefined, noteTone: "rose", href: "/lims?tab=all" });
    tiles.push({ icon: "clipboard", tone: "brand", value: count(mine), label: "Assigned to me", href: "/lims?tab=mine" });
    if (!tech && !review) tiles.push({ icon: "handover", tone: "sky", value: count(taken), label: "Taken, with the lab", href: "/lims?tab=done" });
  }
  if (review || tech) tiles.push({ icon: "receipt", tone: "sky", value: issuedToday, label: "Issued today", href: review && !tech ? "/lims?tab=issued" : "/lims?tab=issue" });

  // Shortcuts: the lists used all day, one click from here. Links to other pages appear only if the person's menu has that page.
  const menu = new Set(visibleNav(new Set(me.permissions), features, me.roles).map((n) => n.href));
  const shortcuts: Shortcut[] = [
    { href: "/lims?tab=review", label: "To review", icon: "hourglass", tone: "amber", show: review },
    { href: "/lims?tab=critical", label: "Critical results", icon: "alarm", tone: "rose", show: review },
    { href: "/lims?tab=passed", label: "Waiting to be issued", icon: "check", tone: "emerald", show: review && !tech },
    { href: "/lims?tab=work", label: "Enter results", icon: "flask", tone: "violet", show: tech },
    { href: "/lims?tab=accept", label: "Accept samples", icon: "tube", tone: "rose", show: tech },
    { href: "/lims?tab=issue", label: "Issue reports", icon: "check", tone: "emerald", show: tech },
    { href: "/lims?tab=qc", label: "Quality control", icon: "pulse", tone: "sky", show: tech && can("LIMS_QC") },
    { href: "/lims?tab=all", label: "Samples to take", icon: "tube", tone: "rose", show: collect },
    { href: "/lims?tab=mine", label: "Assigned to me", icon: "clipboard", tone: "brand", show: collect },
    { href: "/lims?tab=done", label: "Taken, with the lab", icon: "handover", tone: "sky", show: collect && !tech },
    { href: "/nursing", label: "Ward and tasks", icon: "bed", tone: "violet", show: collect && menu.has("/nursing") },
    { href: "/patients", label: "Patients", icon: "user", tone: "brand", show: menu.has("/patients") },
    { href: "/lims?tab=tests", label: "Tests and ranges", icon: "list", tone: "sky", show: review && can("LAB_MASTERS") },
  ];
  const shown = shortcuts.filter((s) => s.show).slice(0, 6);
  const title = review ? (can("RAD_REPORT") && !can("LAB_VERIFY") ? "Radiologist Dashboard" : "Pathologist Dashboard") : tech ? "Technician Dashboard" : "Nurse Dashboard";
  const sub = primary === "review" ? "Reports to review" : primary === "tech" ? "Your next jobs: reports to issue first, then new samples" : "Samples to take";

  return (
    <div ref={fit.ref} style={fit.height ? { height: fit.height } : undefined} className="flex flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold text-slate-900">{t(title)}</h1>
          <p className="flex items-center gap-2 text-sm text-slate-600">
            <Icon name="calendar" className="h-4 w-4 text-slate-500" />
            <span>{new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(now)}</span>
            <span className="text-slate-500">|</span>
            <span>{new Intl.DateTimeFormat(locale, { timeZone: tz, timeStyle: "short" }).format(now)}</span>
          </p>
        </div>
        <p className="text-sm text-slate-500">{t("Welcome,")} <span className="font-medium text-slate-700">{me.fullName}</span></p>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        {tiles.slice(0, 5).map((x) => <StatTile key={x.label} icon={x.icon} tone={x.tone} value={x.value} label={t(x.label)} note={x.note ? t(x.note) : undefined} noteTone={x.noteTone} href={x.href} />)}
      </div>

      <div className="grid gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <Panel title={t(sub)} href={primary === "review" ? "/lims?tab=review" : primary === "tech" ? "/lims?tab=issue" : "/lims?tab=all"} viewAll={t("View All")}
          actions={doable[0] ? <span className="hidden items-center gap-1.5 text-xs text-slate-500 sm:flex">{t("Press")} <kbd className="rounded border border-slate-300 bg-slate-50 px-1.5 font-sans text-slate-700">N</kbd> {t("for the next one")}</span> : undefined}>
          {list.length === 0 ? <Empty>{loading ? t("Loading…") : t("Nothing is waiting. You are all caught up.")}</Empty> : (
            <table className="w-full text-sm">
              <thead><tr><th className={th}>{t("Patient")}</th><th className={th}>{t("Test")}</th><th className={th}>{t("Stage")}</th><th className={th}>{t("Due")}</th><th className={th} /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {list.map((r, i) => {
                  const step = nextStep(r);
                  const blocked = r.status === "PENDING_COLLECTION" && notHere(r);
                  return (
                    <tr key={r.id} className={clsx(r.priority === "EMERGENCY" && "bg-rose-50/60", i === 0 && !blocked && "ring-1 ring-inset ring-brand-200")}>
                      <td className={td}>
                        <span className="flex items-center gap-2">
                          <span className={clsx("h-8 w-1 shrink-0 rounded-full", r.priority === "EMERGENCY" ? "bg-rose-500" : r.priority === "URGENT" ? "bg-amber-400" : "bg-slate-200")} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-slate-900">{r.patient.name}</span>
                            <span className="block truncate text-xs text-slate-500">{r.patient.mrn}{r.bed ? ` · ${t("Bed")} ${r.bed.code}` : ""}</span>
                          </span>
                        </span>
                      </td>
                      <td className={td}><span className="block">{r.test}</span>{r.priority !== "ROUTINE" && <PriorityBadge p={r.priority} />}{r.critical && <span className="ml-1 text-xs font-medium text-rose-600">{t("critical")}</span>}</td>
                      <td className={td}>{blocked ? <span className={clsx("rounded-md px-1.5 py-0.5 text-[11px] font-medium", TONE.amber.pill)}>{t("not at reception yet")}</span> : <StageBadge r={r} />}</td>
                      <td className={clsx(td, "whitespace-nowrap text-xs", r.delayed ? "font-medium text-rose-600" : "text-slate-500")}>{time(r.dueAt)}{r.delayed ? ` · ${t("late")}` : ""}</td>
                      <td className={clsx(td, "text-right")}>{blocked ? null : <Button variant={i === 0 ? "primary" : "secondary"} onClick={() => setOpen(r)}>{t(step.label)}</Button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <aside className="grid min-w-0 content-start gap-3 sm:grid-cols-2 xl:flex xl:min-h-0 xl:flex-col">
          <Panel title={t("Shortcuts")} className="xl:shrink-0">
            <div className="grid grid-cols-2 gap-2">
              {shown.map((s) => (
                <Link key={s.href + s.label} href={s.href} className={clsx("flex items-center gap-2 rounded-lg px-2.5 py-2.5 text-sm font-medium leading-tight transition", TONE[s.tone].tile)}>
                  <Icon name={s.icon} className="h-5 w-5 shrink-0" /><span>{t(s.label)}</span>
                </Link>
              ))}
            </div>
            <p className="mt-2.5 text-xs text-slate-500">{t("Tip: press")} <kbd className="rounded border px-1">/</kbd> {t("anywhere to search for a patient.")}</p>
          </Panel>
          <Panel title={t("Notifications")} className="xl:min-h-0 xl:flex-1">
            {(notes.data?.data.length ?? 0) === 0 ? <Empty>{notes.isLoading ? t("Loading…") : t("No new notifications.")}</Empty> : (
              <ul className="space-y-2.5">
                {notes.data?.data.map((n) => {
                  const k = kindOf(n.type);
                  return (
                    <li key={n.id}>
                      <Link href={hrefOf(n)} className="flex items-start gap-2.5 text-sm hover:text-brand-600">
                        <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", k.critical ? "bg-rose-500" : n.readAt ? "bg-slate-300" : "bg-brand-500")} />
                        <span className="min-w-0 flex-1 text-slate-700">{t(k.text)}</span>
                        <span className="shrink-0 text-xs text-slate-500">{ago(n.createdAt)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </aside>
      </div>

      {open && (nextStep(open).kind === "collect" ? <CollectModal req={open} onClose={() => setOpen(null)} /> : nextStep(open).kind === "tech" ? <TechModal req={open} onClose={() => setOpen(null)} /> : <ReviewModal req={open} onClose={() => setOpen(null)} />)}
    </div>
  );
}
