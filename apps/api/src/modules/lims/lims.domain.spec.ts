import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_ROLES } from "@medos/shared";
import {
  addMinutes, average, canMove, clockStart, departmentKindOf, isDelayed, LIMS_STATUSES, PRIORITY_RANK, percentile, qcResultFrom, reportReadyText, scheduledText, targetMinutes, turnaroundMinutes,
} from "./lims.domain";

const targets = { routineTatMinutes: 1440, urgentTatMinutes: 360, emergencyTatMinutes: 60 };

describe("LIMS rules", () => {
  it("a request only moves forward along the allowed steps (the same steps the database enforces)", () => {
    const path = ["PENDING_COLLECTION", "COLLECTED", "IN_PROCESS", "PENDING_REVIEW", "PASSED", "ISSUED", "HANDED_OVER"] as const;
    for (let i = 0; i < path.length - 1; i++) assert.ok(canMove(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`);
    // Back-steps that exist: a rejected sample is taken again, and review can send the work back to the technician.
    assert.ok(canMove("COLLECTED", "PENDING_COLLECTION"));
    assert.ok(canMove("IN_PROCESS", "PENDING_COLLECTION"));
    assert.ok(canMove("PENDING_REVIEW", "IN_PROCESS"));
    // Everything else is refused: skipping a step, undoing a released report, leaving a final state.
    assert.ok(!canMove("PENDING_COLLECTION", "IN_PROCESS"));
    assert.ok(!canMove("COLLECTED", "PENDING_REVIEW"));
    assert.ok(!canMove("IN_PROCESS", "PASSED"));
    assert.ok(!canMove("PASSED", "IN_PROCESS"));
    assert.ok(!canMove("ISSUED", "PASSED"));
    assert.ok(!canMove("PASSED", "CANCELLED"));
    assert.ok(!canMove("PENDING_REVIEW", "CANCELLED"));
    for (const from of ["HANDED_OVER", "CANCELLED"] as const) for (const to of LIMS_STATUSES) assert.ok(!canMove(from, to), `${from} -> ${to}`);
  });

  it("an emergency sorts before urgent, which sorts before routine", () => {
    assert.ok(PRIORITY_RANK.EMERGENCY < PRIORITY_RANK.URGENT && PRIORITY_RANK.URGENT < PRIORITY_RANK.ROUTINE);
  });

  it("the turnaround target comes from the priority; only a routine test uses the test's own turnaround", () => {
    assert.equal(targetMinutes(targets, "EMERGENCY", 48), 60);
    assert.equal(targetMinutes(targets, "URGENT", 48), 360);
    assert.equal(targetMinutes(targets, "ROUTINE", null), 1440);
    assert.equal(targetMinutes(targets, "ROUTINE", 4), 240);
    assert.equal(targetMinutes({ ...targets, urgentTatMinutes: 2000 }, "URGENT", null), 1440, "an urgent target is never longer than the routine one");
  });

  it("a request is delayed while open past its due time, or when it was issued after it", () => {
    const due = new Date("2026-11-09T10:00:00Z");
    assert.equal(isDelayed({ status: "IN_PROCESS", dueAt: due, issuedAt: null }, new Date("2026-11-09T09:59:00Z")), false);
    assert.equal(isDelayed({ status: "IN_PROCESS", dueAt: due, issuedAt: null }, new Date("2026-11-09T10:01:00Z")), true);
    assert.equal(isDelayed({ status: "ISSUED", dueAt: due, issuedAt: new Date("2026-11-09T09:00:00Z") }, new Date("2026-11-12T00:00:00Z")), false);
    assert.equal(isDelayed({ status: "ISSUED", dueAt: due, issuedAt: new Date("2026-11-09T11:00:00Z") }, new Date("2026-11-09T11:30:00Z")), true);
    assert.equal(isDelayed({ status: "CANCELLED", dueAt: due, issuedAt: null }, new Date("2027-01-01T00:00:00Z")), false);
  });

  it("the clock starts at the time the patient was asked to come, if that is later than the order", () => {
    const created = new Date("2026-11-09T08:00:00Z");
    assert.deepEqual(clockStart({ createdAt: created, scheduledFor: null }), created);
    assert.deepEqual(clockStart({ createdAt: created, scheduledFor: new Date("2026-11-10T08:00:00Z") }), new Date("2026-11-10T08:00:00Z"));
    assert.deepEqual(clockStart({ createdAt: created, scheduledFor: new Date("2026-11-08T08:00:00Z") }), created);
    assert.deepEqual(addMinutes(created, 90), new Date("2026-11-09T09:30:00Z"));
  });

  it("turnaround, average and percentiles", () => {
    assert.equal(turnaroundMinutes(new Date("2026-11-09T08:00:00Z"), new Date("2026-11-09T09:30:00Z")), 90);
    assert.equal(average([]), null);
    assert.equal(average([10, 20, 30]), 20);
    assert.equal(percentile([], 90), null);
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
    assert.equal(percentile([7], 99), 7);
  });

  it("a quality-control result is worked out from the numbers and their limits", () => {
    assert.equal(qcResultFrom(5, 4, 6), "PASS");
    assert.equal(qcResultFrom(4, 4, 6), "PASS");
    assert.equal(qcResultFrom(3.99, 4, 6), "FAIL");
    assert.equal(qcResultFrom(6.01, 4, 6), "FAIL");
    assert.equal(qcResultFrom(9, null, 10), "PASS");
    assert.equal(qcResultFrom(11, null, 10), "FAIL");
    assert.equal(qcResultFrom(null, 4, 6), null);
    assert.equal(qcResultFrom(5, null, null), null);
  });

  it("only laboratory and imaging tests belong to a LIMS department", () => {
    assert.equal(departmentKindOf("LABORATORY"), "PATHOLOGY");
    assert.equal(departmentKindOf("RADIOLOGY"), "RADIOLOGY");
    assert.equal(departmentKindOf("CARDIOLOGY"), null);
    assert.equal(departmentKindOf("PROCEDURE"), null);
  });

  it("messages to the patient name the department, never the test, and never a result", () => {
    const text = scheduledText({ firstName: "Asha", facility: "City Hospital", departments: ["laboratory"], when: "12 Nov 2026, 9:00 am", instructions: "Come fasting for 8 hours.", requestNumbers: ["LRQ-2026-000001"] });
    assert.match(text, /Asha/);
    assert.match(text, /laboratory test at City Hospital/);
    assert.match(text, /12 Nov 2026, 9:00 am/);
    assert.match(text, /Come fasting for 8 hours/);
    assert.match(text, /LRQ-2026-000001/);
    assert.doesNotMatch(text, /blood|glucose|haemoglobin/i);
    assert.match(scheduledText({ firstName: "Asha", facility: "X", departments: ["laboratory", "imaging"], when: null, instructions: null, requestNumbers: ["A", "B"] }), /laboratory and imaging test/);
    assert.match(reportReadyText({ firstName: "Asha", facility: "City Hospital", requestNumbers: ["LRQ-1"] }), /ready at City Hospital.*not sent by message/);
  });

  it("the built-in roles split the work as designed: managers never pass clinical results", () => {
    const manager = SYSTEM_ROLES["LIMS_MANAGER"]!;
    const admin = SYSTEM_ROLES["ADMINISTRATOR"]!;
    const hospitalManager = SYSTEM_ROLES["MANAGER"]!;
    for (const forbidden of ["LAB_VERIFY", "RAD_REPORT", "LAB_RESULT", "RAD_PERFORM", "LAB_COLLECT"] as const) {
      assert.ok(!manager.includes(forbidden), `LIMS_MANAGER must not hold ${forbidden}`);
      assert.ok(!admin.includes(forbidden), `ADMINISTRATOR must not hold ${forbidden}`);
      assert.ok(!hospitalManager.includes(forbidden), `MANAGER must not hold ${forbidden}`);
    }
    // The administrator and the hospital manager see the same laboratory monitoring.
    for (const p of ["LIMS_READ", "LIMS_REPORTS", "LAB_READ", "RAD_READ"] as const) {
      assert.ok(admin.includes(p) && hospitalManager.includes(p), p);
    }
    assert.ok(admin.includes("LIMS_DEPARTMENTS") && admin.includes("LAB_MASTERS") && admin.includes("ADMIN_USERS") && admin.includes("AUDIT_READ"));
    assert.ok(manager.includes("LIMS_ASSIGN") && manager.includes("LIMS_MANAGE") && manager.includes("LIMS_QC"));
    // Technicians prepare and issue; the specialists pass; only a nurse takes samples.
    assert.ok(SYSTEM_ROLES["P_LAB_TECH"]!.includes("LAB_RESULT") && SYSTEM_ROLES["P_LAB_TECH"]!.includes("LIMS_ISSUE") && !SYSTEM_ROLES["P_LAB_TECH"]!.includes("LAB_VERIFY"));
    assert.ok(SYSTEM_ROLES["R_LAB_TECH"]!.includes("RAD_PERFORM") && SYSTEM_ROLES["R_LAB_TECH"]!.includes("LIMS_ISSUE") && !SYSTEM_ROLES["R_LAB_TECH"]!.includes("RAD_REPORT"));
    assert.ok(!SYSTEM_ROLES["P_LAB_TECH"]!.includes("RAD_READ") && !SYSTEM_ROLES["R_LAB_TECH"]!.includes("LAB_READ"), "each technician sees only their own department");
    assert.ok(SYSTEM_ROLES["NURSE"]!.includes("LIMS_COLLECT") && !SYSTEM_ROLES["P_LAB_TECH"]!.includes("LIMS_COLLECT") && !SYSTEM_ROLES["R_LAB_TECH"]!.includes("LIMS_COLLECT"));
    assert.ok(SYSTEM_ROLES["PATHOLOGIST"]!.includes("LAB_VERIFY") && SYSTEM_ROLES["RADIOLOGIST"]!.includes("RAD_REPORT"));
    assert.ok(SYSTEM_ROLES["DOCTOR"]!.includes("LIMS_ORDER") && SYSTEM_ROLES["RECEPTIONIST"]!.includes("LIMS_REQUEST") && !SYSTEM_ROLES["DOCTOR"]!.includes("LIMS_REQUEST"));
  });
});
