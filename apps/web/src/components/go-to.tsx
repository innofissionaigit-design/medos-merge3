"use client";
import Link from "next/link";
import { Card, Spinner } from "@/components/ui";
import { Icon, type IconName } from "@/components/dashboard-kit";
import { useT } from "@/lib/i18n";
import { NAV_ICON, NAV_SECTION, SECTION_TONE, type NavItem } from "@/lib/nav";

const ORDER = ["Overview", "Front desk and OPD", "Emergency and critical care", "Inpatient", "Laboratory", "Billing and insurance", "Pharmacy and stores", "Management"];

/** The "Go to" panel of a dashboard: every screen the person may open, in the same sections as the side menu. */
export function GoToPanel({ items }: { items: NavItem[] }) {
  const t = useT();
  const groups = ORDER.map((title) => ({ title, items: items.filter((n) => (NAV_SECTION[n.href] ?? "Management") === title) })).filter((g) => g.items.length > 0);
  return (
    <Card title={t("Go to")} className="mt-4">
      {items.length === 0 ? <Spinner /> : (
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => (
            <section key={g.title} aria-label={t(g.title)}>
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">{t(g.title)}</h3>
              <div className="grid grid-cols-2 gap-2">
                {g.items.map((n) => (
                  <Link key={n.href} href={n.href} className="group flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${(SECTION_TONE[g.title] ?? SECTION_TONE.Management)!.chip}`}><Icon name={(NAV_ICON[n.href] ?? "list") as IconName} className="h-4 w-4" /></span>
                    <span className="min-w-0 truncate font-medium group-hover:text-brand-700">{t(n.label)}</span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <p className="mt-4 text-xs text-slate-500">{t("Tip: press")} <kbd className="rounded border px-1">/</kbd> {t("anywhere to search for a patient.")}</p>
    </Card>
  );
}
