"use client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { PANEL } from "./desk-ui";

interface Doc { id: string; displayName: string; specialty: string | null; departmentId?: string | null; scheduleSet: boolean }
interface Win { dayOfWeek: number; start: string; end: string; slotMinutes: number }
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// The week reads Monday to Sunday; dayOfWeek stays 0 = Sunday as the server sends it.
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** The doctors a department / doctor choice leaves: one doctor, else one department's doctors, else everyone. */
export function filterDoctors<T extends { id: string; departmentId?: string | null }>(docs: T[], departmentId: string, doctorId: string): T[] {
  if (doctorId) return docs.filter((d) => d.id === doctorId);
  if (departmentId) return docs.filter((d) => d.departmentId === departmentId);
  return docs;
}

/** Today's weekday (0 = Sunday) in the hospital's time zone, so the right column is highlighted whatever the computer's own zone is. */
function weekdayIn(tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date());
  return Math.max(0, DAYS.indexOf(name));
}

/**
 * Read-only weekly schedule of the doctors chosen by the filters above it (department, then doctor), for staff who book appointments but may not change
 * schedules (that stays with the administrator). One row per doctor: name, department and slot length on the left, and all seven weekdays side by side,
 * so nothing is cut off or needs sideways scrolling. Today's weekday is highlighted.
 */
export function DoctorSchedules({ departmentId = "", doctorId = "", title = "Doctors' weekly schedules" }: { departmentId?: string; doctorId?: string; title?: string }) {
  const t = useT();
  const { me } = useMe();
  const today = weekdayIn(me.facility?.timezone ?? me.tenant.timezone);
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doc[]>("/practitioners") });
  const depts = useQuery({ queryKey: ["departments"], queryFn: () => api.get<{ id: string; name: string }[]>("/departments") });
  const shown = filterDoctors(docs.data ?? [], departmentId, doctorId);
  const schedules = useQueries({ queries: shown.map((d) => ({ queryKey: ["schedule", d.id], queryFn: () => api.get<Win[]>(`/practitioners/${d.id}/schedule`) })) });
  const deptName = (id?: string | null) => depts.data?.find((x) => x.id === id)?.name ?? null;
  return (
    <section className={PANEL}>
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-800">{t(title)}</h2>
        {shown.length > 0 && <span className="text-xs text-slate-500">{shown.length} {t(shown.length === 1 ? "doctor" : "doctors")}</span>}
      </header>
      {docs.isLoading ? <div className="p-4"><Spinner /></div> : shown.length === 0 ? <p className="px-4 py-5 text-sm text-slate-500">{t("No doctors yet.")}</p> : (
        <ul className="divide-y divide-slate-100">
          {shown.map((d, i) => {
            const wins = schedules[i]?.data;
            const sub = deptName(d.departmentId) ?? d.specialty;
            const slots = wins ? [...new Set(wins.map((w) => w.slotMinutes))] : [];
            return (
              <li key={d.id} className="grid gap-2 px-4 py-2.5 lg:grid-cols-[200px_minmax(0,1fr)] lg:items-start lg:gap-4">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900">{d.displayName}</div>
                  {sub ? <div className="truncate text-xs text-slate-500">{sub}</div> : null}
                  {slots.length === 1 ? <span className="mt-0.5 inline-block rounded-full bg-teal-50 px-2 py-px text-[11px] font-medium text-teal-700">{slots[0]} {t("min slots")}</span> : null}
                </div>
                {schedules[i]?.isLoading ? <div className="text-xs text-slate-400">…</div>
                  : !wins || wins.length === 0 ? <div className="text-xs text-slate-500">{t(d.scheduleSet ? "Not available on any day" : "No weekly schedule: bookable at any time")}</div>
                    : (
                      <div className="grid grid-cols-4 gap-1 sm:grid-cols-7">
                        {WEEK.map((day) => {
                          const w = wins.filter((x) => x.dayOfWeek === day);
                          const isToday = day === today;
                          return (
                            <div key={day} className={`rounded-md border px-1.5 py-1 text-center ${w.length === 0 ? "border-slate-100 bg-slate-50/60" : isToday ? "border-teal-300 bg-teal-50" : "border-slate-200 bg-white"}`}>
                              <div className={`text-[10px] font-semibold uppercase tracking-wider ${isToday ? "text-teal-700" : "text-slate-400"}`}>{t(DAYS[day]!).slice(0, 3)}</div>
                              {w.length ? w.map((x) => (
                                <div key={`${x.start}-${x.end}`} className="whitespace-nowrap text-[11px] leading-tight tabular-nums text-slate-700">{x.start}–{x.end}{slots.length > 1 ? <span className="block text-[10px] text-slate-400">{x.slotMinutes} {t("min")}</span> : null}</div>
                              )) : <div className="text-[11px] leading-tight text-slate-300">–</div>}
                            </div>
                          );
                        })}
                      </div>
                    )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
