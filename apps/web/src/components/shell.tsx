"use client";
import clsx from "clsx";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ageText, type AgeValue } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { needsDesk, useDesk } from "@/lib/desk";
import { GROUP_NAV_ABOVE, NAV, NAV_ICON, NAV_SECTION, SECTION_TONE, visibleNav, type NavItem } from "@/lib/nav";
import { Icon as KitIcon, type IconName as KitIconName } from "@/components/dashboard-kit";
import { NotificationBell } from "./notifications";
import { EmergencyAlertBar } from "./emergency-alert";
import { IcuAlertBar } from "./icu-alert";
import { DeliveryToastHost } from "./delivery-toasts";
import { DeskChooser } from "./reception-desk";
import { useDebounced } from "./ui";

export interface PatientRow { id: string; mrn: string | null; firstName: string; lastName: string | null; gender: string; age: AgeValue; mobile: string | null }
export const patientName = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");

/** Global patient search: MRN, mobile or name. Press "/" anywhere to focus it. */
function GlobalSearch() {
  const router = useRouter();
  const { t } = useI18n();
  const { can } = useMe();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["global-search", term], queryFn: () => api.page<PatientRow>("/patients", { q: term, pageSize: 8 }), enabled: term.length >= 2 && can("PATIENT_READ") });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  if (!can("PATIENT_READ")) return <div />;
  const rows = res.data?.data ?? [];
  const go = (id: string) => { setOpen(false); setQ(""); router.push(`/patients/${id}`); };
  return (
    <div className="relative w-full max-w-md">
      <input
        ref={ref} value={q} placeholder={t("Search patient by MRN, mobile or name") + "   ( / )"} aria-label="Search patients"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, rows.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === "Enter" && rows[hi]) go(rows[hi]!.id);
          if (e.key === "Escape") { setOpen(false); ref.current?.blur(); }
        }}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
      {open && term.length >= 2 && (
        <ul className="absolute z-40 mt-1 max-h-80 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg" role="listbox">
          {res.isLoading && <li className="px-3 py-2 text-sm text-slate-500">Searching…</li>}
          {!res.isLoading && rows.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No patients found</li>}
          {rows.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === hi} onMouseDown={() => go(p.id)} onMouseEnter={() => setHi(i)} className={clsx("cursor-pointer px-3 py-2 text-sm", i === hi && "bg-brand-50")}>
              <span className="font-medium">{patientName(p)}</span> <span className="text-slate-500">· {p.mrn} · {p.gender.toLowerCase()}{ageText(p.age) ? `, ${ageText(p.age)}` : ""}{p.mobile ? ` · ${p.mobile}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The menu entries in their sections, keeping each person's own order: sections appear where their first entry is. */
function sections(items: NavItem[]): { title: string; items: NavItem[] }[] {
  const out: { title: string; items: NavItem[] }[] = [];
  for (const n of items) {
    const title = NAV_SECTION[n.href] ?? "More";
    const g = out.find((x) => x.title === title);
    if (g) g.items.push(n); else out.push({ title, items: [n] });
  }
  // Overview first and Management last; the others keep the order of the person's own first entries.
  const rank = (t: string) => (t === "Overview" ? 0 : t === "Management" ? 2 : 1);
  return out.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g.title) - rank(b.g.title) || a.i - b.i).map((x) => x.g);
}

function NavGlyph({ href, active, section }: { href: string; active: boolean; section: string }) {
  const name = (NAV_ICON[href] ?? "list") as KitIconName;
  const tone = (SECTION_TONE[section] ?? SECTION_TONE.Management)!;
  return (
    <span className={clsx("flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset transition", active ? "bg-brand-600 text-white ring-brand-600 shadow-sm" : `${tone.chip} ring-black/5`)}>
      <KitIcon name={name} className="h-3.5 w-3.5" />
    </span>
  );
}

/** Which sections the person has folded away; kept in this browser only, so it is a convenience and never required. */
function useFolded(): [Set<string>, (title: string) => void] {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  useEffect(() => { try { const v = localStorage.getItem("medos.nav.folded"); if (v) setFolded(new Set(JSON.parse(v) as string[])); } catch { /* the menu works without it */ } }, []);
  const toggle = (title: string) => setFolded((cur) => { const n = new Set(cur); if (n.has(title)) n.delete(title); else n.add(title); try { localStorage.setItem("medos.nav.folded", JSON.stringify([...n])); } catch { /* ignore */ } return n; });
  return [folded, toggle];
}

const initialsOf = (name: string) => name.replace(/^Dr\.?\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
const roleLabel = (r: string | undefined) => (r ? r.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "");

export function Shell({ children }: { children: ReactNode }) {
  const { me, features } = useMe();
  const { desk, choose } = useDesk();
  const router = useRouter();
  const { t } = useI18n();
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const [folded, toggleFold] = useFolded();
  const picksDesk = needsDesk(me.roles, features);
  const activeDesk = picksDesk ? (desk ?? null) : null;
  const nav = visibleNav(new Set(me.permissions), features, me.roles, activeDesk);
  // A screen that belongs to the other desk (for example the ward list at the OPD desk).
  const otherDesk = activeDesk ? NAV.find((n) => n.desk && n.desk !== activeDesk && path.startsWith(n.href)) : undefined;
  // When the server cannot be reached (it is stopped, restarting or out of disk), a click on Sign out or on a facility switch used to end in an unhandled "Failed to fetch" error.
  // The person stays where they are and is told what happened; nothing is cleared until the server has answered.
  const [netError, setNetError] = useState<string | null>(null);
  const SERVER_DOWN = "The server is not responding, so this could not be done. Check that it is running, then try again.";
  async function logout() {
    setNetError(null);
    try {
      const r = await fetch("/api/session/logout", { method: "POST", credentials: "same-origin", headers: { "x-medos-csrf": "1" } });
      if (r.status >= 500) throw new Error("server error");
    } catch {
      setNetError(SERVER_DOWN);
      return;
    }
    choose(null);
    window.location.assign("/login");
  }
  async function switchFacility(facilityId: string) {
    setNetError(null);
    try {
      const r = await fetch("/api/session/switch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-medos-csrf": "1" }, body: JSON.stringify({ facilityId }) });
      if (r.status >= 500) throw new Error("server error");
    } catch {
      setNetError(SERVER_DOWN);
      return;
    }
    window.location.assign("/dashboard");
  }
  const problem = netError ? (
    <div role="alert" className="fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-3 bg-red-600 px-4 py-2 text-sm text-white shadow">
      <span>{t(netError)}</span>
      <button type="button" className="rounded border border-white/60 px-2 py-0.5 text-xs hover:bg-red-700" onClick={() => setNetError(null)}>{t("Dismiss")}</button>
    </div>
  ) : null;
  if (picksDesk && desk === undefined) return <div className="p-6 text-slate-500">{t("Loading…")}</div>;
  if (picksDesk && desk === null) return <>{problem}<DeskChooser name={me.fullName} onChoose={(d) => { choose(d); router.push("/dashboard"); }} onSignOut={logout} /></>;
  return (
    <div className="flex min-h-screen">
      {problem}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-slate-50/70 md:flex">
        <div className="flex items-center gap-2.5 border-b border-slate-200 bg-white px-4 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white shadow-sm" aria-hidden>M</span>
          <div className="min-w-0"><div className="text-[15px] font-semibold leading-tight tracking-tight text-slate-900">MedOS</div><div className="truncate text-xs text-slate-500">{me.tenant.name}</div></div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Main">
          {(nav.length > GROUP_NAV_ABOVE ? sections(nav) : [{ title: "", items: nav }]).map((g, gi) => {
            const open = !g.title || !folded.has(g.title) || g.items.some((n) => path.startsWith(n.href));
            return (
              <div key={g.title || "all"} className={clsx(gi > 0 && "mt-3 border-t border-slate-200/80 pt-3")}>
                {g.title && (
                  <button type="button" onClick={() => toggleFold(g.title)} aria-expanded={open} className="group flex w-full items-center gap-1.5 rounded px-2 pb-1 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-400 hover:text-slate-600">
                    <span className={clsx("h-1.5 w-1.5 rounded-full", (SECTION_TONE[g.title] ?? SECTION_TONE.Management)!.dot)} aria-hidden />
                    <span className="flex-1">{t(g.title)}</span>
                    <KitIcon name="chevronDown" className={clsx("h-3 w-3 opacity-0 transition group-hover:opacity-100", !open && "-rotate-90 opacity-100")} />
                  </button>
                )}
                {open && (
                  <div className="space-y-0.5">
                    {g.items.map((n) => {
                      const on = path.startsWith(n.href);
                      const section = NAV_SECTION[n.href] ?? "Management";
                      return (
                        <Link key={n.href} href={n.href} aria-current={on ? "page" : undefined} className={clsx("group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition", on ? "bg-white font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200" : "font-medium text-slate-600 hover:bg-white hover:text-slate-900 hover:shadow-sm")}>
                          {on && <span className="absolute -left-3 top-1.5 h-6 w-[3px] rounded-r-full bg-brand-600" aria-hidden />}
                          <NavGlyph href={n.href} active={on} section={section} />
                          <span className="truncate">{t(n.label)}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="flex items-center gap-2.5 border-t border-slate-200 bg-white px-3 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 ring-1 ring-brand-100" aria-hidden>{initialsOf(me.fullName)}</span>
          <div className="min-w-0"><div className="truncate text-[13px] font-medium leading-tight text-slate-900">{me.fullName}</div><div className="truncate text-xs text-slate-500">{roleLabel(me.roles[0])}</div></div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
          <button className="rounded border border-slate-300 px-2 py-1 text-sm md:hidden" onClick={() => setMenu((m) => !m)} aria-label="Menu">☰</button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <NotificationBell />
            {me.facilities.length > 1 ? (
              <select aria-label="Facility" value={me.facility?.id ?? ""} onChange={(e) => switchFacility(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm">
                {me.facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            ) : <span className="hidden text-slate-500 sm:inline">{me.facility?.name}</span>}
            {activeDesk && (
              <select
                aria-label={t("Switch desk")}
                title={t("Switch desk")}
                value={activeDesk}
                onChange={(e) => { choose(e.target.value as "OPD" | "IPD"); router.push("/dashboard"); }}
                className="rounded border border-brand-200 bg-brand-50 px-2 py-1 text-brand-700 hover:bg-brand-100"
              >
                <option value="OPD">OPD {t("desk")}</option>
                <option value="IPD">IPD {t("desk")}</option>
              </select>
            )}
            <Link href="/account" className="hidden text-slate-700 hover:underline sm:inline" title={t("My account")}>{me.fullName}</Link>
            <button onClick={logout} className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50">{t("Sign out")}</button>
          </div>
        </header>
        {menu && (
          <nav className="border-b border-slate-200 bg-white p-2 md:hidden" aria-label="Mobile">
            {nav.map((n) => <Link key={n.href} onClick={() => setMenu(false)} href={n.href} className="block rounded px-3 py-2 text-sm hover:bg-slate-100">{t(n.label)}</Link>)}
          </nav>
        )}
        <EmergencyAlertBar />
        <IcuAlertBar />
        <main className="min-w-0 flex-1 p-4 md:p-6">
          {me.dataScope && me.dataScope.kind !== "ALL" && (
            <p className="mb-3 rounded border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-slate-700" data-testid="scope-note">
              {me.dataScope.kind === "DOCTOR" ? t("You see only your own patients, records and reports.") : `${t("You see only the data of your department:")} ${me.dataScope.departments.map((d) => d.name).join(", ")}`}
            </p>
          )}
          {otherDesk && activeDesk ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
              <h1 className="font-medium">{otherDesk.label} {t("belongs to the")} {activeDesk === "OPD" ? "IPD" : "OPD"} {t("desk")}.</h1>
              <p className="mt-1 text-slate-700">{t("You are at the")} {activeDesk} {t("desk. Switch desk to open it.")}</p>
              <button type="button" className="mt-3 rounded border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50" onClick={() => { choose(null); router.push("/dashboard"); }}>{t("Switch desk")}</button>
            </div>
          ) : children}
        </main>
      </div>
      <DeliveryToastHost />
    </div>
  );
}
