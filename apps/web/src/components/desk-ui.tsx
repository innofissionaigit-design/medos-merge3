"use client";
import { useEffect } from "react";

/** Small line icons and helpers shared by the role start screens (doctor desk, pharmacy desk). */
export type IconName = "clock" | "check" | "users" | "queue" | "patients" | "calendar" | "bed" | "video" | "chart" | "play" | "search" | "cart" | "plus" | "box" | "alert" | "hourglass" | "pill";
const ICONS: Record<IconName, string> = {
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.2a6.5 6.5 0 0 1 3.5 5.8",
  queue: "M4 6h16M4 12h16M4 18h10",
  patients: "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM4 20a8 8 0 0 1 16 0",
  calendar: "M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  bed: "M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M7 11.5h.01",
  video: "M3 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM15 11l6-3v8l-6-3",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  play: "M7 4.5v15l12-7.5-12-7.5Z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM21 21l-5-5",
  cart: "M3 4h2l2.2 10.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6M9.5 20h.01M17.5 20h.01",
  plus: "M12 5v14M5 12h14",
  box: "M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9ZM3.5 7.5 12 12l8.5-4.5M12 12v9",
  alert: "M12 4 2.8 19.5a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5L12 4ZM12 10v4.5M12 17.5h.01",
  hourglass: "M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9",
  pill: "M10.5 20.5a4.95 4.95 0 0 1-7-7l10-10a4.95 4.95 0 0 1 7 7l-10 10ZM8.5 8.5l7 7",
};
export function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  return <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}><path d={ICONS[name]} /></svg>;
}

/** Shared look of the role start screens: a soft white panel and a small key hint. */
export const PANEL = "rounded-xl border border-slate-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06),0_1px_2px_rgba(15,23,42,0.04)]";
export const KBD = "rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] font-medium text-slate-500";

export const typing = (el: EventTarget | null): boolean => el instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);

/** One key per place. Ignored while typing and when a modifier is held, so it never clashes with the browser or a text box. */
export function useDeskKeys(onKey: (key: string, e: KeyboardEvent) => void): void {
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      onKey(e.key.toUpperCase(), e);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });
}
