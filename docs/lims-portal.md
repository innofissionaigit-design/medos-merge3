# Laboratory portal (LIMS)

## Purpose
One place where the laboratory floor is run: the **LIMS manager** controls it, the **pathology** and **radiology technicians** prepare reports, the **pathologist** and **radiologist** pass them, the **nurse** takes the samples, **reception** launches outpatients' tests, and the **doctor** orders and receives them. The **administrator** and the **manager** watch the same figures but cannot touch a clinical result.

It is a layer on top of the laboratory (`docs/lims.md`) and radiology (`docs/radiology.md`) work that already existed. Samples, result values, studies, signed reports, critical-value alerts and amendments are still kept by those modules; the LIMS adds the queue, who does what next, priorities, turnaround times, quality control, exceptions and the patient messages. Decision record: ADR-014.

## Where it lives
There is **no separate portal and no separate sign-in**. The laboratory is the **Laboratory (LIMS)** page (`/lims`) of the main MedOS app, signed into with the normal login. What each person sees is decided only by their role's permissions: the menu entry appears for people who work in the laboratory, and the page shows only the desk their role needs. People with a laboratory role land on it after signing in. The server enforces every permission; the page only decides what to show. Nurses are the hospital's existing nurses (role `NURSE`); the LIMS manager gives them sample work by assigning them.

| Role (system role name) | Lands on | Does |
|---|---|---|
| `LIMS_MANAGER` | Control room | Watches every request, assigns work, changes priorities, cancels, reviews QC and instruments, decides exceptions, reads performance reports. **Cannot** enter, pass or sign a result. |
| `P_LAB_TECH` | Technician desk (pathology only) | Accepts or rejects the sample that arrived, types the values, sends for review, issues a passed report, records QC. |
| `R_LAB_TECH` | Technician desk (radiology only) | Performs the scan, attaches images, sends for review, issues a signed report, records QC. |
| `PATHOLOGIST` | Review desk | Reviews the values, passes (verifies) them or sends them back; amends a released report with a reason; keeps tests and ranges. |
| `RADIOLOGIST` | Review desk | Reviews the study and images, writes findings and impression, signs or sends back; amends with a reason. |
| `NURSE` | Sample collection | Takes the sample (laboratory) or gets the patient ready (imaging). Assigned nurse first, then everyone waiting; emergencies on top. |
| `RECEPTIONIST` | Reception desk | Launches outpatients' advised tests after the patient agrees, sees the lab queue, hands reports over. |
| `ADMINISTRATOR`, `MANAGER` | Control room (view) | The same dashboards, lists and reports as the LIMS manager. The administrator also keeps the laboratory departments, test master data, users and permissions, and reads the audit log. Neither can enter, verify, sign, issue or silently change a result. |
| `DOCTOR` | No separate page: the outpatient visit page, and the **admitted patient's page** (*Lab and imaging* tab) | Orders tests (an admitted patient's go straight to the laboratory), marks one urgent or emergency, sees where each test is and reads the report once it is issued. |

The earlier roles `LAB_TECHNICIAN` and `RADIOGRAPHER` still exist and still use the older LIS page (`docs/lis.md`).

## Departments
Every facility has two: **Pathology** and **Radiology** (created by the migration for existing facilities and on first use for new ones). The administrator can rename them, change the turnaround targets (routine, urgent, emergency), set the default instructions given to patients, and switch one off (refused while it has open requests). A test goes to Pathology if it is a laboratory test and to Radiology if it is imaging; cardiology and procedures are not run by the LIMS.

## Which department runs a test (the test list)
Every investigation on the price list is **grouped with Pathology or Radiology** (`Service.limsDepartment`). The grouping decides which technician a test reaches:
* A doctor or reception **chooses tests from the list**, shown in two groups. A chosen test, or a typed name that matches the list, is routed by its group, whichever box it was typed in. A test not on the list keeps the kind it was typed with and is priced later by the cashier.
* New investigations are grouped by their name when added (words such as X-ray, ultrasound, CT, MRI, mammography, Doppler go to Radiology; everything else to Pathology). The migration grouped the tests that already existed the same way.
* The **administrator** (`LIMS_DEPARTMENTS`) or the **pathologist** (`LAB_MASTERS`) can move any test between the two groups (Laboratory → Departments, or the pathologist's *Tests and ranges* tab). The change applies to new requests; a request already in the queue stays where it is. It is audited (`LIMS_TEST_GROUPING_CHANGED`).
* Within a department the request goes to that department's technicians (they are told); the LIMS manager can also assign it to one technician.

## The two workflows

### Admitted patient (IPD)
1. The doctor orders the test from the admission's *Lab and imaging* tab (`POST /lims/orders`): no consent step, optional priority (`ROUTINE`, `URGENT`, `EMERGENCY`) and a reason. The test **enters the queue immediately** and is **never held back by how busy the lab is** (the lab-load date below is for outpatients only). A **nurse is chosen automatically**: of the nurses who take samples, the one with the fewest samples waiting, then by name (the LIMS manager can change it). That nurse is told; an emergency also tells the LIMS manager.
2. A nurse takes the sample (imaging: gets the patient ready). The technician of that department is told.
3. The technician **accepts** the sample (or **performs** the scan), types the values (or attaches images and notes), and **sends it for review**. The pathologist or radiologist is told.
4. The pathologist or radiologist **passes** it (verifies the values or signs the report) or **sends it back** with a reason.
5. The technician **issues** the report. Only now does the doctor see it (visit and admission pages) and get a notification that names the **test, the patient and the bed** (looked up when the list is read, never stored in the notice). A critical value still alerts the doctor the moment it is passed. Issuing also **adds the test to the admission's bill** (see Billing). The request, the nurse's list and the control room show the patient's bed.

### Outpatient (OPD)
Tests reach reception in two ways: the doctor advised them (below), or reception **books them for a patient who has no doctor's order** (a patient with a request from an outside doctor, or who asks for a test). In the second case reception chooses the patient and the tests from the grouped list on the *Book a test* tab; the patient agrees; `POST /lims/opd/book` opens a **laboratory-only visit** (an outpatient visit with no doctor and no consultation, closed at once, marked `labOnly` and left out of the OPD consultation reports), creates the test orders (source `RECEPTION`), and launches them exactly as in steps 3 to 5 below. An outside doctor's name can be recorded and is shown to the technician and the specialist.

1. The doctor signs the consultation (or orders directly). The advised tests wait on the reception desk (*Tests advised*); they are **not** in the lab yet.
2. Reception asks the patient. If the patient agrees, reception **launches** the tests (`POST /lims/opd/launch`) saying how the patient agreed (said at the desk, or signed), the priority, when to come (left empty, the lab load gives the first free hour), which nurse (optional) and what to do beforehand (pre-filled from the test's own instructions, else the department's default). The screen shows the **cost of the tests** from the price list. If the patient does not agree, reception records the reason and the tests are taken off (`POST /lims/opd/decline`).
3. Reception can **take an advance** at once (the existing advance card: `POST /patients/:id/advances`); it stays the patient's money until used.
4. The tests join the queue ordered by priority then time, and the **patient is messaged on WhatsApp and by SMS** (hospital setting `LIMS_MESSAGE_CHANNEL`: `WHATSAPP`, `SMS` or `BOTH`, the default), and by email when email is on. The message names the *department*, the date and time and what to do beforehand; it never names a test and never carries a result.
5. The **LIMS manager gives the work to a nurse** (*Today's patients*, or the request's detail). Reception, the LIMS manager, the manager and the administrator all see the booking at once.
6. **On the day** the patient is on the *Today's patients* list of reception, the LIMS manager (and the manager and administrator) and the nurse (`GET /lims/requests?expected=true`, optionally `arrived=true|false`): outpatients due today, or earlier and not yet attended, shown as *not here yet* or *at reception*.
7. When the patient reports, reception presses **Patient arrived** (`POST /lims/batches/:batchId/arrive`, one step): the tests are **billed at the price list** (a bill of type Other, as the Cashier does), the **advance is used first**, the **rest is taken** (one way or split) and the patient is marked as reported. If the balance is not paid in full nothing is billed and nothing is taken (`PAYMENT_REQUIRED`); a test with no price on the list stops it (`TEST_NEEDS_PRICE`) until the Cashier prices it. The nurse and the LIMS manager are told. Pressing twice takes nothing twice (`Idempotency-Key`).
8. The nurse takes the sample **only after the patient has reported** (`PATIENT_NOT_ARRIVED` otherwise); then steps 3 to 5 above.
9. When **every report of the booking** is issued the patient is told the reports are ready at reception (WhatsApp and SMS, and email). Reception prints the report and records that it was **handed over** and to whom.

WhatsApp and SMS use the hospital's connected message provider (`docs/prescriptions.md`, `MESSAGE_PROVIDER`). Until one is connected the messages are logged and nothing leaves the server; the reception screen says so. A patient who has withdrawn consent to messages is never sent one. Turn the messages off with the setting `LIMS_PATIENT_MESSAGES`.

## Request states
`PENDING_COLLECTION` → `COLLECTED` → `IN_PROCESS` → `PENDING_REVIEW` → `PASSED` → `ISSUED` → `HANDED_OVER` (outpatients), or `CANCELLED`. Two steps go back: a rejected sample (or a patient who is not prepared) returns to `PENDING_COLLECTION` with a new sample needed (`needsRecollection`, counted), and review can send the work back to `IN_PROCESS` with a reason. The same moves are enforced by a database trigger, so a bug or a manual change cannot skip a step. Every step is written to an append-only history with who did it and when; turnaround times and investigations come from it.

* A sample is taken **once**; two nurses pressing at the same time take it once.
* Results can be typed only after the sample is accepted; the pathologist can pass only what the technician sent for review; nothing is issued before it is passed. The earlier laboratory and radiology screens obey the same rules for a request the LIMS manages.
* A report not yet issued is hidden from the doctor, the patient app and the printed visit summary; the staff who work on it still see it.
* An issued report is never changed; a correction is an amendment with a reason (existing rule) and the doctor is told again.

## Lab load and the outpatient's date
An outpatient's test date is **not typed by hand**: it comes from how busy the labs are.
* Each department has a **capacity** (outpatient tests it can take in an hour) and **working hours**, kept by the administrator (Laboratory → Departments). Starting figures: Pathology 8 an hour and Radiology 3 an hour, 08:00 to 18:00.
* When reception launches or books tests and leaves "Come at" empty, the system gives the patient **the first hour in which every department needed has room**. Work already waiting with no time set (inpatients, walk-ins) uses up the first hours; tests already booked for an hour use that hour. The busier the lab, the later the date, and a full day moves the patient to the next working day. Both departments needed means one time at which both have room.
* An **emergency** is not scheduled: the patient comes now. A time typed by reception is respected. The time is taken under a lock, so two receptionists booking together never take the same last place.
* The reception screen shows the date the patient would be given and how full each lab is before the request is sent; the patient's message and the queue rows carry it; the report's due time counts from it.
* The **LIMS manager, the administrator and the manager** see the pressure in **Laboratory → Lab load**: for each lab, what is waiting, in the lab, with the specialist and to issue, the next free outpatient place, and each coming day's bookings against capacity (`GET /lims/reports/pressure`). Raising a lab's capacity makes later patients' dates earlier.

## Turnaround time (TAT)
Each request gets a due time when it is created: the department's target for the priority (routine, urgent, emergency). A routine laboratory test uses the test's own turnaround hours when the pathologist set one. For an outpatient asked to come at a set time the clock starts then. Raising a priority starts the shorter clock from now; only the LIMS manager lowers a priority. The dashboards show requests open past their due time, reports issued late, average, middle and slowest-1-in-10 time, the share issued on time, and where the time goes (queue to sample, sample to accepted, accepted to review, review, passed to issued).

## Quality control, instruments, exceptions
* **Instruments**: kept by the LIMS manager (name, model, serial, status, calibration dates). A calibration that is overdue or due within 14 days is flagged.
* **QC runs**: recorded by technicians (and the manager). With numbers and limits the result (pass or fail) is worked out by the server; otherwise the technician says whether the check passed. A failure tells the manager. A run is never changed; the manager adds a review once (not for their own run). A failure marked *needs action* puts its instrument into maintenance until the manager sets it back.
* **Exceptions**: a nurse, reception, a technician or the manager asks for a one-off departure from the rules (go ahead of the queue, use a sample that is not ideal, explain a delayed report). Only the LIMS manager decides, never their own. Approving a queue jump makes the request urgent; approving a compromised sample marks the request so the technician and the specialist see it.

## Permissions
New: `LIMS_READ`, `LIMS_REPORTS`, `LIMS_ORDER`, `LIMS_REQUEST`, `LIMS_PRIORITY`, `LIMS_COLLECT`, `LIMS_ASSIGN`, `LIMS_ISSUE`, `LIMS_QC`, `LIMS_MANAGE`, `LIMS_DEPARTMENTS` (listed with their meaning in `packages/shared/src/permissions.ts`). The department rules reuse the existing ones: pathology needs `LAB_READ` / `LAB_RESULT` / `LAB_VERIFY`; radiology needs `RAD_READ` / `RAD_PERFORM` / `RAD_REPORT`. **A manager is never given `LAB_VERIFY` or `RAD_REPORT` by default.** A hospital that has a qualified manager can give those permissions through a custom role; the check is on the permission, not on being a manager. A doctor sees only their own patients' requests; reception sees only outpatient requests and no clinical detail.

## Billing
**Work in the laboratory never waits for billing.** What changed is who bills, and when:

* **Outpatient** (a doctor's test, or a test booked at reception): the tests are billed **when the patient reports at reception** (`POST /lims/batches/:batchId/arrive`), with the same billing the Cashier uses (`TestOrdersService`, a bill of type Other at the price-list price and tax, every line tied to its test order so it cannot be billed twice). An **advance** the patient paid earlier is applied first (`AdvancesService`, receipt method Other pointing back at the advance), then the rest is taken as an ordinary receipt (cash, UPI, card, bank transfer, split payments; UPI, card and bank need a reference). It is all one transaction. The nurse cannot take the sample before this. The Cashier's *Tests the doctors advised* screen still lists tests not yet billed, and billing one there first is fine: reception then only collects what is still due.
* **Admitted patient**: nothing is collected at the bed. When the report is **issued**, the test becomes a **charge on the admission** (`Charge`, type `SERVICE`, source key `LIMS:<request id>` so it is added once), and the IPD final bill takes it with the other charges. These tests are **left out of the Cashier's test list** so they cannot be billed twice. A test with no price on the list, or an admission whose final bill is already issued, is not charged: the request history says why (`CHARGE_NOT_POSTED`) and the charge is added by hand.
* **Who can follow it**: the LIMS manager, the manager and the administrator see the **Billing** tab (`GET /lims/reports/billing`): by department, tests billed and not billed, the billed amount, reports issued but not billed, and the list of charges added to admitted patients' bills with the admission and whether they are waiting for the final bill. The nurse, technicians and specialists never see money.
* A rejected and re-taken sample is the same request, so it is never billed twice. A cancelled request that was already billed is reversed through the existing billing rules (credit note); a charge not yet billed is voided in the admission's charges.

## Audit events
`LIMS_TESTS_ORDERED`, `LIMS_OPD_LAUNCHED` / `LIMS_OPD_BOOKED` (with how the patient agreed), `LIMS_TEST_GROUPING_CHANGED`, `LIMS_OPD_DECLINED`, `LIMS_PATIENT_ARRIVED` (with what was owed, the advance used and what was collected), `LIMS_CHARGE_NOT_POSTED`, `CHARGE_POSTED` (source LIMS), `LIMS_SAMPLE_COLLECTED`, `LIMS_SAMPLE_REJECTED`, `LIMS_SAMPLE_ACCEPTED`, `LIMS_SCAN_PERFORMED`, `LIMS_SENT_FOR_REVIEW`, `LIMS_RETURNED_TO_TECH`, `LIMS_REPORT_PASSED`, `LIMS_REPORT_ISSUED`, `LIMS_REPORT_HANDED_OVER`, `LIMS_REQUEST_CANCELLED`, `LIMS_PRIORITY_CHANGED`, `LIMS_REQUEST_ASSIGNED`, `LIMS_DEPARTMENT_CHANGED`, `LIMS_INSTRUMENT_ADDED` / `LIMS_INSTRUMENT_CHANGED`, `LIMS_QC_RECORDED` / `LIMS_QC_FAILED` / `LIMS_QC_REVIEWED`, `LIMS_EXCEPTION_RAISED` / `LIMS_EXCEPTION_APPROVED` / `LIMS_EXCEPTION_DENIED`, `LIMS_PATIENT_MESSAGE_SENT`, plus the existing `LAB_*` and `RAD_*` events. Audit metadata holds request numbers, departments, reasons and masked numbers, never results.

## Notifications (staff, in the app)
`LIMS_COLLECTION_WAITING`, `LIMS_ASSIGNED`, `LIMS_SAMPLE_READY`, `LIMS_REVIEW_WAITING`, `LIMS_READY_TO_ISSUE`, `LIMS_REPORT_ISSUED`, `LIMS_EXCEPTION_RAISED` (also used for a failed quality check), `LIMS_PATIENT_ARRIVED` (the nurse and the LIMS manager: the outpatient has reported). Each is a pointer with no patient name stored (`docs/notifications.md`); when the list is read, a laboratory notice also shows the test, the patient (to people who may open patient records) and the bed, and leads to the admission or the visit.

## Database rules
`LimsRequest` cannot be deleted, moved to another patient, visit, test or department, or change state out of order; the times a report was passed, issued or handed over, or the patient reported at reception, cannot be rewritten; an admitted patient's request never claims an outpatient's agreement; a request needs a laboratory or radiology test of the same patient, visit and facility that is not cancelled. The history is append-only. A QC run is never changed (only the review is added, once). A decided exception is never changed and cannot be decided by the person who raised it. Every new table is tenant-scoped with row-level security. Migrations `20261109100000_lims_portal`, `20261109130000_lims_test_grouping_and_reception_booking` (the test grouping, the laboratory-only visit, and the `RECEPTION` order source) and `20261110090000_lims_lab_capacity` (capacity and working hours of each department).

## API
All under `/api/v1`.

| Route | Permission | What |
|---|---|---|
| `GET /lims/status` | `LIMS_READ` | Whether patient messages are on, the channel, and whether a provider is connected |
| `GET /lims/dashboard` | `LIMS_READ` | Where every department stands, today's collection, acceptance and rejection |
| `GET /lims/reports/performance?from&to&department` | `LIMS_REPORTS` | Workload, turnaround, rejection, per day, per technician |
| `GET /lims/reports/billing?from&to&department` | `LIMS_REPORTS` and (`INVOICE_READ` or `LIMS_MANAGE`) | Billed, not billed, issued but not billed, and charges added to admitted patients' bills (read only) |
| `GET /lims/departments`, `PUT /lims/departments/:kind` | `LIMS_READ`, `LIMS_DEPARTMENTS` | The two departments |
| `POST /lims/orders` | `LIMS_ORDER` | A doctor orders tests for a visit (chosen from the list, or typed) |
| `GET /lims/catalogue`, `PUT /lims/catalogue/:serviceId` | `LIMS_ORDER`, `LIMS_REQUEST`, `LIMS_MANAGE`, `LIMS_DEPARTMENTS` or `LAB_MASTERS` to read; `LIMS_DEPARTMENTS` or `LAB_MASTERS` to change | The test list with each test's department; move a test to the other department |
| `POST /lims/opd/book` | `LIMS_REQUEST` | Reception books tests for a patient with no doctor's order |
| `GET /lims/opd/availability?pathology=&radiology=&priority=` | `LIMS_REQUEST` | The date and time an outpatient would be given now, and how full each lab is today |
| `GET /lims/reports/pressure?days=` | `LIMS_REPORTS` | How full each lab is, day by day, and its next free place |
| `GET /lims/opd/pending`, `POST /lims/opd/launch`, `POST /lims/opd/decline` | `LIMS_REQUEST` | Reception: tests waiting, launch with consent, patient declined |
| `GET /lims/batches/:batchId/billing` | `LIMS_REQUEST` or `LIMS_REPORTS` | What a booking costs, the advance available, and what is still to collect |
| `POST /lims/batches/:batchId/arrive` + `Idempotency-Key` | `LIMS_REQUEST` and `PAYMENT_CREATE` | The patient has reported: bill, use the advance, take the rest, mark as reported (201; 200 if replayed; 409 `PAYMENT_REQUIRED`, `PAYMENT_EXCEEDS_BALANCE`, `TEST_NEEDS_PRICE`) |
| `GET /lims/staff` | `LIMS_ASSIGN` or `LIMS_REQUEST` | Nurses and technicians to give work to |
| `GET /lims/requests`, `GET /lims/requests/:id` | `LIMS_READ` | Queue and detail with history (filters: stage, department, origin, priority, search, mine, overdue, recollect, expected, arrived) |
| `GET /encounters/:id/lims` | `LIMS_READ` | A visit's requests, for the doctor |
| `POST /lims/requests/:id/priority` | `LIMS_PRIORITY` | Raise (anyone with it, doctors for their own patients); lower needs `LIMS_MANAGE` |
| `POST /lims/requests/:id/assign` | `LIMS_ASSIGN` | Nurse and/or technician |
| `POST /lims/requests/:id/collect` | `LIMS_COLLECT` | Sample taken / patient ready |
| `POST /lims/requests/:id/accept` | `LAB_RESULT` | Laboratory technician accepts the sample |
| `POST /lims/requests/:id/perform` | `RAD_PERFORM` | Radiology technician performs the scan |
| `POST /lims/requests/:id/reject-sample` | `LAB_RESULT` or `RAD_PERFORM` | Sample unusable / patient not prepared |
| `POST /lims/requests/:id/submit` | `LAB_RESULT` or `RAD_PERFORM` | Send for review |
| `POST /lims/requests/:id/return` | `LAB_VERIFY` or `RAD_REPORT` | Send back with a reason |
| `POST /lims/requests/:id/issue` | `LIMS_ISSUE` (and the department's technician permission) | Issue a passed report |
| `POST /lims/requests/:id/handover` | `LIMS_REQUEST` | Reception hands an outpatient's report over |
| `GET /lims/requests/:id/report` | `LIMS_REQUEST`, `LIMS_ISSUE` or `LIMS_MANAGE` | Print an issued report |
| `POST /lims/requests/:id/cancel` | `LIMS_MANAGE` | Cancel before review |
| `GET/POST /lims/instruments`, `PUT /lims/instruments/:id` | `LIMS_READ`, `LIMS_MANAGE` | Instruments |
| `GET/POST /lims/qc`, `POST /lims/qc/:id/review` | `LIMS_READ`, `LIMS_QC`, `LIMS_MANAGE` | Quality control |
| `GET/POST /lims/exceptions`, `POST /lims/exceptions/:id/decide` | `LIMS_READ`, floor roles, `LIMS_MANAGE` | Exceptions |

Passing a report is done with the existing `POST /lab/results/:id/verify` or `POST /rad/studies/:id/report`; typing values with `PUT /lab/results/:id/draft`. Those routes now also move the request, and refuse out-of-order calls for a request the LIMS manages.

## Running a demo
After `pnpm db:migrate`, `pnpm db:seed` creates the logins `lims_manager1`, `p_lab_tech1`, `r_lab_tech1`, `pathologist1`, `radiologist1` (and the usual `nurse1`, `reception1`, `doctor1`, `admin`, `manager1`) with the seed password, a CBC set-up, and three inpatient orders (one an emergency). Sign in at the normal login; the menu shows **Laboratory (LIMS)**.

## Known limitations
* One sample per test order (as before); no analyser interface, reagent stock, or result trends.
* Radiology images are attached by the technician through the existing image storage; there is still no PACS.
* The patient is messaged only for outpatients, and only when a message provider is connected; the log-only default records what would have been sent.
* A test the doctor typed that matches nothing on the price list is still ordered. An outpatient cannot report until the Cashier prices it; an admitted patient's is not charged until a charge is added by hand.
* The patient's date is fixed when the tests are launched; moving a booking to another day is done by the LIMS manager cancelling and reception booking again. Advances are the patient's, not tied to one booking: arrival uses whatever the patient has in advance.
* An outpatient's test that the cashier bills **before** reception launches it still shows on the earlier LIS screens (the earlier rule "billed means the lab may work on it" is kept). Reception still sees it under *Tests advised* and launching it brings it under the portal's rules.
* The performance reports read up to 5,000 requests per period; choose a shorter period for a very busy laboratory.
* Cardiology and other procedures are not run through the LIMS.
* A test advised in a consultation keeps the kind of the box the doctor typed it in (laboratory or other tests); only tests chosen from the list, typed into the portal's order form, or booked at reception are re-routed by the grouping.
