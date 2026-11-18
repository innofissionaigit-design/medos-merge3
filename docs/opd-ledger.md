# OPD visit taken → cashier ledger

**Purpose.** Reception takes the OPD visit and does not handle money. The cashier is told, makes the bill and collects the payment, and keeps a ledger of the day's OPD visits.

## Flow
1. **Reception** starts the OPD visit (walk-in or check-in). No payment step: `OPD_FEE_BEFORE_VISIT` is now off by default. A hospital that wants the old "pay first" rule can switch it on (docs/opd-payment.md).
2. **The cashier is notified** ("An OPD visit was taken: make the bill and collect the payment"). Notified: everyone holding `OPD_BILL_ALERT` (the CASHIER and BILLING roles), in the same transaction as the check-in.
3. **The cashier's ledger** (Billing → "OPD visits taken", `GET /api/v1/opd-ledger?date=`) lists every OPD visit of the day with token, patient, doctor, time taken, and where its bill stands: **To bill** (no bill yet, "Make bill"), **To collect** / **Part paid** ("Collect payment"), **Paid** ("View bill"). It shows the day's totals: visits, to bill, to collect, billed, collected, outstanding.
4. The bill is the ordinary OPD bill linked to the visit; payments, receipts, refunds and the soft copy sent to the patient work as before.

## Permissions and data
`OPD_BILL_ALERT` (new, added to CASHIER and BILLING by migration `20261125120000_opd_bill_alert`); the ledger itself needs `INVOICE_READ`. No new tables: the ledger is read from visits and bills. Notification type: `OPD_VISIT_TAKEN`.

## Known limitations
- Reception roles that already hold `PAYMENT_CREATE` can still take payment on a bill; this change only removes the requirement and the prompt.
- The ledger is per day and per facility; there is no export yet.
