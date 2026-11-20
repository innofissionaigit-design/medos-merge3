# Planned admission workflow

A patient who is to be admitted on a **chosen day**, not today. Nothing is an admission until the admission desk admits the patient on that day. After that the patient is in the ordinary IPD flow (same admission number, bed history, charges, nursing, medicines and discharge).

Menu: **Planned admissions**. Demo password for every user: `Medos#Demo2026`, hospital code `demo-hospital`.

## 1. How a request starts

| Route | Who starts it | First stop |
|---|---|---|
| **OPD advised** | The OPD doctor ticks "This patient needs to be admitted" in the consultation | Reception asks the patient. Agree: the procedure starts. Refuse: the request closes with the reason. |
| **Arranged with a consultant** | Reception records what the patient says and picks the consultant | That doctor reviews it. |
| **Came with outside papers** | Reception records the outside doctor's advice and reports and picks a consultant to assess | The same review. Outside advice is not an admission order of this hospital. |

## 2. The steps

```
ADVISED ─consent─┐
DOCTOR REVIEW ⇄ AWAITING PATIENT ─accept─┤
                                         ▼
DESK REVIEW → ESTIMATE AND PAYER → (PRE-AUTH) → DEPOSIT → BED → READY → ADMITTED
   any open step ─cancel→ CLOSED  (cancelled, no-show, patient declined, doctor declined, other treatment)
```

| # | Step | Who (demo user) | What is done |
|---|---|---|---|
| 1 | **Request** | Reception (`reception1`, IPD desk) | Raise the request: patient, consultant, what the patient says. Record consent or refusal. |
| 2 | **Doctor** | The consultant (e.g. `doctor5`) | Four answers: **ask the patient** (come to the chamber, send reports, get tests), **accept** (diagnosis, procedure, day, expected stay, room category), **recommend other treatment**, or **decline**. |
| 3 | **Admission desk** | `admission1` | Verify consultant, diagnosis, procedure, day, expected stay and ward. Can correct them or move the day. |
| 4 | **Estimate and payer** | Billing (`cashier1`), insurance (`tpa1`) | Billing makes the estimate (the server works out the total; a bed line is suggested from the ward's rate and the stay). Payer is self-pay, or insured: the policy must be valid on the admission day. |
| 5 | **Pre-authorisation** (insured only) | `tpa1` | Request from the insurer, then record the approved amount or the rejection. Or switch to self-pay. |
| 6 | **Deposit** | `cashier1`; a manager can waive | Set the deposit and take it as an advance payment (cash, UPI, card, bank transfer, or split). The step clears when what was received reaches what was asked. A manager may waive it with a written reason. |
| 7 | **Bed** | Bed manager (`bedmgr1`) | Hold a bed. It shows as **reserved**. |
| 8 | **On the day** | `admission1` | **Admit**. The admission opens on the held bed. |
| 9 | **Nursing** | Nurse (`nurse1`) | Fill in the **nursing admission assessment**, which closes the nurse's task. |

Each person sees only the action that is theirs now. A step out of order, or by someone without the permission, is refused.

## 3. Nursing admission assessment

One record per admission: awareness, movement, pain (0 to 10), allergies (or "no known allergies"), fall risk, pressure sore risk and nutrition risk (low, medium, high), diet or fasting instruction, belongings, ID band checked, consent form checked, and a note. A **high risk, or pain of 7 or more, needs a note**. Once saved it cannot be edited; anything new goes in a nursing note.

## 4. Rules to know

- **One open request per patient.** A held bed cannot be held by a second request.
- **A held bed is reserved** from the moment it is held, not from the planned day.
- **Cancelling or a no-show** returns the bed to available. The deposit stays the patient's advance, to be used or given back.
- **Emergency Ward beds** and the emergency ward as a room category are refused.
- **The deposit** stays the patient's advance and is set against the final bill by the cashier.
- **A request cannot be ready** without a bed, a day, a verified desk step, a payer, and a cleared deposit or approval.
- **Insurance:** the claim started here is the same claim the claims officer works in Insurance claims. The insurer is not contacted electronically; the team records what the insurer answers.

## 5. Example run in the demo

Request **PA-2026-000019**, patient Kaushik Saha, started from reception:

1. `reception1` raised the request for consultant Dr. Sandip Biswas.
2. `doctor5` accepted: symptomatic gallstones, laparoscopic cholecystectomy, 3 days.
3. `admission1` verified the details; ward Private Rooms.
4. `cashier1` made the estimate (surgeon and theatre ₹40,000, bed 3 days ₹6,000, total ₹46,000); `tpa1` set the payer to insured.
5. `tpa1` asked for pre-authorisation of ₹46,000 and recorded ₹36,000 approved.
6. `cashier1` set a ₹10,000 deposit and took it by UPI.
7. `bedmgr1` held bed P4.
8. `admission1` admitted the patient: admission ADM-2026-000020 (a nursing assessment task was created).

## 6. Known limits

- A bed is held from the moment it is allocated, so for a day far ahead it is out of use in between.
- An ordinary Admit patient for someone with an open planned request does not close the request; the desk must cancel or admit the request.
- A request goes to one named consultant. There is no "any doctor of the department" pool.
- The estimate is a billing estimate, not a package price, and is not posted as charges.
