"use client";
import clsx from "clsx";
import Link from "next/link";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Shared building blocks of the role dashboards (reception, lab desk): icons, tones, stat tiles, panels, and fitting the dashboard to the screen. */

// ───────────────────────── icons (inline, stroke-based) ─────────────────────────

const PATHS = {
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0",
  userPlus: "M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 12.5-4.3M19 14v6m-3-3h6",
  calendar: "M7 3v3m10-3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3 7h2m4 0h2m-8 4h2m4 0h2",
  calendarPlus: "M7 3v3m10-3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm7 7v6m-3-3h6",
  bed: "M3 18V7m0 7h18v4M3 14V11a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3m10 0v-2a3 3 0 0 0-3-3h-7",
  siren: "M7 18v-5a5 5 0 0 1 10 0v5M5 18h14v3H5zM12 3v2m7.1 1.9-1.4 1.4M4.9 6.9l1.4 1.4M12 13v2",
  pulse: "M3 12h4l2-5 4 10 2-5h6",
  percent: "M19 5 5 19M7.5 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm9 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  clipboard: "M9 4h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M9 14l2 2 4-4",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6m-6 4h6m-6 4h3",
  flask: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9",
  hospital: "M4 21V6a1 1 0 0 1 1-1h5V3h4v2h5a1 1 0 0 1 1 1v15M2 21h20M12 8v4m-2-2h4M8 15h2m4 0h2M10 21v-3h4v3",
  tube: "M9 3h6m-5 0v14a2 2 0 0 0 4 0V3M10 11h4",
  hourglass: "M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9m10 0c0-5-10-5-10-9s10-4 10-9",
  check: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-4-9 3 3 5-6",
  alarm: "M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-12v4l2.5 2M4 4 2 6m18-2 2 2",
  plus: "M12 5v14m-7-7h14",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  handover: "M4 14h4l3 3h5a2 2 0 0 0 0-4h-3m-9 1v6m9-11 3-3 3 3m-3-3v8",
  print: "M7 9V3h10v6M6 18H4v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7h-2M7 14h10v7H7z",
  download: "M12 4v11m-4-4 4 4 4-4M5 20h14",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zm4 4h4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4 4",
  filter: "M4 5h16l-6 7v6l-4 2v-8z",
  grid: "M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z",
  chevronDown: "m6 9 6 6 6-6",
  chevronLeft: "m15 6-6 6 6 6",
  chevronRight: "m9 6 6 6-6 6",
  arrowUp: "M12 19V5m-6 6 6-6 6 6",
  arrowDown: "M12 5v14m-6-6 6 6 6-6",
} as const;
export type IconName = keyof typeof PATHS;
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={clsx("h-5 w-5", className)}>
      <path d={PATHS[name]} />
    </svg>
  );
}

// ───────────────────────── tones ─────────────────────────

export const TONE = {
  brand: { chip: "bg-brand-50 text-brand-600", tile: "bg-brand-50 hover:bg-brand-100 text-brand-700", pill: "bg-brand-50 text-brand-700" },
  violet: { chip: "bg-violet-50 text-violet-600", tile: "bg-violet-50 hover:bg-violet-100 text-violet-700", pill: "bg-violet-50 text-violet-700" },
  rose: { chip: "bg-rose-50 text-rose-600", tile: "bg-rose-50 hover:bg-rose-100 text-rose-700", pill: "bg-rose-50 text-rose-700" },
  emerald: { chip: "bg-emerald-50 text-emerald-600", tile: "bg-emerald-50 hover:bg-emerald-100 text-emerald-700", pill: "bg-emerald-50 text-emerald-700" },
  amber: { chip: "bg-amber-50 text-amber-600", tile: "bg-amber-50 hover:bg-amber-100 text-amber-700", pill: "bg-amber-50 text-amber-700" },
  sky: { chip: "bg-sky-50 text-sky-600", tile: "bg-sky-50 hover:bg-sky-100 text-sky-700", pill: "bg-sky-50 text-sky-700" },
} as const;
export type Tone = keyof typeof TONE;

// ───────────────────────── fitting the screen ─────────────────────────

/** Below this height the screen is too short to fit everything; the page scrolls as usual instead of squeezing the panels. */
const MIN_FIT_HEIGHT = 560;

/**
 * On wide screens (≥1280px) the dashboard takes exactly the height left under the top bar, so staff see everything without scrolling;
 * a long list scrolls inside its own panel. It re-measures when the window resizes or an alert bar appears above the page.
 */
export function useFitToScreen<T extends HTMLElement>(minWidth = 1280) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wide = window.matchMedia(`(min-width: ${minWidth}px)`);
    const main = el.closest("main");
    const measure = () => {
      if (!wide.matches) { setHeight(null); return; }
      const pad = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(MIN_FIT_HEIGHT, Math.floor(window.innerHeight - top - pad)));
    };
    measure();
    window.addEventListener("resize", measure);
    wide.addEventListener("change", measure);
    // Alert bars and notices above the page come and go: watch what sits above the dashboard.
    const shell = main?.parentElement;
    const mo = shell ? new MutationObserver(measure) : null;
    if (shell && mo) mo.observe(shell, { childList: true });
    return () => { window.removeEventListener("resize", measure); wide.removeEventListener("change", measure); mo?.disconnect(); };
  }, [minWidth]);
  return { ref, height };
}

// ───────────────────────── small building blocks ─────────────────────────

/** A dashboard panel. "View All" is a link (`href`) or, inside a page with tabs, a button (`onViewAll`). `actions` sits beside the title. */
export function Panel({ title, href, onViewAll, viewAll, actions, children, className }: { title: string; href?: string; onViewAll?: () => void; viewAll?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("flex min-h-0 min-w-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm", className)}>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pb-1.5 pt-3">
        <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
        <div className="flex items-center gap-3">
          {actions}
          {viewAll && href && <Link href={href} className="text-sm font-medium text-brand-600 hover:underline">{viewAll}</Link>}
          {viewAll && !href && onViewAll && <button type="button" onClick={onViewAll} className="text-sm font-medium text-brand-600 hover:underline">{viewAll}</button>}
        </div>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 pb-3">{children}</div>
    </section>
  );
}

const NOTE_TONES = { gray: "bg-slate-100 text-slate-600", brand: TONE.brand.pill, rose: TONE.rose.pill, emerald: TONE.emerald.pill, violet: TONE.violet.pill, amber: TONE.amber.pill } as const;

/** One number with its label: a link (`href`) or, inside a page with tabs, a button (`onClick`). */
export function StatTile({ icon, tone, value, label, note, noteTone = "gray", href, onClick }: { icon: IconName; tone: Tone; value: ReactNode; label: string; note?: ReactNode; noteTone?: keyof typeof NOTE_TONES; href?: string; onClick?: () => void }) {
  const cls = "group flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-left shadow-sm transition hover:border-brand-500 hover:shadow";
  const body = (
    <>
      <span className={clsx("grid h-10 w-10 shrink-0 place-items-center rounded-xl", TONE[tone].chip)}><Icon name={icon} className="h-5 w-5" /></span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="text-xl font-semibold leading-tight text-slate-900">{value ?? <span className="text-slate-300">…</span>}</span>
          {note !== undefined && note !== null && <span className={clsx("truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium", NOTE_TONES[noteTone])}>{note}</span>}
        </span>
        <span className="block text-sm leading-tight text-slate-600">{label}</span>
      </span>
    </>
  );
  return href ? <Link href={href} className={cls}>{body}</Link> : <button type="button" onClick={onClick} className={cls}>{body}</button>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500">{children}</p>;
}

export const th = "px-2 py-2 text-left text-xs font-medium text-slate-500";
export const td = "px-2 py-2 align-middle";
