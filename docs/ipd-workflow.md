# IPD workflow: admission to discharge

How an inpatient moves through MedOS, who does each step, and where. Based on the flow run end to end in the demo hospital (`demo-hospital`, password `Medos#Demo2026` for every demo user).

## At a glance

```
Register → Admit (direct, or planned) → Nursing assessment → Stay: rounds, medicines,
tests, scans, charges → Doctor advises discharge → Discharge stages → Final bill and
payment → Patient leaves → Bed cleaned → Medical records sign-off
```

## 1. Registration

| Who | Where | What |
|---|---|---|
| Receptionist `reception1` | OPD or IPD desk, **Patients** | Register the patient once. One patient record is used by every department. |

## 2. Admission: two routes

### 2a. Direct admission
| Who | Where | What |
|---|---|---|
| Receptionist `reception1` (IPD desk) | **Admissions → Admit patient** | Choose the patient, the consultant, a free bed (grouped by ward) and a reason. |

### 2b. Planned admission (patient comes on a chosen day)
| Step | Who | Where | What |
|---|---|---|---|
| 1. Request | `reception1` | Planned admissions → New request | Patient, consultant, what the patient says. |
| 2. Doctor | The consultant (e.g. `doctor5`) | Open the request | Accept with diagnosis, procedure, day, expected stay (or ask for more, recommend other treatment, decline). |
| 3. Admission desk | `admission1` | Request page | Verify the details and choose the ward. |
| 4. Estimate and payer | `cashier1`, `tpa1` | Request page | Estimate of charges; self-pay or insured; tariff checked; pre-authorisation requested and approved when insured. |
| 5. Deposit | `cashier1` | Request page | Deposit amount set and taken. |
| 6. Bed | `bedmgr1` | Request page | Hold a bed. |
| 7. On the day | `admission1` | Request page | Admit the patient. The request becomes an admission. |

## 3. During the stay

| Area | Who | What |
|---|---|---|
| Nursing admission assessment | Nurse `nurse1` | Complete for each new patient (allergies, risks, pain). Overdue ones show on the nurse dashboard. |
| Vitals, tasks | Nurse | Ward worklist, **Nursing**. |
| Medication | Doctor orders; nurse gives | A dose can be marked Given only within 2 hours of its time. |
| Rounds, notes, orders | Doctor `doctor2` | Admission page, **Rounds and procedures**. |
| Charges | Automatic and `cashier1` | Bed days, medicines, tests and procedures post as charges; extra charges can be added from the price list. |
| Bed transfer | Doctor or nurse | The old bed goes to cleaning; the full bed history is kept. |

### Laboratory test
1. Nurse or lab technician: **Take sample** (`nurse1` or `labtech1`).
2. Lab technician `labtech1`: **Accept sample**.
3. Lab technician: type results, **Save draft**, **Send for review**.
4. Pathologist `pathologist1`: **Verify and release**.
5. LIMS technician `p_lab_tech1`: **Issue** the report. The doctor sees it only after this.

### Scan (radiology)
1. Nurse `nurse1`: **Patient ready** on the LIMS page.
2. Radiographer `radiographer1`: **Record scan**, then send for review.
3. Radiologist `radiologist1`: write and sign the report.
4. Radiology LIMS technician `r_lab_tech1`: **Issue**.

### Pharmacy
Pharmacist `pharmacist1` dispenses from the prescription queue. Dispensed items become admission charges.

## 4. Discharge

Everything below happens on the admission's **Discharge** tab.

| Stage | Who | Notes |
|---|---|---|
| Discharge decision | Consultant | Says the patient is clinically fit. Nothing else starts before this. |
| Summary preparation | RMO `rmo1` writes, consultant `doctor2` signs, `rmo1` verifies | A signed summary changes only by amendment, with a reason. |
| Nursing clearance | Nurse | Medicines recorded, documentation up to date, handover confirmed. |
| Charges review | Cashier | Bed days and all charges checked before the bill. |
| Pharmacy clearance | Pharmacist | Every issued medicine accounted for. |
| Laboratory / radiology | Lab and radiology teams | Every test done, reported and billed (or waived by the doctor). |
| OT / procedure | OT coordinator | Clears itself when no procedure is open. |
| Insurance | TPA desk | Not needed for a self-pay patient. |
| Final billing | `cashier1` | Final bill issued and paid; deposits applied. |
| Financial release | Automatic | Clears once nothing is outstanding. |
| Physical exit | Nurse or patient transport (`transport1`) | Record how the patient left. This frees the bed. |
| Bed turnover | Housekeeping `housekeeping1` | Bed goes through cleaning to ready. |
| Post-discharge | Medical records `mrd1` | Sign off the record with ICD-10 diagnosis codes; the paper file is filed. Codes cannot be changed afterwards. |

## 5. Where each role starts

| Role | Username | Starts at |
|---|---|---|
| Reception | `reception1` | Desk screen (press 1 for OPD, 2 for IPD) |
| Nurse | `nurse1` | Dashboard: patients, doses due, vitals due, assessments |
| Doctor | `doctor2` | Dashboard: queue and rounds |
| RMO | `rmo1` | Dashboard: summaries to write and to verify |
| Ward coordinator | `coordinator1` | Dashboard: who needs attention, by ward |
| Cashier | `cashier1` | Dashboard: bills owing |
| Medical records | `mrd1` | Dashboard: records ready to sign off |
| Admin, manager | `admin`, `manager1` | Dashboard: money, beds, items needing attention |

## Known gaps seen in the demo

- The doctor can waive the laboratory / radiology discharge stage; the unbilled test then stays on the screen as a warning.
- Emergency Ward beds appear in the direct Admit patient list.
