# Ward rounds, the ward coordinator and procedures

## Purpose

The inpatient treatment flow: **doctor rounds → clinical orders → nursing task list → pharmacy issue → medication administration → investigations and procedures → clinical review → ongoing charge posting**. This page covers what was added to join the parts that already existed (orders, medicine chart, pharmacy, tests, charges) into one daily routine, and the people who run it.

Menu items: **Ward board** (the ward coordinator, the manager and the administrator), **My rounds** (the doctor). On the admission page there is a new tab, **Rounds and procedures**.

## The ward coordinator

A new role, `WARD_COORDINATOR`, for the person who looks after the wards as a whole. The coordinator can **check every ward and what is going on in it, and set the times of the doctors' rounds**. The coordinator reads; the coordinator does not treat, order, write clinical notes or give medicines (the role holds none of those permissions, and a test tries each one).

**Ward board** (`/wards`, refreshes every 15 seconds):

* counts: admitted patients, vitals late, doses overdue, tasks overdue, patients with no doctor's note in 24 hours, charges not yet billed;
* **round times** (editor, below) and **today's doctor rounds**: each doctor, the time, whether it is due, started, finished (how many patients were seen) or not started in time;
* every ward, its beds (occupied, free), and for each patient: bed, doctor, day of stay, vitals (late or not), medicines (overdue, due, or a new order waiting for its schedule), the nurses' tasks, tests waiting or reported, the doctor's last note and how the patient was said to be, what has been charged and not billed, and how far discharge has got;
* **what has just happened**: the doctors' notes, round starts and finishes, signed medicine orders, doses given, nursing tasks and notes, tests ordered, procedures, admissions and discharges, with who did it.

## Round times

By default every facility has two: **7:00 AM** (Morning round) and **12:00 PM** (Noon round), made when the hospital or the facility is set up (and added to existing facilities by the migration). The coordinator can **add** a time (for all doctors, or for one doctor only), **change** a time, and **switch a time off and on**. Times are in the facility's time zone. Two active times for the same people cannot be at the same minute (database rule). Every change is audited (`ROUND_SLOT_CREATED`, `ROUND_SLOT_UPDATED`).

**In the doctor's profile.** A doctor's round times are not copied anywhere: the doctor's page reads them live. **My rounds** and the doctor's **My account** page show the times that apply to that doctor (those for all doctors, and those set for that doctor alone), with today's state of each. When the coordinator changes a time, the doctor's profile shows the new time at once.

## The doctor is told

A worker checks every minute (`REMINDER_POLL_SECONDS`, the same switch as the reminder worker). When a round time has come, **every doctor who has admitted patients** (and who may make rounds, `ROUND_DO`) gets a round for that time and a notification (**A ward round is due**, with the red alert style), once. A doctor with no admitted patients is not told. A time that was missed by more than six hours (for example the server was off) is not made late.

The doctor opens the notification (it goes straight to the round) and **starts the round**. That is the acknowledgement: it records who went and when. A round **not started within `ROUND_MISSED_AFTER_MINUTES`** (setting, default 60) is marked *not started in time* and the people who set the times (coordinator, administrator) are told; the doctor can still start it late.

## The round

The round screen (`/rounds/:id`) lists the doctor's admitted patients, those not yet seen first, with the **clinical review** for each in one place: latest vitals, medicines ordered (with doses overdue or due, and doses given in 24 hours), medicines waiting for the nurse to start their schedule, the nurses' pending and overdue tasks, tests waiting and results from the last 24 hours, procedures, charges not yet billed, and the **last note with its plan**. Beside each patient: **Open the chart** and **Write the note**.

A **note** says how the patient is (improving, stable, worsening, critical), what was found, the plan, and gives **instructions for the nurses**. Each instruction becomes a **task on the nurses' list**, due when the doctor says (default 60 minutes), and the nurses are told. Pending tasks keep the nursing step of discharge open until they are done, as every nursing task does. A note is never rewritten: a correction is an addendum, or the note is marked *entered in error* by its author (the text stays, struck through). Notes may also be written outside a round. Only the doctor in charge of the patient writes a note (another doctor does not even see the patient).

The doctor **finishes the round**; how many of the doctor's patients were seen is kept (`patientsSeen` of `patientsTotal`). A finished round takes no more notes and cannot be reopened.

## Orders and the nurses' list

* The doctor signs medicine orders on the admission as before; tests are ordered from the same page (laboratory and imaging).
* A signed medicine order with no dose schedule yet shows on the **nursing worklist** as *new medicine order: start the schedule* (and on the ward board as *new order*), until the nurse presses *Generate next 24 h* on the medicine chart. The nurse still starts the schedule; nothing is given because it was ordered.
* The doctor's instructions from a round are nursing tasks, as above.

## Procedures

A procedure done on an admitted patient is recorded once (**what was done, what was found, who did it, when**) from the *Rounds and procedures* tab (`PROCEDURE_RECORD`: doctors and ICU doctors). When it names a service of the price list, **its charge is added to the admission in the same step**, so the bill grows as treatment goes on; the charge cannot be added after the final bill is issued. A wrong entry is marked *entered in error*: its charge is taken off the bill if it has not been billed yet; a charge already on a bill needs a credit note from billing. A procedure cannot be in the future or before the admission, and cannot be recorded for a discharged patient.

## Permissions

| Permission | Who | What |
|---|---|---|
| `WARD_BOARD_READ` | Ward coordinator, manager, administrator | The ward board and its activity list (read only) |
| `ROUND_MANAGE` | Ward coordinator, administrator | Add, change, switch off round times; told when a round is missed |
| `ROUND_READ` | Coordinator, doctor, nurses, manager, administrator | See the round times |
| `ROUND_DO` | Doctor | Told of rounds; start, write notes, finish |
| `PROCEDURE_RECORD` | Doctor, ICU doctor | Record a procedure (and its charge) |

The coordinator role also reads admissions, patients, nursing, vitals, laboratory, imaging, prescriptions, IPD reports and planned admissions. Seed login: `coordinator1`.

## Audit events

`ROUND_SLOT_CREATED`, `ROUND_SLOT_UPDATED`, `ROUND_STARTED`, `ROUND_COMPLETED`, `ROUND_MISSED`, `ROUND_NOTE_ADDED`, `ROUND_NOTE_ENTERED_IN_ERROR`, `PROCEDURE_RECORDED`, `PROCEDURE_ENTERED_IN_ERROR`, `CHARGE_POSTED`, `CHARGE_VOIDED`.

## Database rules

One active round time per minute for all doctors, and one per doctor; a round time is switched off, never deleted; one round per doctor, time and day; a round goes forward only (due, started, finished; a finished round is final; who it is for and when it was due never change); round notes and procedure records are append-only (only the *entered in error* mark may be added, once, with its reason; the text can never be rewritten and nothing is deleted); the people and records referred to belong to the same hospital and facility (row-level security on all four tables). The worker finds hospitals with round times through a narrow database function, then works one hospital at a time.

## API (`/api/v1`)

| | |
|---|---|
| `GET /rounds/slots` | any of `ROUND_READ`, `ROUND_MANAGE`, `ROUND_DO`, `WARD_BOARD_READ` |
| `POST /rounds/slots`, `PATCH /rounds/slots/:id` | `ROUND_MANAGE` |
| `GET /rounds/mine`, `GET /rounds/:id`, `POST /rounds/:id/start`, `POST /rounds/:id/complete` | `ROUND_DO` (own rounds only) |
| `GET /rounds/today`, `GET /ward-board`, `GET /ward-board/activity` | `WARD_BOARD_READ` |
| `POST /admissions/:id/round-notes`, `POST /round-notes/:id/enter-in-error` | `ROUND_DO` (own patients) |
| `GET /admissions/:id/round-notes` | `ADMISSION_READ` or `ROUND_DO` |
| `GET /admissions/:id/procedure-records` | `ADMISSION_READ` or `PROCEDURE_RECORD` |
| `POST /admissions/:id/procedure-records`, `POST /procedure-records/:id/enter-in-error` | `PROCEDURE_RECORD` |

## Known limits

* A round is for the doctor in charge of a patient; there is no "covering doctor" for another doctor's patients.
* The notice is a notification in the app (and the red alert style). It is not an SMS or phone push.
* The estimate of a planned admission still does not post charges, and bed days are still posted when the cashier makes the final bill (or by the *Post bed days* button), not automatically every day. Procedures post their own charges.
* The coordinator cannot change a doctor's round once it is made (only the times for the days to come).
* The worker needs `REMINDER_WORKER_ENABLED` (on by default). See `docs/backlog.md` for follow-ups.

Tests: `modules/rounds/rounds.spec.ts` (round times, defaults, the doctor's profile, notices, missed rounds, notes and instructions, the board, new orders on the nurses' list, procedures and their charges, isolation), `common/tenant-sweep.spec.ts`.
