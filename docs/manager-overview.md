# Hospital status overview (manager)

A single read-only page, **Hospital status** (`/overview`), for the hospital manager and the administrator. It shows the state of the emergency ward, the ICU and billing right now and refreshes by itself. It **follows the work; it does not direct it**: there is no button on it, and the manager's role has none of the permissions that act on a patient in the ward.

## What it shows

| Area | What the manager sees |
|---|---|
| **Emergency ward** | Patients in the ward, how many wait for triage and for the doctor, the longest wait for a doctor, patients by urgency colour, beds free (and patients without a bed), arrivals today and where the doctors sent them (OT, ICU, home), the emergency bills due, and a list of every patient: level, bed, doctor, time in the ward, bill due (with a link to the same case page the team uses, read only). |
| **ICU** | Patients in the ICU, beds free, vitals running late, urgent instructions still open, tests waiting, equipment in use, what has been charged so far, and a list of every stay: bed, doctor, since when, vitals on time or late, charged so far. |
| **Billing** | Billed today, collected today (by cash, UPI, card ...), outstanding bills and how much by kind (emergency, admitted patients, outpatients, pharmacy), and the charges of admitted patients that are not yet on a bill. |

The numbers come from the same services the working screens use (the emergency board, the ICU board, the cashier's unbilled charges), so the manager sees what the nurses, doctors and cashiers see.

## Access

* `GET /overview`: `OVERVIEW_READ` (held by `MANAGER` and `ADMINISTRATOR`).
* The manager also has read access to the emergency board (`ER_READ`), the ICU board (`ICU_READ`), invoices (`INVOICE_READ`) and the audit trail.
* The manager has **none** of: `ER_REGISTER`, `ER_TRIAGE`, `ER_TREAT`, `ER_BILL`, `ICU_DOCTOR`, `ICU_NURSE`, `ORDER_REQUEST`, vitals or prescribing, admitting or discharging, adding charges, taking payment, dispensing. A test (`overview.spec.ts`) tries each of those routes as the manager and expects "forbidden".
* Everything is limited to the manager's hospital and facility; another hospital's numbers are never included.

## Known limits

No trends over time, targets or alerts sent to the manager's phone; the page shows now. See `docs/backlog.md`.
