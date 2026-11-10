# ADR-015: An emergency patient has an `EMERGENCY` visit that becomes the inpatient visit, and one running bill

**Status:** Accepted.

## Context
ADR-006 reserved `EMERGENCY` as a future encounter type. The hospital asked for an emergency ward: a dedicated desk and nurse, a red alert to the nurse and the doctor on arrival, a bill that opens at once and collects medicines and tests, vitals the doctor can see, tests tagged emergency, and an immediate decision to the OT or ICU, with those two wards created. Out of MLP-1 scope (CLAUDE.md), so it was requested explicitly; the extras are in `docs/backlog.md`.

## Decision
1. **A new encounter type `EMERGENCY`** plus one `EmergencyCase` per visit (status, triage level, called doctor, decision) and append-only `EmergencyTriage` and `EmergencyNote`. Vitals, prescriptions and tests attach to the visit like any other, so nothing is rebuilt.
2. **On a move to the OT or ICU the same visit becomes `IPD`** and an `Admission` is created for it. The database allows exactly this change of type (EMERGENCY to IPD, only while the visit is open and has an emergency case); the identity trigger still forbids every other change. This keeps one chart through the whole episode instead of copying the emergency record into a new visit.
3. **One running bill: a draft `EMERGENCY` invoice per visit.** Medicines dispensed to the visit and laboratory tests (when the report is issued) are added as lines to the open draft (`EmergencyBillService`, serialized by locking the visit; a source is billed once). The desk issues it and collects payment with the ordinary ledger; the doctor's decision issues what is open. Once issued, nothing changes (ADR-007); a later charge opens a new draft.
4. **Laboratory origin `EMERGENCY`**: no consent, straight to the lab, emergency priority by default, sample assigned to an emergency nurse. Medicine returns before the bill is issued reduce the line; after it, the normal credit note applies.
5. **Roles by permission**: `ER_READ`, `ER_REGISTER`, `ER_TRIAGE`, `ER_TREAT`, `ER_BILL`. The doctor sees and acts on only the cases called to them (the existing doctor data scope), and only that doctor can accept, write notes or decide.
6. **The red alert** is a notification plus a bar that stays until the nurse saves the triage record or the doctor accepts, computed from the case (`GET /emergency/alerts`), so it cannot be missed or lost.

## Alternatives considered
* **A separate emergency module with its own visit and bill:** duplicates vitals, prescribing, laboratory and billing, and splits the chart.
* **A new inpatient visit at the OT or ICU, copying the emergency record:** simpler schema, but the doctor in the ICU would not see the emergency vitals, medicines and tests without a lookup, and bills and results would straddle two visits.
* **Bill each medicine and test as its own invoice:** many small bills for the desk to collect, and the cashier's test queue would double-bill.
* **Charge to an admission from the start:** there is no admission yet, and a patient may go home.

## Consequences
* An emergency patient is a normal patient everywhere else (search, record, laboratory, pharmacy, billing).
* The encounter-type trigger and the `LimsRequest` consent rule were relaxed for `EMERGENCY` in one migration.
* Reports that count visits by type now see `EMERGENCY`; none of the OPD reports count them.
