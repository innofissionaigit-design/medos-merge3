# Soft copy of a bill

**Purpose.** After a bill is paid, the patient gets a private link to the soft copy of the bill (HTML, and PDF on request) by email, WhatsApp or SMS, so nobody has to ask for it at the counter.

## How it works
1. **Payment settles the bill.** In the same transaction that takes the payment, if the bill is now `PAID` and `BILL_AUTO_SEND` is on, one delivery is queued for each channel in `BILL_SEND_CHANNELS` that the patient can be reached on. A payment never fails because of this.
2. **A channel is queued only if it can work:** WhatsApp and SMS need a valid Indian mobile number and no withdrawn consent to messages; email needs `EMAIL_ENABLED`, an address, no entry on the suppression list, and email consent (or `EMAIL_REQUIRE_CONSENT` off). Anything else is left out, not failed.
3. **A background worker sends it** (the same one that sends prescription messages). Each attempt makes a new private link; only a hash of its secret is stored. Failures are retried after 1, 5 and 30 minutes; after the fourth failure staff can press "Try again" on the bill.
4. **The patient opens the link** (`/api/bill/<secret>`, relayed to `GET /api/v1/public/bills/<secret>`; `?format=pdf` for the PDF). No sign-in. The link reaches only that one bill, expires after `BILL_LINK_DAYS` (default 30, at most 30), and a wrong, expired or revoked link all answer "not found".
5. **Staff** see what was sent on the bill ("Soft copy of the bill") and can press **Send soft copy now** to send it again, for example after the patient gives a new number.

The same bill, amount paid and channel is queued automatically once. A later extra payment is not needed: only a fully paid bill triggers it; staff can send a copy of a part-paid bill by hand.

## Settings (ADMIN_SETTINGS)
| Setting | Default | Meaning |
|---|---|---|
| `BILL_AUTO_SEND` | on | Send the soft copy automatically when a bill is fully paid |
| `BILL_SEND_CHANNELS` | EMAIL, WHATSAPP | Any of EMAIL, WHATSAPP, SMS |
| `BILL_LINK_DAYS` | 30 | How long the link works |

Nothing leaves the server until a provider is connected (`MESSAGE_PROVIDER=http` with `MESSAGE_API_URL`, and `EMAIL_PROVIDER=http`); until then each copy is shown as "Recorded, not sent for real".

## Data
`InvoiceDelivery` (one row per channel: masked recipient, status, attempts, provider id, error) and `InvoiceShare` (hash of the link secret, expiry, revoked, open count). Both are tenant-scoped with row-level security, cannot be deleted, and a share can only be revoked, never changed. The message text, the address and the full number are never stored.

## Permissions and audit
Staff need `INVOICE_READ` to see and send. Audit events: `BILL_COPY_SEND_REQUESTED`, `BILL_COPY_SENT`, `BILL_COPY_SEND_RETRIED`, `BILL_SHARE_OPENED`.

## Known limitations
- The email carries a link, not an attachment (the email provider interface sends text and HTML only).
- WhatsApp templates approved by Meta, delivery receipts and a patient opt-out keyword are not handled; the provider adapter is the hospital's.
- Refund or credit-note changes do not resend the copy; the link always shows the current bill.
