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

## The two workflows

### Admitted patient (IPD)
1. The doctor orders the test from the admission's *Lab and imaging* tab (`POST /lims/orders`): no consent step, optional priority (`ROUTINE`, `URGENT`, `EMERGENCY`) and a reason. The test **enters the queue immediately**; the nurses are told (an emergency also tells the LIMS manager).
2. A nurse takes the sample (imaging: gets the patient ready). The technician of that department is told.
3. The technician **accepts** the sample (or **performs** the scan), types the values (or attaches images and notes), and **sends it for review**. The pathologist or radiologist is told.
4. The pathologist or radiologist **passes** it (verifies the values or signs the report) or **sends it back** with a reason.
5. The technician **issues** the report. Only now does the doctor see it (visit and admission pages) and get a notification. A critical value still alerts the doctor the moment it is passed.

### Outpatient (OPD)
1. The doctor signs the consultation (or orders directly). The advised tests wait on the reception desk (*Tests advised*); they are **not** in the lab yet.
2. Reception asks the patient. If the patient agrees, reception **launches** the tests (`POST /lims/opd/launch`) saying how the patient agreed (said at the desk, or signed), the priority, when to come, which nurse, and what to do beforehand (pre-filled from the test's own instructions, else the department's default). If the patient does not agree, reception records the reason and the tests are taken off (`POST /lims/opd/decline`).
3. The tests join the queue ordered by priority then time, and the **patient is messaged**: WhatsApp or SMS (hospital setting `LIMS_MESSAGE_CHANNEL`), and email when email is on. The message names the *department*, the time and what to do beforehand; it never names a test and never carries a result.
4. The assigned nurse (or any nurse) takes the sample, then steps 3 to 5 above.
5. When **every report of the booking** is issued the patient is told the reports are ready at reception (WhatsApp/SMS and email). Reception prints the report and records that it was **handed over** and to whom.

WhatsApp and SMS use the hospital's connected message provider (`docs/prescriptions.md`, `MESSAGE_PROVIDER`). Until one is connected the messages are logged and nothing leaves the server; the reception screen says so. A patient who has withdrawn consent to messages is never sent one. Turn the messages off with the setting `LIMS_PATIENT_MESSAGES`.

## Request states
`PENDING_COLLECTION` → `COLLECTED` → `IN_PROCESS` → `PENDING_REVIEW` → `PASSED` → `ISSUED` → `HANDED_OVER` (outpatients), or `CANCELLED`. Two steps go back: a rejected sample (or a patient who is not prepared) returns to `PENDING_COLLECTION` with a new sample needed (`needsRecollection`, counted), and review can send the work back to `IN_PROCESS` with a reason. The same moves are enforced by a database trigger, so a bug or a manual change cannot skip a step. Every step is written to an append-only history with who did it and when; turnaround times and investigations come from it.

* A sample is taken **once**; two nurses pressing at the same time take it once.
* Results can be typed only after the sample is accepted; the pathologist can pass only what the technician sent for review; nothing is issued before it is passed. The earlier laboratory and radiology screens obey the same rules for a request the LIMS manages.
* A report not yet issued is hidden from the doctor, the patient app and the printed visit summary; the staff who work on it still see it.
* An issued report is never changed; a correction is an amendment with a reason (existing rule) and the doctor is told again.

## Turnaround time (TAT)
Each request gets a due time when it is created: the department's target for the priority (routine, urgent, emergency). A routine laboratory test uses the test's own turnaround hours when the pathologist set one. For an outpatient asked to come at a set time the clock starts then. Raising a priority starts the shorter clock from now; only the LIMS manager lowers a priority. The dashboards show requests open past their due time, reports issued late, average, middle and slowest-1-in-10 time, the share issued on time, and where the time goes (queue to sample, sample to accepted, accepted to review, review, passed to issued).

## Quality control, instruments, exceptions
* **Instruments**: kept by the LIMS manager (name, model, serial, status, calibration dates). A calibration that is overdue or due within 14 days is flagged.
* **QC runs**: recorded by technicians (and the manager). With numbers and limits the result (pass or fail) is worked out by the server; otherwise the technician says whether the check passed. A failure tells the manager. A run is never changed; the manager adds a review once (not for their own run). A failure marked *needs action* puts its instrument into maintenance until the manager sets it back.
* **Exceptions**: a nurse, reception, a technician or the manager asks for a one-off departure from the rules (go ahead of the queue, use a sample that is not ideal, explain a delayed report). Only the LIMS manager decides, never their own. Approving a queue jump makes the request urgent; approving a compromised sample marks the request so the technician and the specialist see it.

## Permissions
New: `LIMS_READ`, `LIMS_REPORTS`, `LIMS_ORDER`, `LIMS_REQUEST`, `LIMS_PRIORITY`, `LIMS_COLLECT`, `LIMS_ASSIGN`, `LIMS_ISSUE`, `LIMS_QC`, `LIMS_MANAGE`, `LIMS_DEPARTMENTS` (listed with their meaning in `packages/shared/src/permissions.ts`). The department rules reuse the existing ones: pathology needs `LAB_READ` / `LAB_RESULT` / `LAB_VERIFY`; radiology needs `RAD_READ` / `RAD_PERFORM` / `RAD_REPORT`. **A manager is never given `LAB_VERIFY` or `RAD_REPORT` by default.** A hospital that has a qualified manager can give those permissions through a custom role; the check is on the permission, not on being a manager. A doctor sees only their own patients' requests; reception sees only outpatient requests and no clinical detail.

## Billing: where it is done today, and where to plug it in next
**LIMS does not wait for billing, and does not bill.** A test order (`TestOrder`) stays `ORDERED` while the laboratory works on it. Nothing in this release creates an invoice, a charge or a receipt for a LIMS test.

**Where billing is done today**: at the **Cashier**, *Billing → Tests the doctors advised* (`docs/test-orders.md`, `TEST_BILL`). The cashier bills each test from the price list; the test order becomes `BILLED` and is tied to the invoice line (`sourceType` `TEST_ORDER` or `TEST_BILLING_LINE`). That screen still lists a test that is already in the laboratory, and billing it does not disturb the request. Two guards were added so the cashier cannot undo laboratory work: a test already in the LIMS cannot be cancelled at the cashier (only the LIMS manager cancels it), and leaving it off a bill does not cancel it.

**What the LIMS already gives billing**, so it can be added without reshaping anything:
* `LimsRequest.testOrderId` → `TestOrder` (status, `invoiceId`, price-list `serviceId`), and the request view carries `billed`.
* The administrator's and manager's **Billing** tab (`GET /lims/reports/billing`, needs `INVOICE_READ`) already shows, by department, tests billed, not billed, billed amount and *reports issued but not billed*. It only reads.
* Database triggers let samples, results and studies attach to an order that is `ORDERED` *or* `BILLED` as long as a live request exists, so the order of billing and work is free.

**Suggested design for the next step** (needs your decisions, below):
* **Outpatient**: bill at reception or the cashier **after launching and before the sample is taken**. Add a facility setting such as `LIMS_REQUIRE_PAYMENT_BEFORE_COLLECTION`; when on, `POST /lims/requests/:id/collect` refuses an unbilled outpatient request (never for `EMERGENCY`). Hook points: `LimsService.launch()` (to prepare or print the bill) and `LimsService.collect()` (the gate). The cashier's existing flow can bill the launched tests as it is.
* **Admitted patient**: do **not** make the patient pay at the bed. Add a charge to the admission (`Charge`, type `SERVICE`, `CHARGE_CREATE`) when the order is placed or when the report is issued, with the request id as its source so it can never be billed twice, and let the IPD final bill collect it. Hook points: `LimsService.order()` or `LimsService.issue()`.
* **Corrections**: a rejected and re-taken sample must not be billed twice (the request is the same, so bill per request, not per sample); a cancelled request that was billed is reversed with a credit note through the existing billing rules.
* **Insurance**: the claims module (`docs/claims.md`) already follows invoices, so billed LIMS tests flow into claims without further work.

**Decisions to make before building it**: (1) pay first or pay later for outpatients, and are there exceptions (emergency, staff, charity); (2) charge an inpatient at order, at sample collection or at issue; (3) are panels or packages priced as one item; (4) what happens to the bill when a sample is rejected, a test is cancelled or a report is amended; (5) must a test have a price-list item before it can be ordered (today an unmatched name is allowed and priced by the cashier).

## Audit events
`LIMS_TESTS_ORDERED`, `LIMS_OPD_LAUNCHED` (with how the patient agreed), `LIMS_OPD_DECLINED`, `LIMS_SAMPLE_COLLECTED`, `LIMS_SAMPLE_REJECTED`, `LIMS_SAMPLE_ACCEPTED`, `LIMS_SCAN_PERFORMED`, `LIMS_SENT_FOR_REVIEW`, `LIMS_RETURNED_TO_TECH`, `LIMS_REPORT_PASSED`, `LIMS_REPORT_ISSUED`, `LIMS_REPORT_HANDED_OVER`, `LIMS_REQUEST_CANCELLED`, `LIMS_PRIORITY_CHANGED`, `LIMS_REQUEST_ASSIGNED`, `LIMS_DEPARTMENT_CHANGED`, `LIMS_INSTRUMENT_ADDED` / `LIMS_INSTRUMENT_CHANGED`, `LIMS_QC_RECORDED` / `LIMS_QC_FAILED` / `LIMS_QC_REVIEWED`, `LIMS_EXCEPTION_RAISED` / `LIMS_EXCEPTION_APPROVED` / `LIMS_EXCEPTION_DENIED`, `LIMS_PATIENT_MESSAGE_SENT`, plus the existing `LAB_*` and `RAD_*` events. Audit metadata holds request numbers, departments, reasons and masked numbers, never results.

## Notifications (staff, in the app)
`LIMS_COLLECTION_WAITING`, `LIMS_ASSIGNED`, `LIMS_SAMPLE_READY`, `LIMS_REVIEW_WAITING`, `LIMS_READY_TO_ISSUE`, `LIMS_REPORT_ISSUED`, `LIMS_EXCEPTION_RAISED` (also used for a failed quality check). Each is a pointer with no patient name (`docs/notifications.md`).

## Database rules
`LimsRequest` cannot be deleted, moved to another patient, visit, test or department, or change state out of order; the times a report was passed, issued or handed over cannot be rewritten; an admitted patient's request never claims an outpatient's agreement; a request needs a laboratory or radiology test of the same patient, visit and facility that is not cancelled. The history is append-only. A QC run is never changed (only the review is added, once). A decided exception is never changed and cannot be decided by the person who raised it. Every new table is tenant-scoped with row-level security. Migration `20261109100000_lims_portal`.

## API
All under `/api/v1`.

| Route | Permission | What |
|---|---|---|
| `GET /lims/status` | `LIMS_READ` | Whether patient messages are on, the channel, and whether a provider is connected |
| `GET /lims/dashboard` | `LIMS_READ` | Where every department stands, today's collection, acceptance and rejection |
| `GET /lims/reports/performance?from&to&department` | `LIMS_REPORTS` | Workload, turnaround, rejection, per day, per technician |
| `GET /lims/reports/billing?from&to&department` | `LIMS_REPORTS` and `INVOICE_READ` | Billed, not billed, issued but not billed (read only) |
| `GET /lims/departments`, `PUT /lims/departments/:kind` | `LIMS_READ`, `LIMS_DEPARTMENTS` | The two departments |
| `POST /lims/orders` | `LIMS_ORDER` | A doctor orders tests for a visit |
| `GET /lims/opd/pending`, `POST /lims/opd/launch`, `POST /lims/opd/decline` | `LIMS_REQUEST` | Reception: tests waiting, launch with consent, patient declined |
| `GET /lims/staff` | `LIMS_ASSIGN` or `LIMS_REQUEST` | Nurses and technicians to give work to |
| `GET /lims/requests`, `GET /lims/requests/:id` | `LIMS_READ` | Queue and detail with history (filters: stage, department, origin, priority, search, mine, overdue, recollect) |
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
* A test the doctor typed that matches nothing on the price list is still ordered (the cashier prices it later).
* An outpatient's test that the cashier bills **before** reception launches it still shows on the earlier LIS screens (the earlier rule "billed means the lab may work on it" is kept). Reception still sees it under *Tests advised* and launching it brings it under the portal's rules.
* The performance reports read up to 5,000 requests per period; choose a shorter period for a very busy laboratory.
* Cardiology and other procedures are not run through the LIMS.
