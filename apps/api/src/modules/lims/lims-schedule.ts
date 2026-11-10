import { localDateStr, zonedToUtc } from "../../common/time";
import type { DepartmentKind } from "./lims.domain";

/**
 * Lab load and the outpatient's date (docs/lims-portal.md). A department takes `capacityPerHour` outpatient tests in each working hour. Work already waiting with no time
 * set (inpatients, walk-ins, emergencies) uses the first hours that are left; tests already booked for a time use their hour. An outpatient is given the first hour in which
 * every department they need has room, so the date depends on how busy the labs are. Pure functions: the service gathers the numbers.
 */
export interface DeptLoad {
  kind: DepartmentKind;
  capacityPerHour: number;
  /** Working hours, in minutes after local midnight. */
  openMinute: number;
  closeMinute: number;
  /** Open requests that have no time set; they use up the first hours that are free. */
  backlog: number;
  /** The times open requests are booked for. */
  booked: readonly Date[];
}

export interface Slot { start: Date; end: Date; capacity: number; booked: number; free: number }

const HOUR = 3_600_000;

/** The department's working hours as hourly slots from now, `days` days ahead, with what is booked and what is left (the backlog is spread over the first free capacity). */
export function slotsFor(now: Date, tz: string, d: DeptLoad, days: number): Slot[] {
  const out: Slot[] = [];
  let backlogLeft = d.backlog;
  const firstHour = Math.floor(d.openMinute / 60) * 60;
  for (let offset = 0; offset < days; offset++) {
    const date = localDateStr(new Date(now.getTime() + offset * 24 * HOUR), tz);
    for (let m = firstHour; m + 60 <= d.closeMinute; m += 60) {
      const start = zonedToUtc(date, m, tz);
      const end = new Date(start.getTime() + HOUR);
      if (end.getTime() <= now.getTime()) continue;
      // The part of the current hour that is left counts, rounded down.
      const left = Math.min(1, (end.getTime() - Math.max(start.getTime(), now.getTime())) / HOUR);
      const capacity = Math.floor(d.capacityPerHour * left);
      const booked = d.booked.filter((t) => t.getTime() >= start.getTime() && t.getTime() < end.getTime()).length;
      const roomBeforeBacklog = Math.max(0, capacity - booked);
      const fromBacklog = Math.min(backlogLeft, roomBeforeBacklog);
      backlogLeft -= fromBacklog;
      out.push({ start, end, capacity, booked, free: roomBeforeBacklog - fromBacklog });
    }
  }
  return out;
}

const ceilTo = (t: Date, minutes: number): Date => new Date(Math.ceil(t.getTime() / (minutes * 60_000)) * minutes * 60_000);

export interface Suggestion { at: Date; byDepartment: { kind: DepartmentKind; hourStart: Date; free: number }[] }

/**
 * The first time (on a quarter hour, never in the past) in which every department that is needed has room for its tests. `need` is how many tests each department
 * must take (a department asked for more than it can take in an hour is asked for a full hour). Null when there is no room within `days` days.
 */
export function earliestSlot(now: Date, tz: string, loads: readonly DeptLoad[], need: Partial<Record<DepartmentKind, number>>, days = 14): Suggestion | null {
  const needed = loads.filter((l) => (need[l.kind] ?? 0) > 0);
  if (needed.length === 0) return { at: ceilTo(now, 15), byDepartment: [] };
  const grids = needed.map((l) => ({ l, slots: slotsFor(now, tz, l, days), need: Math.min(need[l.kind] ?? 1, l.capacityPerHour) }));
  const starts = [...new Set(grids.flatMap((g) => g.slots.map((s) => s.start.getTime())))].sort((a, b) => a - b);
  for (const t of starts) {
    const picked = grids.map((g) => ({ g, slot: g.slots.find((s) => s.start.getTime() <= t && t < s.end.getTime()) }));
    if (picked.every((p) => p.slot && p.slot.free >= p.g.need)) {
      const at = new Date(Math.max(ceilTo(now, 15).getTime(), t));
      return { at, byDepartment: picked.map((p) => ({ kind: p.g.l.kind, hourStart: (p.slot as Slot).start, free: (p.slot as Slot).free })) };
    }
  }
  return null;
}

export interface DayLoad { date: string; capacity: number; booked: number; backlog: number; percent: number }

/** The load of each of the next days: tests booked (and, for today, work waiting) against what the department can take in its working hours. */
export function dayLoads(now: Date, tz: string, d: DeptLoad, days: number): DayLoad[] {
  const slots = slotsFor(now, tz, { ...d, backlog: 0 }, days);
  const byDate = new Map<string, DayLoad>();
  for (let offset = 0; offset < days; offset++) {
    const date = localDateStr(new Date(now.getTime() + offset * 24 * HOUR), tz);
    byDate.set(date, { date, capacity: 0, booked: 0, backlog: offset === 0 ? d.backlog : 0, percent: 0 });
  }
  for (const s of slots) {
    const row = byDate.get(localDateStr(s.start, tz));
    if (row) { row.capacity += s.capacity; row.booked += s.booked; }
  }
  const today = localDateStr(now, tz);
  return [...byDate.values()].map((r) => ({ ...r, percent: r.capacity > 0 ? Math.min(100, Math.round(((r.booked + (r.date === today ? r.backlog : 0)) / r.capacity) * 100)) : 100 }));
}
