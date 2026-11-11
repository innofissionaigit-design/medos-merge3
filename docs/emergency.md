# Emergency ward

A patient who comes to the emergency ward is registered at a dedicated desk, triaged by an emergency nurse, seen by the doctor who was called, and sent to the operation theatre, the ICU, or home. Everything the patient is charged goes on one emergency bill that opens at registration. It is built inside the main app, with role-based access only (no separate portal or sign-in). Decision record: `docs/adr/015-emergency-visit.md`.

## The people

| Role | What it does | Permissions it adds |
|---|---|---|
| `EMERGENCY_RECEPTIONIST` | Handles emergency arrivals only: registers the patient (finds the patient or adds a new one in a few fields, or "name not known"), calls a doctor, adds a charge to the emergency bill, issues it and takes the payment. Has **no** appointments, OPD queue, admissions or pharmacy access. | `ER_READ`, `ER_REGISTER`, `ER_BILL`, patient create/read/update, `DUPLICATE_OVERRIDE`, `REGISTRATION_FEE_EXEMPT`, `INVOICE_READ`, `PAYMENT_CREATE`, `CASHIER_SHIFT_MANAGE` |
| `EMERGENCY_NURSE` | Keeps the **emergency triage record** and the vitals, takes the samples of emergency tests, gives or moves the patient's emergency bed, and **asks the doctor** for a test or a medicine (a *nurse request*, below). Has **no** OPD queue, admissions list, nursing worklist, reports, ordering or prescribing. | `ER_READ`, `ER_TRIAGE`, `ORDER_REQUEST`, patient read, vitals, lab/imaging sample collection, allergies, `PRESCRIPTION_READ` |
| `EMERGENCY_DOCTOR` | The doctor who was called accepts the patient, writes the assessment, orders and signs medicines, orders tests, **accepts or declines the nurses' requests** and decides where the patient goes. Sees only the cases called to them. Has **no** OPD queue, appointments, video consultations or reports. | `ER_READ`, `ER_TREAT`, patient read, vitals, allergies, prescribing and signing, test ordering (`LIMS_ORDER`, `LIMS_PRIORITY`), lab and imaging read |
| `DOCTOR` | An ordinary doctor can also be called to the emergency ward (they keep `ER_READ`, `ER_TREAT`). | `ER_READ`, `ER_TREAT` |
| `ADMINISTRATOR`, `MANAGER` | Watch the emergency board and the status overview (`docs/manager-overview.md`); change nothing. | `ER_READ`, `OVERVIEW_READ` |

Demo logins from `pnpm seed`: `er_reception1`, `er_nurse1`, `er_doctor1` (menu: **Emergency**).

**Who starts what.** The desk registers the patient and the bill. The nurse triages, records vitals, takes samples, moves the bed, and *asks*. The doctor accepts the patient, orders medicines and tests, answers the nurse's requests and decides. The manager and the administrator only follow.

## The workflow

1. **Arrival.** The desk registers the patient (`POST /emergency/cases`): who, the complaint, how the patient came, and the doctor to call. In one transaction MedOS opens an `EMERGENCY` visit (the visit number is the case number, `ER-2026-000001`), opens the **emergency bill** (with the registration and doctor's fee when the hospital has set `EMERGENCY_FEE_AMOUNT`) and raises the **red alert**: every emergency nurse and the doctor who was called get a notification and a red bar at the top of every page until they act. A patient is never held up by the registration fee, and one patient cannot be in the ward twice.
2. **Triage.** The emergency nurse saves the **triage record** (level red / orange / yellow / green / blue, consciousness, airway, breathing, circulation, pain, note). Each assessment is a new record; the history is kept. The nurses' alert ends; the doctor is told.
3. **Vitals.** The nurse records vitals on the visit with the ordinary vitals card. The doctor's case page shows the latest readings at the top.
4. **Doctor.** The doctor **accepts** the patient (the doctor's alert ends; writing the first note also accepts), writes assessment and progress notes (append-only, with a working diagnosis), and orders:
   * **Medicines** with the ordinary medication-order card. Signing tells the pharmacy. When the pharmacist dispenses, the medicines are **added to the emergency bill**, not sold at the counter. Medicines returned before the bill is issued come off it.
   * **Tests** with the ordinary laboratory card. They go straight to the laboratory, **tagged emergency by default** (the doctor may choose another priority), with no consent step, and the sample is assigned to an emergency nurse. When the report is **issued**, the test is added to the emergency bill (a test with no price is not added, and the history says why so the desk can add it by hand). The Cashier does not bill these tests separately.
5. **The bill.** The desk can add a charge from the price list or by hand, issue the bill (a normal invoice, frozen once issued) and take payment (cash, UPI, card, bank transfer, split payments) with the ordinary billing. Charges added after the bill is issued open a new open bill.
6. **The decision** (`POST /emergency/cases/:id/decision`, the called doctor only):
   * **OT** or **ICU**: the patient is admitted to a free bed of that ward at once, on the **same record**: the emergency visit becomes the inpatient visit (a database-controlled change of type, `EMERGENCY` to `IPD`), so vitals, prescriptions and tests stay with the patient; the doctor continues from the admission page. What was charged during the emergency is **frozen on an issued bill** for payment at the desk; later charges go to the admission.
   * **Home**: the visit ends and the bill is issued.
   Beds are locked while allocated, so two patients cannot get the same bed. The patient's **emergency bed** is freed at the same moment.

## The emergency ward's beds

Every facility has an **Emergency Ward** (code `ER`: one emergency room, six beds `ER1` to `ER6`, no bed charge: the emergency fee covers it). A patient lies in a bed from arrival until the doctor decides.

* **At arrival** the desk can choose a free bed; left out, the first free bed is given (rows are locked with `SKIP LOCKED`, so patients arriving together never share a bed). If the ward is **full the patient is still registered**, without a bed: an emergency is never turned away. The nurse or the desk gives a bed later (`POST /emergency/cases/:id/bed`).
* **Moving** to another free bed (`POST /emergency/cases/:id/bed`, nurse or desk): the stay in the old bed ends and the bed goes to *cleaning* (or *available*, as the hospital's `BED_AFTER_DISCHARGE` setting says), the new stay begins. Every stay is kept (`EmergencyBedStay`); the database allows one open stay per patient and one per bed, and a stay is only ever ended, never rewritten or deleted.
* **Leaving**: the stay ends when the doctor decides (OT, ICU or home) or the registration is cancelled.
* The board shows the beds as a row of coloured tiles (by triage level) with who is lying in each, and the case page shows the bed with a *Move* control.

## Nurse requests

The emergency nurse (and the ICU nurse, `docs/icu.md`) can **ask** the doctor in charge for:

* **a test** (from the test list, with how soon it is needed), or
* **a medicine** (name, strength, dose, route, how often, days).

The request is kept exactly as written (`OrderRequest`; its decision is added once; it is never rewritten or deleted). **Nothing reaches the laboratory or the pharmacy until the doctor accepts.** The doctor is told, and sees the requests on the case page. **Accept** does the work in the same transaction: a test is ordered in the doctor's name (as an emergency test, taken by the emergency nurse); a medicine is added to the doctor's **draft** prescription, beside what is already there, to review and **sign** as usual. **Decline** needs a reason. The nurse is told either way, and can withdraw a request nobody has decided. A nurse can ask only for patients in her own ward (the emergency nurse for the emergency ward, the ICU nurse for the ICU); a doctor decides only requests for their own patients.

## The wards

Every facility has an **Operation Theatre** (code `OT`: two operating rooms, `OT-1`, `OT-2`, one table each) and an **Intensive Care Unit** (code `ICU`: three rooms, `ICU-1` to `ICU-3`, one bed each), created by the migration for existing hospitals and by provisioning for new ones, plus an **Emergency Medicine** department (`EM`). They are ordinary wards: the administrator can rename them, change the daily rate or add rooms and beds under *Administration*. If a hospital changes the ward codes, set `EMERGENCY_OT_WARD_CODE` and `EMERGENCY_ICU_WARD_CODE`.

## States

`ARRIVED` → `TRIAGED` → `IN_TREATMENT` → `HANDED_OVER` (OT or ICU) or `DISCHARGED` (home); `ARRIVED` → `CANCELLED` (registered by mistake, only before anything is done). The first two may be skipped (a doctor may accept before the triage record is saved). A closed case takes nothing more. The database enforces the transitions, the identity of the case (patient, visit, doctor) and that triage records and notes are append-only.

## Settings

`EMERGENCY_FEE_AMOUNT` (default 0), `EMERGENCY_WARD_CODE` (`ER`), `EMERGENCY_OT_WARD_CODE` (`OT`), `EMERGENCY_ICU_WARD_CODE` (`ICU`).

## Audit events

`EMERGENCY_BED_CHANGED`, `ORDER_REQUESTED`, `ORDER_REQUEST_ACCEPTED`, `ORDER_REQUEST_DECLINED`, `ORDER_REQUEST_CANCELLED`, `EMERGENCY_REGISTERED`, `EMERGENCY_TRIAGED`, `EMERGENCY_ACCEPTED`, `EMERGENCY_NOTE_ADDED`, `EMERGENCY_DECISION`, `EMERGENCY_CANCELLED`, `EMERGENCY_CHARGE_ADDED`, `EMERGENCY_BILL_OPENED`, `EMERGENCY_BILL_CHARGED`, `EMERGENCY_BILL_LINE_REDUCED`, `ENCOUNTER_BECAME_INPATIENT`, `ADMISSION_CREATED` (source `EMERGENCY`), `INVOICE_ISSUED`, `CHARGE_POSTED` (target `EMERGENCY_BILL`).

## Notifications

`EMERGENCY_ARRIVAL` (emergency nurses and the doctor called; shown in red), `EMERGENCY_TRIAGED` (the doctor), `EMERGENCY_DECISION` (the desk and the emergency nurses), `ORDER_REQUESTED` (the doctor in charge), `ORDER_REQUEST_DECIDED` (the nurse who asked). Like all notifications they carry no patient name; the screen looks the details up.

## Routes

| Method | Path | Access |
|---|---|---|
| GET | `/emergency/cases?view=active\|closed&q` | `ER_READ` (a doctor sees only their own) |
| GET | `/emergency/alerts` | `ER_READ` (what this person must act on) |
| GET | `/emergency/doctors` | `ER_REGISTER` |
| GET | `/emergency/beds` | `ER_READ` (emergency, OT and ICU beds, whether each is free, who lies in each emergency bed) |
| POST | `/emergency/cases` + `Idempotency-Key` | `ER_REGISTER` |
| GET | `/emergency/cases/:id` | `ER_READ` |
| POST | `/emergency/cases/:id/triage` | `ER_TRIAGE` |
| POST | `/emergency/cases/:id/accept`, `/notes` | `ER_TREAT` and the called doctor |
| POST | `/emergency/cases/:id/decision` + `Idempotency-Key` | `ER_TREAT` and the called doctor |
| POST | `/emergency/cases/:id/cancel` | `ER_REGISTER` |
| POST | `/emergency/cases/:id/bed` | `ER_TRIAGE` or `ER_REGISTER` (give a bed, or move the patient) |
| POST | `/order-requests` | `ORDER_REQUEST` (nurse asks; only for a patient in her ward) |
| GET | `/order-requests?encounterId` | `ORDER_REQUEST`, `ER_TREAT` or `ICU_DOCTOR` |
| POST | `/order-requests/:id/decision` | `ER_TREAT` or `ICU_DOCTOR`, and the doctor in charge (accept or decline) |
| POST | `/order-requests/:id/cancel` | `ORDER_REQUEST`, the nurse who asked |
| POST | `/emergency/cases/:id/bill/charges`, `/bill/issue` | `ER_BILL` |

Vitals, prescriptions, tests and payments use the existing routes (`/encounters/:id/observations`, `/encounters/:id/prescription`, `/lims/orders`, `/invoices/:id/payments`).

## Known limits (see `docs/backlog.md`)

* No separate ER bed board, medico-legal case record, ambulance log, resuscitation order sets or emergency reports.
* A patient can be sent to the OT, the ICU or home; admission to an ordinary ward, referral to another hospital, or leaving against advice are not decisions yet.
* The doctor called cannot be changed after registration (cancel and register again before anything is done).
* The nurse's medication chart exists once the patient is admitted; there is none during the emergency stay.
* An emergency test with no price on the price list is not billed automatically; the desk adds the charge.
