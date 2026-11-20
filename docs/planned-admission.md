# Planned admission

## Purpose

A patient who is to be admitted on a **chosen day**, not today. The request can start in three ways, the consultant decides, and then the admission desk, billing, insurance, bed management and nursing each do their part before the patient is admitted into the **ordinary IPD flow** (same admission number, visit, bed history, charges, nursing, medicines and discharge). Nothing here is an admission until the desk admits the patient on the day.

Menu: **Planned admissions** (`/planned`). The doctor also gets a "This patient needs to be admitted" box inside the consultation.

## The three ways a request starts

| Route | Who starts it | First stop |
|---|---|---|
| **OPD advised** | The OPD doctor ticks *This patient needs to be admitted* in the consultation (reason, and optionally diagnosis, procedure, day, expected stay). Only the doctor of that visit can. | **Reception** asks the patient. Agree: the admission procedure starts. Refuse: the request closes with the reason. |
| **Arranged with a consultant** | Reception records what the patient says and picks the consultant the patient arranged with. | The request goes to **that doctor**, who reviews it on the Planned admissions screen. |
| **Came with outside papers** | Reception records the outside doctor's advice, prescription and reports and picks a consultant to assess the patient. | The same review. An outside doctor's advice is **not** an admission order of this hospital. |

The doctor's review (outside routes) has four answers: **ask the patient** to come to the chamber, send reports, or get tests done (reception is told; for the chamber the patient is put in the doctor's OPD queue in one click, and the request returns to the doctor when the patient has come or the reports are in); **accept** (diagnosis, procedure, day, expected stay, room category: the patient is in the admission queue); **recommend other treatment** (closes, with the note); **decline** (closes, with the reason).

## Steps and who does them

```
ADVISED ─consent─┐
DOCTOR_REVIEW ⇄ AWAITING_PATIENT ─accept─┤
                                         ▼
DESK_REVIEW → TARIFF_PAYER → (PREAUTH) → DEPOSIT → BED_ALLOCATION → READY → ADMITTED
   any open step ─cancel→ CLOSED (cancelled / no-show / patient declined / doctor declined / other treatment)
```

| Step | Team | What is done | Permission |
|---|---|---|---|
| Request | Reception | Raise the request; record the patient's consent or refusal; send the patient to the chamber | `PLANNED_REQUEST` |
| Doctor | Consultant | Ask, accept, other treatment, decline (only for the consultant's own requests) | `PLANNED_DOCTOR` |
| Admission desk | Admission | Verify consultant, diagnosis, planned procedure, day, expected stay and room category (ward); correct them; move the day; admit on the day | `PLANNED_DESK` (+ `ADMISSION_CREATE` to admit) |
| Estimate and payer | Billing, Insurance | Billing makes the estimate (lines, total worked out by the server; a bed line is suggested from the ward's rates and the expected stay). Payer: self-pay, or insured: the insurance team checks the policy (valid on the admission day), coverage and network and starts the cashless claim | `PLANNED_BILLING`, `PLANNED_INSURANCE` |
| Pre-authorisation | Insurance | Ask the insurer, record approval (amount) or rejection; or switch to self-pay. Done through the ordinary claim (docs/claims.md) | `PLANNED_INSURANCE` |
| Deposit | Billing, Manager | Billing sets the deposit and takes it as an ordinary **advance payment** (cash, UPI, card, bank transfer, split) marked as taken for the request; when what was received reaches what was asked, the step clears by itself. A manager may waive it with a written reason. Zero is accepted only when the insurer's approval covers the whole estimate | `PLANNED_BILLING` + `PAYMENT_CREATE`; `PLANNED_APPROVE` |
| Bed | Bed management | Holds a bed (it shows as **reserved**); may change it while the request is ready | `PLANNED_BED` |
| On the day | Admission desk | **Admit**: the admission opens on the held bed, and the **nursing admission assessment** appears on the nurses' task list (due in an hour) | `PLANNED_DESK` + `ADMISSION_CREATE` |
| Nursing | Nurse | Fills in the **nursing admission assessment** (below), which closes the task | `NURSING_DOCUMENT` |

`PLANNED_READ` (reception, doctor, nurse, cashier, insurance, bed, manager, administrator) lets a person see the queue and a request; it changes nothing. Roles added: **ADMISSION_DESK** (request, desk, bed, patient registration, admissions) and **BED_MANAGER** (bed only). Existing roles gained what their part needs (reception: request and desk; doctor: doctor; cashier: billing; claims officer: insurance; manager and administrator: approve).

The screen shows each person only what they may do now (the server works out the same list). A step out of order, or by someone without the permission, is refused.

## Nursing admission assessment

A structured record, one per admission, on the request page (and saved through `POST /admissions/:id/nursing-assessment`): awareness, movement, pain (0 to 10), allergies (tick *no known allergies* or write them), **fall risk**, **pressure sore risk** and **nutrition risk** (low, medium, high), diet or fasting instruction, belongings, ID band checked, consent form checked, and a note. A **high risk or pain of 7 or more needs a note** on what was done. Saving it closes the "Nursing admission assessment" task in the same transaction. The record is **append-only** (the database refuses edits and deletes); anything new goes in a nursing note. Audit event `NURSING_ADMISSION_ASSESSMENT_RECORDED` (risk levels and pain only, not the free text). Permissions: `NURSING_DOCUMENT` to record, `NURSING_READ` to read. The hospital's own policy decides how the risk levels are scored; the form records the nurse's level, not a scale. Limits: no scored tools (Morse, Braden, MUST) and no edit after saving; both are in `docs/backlog.md`.

## How it joins the IPD flow

* **Admission**: `AdmissionsService.admitFromPlanned` does what an ordinary admission does (registration-fee rule, one admitted stay per patient, numbering, visit, bed assignment with the bed history reason "Planned admission", audit) on the **reserved** bed, in one transaction with the request.
* **Beds**: a held bed is `RESERVED`; nobody can free it by hand (the bed screen and the database both refuse) and a second request cannot hold it (the bed row is locked). Cancelling or recording a no-show returns it to *available*. Emergency-ward beds and the emergency ward as a room category are refused.
* **Money**: the estimate and the deposit are shown on the admission page; the deposit stays the patient's advance (docs/advance-payments.md) and is set against the final bill by the cashier as before. If the request is cancelled the deposit stays the patient's advance, to be given back or used.
* **Insurance**: the claim started here is the same claim the claims officer works in `/claims`; cancelling closes a claim that was only started.
* **Nursing**: the assessment is a nursing task on the admission.
* The ordinary **Admit patient** button still works for walk-in admissions.

## Safety rules the database keeps

One open request per patient and per visit; one request per held bed; the timeline is append-only; what the patient said and who the request is for never change; an admitted or closed request is final; the estimate can be changed only in the billing, insurance and deposit steps; a request cannot be ready without a bed, a day, a verified desk step, a payer and a cleared deposit or approval; the claim, policy and admission must be the patient's own; every record belongs to one hospital and one facility (row-level security).

## Audit events

`PLANNED_ADMISSION_ADVISED`, `_REQUESTED`, `_CONSENT_GIVEN`, `_PATIENT_DECLINED`, `_DOCTOR_ASKED_PATIENT`, `_PATIENT_READY`, `_DOCTOR_ACCEPTED`, `_DOCTOR_OTHER_TREATMENT`, `_DOCTOR_DECLINED`, `_DESK_VERIFIED`, `_RESCHEDULED`, `_ESTIMATE_SAVED`, `_PAYER_SET`, `_PAYER_CHANGED_SELF_PAY`, `_TARIFF_DONE`, `_PREAUTH_REQUESTED`, `_PREAUTH_APPROVED`, `_PREAUTH_REJECTED`, `_DEPOSIT_REQUIRED_SET`, `_DEPOSIT_TAKEN`, `_FINANCIAL_CLEARED`, `_DEPOSIT_WAIVED`, `_BED_ALLOCATED`, `_BED_CHANGED`, `_ADMITTED`, `_CANCELLED`, `_NO_SHOW`; plus the usual `ADVANCE_RECEIVED`, `CLAIM_*`, `BED_STATUS_CHANGED`, `ADMISSION_CREATED`. Each step also appears on the request's own timeline ("What happened").

## Notifications

`PLANNED_ADMISSION_ADVISED` (reception), `_REQUEST` (the consultant), `_DECIDED` (reception, when the doctor asks for something or closes it), `_STEP` (the team whose turn it is; the nurses when the patient is admitted). The person who acted is not told.

## API (`/api/v1`)

| | |
|---|---|
| `GET /planned-admissions`, `GET /planned-admissions/summary`, `GET /planned-admissions/:id` | `PLANNED_READ` |
| `POST /planned-admissions` | `PLANNED_REQUEST` (outside routes) |
| `POST /encounters/:id/planned-admission`, `GET /encounters/:id/planned-admission` | `PLANNED_DOCTOR`; read also `PLANNED_READ` |
| `POST /planned-admissions/:id/consent` | `PLANNED_REQUEST` |
| `POST /planned-admissions/:id/doctor` | `PLANNED_DOCTOR` (own requests) |
| `POST /planned-admissions/:id/patient-ready` | `PLANNED_REQUEST` or `PLANNED_DESK` |
| `POST /planned-admissions/:id/verify`, `/reschedule`, `/admit` | `PLANNED_DESK` (`/admit` also `ADMISSION_CREATE`) |
| `PUT /planned-admissions/:id/estimate`, `PUT .../deposit-required`, `POST .../financial-check` | `PLANNED_BILLING` |
| `POST .../payer`, `POST .../tariff-done` | `PLANNED_BILLING` or `PLANNED_INSURANCE` (insured payer: insurance only) |
| `POST .../preauth` | `PLANNED_INSURANCE` |
| `POST .../deposit` | `PLANNED_BILLING` + `PAYMENT_CREATE`; `Idempotency-Key` required |
| `POST .../waive` | `PLANNED_APPROVE` |
| `POST .../bed` | `PLANNED_BED` |
| `POST .../cancel` | `PLANNED_DESK`, `PLANNED_REQUEST`, or the consultant before the desk has it |

Numbers: `PA-{YEAR}-{SEQ}` (a numbering sequence like the others, configurable).

## Known limits

* A held bed is reserved from the moment it is held, not from the planned day; for a day far ahead the bed is out of use meanwhile. Date-aware reservation is in `docs/backlog.md`.
* An ordinary **Admit patient** for someone who has an open planned request does not close it; the desk cancels or admits the request.
* A reception-registered request goes to one named consultant; there is no "any doctor of the department" pool and no change of consultant by the doctor (the desk can reassign).
* The estimate is a billing estimate, not a package price; it is not posted as charges.
* The insurer is not contacted electronically: the team records what the insurer answers.

Tests: `modules/planned/planned.spec.ts` (all three routes, insurance, deposit, bed, admission, nursing task, isolation, history, concurrency, the ordinary admission still working), `common/tenant-sweep.spec.ts`.
