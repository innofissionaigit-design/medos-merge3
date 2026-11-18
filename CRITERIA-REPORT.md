# Acceptance criteria check: medos-rajarshee (merged code)

Date 13 Nov 2026 · App: web http://localhost:3100, API :4100 · Method: every story below was exercised **by hand through the live app**, with each step done by the role that owns it (real logins; the same gateway the screens use), plus on-screen checks in the browser pane for the language switch, the lab screens and the earlier walkthroughs. Scripts: `scripts/flow-check/flows2.cjs` (flows `crit1` … `crit8`), logs in `.local/flow-check3/`.

## Result at a glance

| | Stories (78) | "Problem" items (17) |
|---|---|---|
| **Works** | **69** | **14** |
| Partly / works with a caveat | 8 | 3 |
| **Does not work as written** | **1** | 0 |

## Not working, or only partly (the short list)

| # | Criterion | What I found |
|---|---|---|
| 1 | **PHM takes payment while dispensing** | **Does not work as written.** The pharmacist cannot take payment (HTTP 403). Dispensing creates the pharmacy bill and the **cashier** collects it. This is a deliberate rule in the code (`docs/billing-roles.md`, chakrabardhan's change: "pharmacy generates the bill but does not collect payment"). If you want the pharmacist to collect, that permission has to go back to the Pharmacist role. |
| 2 | Overbooking by exception | **No built-in role can do it** (administrator, manager and receptionist all get "You do not have permission"). It works only after the administrator creates a custom role with `APPOINTMENT_OVERBOOK` (tested: allowed with a reason, refused for a nurse). |
| 3 | Any clinician searches patients | Nurse, reception and cashier search by name, mobile and MRN. A **doctor finds only patients under his own care** (data scope), so a doctor cannot look up any patient in the hospital. By design, but not "any clinician". |
| 4 | Bed-day charges accrue per assignment | They accrue **per calendar day**. After a same-day transfer only **one** line is posted for that day (the first bed's rate); from the next day each bed is charged for the days it was used. |
| 5 | Clear errors, no internal terms | Mostly clear, but: the lab result form shows `values.65a579a9-…: Required` (an internal id) instead of "Haemoglobin is required"; after a failed send it says "Someone else changed this result" when nobody did; many forms show only "Request validation failed". |
| 6 | Bengali / Hindi | The switch works and most of the screen turns Bengali, but **9 of 26 menu entries** stay in English in both languages: Emergency, ICU, Laboratory (LIMS), Planned admissions, My rounds, Ward board, Hospital status, Procurement, After discharge. Hindi was checked in the language files, not on screen. |
| 7 | MGR exports a report to CSV | The export is **logged** (API answers 201) and the Download CSV button exists; I did not open a downloaded file. |
| 8 | Backup and verified restore | **Not verified by me.** The backup tool exists with its own tests, but this PC has no PostgreSQL client tools (the database runs in Docker), so I could not run a backup and restore. `docs/backup-validation.md` says it passed on the developer's PC; Linux is untested. |
| 9 | Isolate tenants | Proven by the automated tenant sweep (50/50) and the row-level-security tests; by hand I checked what one tenant allows (a `tenantId` sent by the browser is refused, unknown ids look like "not found"). The demo has only one hospital, so I could not try one hospital against another live. |
| P1 | Email management | Screens/API exist (status, 7 templates in English/Bengali/Hindi, outbox, suppression list, test mail), but email is **switched off** (`EMAIL_ENABLED` false, provider "log"): a test mail answers "DISABLED" and nothing is sent until configured. |
| P2 | AI integration | Exists but **switched off and not connected** (no provider, no key); the status says "switched off for this hospital". |
| P3 | Hand-written prescription + OCR | Upload works once `PRESCRIPTION_UPLOAD_ENABLED` is on (it is off by default); the **OCR provider is not configured**, so the scan says "OCR not configured" and the doctor types the lines by hand, then approves. Real OCR extraction could not be tested. |

Also still true from the earlier report (not a criterion, but serious): **F1**, a doctor who does not treat a patient can write a note, vitals, diagnosis and prescription on that patient's visit (and it reached the pharmacy queue).

## What works (tested by hand)

### Access
* Log in with hospital code + **username** and with hospital code + **email** + password; wrong password / wrong hospital code answer the same generic "Invalid credentials".
* Session: access token works; **refresh gives a new pair, the old refresh token cannot be replayed**; **logout revokes**; a forged or missing token is refused (401).
* **Change password** (wrong current password refused; old password stops working, new one works); weak passwords refused; administrator resets, unlocks, deactivates; an inactive user cannot log in.
* ADM creates users, sets roles, creates and edits **custom roles**.
* **Permissions server-side:** 8 forbidden calls by wrong roles all returned 403.
* **Rate limit:** with the limit on, the 11th login attempt in a minute returns **429 RATE_LIMITED**. (My test API has it off on purpose so scripted logins are not throttled; I proved it on a throwaway second API with it on, then stopped that.)

### Masters
Facility (phone, GSTIN); departments (create/edit); wards, rooms, beds with daily rate; practitioners with **weekly schedule**; service catalogue add + price change; print header (name, address, GSTIN) and footers; feature flags (pharmacy, IPD, nursing); numbering rules (list, change, invalid pattern refused). The GST rounding switch is `INVOICE_TAX_SPLIT`.

### Reception, appointments, queue
Register a patient (the call takes ~0.5 s; the form asks 5 fields); duplicate warning (listed matches) and the stop (409); **deliberate override with a reason, audited**; edit demographics (nurse refused); photo and PDF upload (an .exe refused); extra identifier (LEGACY / EXTERNAL); free slots of a doctor; book; **no double booking**, outside hours refused, past refused; **reschedule/postpone**; **prepone to the past refused, to an earlier future date works**; cancel with reason (second cancel refused); no-show (only when the time has come); walk-in with token; priority to emergency puts the patient first; doctor calls a chosen or the next patient.

### Clinical
Vitals by nurse and doctor (impossible value refused); allergy; diagnosis; consultation **draft**; prescription; **allergy warning on the prescription, signing blocked until acknowledged, override works and is audited**; signed note cannot be overwritten; **amendment needs a reason, creates version 2, version 1 stays readable**; all digital-prescription segments (complaint, history, past history, examination, advice, lab / imaging / cardiology / procedures advised, diet, referral, follow-up) save.

### Billing
Draft invoice create and edit (server works out the total; a total sent by the browser is refused); issue; an issued invoice cannot be edited; payment above balance refused; **split payment cash + UPI + card**; receipt prints; invoice prints as HTML and **PDF**; **discount by manager only** (cashier refused); **credit note** by manager, **refund** by cashier only (manager refused; refund above allowed refused); manager cancels an unpaid invoice; cashier shift (current, expected cash, close with count and note); patient ledger lists bills, payments, credit note, refund and balances to settled.

### Pharmacy
Draft prescription hidden from the pharmacist; signed one appears; **FEFO** batch suggested and used (earliest expiry first); patient return raises a credit note; returning more than sold refused; cashier cannot dispense; medicine master add/edit; supplier; **purchase received**; **return to supplier** (debit note); **adjust / write off** with a reason (short reason refused); stock ledger lists every movement; overselling refused (INSUFFICIENT_STOCK). Locations and two-step stock transfer (earlier round).

### Inpatient
Admit under a named consultant; bed status explicit (OCCUPIED, CLEANING, MAINTENANCE only by administrator); transfer keeps both assignments; charges posted; an admission with charges cannot be cancelled, one without can; nurse worklist; notes and addenda, intake/output, medication schedule from signed orders (earlier IPD flow, 125/127 with the F1 misses).

### Reports, audit, print
19 operational reports answer (13 needed); a range over 93 days and a reversed range are refused; a nurse cannot run finance reports; CSV export is logged. Audit log: view, **filter by action**, list of people, manager can read, nurse cannot; audit events cannot be edited or deleted through the API (404); 7 sampled important actions all wrote events. Prints: invoice, receipt, prescription, discharge summary, patient label (HTML and PDF), radiology report.

### Menus, language, data
Role menus match the role (reception, doctor, nurse, cashier, pharmacist, manager, administrator and the lab roles); global patient search in the header ("/" shortcut); a dashboard per role. Seed data: 1,099 patients, 101 medicines in 205 batches, 13 doctors, 60 users, 36 beds, 11 departments (the demo seed is about 1,000 patients; the rest are my test patients).

### The "Problem" items
* **LIS with branches:** one lab module with Pathology and Radiology branches and different views: `labtech1` sees the Pathology work list, `radiographer1` the Radiology scan list (both on the LIS screen); `pathologist1`, `radiologist1`, `p_lab_tech1`, `r_lab_tech1` use the newer Laboratory (LIMS). Both modules exist side by side.
* **X-ray:** radiology branch queue, record scan, radiologist report, print.
* **Telemedicine:** 26/26 in the earlier flow run.
* **API for other systems / voice bot:** an administrator creates a key with limited abilities; the bot lists doctors and free times, registers a caller, finds a caller by mobile (only first name, last initial, gender, age, MRN), **books, postpones and cancels its own booking**, and is refused on invoices, patients search, users and pharmacy.
* **Reports:** a doctor's own report (booked, walk-ins, cancelled, no-show, consulted, booked-and-consulted, collected, my share); the all-doctors report is refused to a doctor and shows 10 doctors with all columns and the hospital's share to the administrator.
* **Split:** earnings model (percentage / fixed / both), a **60 % rule** for one doctor, a **₹300 fixed fee** for another, a default for the rest; only the administrator can change it.
* **Skip the booking amount** for special cases: reason from the configured list, only for staff with the right (earlier round).
* **Payment-link deadline + auto-cancel:** the booking gets a deadline (15 minutes); two real bookings waited it out and were **cancelled by the system: "Booking fee not paid in time"** (audited, no human actor). The WhatsApp send is a documented placeholder; the database refuses edits to a payment link.
* **Cancellation in the ledger:** cancelling a ₹400-fee booking inside the free-cancel window shows in the patient ledger: fee received **credit ₹400**, **Cancellation charge debit ₹200** (50 %), the rest paid from the advance.
* **Postpone / prepone:** see above; the past date is refused.
* **Duplicate by a different mobile number:** same person registered twice (needs the override): the second record **cannot book the same doctor again**, and **cannot book another doctor of the same department on the same day** (409 DUPLICATE_BOOKING_SUSPECTED); a different day is allowed; override only for staff with the right and with a reason.

## Test data I created and left
Test users (`crit…`, `ovb…`), a custom role, a department, a ward/room/bed, a service, earnings rules (60 % / ₹300 / 50 % default) and the print header/footer I set, integration key "Voice bot …" (30 days), numbering unchanged, schedules changed for some doctors (Dr. Abhijit Bose now Mon/Wed 10:00-13:00; Dr. Debjani Sarkar, Dr. Arpita Chakraborty and Dr. Tanushree Das open all day), the facility phone and GSTIN. Booking-fee, OCR and upload switches are back off.
