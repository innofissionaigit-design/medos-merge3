/** Minutes after local midnight, written the way people read a clock: 420 is "07:00". */
export const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** 420 is "7:00 AM", 720 is "12:00 PM", 0 is "12:00 AM". */
export function clock12(minutes: number): string {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The two round times every facility starts with (the coordinator may change them). */
export const DEFAULT_ROUND_SLOTS: readonly { label: string; minutesOfDay: number }[] = [
  { label: "Morning round", minutesOfDay: 7 * 60 },
  { label: "Noon round", minutesOfDay: 12 * 60 },
];

/** A round that was due more than this long ago is not made due now (the server may have been off); the doctor is told only for the recent past. */
export const ROUND_FIRE_WINDOW_MIN = 6 * 60;

/** The label on a nursing task made from a doctor's instruction. */
export const INSTRUCTION_SOURCE = "ROUNDNOTE";
