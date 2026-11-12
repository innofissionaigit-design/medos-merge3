# Flow test report: merged code (medos-rajarshee)

Date: 12 Nov 2026 · Code: `medos-rajarshee`, branch `merge-2-aftercare` (rajarshee's code + chakrabardhan's after-care work, see `MERGE-REPORT-AFTERCARE.md`) · App: web http://localhost:3100 (production build), API :4100, database `medos_merge2` (full demo seed).

Flows tested: **OPD patient journey, emergency ward, telemedicine, ICU, the whole LIMS flow** (outpatient, reception booking, admitted patient, emergency and ICU tests, control room). In these flows the **billing parts come from chakrabardhan's code** (consultation and pharmacy bills, the lab bill at arrival, the emergency bill, admission charges); they are marked 💲 below.

## Result

| Flow | Steps | Passed | Browser / server errors |
|---|---|---|---|
| OPD patient journey | 32 | **32** ✅ | none |
| Whole LIMS flow | 83 | **83** ✅ | none |
| Emergency ward | 47 | **47** ✅ | none |
| ICU | 29 | **29** ✅ | none |
| Telemedicine (staff + patient app) | 26 | **26** ✅ | none |
| **Total** | **217** | **217** | **none** |

Plus:
* **Screens for every role** (21 logins): every page in every role's menu opens with no crash, no server error and no browser error; pages outside the menu are refused (exceptions listed in *Observations*).
* **Automated API tests of the merged code** (real database): 1,379 / 1,382 in the full suite; the files of these flows all pass; tenant isolation sweep 50/50 (details in `MERGE-REPORT-AFTERCARE.md`).
* **Project browser tests** (Playwright): 20/20, including the mandatory OPD journey.

## How it was tested
* Google Chrome driven by Playwright (`scripts/flow-check/flows.cjs`, `role-sweep.cjs`). **Every role signs in through the login form** in its own browser session. Each step is done **by the role that owns it, through that role's browser session** (the same `/api/proxy` gateway the screens use), and the screens each role works from are opened and checked for the patient and state, with a screenshot.
* **Negative checks**: at the important steps, a role that must not do it tries, and must be refused.
* The patient app is used as a patient would: on a phone-sized window, signing in with the code sent by SMS.
* Text messages: the API was pointed (local setting only) at a small local stand-in for the SMS/WhatsApp gateway (`scripts/flow-check/sms-capture.cjs`) so the messages MedOS sends (patient-app sign-in code, lab booking, reports ready) could be read back. Nothing left the machine.
* Logs and 400+ screenshots: `.local/flow-check/` (git-ignored).

## 1. OPD patient journey: 32/32
| Who | Step |
|---|---|
| reception1 | Registers a new patient (MRN issued); opens the patient record |
| reception1 | Walk-in check-in to doctor1 → visit number and token; patient shown on reception's OPD queue and on the doctor's queue |
| reception1 | **Refused**: recording vitals |
| nurse1 | Records pulse, temperature, BP, SpO2 |
| doctor1 | Calls the patient, starts the consultation (**nurse refused** writing it) |
| doctor1 | Consultation note (CBC and chest X-ray advised, follow-up in 5 days), diagnosis J06.9, prescription from stock, **signs**, completes the visit; a signed note **cannot be overwritten**; visit page shows *signed* |
| cashier1 💲 | Consultation bill drafted and issued; **split payment** cash + UPI; receipt prints; bill page shows *paid* |
| cashier1 | **Refused**: dispensing |
| pharmacist1 💲 | Signed prescription is in the pharmacy queue (screen); dispenses (FEFO batch) → pharmacy bill; cashier collects it |
| doctor1 / manager1 / admin | Prescription prints; reports screen; daily OPD report |

## 2. Whole LIMS flow: 83/83
**Outpatient (from the OPD visit above)**
| Who | Step |
|---|---|
| reception1 | The doctor's advised tests wait at the reception desk, not in the lab (X-ray chest PA ₹350 radiology, CBC ₹250 pathology) |
| reception1 | **Refused** without the patient's consent; with consent, tests launched with a date from the lab load (13 Nov 8:00 am: the lab is closed at night) |
| system | Patient sent **WhatsApp and SMS**: department, date, preparation and request numbers, no test name |
| lims_manager1 | Sees both requests in the control room; assigns them to a nurse; **refused** typing a result |
| nurse1 | **Refused** taking the sample before the patient reports at reception (`PATIENT_NOT_ARRIVED`) |
| reception1 💲 | *Patient arrived*: tests billed at the price list and paid in one step |
| nurse1 | Takes the sample / gets the patient ready (**pathology technician refused** taking it) |
| p_lab_tech1 | Accepts the sample (**radiology technician refused**), types the values, **refused** verifying own result, sends for review |
| doctor1 | Cannot see the result before it is issued |
| pathologist1 | Passes (verifies) the values (**LIMS manager refused**) |
| p_lab_tech1 | Issues the report (**nurse refused** issuing) |
| r_lab_tech1 / radiologist1 | X-ray performed (**pathology technician refused**), sent to the radiologist, signed with findings and impression (**LIMS manager refused** signing), issued |
| system | Patient told **"your report … is ready at reception … results are not sent by message"** (WhatsApp and SMS, sent by the worker within a minute) |
| reception1 | Both reports **handed over** (to the patient's brother) |
| doctor1 | Sees the issued report on the visit and the visit page |

**Reception books a test with no doctor's order** (outside referral): booked, patient messaged.

**Admitted patient**: doctor2 orders CBC (urgent) + chest X-ray from the admission → same chain (nurse, technicians, pathologist, radiologist, issue) → 💲 **both became charges on the admission bill** (`LRQ-…` lines).

**Control room**: instrument added (calibration due soon), QC run passing and QC run failing (worked out from the limits), manager reviews the failed run; a nurse raises a *queue jump* exception and the LIMS manager approves it; performance, billing and lab-load reports; hospital manager reads the billing report; the LIMS screens of the LIMS manager, technicians, pathologist, radiologist, reception, nurse and administrator; **cashier refused** the LIMS page.

## 3. Emergency ward: 47/47
| Who | Step |
|---|---|
| er_reception1 | Emergency board; **refused** OPD queue, appointments, admissions, pharmacy |
| er_reception1 | Registers the arrival (ambulance, brought by son) → case `ER-2026-…`, emergency bill and red alert; emergency bed given |
| er_nurse1 / er_doctor1 | Both alerted |
| er_nurse1 | Triage **RED** (breathing compromised, pain 8) — **desk refused** triage; vitals; moves the patient to another emergency bed |
| nurse1 | Marks emergency beds left *cleaning* as clean from the bed board |
| doctor1 / er_nurse1 | **Refused**: a doctor who was not called accepting the case; the nurse deciding the disposition |
| er_doctor1 | Accepts; assessment note (working diagnosis STEMI); orders a test → in the lab queue with **EMERGENCY** priority; emergency nurse takes the sample |
| er_nurse1 | Nurse requests: a medicine and a test (**refused** approving her own request) |
| er_doctor1 | Accepts the medicine request and signs it; declines the test request with a reason; case page |
| pharmacist1 💲 | Dispenses → added to the **emergency bill** (not sold at the counter) |
| er_reception1 💲 | Adds an ECG charge to the emergency bill (**nurse refused**) |
| — | Second patient: triage GREEN → accept → **home**: visit ends, bill issued, bed freed, case *DISCHARGED* |
| — | Third registration **cancelled** (made by mistake) |
| manager1 | Hospital status (emergency ward); **refused** triage |

## 4. ICU: 29/29 (continues the RED emergency case)
| Who | Step |
|---|---|
| er_doctor1 | Hands over to the ICU (free ICU bed, ICU doctor chosen): admitted on the **same visit** |
| icu_doctor1 / icu_nurse1 | Patient on both ICU boards; ICU patient page (with what was handed over); ICU doctor **refused** OPD queue and appointments |
| icu_doctor1 | Vitals every 15 minutes (**nurse refused** setting it); **urgent** instruction |
| icu_nurse1 | Sees the urgent alert; records vitals; marks the instruction done with a note (**doctor refused** ticking it; **done only once**) |
| icu_nurse1 💲 | Starts the ICU cardiac monitor (per-day charge; **cannot run twice at once**); later stops it |
| icu_doctor1 | Day note with plan; orders a test (assigned to an ICU nurse) |
| icu_nurse1 / icu_doctor1 | Nurse asks for a test; doctor accepts (ordered in the doctor's name) |
| icu_doctor1 💲 | Patient page shows **Day 1** and **Billing for this stay** |
| manager1 / doctor1 / admin | Manager sees the board read-only (**refused** writing an instruction); another doctor **refused** writing an ICU note; hospital status |

## 5. Telemedicine: 26/26
| Who | Step |
|---|---|
| admin | Video service address set; **patient app switched on** (`PATIENT_PORTAL_ENABLED`, off by default); a doctor's hours set so a slot exists at night (test setup) |
| reception1 | Registers the patient, books the next slot, **Make video** (**nurse refused**; **only once** per appointment) |
| reception1 / doctor8 | Video consultations screen (desk and doctor) |
| doctor1 / reception1 | Another doctor does not see it and **cannot join**; reception **cannot join** as the doctor |
| patient (patient app, phone size) | Signs in with the **6-digit code received by SMS**, confirms date of birth, sees "video consultation", ticks consent, presses **I am here** → waiting room |
| doctor8 | Sees the patient waiting; joining without the identity check is **refused**; confirms identity (photo ID) and starts → video room on the hospital's video service |
| patient | App shows **Join video call**; joins the room |
| doctor8 | Ends the call |
| reception1 | Second video consultation **cancelled** before it starts, with a reason |

## Observations (not failures)
1. **Pages hidden from the menu but reachable by address** (rajarshee's design: the menu hides them, the page's own access check allows them): the older lab page `/lis` for the doctor, nurse, manager, administrator, emergency nurse/doctor, ICU doctor/nurse, LIMS roles and ward coordinator; `/ipd` and `/nursing` for the ICU doctor; `/ipd` for the ICU nurse. The data on them is still limited by each role's permissions and data scope. If these should be blocked, the page guards need tightening.
2. **Emergency beds and housekeeping.** A bed freed in the emergency ward goes to *cleaning*; it is made available again by a ward nurse or the administrator from the Admissions bed board (rajarshee's behaviour). Chakrabardhan's Housekeeping screen lists only beds vacated by an inpatient discharge, so it does not show emergency beds. The emergency nurse cannot mark the bed clean herself. Worth joining later (a turnover task for emergency beds).
3. **The patient app is off by default**; until the administrator switches on `PATIENT_PORTAL_ENABLED`, the code request answers "sent" but sends nothing (deliberately, so nobody can find out which numbers are registered).
4. **A video call can only be opened from 15 minutes before the appointment**, and an outpatient lab booking made at night is given the next lab opening (08:00). Both are by design; test bookings must respect them.
5. **Lab messages are sent by a background worker** (about once a minute), not at the moment of the click.
6. With all six emergency beds in use, a new emergency is still registered, without a bed (never turned away).

No defect was found in these five flows during the walk-through. The one crash found in this area earlier (pharmacy *Receive purchase*, chakrabardhan's code) was fixed before these runs (`MERGE-REPORT-AFTERCARE.md` §4.5).

## Re-running
```
node scripts/flow-check/sms-capture.cjs              # local SMS/WhatsApp stand-in on 127.0.0.1:4299 (API: MESSAGE_PROVIDER=http, MESSAGE_API_URL=http://127.0.0.1:4299/send)
set BASE=http://localhost:3100
node scripts/flow-check/flows.cjs apps/web <out-dir> <seed password> [opd lims er icu tele]
node scripts/flow-check/role-sweep.cjs apps/web <out-dir> <seed password>
```
Uses the Google Chrome installed on the PC (Playwright from `apps/web`). Each run creates new synthetic patients in the demo database.
