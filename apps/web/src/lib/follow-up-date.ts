/** Follow-up dates: the doctor types "after 7 days" and the date follows from today (the hospital's own day), or picks a date and the days follow. */
const DAY = 86_400_000;
const todayIn = (tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** The date (YYYY-MM-DD) that comes `days` days after today in the time zone. */
export function followUpDate(days: number, tz: string): string {
  return new Date(Date.parse(`${todayIn(tz)}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** How many days from today a date is, or undefined when it is today, in the past, or more than a year away (the consultation accepts 1 to 365). */
export function followUpDays(date: string, tz: string): number | undefined {
  const n = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayIn(tz)}T00:00:00Z`)) / DAY);
  return Number.isFinite(n) && n >= 1 && n <= 365 ? n : undefined;
}
