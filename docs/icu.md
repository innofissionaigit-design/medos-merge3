# Intensive care unit (ICU)

The ICU is built inside the main app, with role-based access only (no separate portal or sign-in). It continues the emergency workflow (`docs/emergency.md`): the emergency doctor hands the patient over, and the ICU doctor and ICU nurse work from one board and one page per patient.

## The people

| Role | What it does | Permissions it adds |
|---|---|---|
| `ICU_DOCTOR` | Takes over the patient, sets how often vitals are taken, writes instructions for the nurse and the day-by-day record, orders tests, prescribes and signs, **accepts or declines the nurse's requests**, starts and stops equipment, adds charges, and discharges with the discharge summary. Sees only the patients under their care. Has **no** OPD queue, appointments, video consultations, reports, nursing worklist or general admissions list: the patient's admission is opened from the ICU page. | `ICU_READ`, `ICU_DOCTOR`, patient read, vitals, allergies, prescribing and signing, `LIMS_ORDER`/`LIMS_PRIORITY`, lab and imaging read, consultation read/create/sign/amend (discharge summary), `ADMISSION_READ`, `ADMISSION_DISCHARGE`, `NURSING_READ`, `CHARGE_CREATE` |
| `ICU_NURSE` | Records the vitals, carries out and ticks off the doctor's instructions, starts and stops equipment, takes the samples of the ICU patients' tests, gives medicines (nursing worklist), adds procedure charges, and **asks the doctor** for a test or a medicine (`docs/emergency.md`, *Nurse requests*). Has **no** OPD queue, reports or general admissions list. | `ICU_READ`, `ICU_NURSE`, `ORDER_REQUEST` + the nursing permissions of `NURSE`, without `QUEUE_READ` and `REPORT_IPD` |
| `ADMINISTRATOR`, `MANAGER` | Follow the ICU board and every stay (read only), and the status overview. | `ICU_READ`, `OVERVIEW_READ` |

Demo logins from `pnpm seed`: `icu_doctor1`, `icu_nurse1` (menu: **ICU**).

## The workflow

1. **Handover.** The emergency doctor sends the patient to the ICU (`docs/emergency.md`), **choosing the ICU doctor** who takes over and a free ICU bed. The patient is admitted on the same visit, so everything recorded in the emergency ward stays. The ICU doctor and every ICU nurse are told (`ICU_ADMITTED`). The visit now belongs to the ICU doctor (they can order tests and medicines); the emergency doctor keeps access to the closed emergency case.
2. **The patient's page** (`/icu/:admissionId`, for the ICU doctor, the ICU nurse, the administrator and the manager): latest vitals, how often vitals are taken, every reading with the name of who took it (readings from before the ICU are marked), the doctor's instructions, the day-by-day record, tests and results, medicines, and a card **Handed over from the emergency ward** with the complaint, the triage record, the emergency doctor's notes and the handover reason.
3. **How often vitals are taken.** The ICU doctor picks **every 5 minutes, 15 minutes, 1 hour or 2 hours** (with an optional reason); each change is kept. The nurse is told (`ICU_VITALS_SCHEDULE`). The next reading is due one interval after the last one taken since the interval was set (or after it was set, if none yet). When it is late, the board shows how many minutes late and the nurse gets an **amber alert bar** on every page until she records vitals.
4. **Vitals.** The ICU nurse records them on the patient's page. They are the visit's ordinary readings, so the doctor sees them at once, in the table and in the day's summary.
5. **Instructions.** The doctor writes instructions for the nurse (optionally **urgent**: an alert until done). The nurse is told (`ICU_INSTRUCTION`) and marks each done once, with an optional note; the doctor sees who did it and when. The words of an instruction are never changed.
6. **Tests.** The ICU doctor orders laboratory and imaging tests from the same page (admitted patients' tests go straight to the laboratory). The sample is assigned to an **ICU nurse** (the one with the fewest samples waiting), who is told, and the LIMS manager sees it in the laboratory board. Results appear on the page; charges go to the admission (`docs/lims-portal.md`).
7. **Day by day.** The doctor writes a note (and a plan for the next day) for each day; the page shows every day from arrival ("Day 1, Day 2 ...", hospital time) with that day's notes, how many vitals sets were taken and their ranges, instructions given and done, and tests ordered. Notes are append-only: a correction is a new note.
8. **Equipment.** The nurse (or the doctor in charge) starts equipment on the patient from the price list (ventilator, monitor, infusion pump ... any service in the category *Room, bed and ICU equipment*), and stops it when it is taken off. The page shows what is in use, who started and stopped it and when. Equipment still in use is **stopped by the system** (and audited) when the patient is moved to a bed in another ward, or goes home, so a ward day is never charged for a ventilator.
9. **Billing.** Everything done in the ICU goes on the admission's bill, and the page shows it under **Billing for this stay**: the **ICU bed for every calendar day** (the first day charged when the patient arrives from the emergency ward), **each piece of equipment for every calendar day it is in use**, tests (when the report is issued), medicines (when the pharmacy gives them) and procedures added from the price list. Days are counted in hospital time and each is charged once, however often the page is opened. The cashier sees the charges under *unbilled charges* and they are paid with the final bill at discharge.
10. **Leaving the ICU.** Transfer to a ward, discharge and billing are done on the admission page (`/ipd/:id`), as for any inpatient; the stay then leaves the ICU board.

## What the database keeps

Vitals orders and day notes cannot be changed or deleted; an instruction can change once, from open to done; nothing can be added to a stay once the patient is no longer admitted; equipment is in use on a patient once at a time, is stopped once and never rewritten or deleted; the interval can only be 5, 15, 60 or 120 minutes.

## Settings

The ICU ward is found by its code, `EMERGENCY_ICU_WARD_CODE` (default `ICU`). The price of the ICU bed is the ward's bed price; the price of equipment is the price in the price list, which the hospital edits like any other service.

## Audit events

`ICU_VITALS_SCHEDULE_SET`, `ICU_INSTRUCTION_GIVEN`, `ICU_INSTRUCTION_DONE`, `ICU_DAY_NOTE_ADDED`, `ICU_EQUIPMENT_STARTED`, `ICU_EQUIPMENT_STOPPED`, `ICU_EQUIPMENT_CHARGES_POSTED`, `EMERGENCY_DECISION` (with the ICU doctor), `ADMISSION_CREATED` (source `EMERGENCY`).

## Routes

| Method | Path | Access |
|---|---|---|
| GET | `/icu/stays` | `ICU_READ` (a doctor sees only their own) |
| GET | `/icu/alerts` | `ICU_READ` (vitals late, urgent instructions open: for the nurse) |
| GET | `/icu/stays/:id` | `ICU_READ` |
| POST | `/icu/stays/:id/vitals-schedule`, `/instructions`, `/notes` | `ICU_DOCTOR` and the doctor in charge |
| GET | `/icu/equipment` | `ICU_READ` (the equipment in the price list, with the price per day) |
| POST | `/icu/stays/:id/equipment`, `/icu/equipment/:id/stop` | `ICU_NURSE` or the doctor in charge |
| POST | `/icu/instructions/:id/done` | `ICU_NURSE` |
| GET | `/emergency/icu-doctors` | `ER_TREAT` (the doctors who can take over) |

Vitals are recorded with the existing `POST /encounters/:id/observations`; tests with `POST /lims/orders`.

## Known limits

No bed-side charting of fluid balance, ventilator settings or scores, no automatic overdue notification when nobody has the page open (the alert bar and board show it), and no scheduled tasks other than vitals. See `docs/backlog.md`.
