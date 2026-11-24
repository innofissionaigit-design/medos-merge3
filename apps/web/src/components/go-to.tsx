"use client";
import Link from "next/link";
import { Card, Spinner } from "@/components/ui";
import { Icon, type IconName } from "@/components/dashboard-kit";
import { useT } from "@/lib/i18n";
import { NAV_ICON, NAV_SECTION, SECTION_TONE, type NavItem } from "@/lib/nav";

const ORDER = ["Overview", "Front desk and OPD", "Emergency and critical care", "Inpatient", "Laboratory", "Billing and insurance", "Pharmacy and stores", "Management"];

/**
 * The "Go to" panel of a dashboard: every screen the person may open, in the same sections as the side menu.
 * Each section is its own panel with one link per line, so a full name always fits and the columns balance themselves on any width.
 */
export function GoToPanel({ items }: { items: NavItem[] }) {
  const t = useT();
  const groups = ORDER.map((title) => ({ title, items: items.filter((n) => (NAV_SECTION[n.href] ?? "Management") === title) })).filter((g) => g.items.length > 0);
  return (
    <Card title={t("Go to")} className="mt-4">
      {items.length === 0 ? <Spinner /> : (
        <div className="columns-1 gap-4 sm:columns-2 xl:columns-3">
          {groups.map((g) => {
            const tone = (SECTION_TONE[g.title] ?? SECTION_TONE.Management)!;
            return (
              <section key={g.title} aria-label={t(g.title)} className="mb-4 break-inside-avoid rounded-xl border border-slate-200 bg-slate-50/60 p-2">
                <h3 className="flex items-center gap-2 px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />{t(g.title)}
                </h3>
                <ul className="space-y-0.5">
                  {g.items.map((n) => (
                    <li key={n.href}>
                      <Link href={n.href} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm text-slate-700 transition hover:bg-white hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone.chip}`}><Icon name={(NAV_ICON[n.href] ?? "list") as IconName} className="h-4 w-4" /></span>
                        <span className="min-w-0 flex-1 font-medium leading-tight group-hover:text-brand-700">{t(n.label)}</span>
                        <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m8 5 5 5-5 5" /></svg>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      <p className="mt-1 text-xs text-slate-500">{t("Tip: press")} <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[11px]">/</kbd> {t("anywhere to search for a patient.")}</p>
    </Card>
  );
}
