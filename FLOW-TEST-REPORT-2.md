# Flow test report 2: advance, telemedicine, LIMS, emergency to ICU, admission, inpatient treatment

Date: 13 Nov 2026 · Code: `medos-rajarshee`, branch `main` (the merged code, commit `e8e2e96`, nothing changed in the app code by this test) · App: web http://localhost:3100 (production build), API :4100, database `medos_merge2`.

## How it was tested

1. **On screen, in the built-in browser** (the pane you were watching): one patient, **Anindita Mukherjee (MRN DEMO-001039)**, taken from registration to a closed record, with a different login at each step (9 profiles): reception1, admission1, doctor4 (Dr. Sneha Das), nurse1, pharmacist1, cashier1, transport1, housekeeping1, mrd1. Plus the ICU doctor's ICU board.
2. **Scripted, in Google Chrome**, every step done by the role that owns it through that role's own signed-in session, with refusal checks (a role that must not do the step tries and must be refused): `scripts/flow-check/flows.cjs` (OPD, LIMS, emergency, ICU, telemedicine) and the new `scripts/flow-check/flows2.cjs` (advance, admission, inpatient, scope probes).
3. **Profile-by-profile screen sweep** (`scripts/flow-check/role-sweep.cjs`, now 31 logins).

## Result

| Flow | Steps | Passed | Notes |
|---|---|---|---|
| 1. Taking an advance (+ booking fee) | 60 | **60** ✅ | |
| 2. Telemedicine (staff + patient app) | 26 | **26** ✅ | |
| 3. LIMS (outpatient, reception booking, admitted patient, control room) | 85 | **85** ✅ | |
| 4. Emergency to ICU | 46 + 29 | **75 / 75** ✅ | (first run 48/48 for emergency) |
| 5. Admission (walk-in and planned, 3 routes) | 99 | **99** ✅ | |
| 6. Inpatient treatment through discharge | 127 | **125** | the 2 misses are finding **F1** below |
| Associated: OPD journey (feeds LIMS and billing) | 32 | **32** ✅ | |
| Doctor data-scope probe | 10 | 4 | the 6 misses are finding **F1** below |
| ICU patient stepped down to a ward | 4 | **4** ✅ | |

No browser error and no server error in any run.

## What was done on screen (Anindita Mukherjee)

| Who | What | Result |
|---|---|---|
| reception1 | Registered the patient; **took an advance ₹5,000 (₹3,000 cash + ₹2,000 UPI, split)** | Receipt RCT-2026-000083, patient page shows "Available to use ₹5,000" |
| reception1 | Created a ₹500 consultation bill, **Use advance** | Bill paid, receipt in method "other", balance ₹4,500 |
| admission1 | **Admitted** to a private room (P3) under Dr. Sneha Das | ADM-2026-000018, bed history started |
| doctor4 | **Signed a medication order** (Ceftriaxone IV, BD); **round note** with a nursing instruction; **procedure "ECG"** charged ₹300 | The instruction became a nurse task; the ECG charge went onto the admission bill by itself |
| nurse1 | Generated the dose chart; **dose refused when given 2 hours or more early**; **held** a dose with a remark; recorded vitals; nursing note; intake 500 ml | All saved and shown |
| doctor4 | **Discharge decision**, then wrote and **signed the discharge summary** | Summary locked ("signed by Dr. Sneha Das") |
| nurse1 | **Cleared nursing** with a handover note | Stage shows who and when |
| cashier1 | **Cleared charges review**, generated the **final bill** ₹2,800 (ECG ₹300 + bed ₹2,500), **paid it from the advance** | Bill paid |
| doctor4 | **Waived the pharmacy stage** with a written reason (the medicine was typed free-hand, so it could not be dispensed from stock); **discharged** (asks "Yes, discharge the patient") | Bed kept until the patient leaves |
| transport1 | **Confirmed the departure** (wheelchair, escorted by husband) | Bed freed, bed turnover opened |
| housekeeping1 | **Start cleaning**, **Mark ready**; sees only beds, never patient names | P3 available again |
| mrd1 | **Coded the diagnosis (ICD-10 K80.20) and signed off the record** | Post-discharge shows "Records complete; claims and receivables closed" |

## Findings

### F1. A doctor can write into another doctor's patient (needs your decision) — **High**
Same behaviour in `medos-final-merged-code`; it is not from the merge.
A doctor who does **not** treat a patient cannot open the patient's visit (they get "not found"), but the server still accepts their **writes** on that visit:

| Done by another doctor (doctor3) on doctor1's OPD visit | Result |
|---|---|
| Write the consultation note | accepted |
| Add a diagnosis | accepted |
| Record vitals | accepted |
| Write a prescription draft | accepted |
| Same on an inpatient's medication order (doctor2's patient) | accepted |

Worse, the stray draft **locks the owner out**: doctor1 then gets "This draft prescription belongs to another doctor", and cannot overwrite the consultation draft either. While testing this I left a visit like that and the owning doctor could **only sign the other doctor's text as it stood** — not edit it — before the visit could be closed.
Cause: `prescriptions.service.ts` (`saveDraft`) and the consultation, diagnosis and vitals writes check that the visit is active but not that it is in the doctor's own scope; the read paths do check (`visitScope`).
Care needed in the fix: the emergency-to-ICU hand-over has the ICU doctor writing on a visit that began as the emergency doctor's, so the scope rule must allow that (the visit's doctor changes on hand-over, or hand-over adds the ICU doctor to the visit). I did **not** change this; say if you want it fixed and I will do it with tests for OPD, ward, emergency and ICU.

### F2. "Intake and output (today)" shows 0.0 between midnight and 6 am — Low
The ward page asks for totals of the calendar date; the server counts the nursing day as 06:00 to 06:00. A night-shift nurse who records 500 ml at 00:23 sees the entry in the list but "Intake 0.0 ml" above it. (Same in the original code.)

### F3. A nursing note marked "entered in error" hides its addenda — Low
The default notes list drops the corrected note **and** any addendum attached to it (for example a re-checked temperature). History is kept in the database and `?includeErrors=true` shows it, but the screen does not.

### Design points worth deciding (not bugs)
* **"Charges review" is a billing stage, but nurses, doctors and reception can clear it** (they hold the charge-posting permission). The cashier then gets "already cleared". Consider a separate permission.
* **The ordinary Admit dialog lists Operation Theatre beds** and the server accepts an admission into one (the emergency doctor's hand-over uses the OT as a destination, so this may be intended). The probe admission was cancelled at once. Emergency and ICU beds were not free to test.
* **A medicine typed free-hand by the doctor cannot be dispensed** (the pharmacist must pick a medicine from stock); the pharmacy stage then blocks the discharge until the doctor waives it. The pharmacist's screen says so clearly. A picker in the doctor's order form would avoid this.
* The "Mark dose as held" window opens still showing the previous "Given" error (cosmetic; the hold saved fine).
* **Patient transport** can open all admission tabs; the medication tab shows "No signed medication orders yet" (data is hidden, but the wording is misleading).
* The Admissions link `?admit=<patient>` does not pre-fill the patient in the Admit window.
* A paid bill still offers "Start OPD visit".

## Things the tests showed working well (kept as evidence)
* Advance: the same click sent twice is not taken twice; a bill cannot take more than it owes; two clicks at once on ₹1,000 cannot overdraw it; refunds only by the method received, with a reason, cash needs an open shift; booking fee blocks check-in until paid or skipped (skip only for configured reasons and only with the permission); printed bill shows an Advance section.
* Admission: one admitted stay per patient; an occupied bed cannot be given twice; a held (reserved) bed cannot be freed by hand or held twice; a planned admission cannot skip steps (estimate, payer, deposit, bed in order); deposit stays the patient's advance; cancelling returns the bed; an admission with charges cannot be cancelled ("Discharge instead").
* Inpatient: a dose cannot be given more than 2 hours early or twice; holding needs a remark; the doctor's round instruction becomes a nurse task; a procedure's charge comes off the bill when it is marked in error; **nursing stage blocks while a task is pending**; **billing stage blocks while part of a deposit is neither used nor given back**; the summary signer cannot verify it; the bed is freed only when the patient actually leaves; housekeeping cannot see the patient; MRD needs a valid ICD-10 code.
* ICU to ward: a patient can be stepped down; the ICU bed becomes "cleaning" and the nurse makes it available.

## Test data and housekeeping
* Each run creates synthetic patients. The last runs filled the ICU, so I stepped the three older ICU test patients down to ward beds (the app refuses to *cancel* an admission that has charges), cleaned their beds, and closed two test visits left open by my scope probe.
* Test settings changed and restored: booking fee switched on for the test and **back off**; patient app (`PATIENT_PORTAL_ENABLED`) and the video service address were switched **on** by the telemedicine test and left on.
* The LIMS test now admits a fresh patient instead of reusing an admitted one (an earlier pending CBC otherwise triggers the duplicate-order refusal, correctly).

## Re-running
```
node scripts/flow-check/sms-capture.cjs
set BASE=http://localhost:3100
node scripts/flow-check/flows.cjs  apps/web <out-dir> <seed password> [opd lims er icu tele]
node scripts/flow-check/flows2.cjs apps/web <out-dir> <seed password> [adv adm ipd scope beds clean]
node scripts/flow-check/role-sweep.cjs apps/web <out-dir> <seed password>
```
Screenshots and logs are in `.local/flow-check2` and `.local/flow-check3` (git-ignored).

---

# Round 3: the six areas checked in the browser with one tab per profile

Method: the Browser pane with up to 9 tabs open at once, each on its own local hostname (`reception.localhost`, `cashier.localhost`, `pharm.localhost`, …) so every tab keeps its own login. Everything below was clicked on screen. Profiles used: reception1, admission1, bedmgr1, doctor1, cashier1, manager1, pharmacist1, nurse1, lims_manager1, p_lab_tech1, pathologist1, er_reception1, er_nurse1, er_doctor1, icu_doctor1, coordinator1.

## 1. Admission: the ways in (all worked)
| Way | What I did on screen | Result |
|---|---|---|
| **Came with outside papers** (Planned admission) | Reception *New request* → "Came directly with an outside doctor's prescription and reports" → doctor **asked her to come to the chamber** → reception **sent her to the doctor's queue** (token 7) → doctor **accepted** → admission desk **verified** → billing **estimate ₹47,500, self-pay, deposit ₹10,000** (RCT-2026-000105) → bed manager **held bed P11** → desk **admitted** | Admitted (ADM-2026-000029); nurse's worklist shows "Nursing admission assessment (9:30 am)" on P11 |
| **OPD advised → inpatient** | Doctor opened an OPD visit, ticked *This patient needs to be admitted* → request PA-2026-000005 → reception asked the patient and pressed *The patient agrees* | Request moved to the admission desk (remaining steps are the same chain as above) |
| **Already arranged with a consultant** | Form checked on screen; the full route was driven earlier by script (accept, verify, waive, cancel) | OK |
| **Walk-in (ordinary Admit)** | Done earlier on screen for Anindita (ADM-2026-000018) | OK |

The bed manager's screen said "No bed is free in Private Rooms. Tick the box to see other wards, or move the day." (my test patients held them); I added beds P11-P13 through the admin master data to continue.

## 2. Emergency to ICU (worked)
er_reception1 registered GopalQv Paul (ER-2026-000020, ambulance, no bed because the ward was full, ₹500 emergency bill opened) → er_nurse1 **triaged Red** (airway at risk, circulation poor, pain 9) → er_doctor1 **accepted**, wrote the assessment (suspected STEMI) → decision **ICU (2 of 3 free)**, bed ICU2, ICU Doctor One, with a confirm step → status "handed over", bill **issued ₹500** → icu_doctor1's ICU board shows the patient in ICU2 "from emergency ER-2026-000020".

## 3. Billing, all the parts (worked)
Registration fee, OPD bill, **collect advised tests at the cashier** (₹600, receipt RCT-2026-000107), **LIMS tests billed at arrival** (₹700), **advance and deposit** (earlier), **planned-admission deposit**, **final IPD bill paid from advance**, **emergency bill issued**, **credit note by the manager** (CN-2026-000001, −₹250), **cashier refund** (RF-2026-000021, −₹250, asks "Yes, refund"), the cashier's **open shift** (expected cash shown), manager **bill list** by type (OPD, Registration, Pharmacy, Admission, Emergency, Other) and the **reports menu** (earnings, collections, outstanding, discharge turnaround, stock).
**Double billing check:** the same advised tests can be collected at the cashier or at reception's LIMS desk. After the cashier collected, reception showed them "billed: nothing more to pay for them". No double charge.

## 4. Pharmacy and its internal workflows (worked)
Prescription queue, stock with batches earliest-expiry first (history/adjust), **Receive purchase against a purchase order** (PO-2026-000001 → PUR-2026-000002, lines filled from the order; this is the screen that crashed in chakrabardhan's code before the merge, now fine), **Locations**: created "General Ward store", **two-step stock transfer** TRF-2026-000001 (50 × Paracetamol-Forte leaves the main store, shows "on the way", counts at the ward only after **Arrived**: ward store 50 units). Free-typed medicine names cannot be dispensed from stock (pharmacist must choose a stock medicine).

## 5. LIMS: advised tests to billing (worked, as you described)
Doctor advised CBC + X-ray in the consultation (ESR was added by my typing; kept) → **reception "Tests advised"**: cost ₹700, the lab load (*Pathology 9 waiting, 21% full, 8 an hour; Radiology 1 waiting*) and the **first free time (13 Nov, 10:00 am)**; *Send to the lab* is **disabled until the patient's agreement is ticked** (said so at the desk / signed form), or *Patient does not agree* → sent as LRQ-2026-000049/50/51, WhatsApp and SMS queued → **Patient arrived** → bill ₹700 (advance used first, then cash/split) → nurse takes samples → technician **accepts**, enters values → **pathologist passes** → technician **issues** → reception **hands over**. The LIMS manager's *Lab load* tab states the rule: "the first hour in which every lab they need has room, so the more work is waiting or booked, the later the date"; the lab technician's queue puts emergencies first.

## 6. Inpatient internal workflows (worked)
Earlier on screen for Anindita: orders, dose chart (a dose more than 2 hours early refused), vitals, notes, intake/output, round note with a nurse instruction, charged procedure, discharge stages, summary, final bill, departure, bed turnover, record sign-off. This round: the **ward coordinator's board** (22 admitted, per-ward rows with vitals, doses, tasks, tests, last doctor note, charged amount, "x of 5" discharge progress, and the doctors' round times with "not started in time").

## New findings from this round
| # | Finding | Severity |
|---|---|---|
| F1 (more evidence) | The prescription written by the non-treating doctor on Dr. Soumen's OPD patient was **signed together with the owner's note and arrived in the pharmacy queue as "Dr. Amit Halder · RX-2026-000019"**. A drug nobody treating the patient ordered would be dispensed. | High |
| F4 | Lab result entry: a failed "Send for review" shows a raw message, `values.65a579a9-…: Required`, instead of "Haemoglobin is required". | Low |
| F5 | After that failed send, the next attempt says **"Someone else changed this result. Reload it first"**, though nobody else did (the dialog keeps a stale version). The technician must close and reopen. | Medium |
| F6 | The ER→ICU screen offers "Dr. ICU Doctor One (4 in the ICU now)" while the ICU board shows 2 (the count includes patients already stepped down to wards). | Low |
| F7 | Doctor pickers include non-OPD doctors: the walk-in OPD check-in list and the planned-admission consultant list include Emergency, ICU and RMO doctors; the planned-admission ward lists include Emergency Ward, ICU and Operation Theatre (the server refuses the emergency ward). | Low |
| F8 | After a planned admission the patient's OPD chamber queue entry (token 7) stays "waiting". | Low |
| F9 | The pathologist's review window shows Hb 12.1 (normal 13.5-17.5) and WBC 11.8 (4.0-11.0) with no low/high flag. | Low (check) |
| F10 | 103 unread notifications on the emergency nurse (and 35-48 on others) from test runs; no "mark all read" seen. | Info |

## Test data left behind
Beds P11-P13 added to Private block; General Ward store (location) with 50 Paracetamol-Forte; new synthetic patients and requests (PA-2026-000004/5, ER-2026-000020, LRQ-2026-000049/51 partly processed: ESR and X-ray not yet resulted); booking fee setting is off.
