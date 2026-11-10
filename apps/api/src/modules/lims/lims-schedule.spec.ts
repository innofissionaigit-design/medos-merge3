import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dayLoads, earliestSlot, slotsFor, type DeptLoad } from "./lims-schedule";

const TZ = "Asia/Kolkata";
/** 10:00 on 10 Nov 2026 in India (04:30 UTC). Hours are written as India time below. */
const NOW = new Date("2026-11-10T04:30:00Z");
const ist = (hhmm: string, day = "2026-11-10") => new Date(`${day}T${hhmm}:00+05:30`);
const lab = (o: Partial<DeptLoad> = {}): DeptLoad => ({ kind: "PATHOLOGY", capacityPerHour: 2, openMinute: 480, closeMinute: 1080, backlog: 0, booked: [], ...o });

describe("lab load and the outpatient's date", () => {
  it("an empty lab gives the patient the next quarter hour", () => {
    assert.deepEqual(earliestSlot(NOW, TZ, [lab()], { PATHOLOGY: 1 })!.at, ist("10:00"));
    assert.deepEqual(earliestSlot(new Date("2026-11-10T04:37:00Z"), TZ, [lab({ capacityPerHour: 8 })], { PATHOLOGY: 1 })!.at, ist("10:15"));
  });

  it("work already waiting with no time set uses the first hours, so the date moves later as the lab gets busier", () => {
    // Two an hour: 3 waiting fill 10:00 (2) and 11:00 (1), so one place is left at 11:00 and two at 12:00.
    assert.deepEqual(earliestSlot(NOW, TZ, [lab({ backlog: 3 })], { PATHOLOGY: 1 })!.at, ist("11:00"));
    assert.deepEqual(earliestSlot(NOW, TZ, [lab({ backlog: 3 })], { PATHOLOGY: 2 })!.at, ist("12:00"));
    assert.deepEqual(earliestSlot(NOW, TZ, [lab({ backlog: 0 })], { PATHOLOGY: 2 })!.at, ist("10:00"));
    // A lab with a long queue sends the patient to another day.
    const next = earliestSlot(NOW, TZ, [lab({ backlog: 40 })], { PATHOLOGY: 1 })!.at;
    assert.ok(next.getTime() >= ist("08:00", "2026-11-11").getTime(), next.toISOString());
  });

  it("tests already booked for an hour use that hour", () => {
    const booked = [ist("10:00"), ist("10:30"), ist("11:00"), ist("11:15")];
    assert.deepEqual(earliestSlot(NOW, TZ, [lab({ booked })], { PATHOLOGY: 1 })!.at, ist("12:00"));
    assert.deepEqual(earliestSlot(NOW, TZ, [lab({ booked: [ist("10:00")] })], { PATHOLOGY: 1 })!.at, ist("10:00"), "one place is still free in that hour");
  });

  it("after closing, or in the last minutes of an hour, the patient is given the next hour with room", () => {
    assert.deepEqual(earliestSlot(new Date("2026-11-10T14:30:00Z"), TZ, [lab()], { PATHOLOGY: 1 })!.at, ist("08:00", "2026-11-11"), "20:00 is after closing");
    // At 10:40 only a third of the hour is left, which rounds down to no place at two an hour.
    assert.deepEqual(earliestSlot(new Date("2026-11-10T05:10:00Z"), TZ, [lab()], { PATHOLOGY: 1 })!.at, ist("11:00"));
  });

  it("a patient who needs two departments is given an hour in which both have room", () => {
    const path = lab();
    const rad = lab({ kind: "RADIOLOGY", capacityPerHour: 1, booked: [ist("10:00"), ist("11:00")] });
    const s = earliestSlot(NOW, TZ, [path, rad], { PATHOLOGY: 1, RADIOLOGY: 1 })!;
    assert.deepEqual(s.at, ist("12:00"));
    assert.deepEqual(s.byDepartment.map((d) => d.kind).sort(), ["PATHOLOGY", "RADIOLOGY"]);
    // A department that is not needed does not hold the patient back.
    assert.deepEqual(earliestSlot(NOW, TZ, [path, rad], { PATHOLOGY: 1 })!.at, ist("10:00"));
  });

  it("asking for more tests than a department takes in an hour asks for a whole hour, and a department with no room at all gives nothing", () => {
    assert.deepEqual(earliestSlot(NOW, TZ, [lab({ capacityPerHour: 2 })], { PATHOLOGY: 9 })!.at, ist("10:00"));
    assert.equal(earliestSlot(NOW, TZ, [lab({ backlog: 10_000 })], { PATHOLOGY: 1 }, 3), null);
    assert.deepEqual(earliestSlot(NOW, TZ, [lab()], {})!.at, ist("10:00"), "nothing needed, nothing to wait for");
  });

  it("the working hours make the grid", () => {
    const slots = slotsFor(NOW, TZ, lab({ openMinute: 9 * 60, closeMinute: 12 * 60 }), 1);
    assert.deepEqual(slots.map((s) => s.start.toISOString()), [ist("10:00").toISOString(), ist("11:00").toISOString()], "9:00 is already past, and the last hour ends at 12:00");
  });

  it("the load of a day is what is booked (and, today, waiting) against what the lab can take", () => {
    const d = dayLoads(NOW, TZ, lab({ booked: [ist("10:00"), ist("11:00"), ist("09:00", "2026-11-11")], backlog: 2 }), 3);
    assert.deepEqual(d.map((x) => x.date), ["2026-11-10", "2026-11-11", "2026-11-12"]);
    assert.equal(d[0]!.capacity, 16, "10:00 to 18:00 at two an hour");
    assert.equal(d[1]!.capacity, 20);
    assert.deepEqual([d[0]!.booked, d[0]!.backlog, d[0]!.percent], [2, 2, 25]);
    assert.deepEqual([d[1]!.booked, d[1]!.percent], [1, 5]);
  });
});
