# OPD visit taken → cashier ledger

**Purpose.** The cashier is told when an OPD visit is taken and keeps a ledger of the day's OPD visits, with where each bill stands. By default (`OPD_FEE_BEFORE_VISIT` **on**) reception first bills and takes the OPD consultation payment and the visit starts after it is paid (docs/opd-payment.md): the ledger then shows the visit as **Paid**. A hospital that switches the rule **off** lets reception take the visit with no payment step, and the cashier makes the bill and collects the payment from the ledger.

## Flow
1. **Reception** starts the OPD visit (walk-in or check-in). With `OPD_FEE_BEFORE_VISIT` on (the default) the consultation bill is paid first (docs/opd-payment.md). With it off there is no payment step and the cashier collects afterwards.
2. **The cashier is notified** ("An OPD visit was taken: make the bill and collect the payment"). Notified: everyone holding `OPD_BILL_ALERT` (the CASHIER and BILLING roles), in the same transaction as the check-in.
3. **The cashier's ledger** (Billing → "OPD visits taken", `GET /api/v1/opd-ledger?date=`) lists every OPD visit of the day with token, patient, doctor, time taken, and where its bill stands: **To bill** (no bill yet, "Make bill"), **To collect** / **Part paid** ("Collect payment"), **Paid** ("View bill"). It shows the day's totals: visits, to bill, to collect, billed, collected, outstanding.
4. The bill is the ordinary OPD bill linked to the visit; payments, receipts, refunds and the soft copy sent to the patient work as before.

## Permissions and data
`OPD_BILL_ALERT` (new, added to CASHIER and BILLING by migration `20261125120000_opd_bill_alert`); the ledger itself needs `INVOICE_READ`. No new tables: the ledger is read from visits and bills. Notification type: `OPD_VISIT_TAKEN`.

## Known limitations
- Reception roles that already hold `PAYMENT_CREATE` can still take payment on a bill; with the rule off the requirement and the prompt are simply not there.
- The ledger is per day and per facility; there is no export yet.
