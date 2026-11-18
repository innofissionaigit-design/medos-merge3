# Welcome message after registration

**Purpose.** Right after a patient is registered, they are sent a short welcome with their Patient ID (MRN) by email, WhatsApp or SMS, so they can quote it on their next call or visit. It carries no clinical content and no link.

## How it works
1. In the registration transaction, after the patient and MRN are created, the welcome is queued (`REGISTRATION_MESSAGE_ENABLED`, default on). Patients brought in by a data migration are not messaged. A problem with messaging never stops a registration.
2. **WhatsApp / SMS:** one `PatientMessage` row per chosen channel, if the patient has a valid Indian mobile and has not withdrawn consent to messages (`REMINDERS_REQUIRE_CONSENT` applies when nothing is recorded). The background worker sends it through the connected message provider; failures retry after 1, 5 and 30 minutes.
3. **Email:** queued in the email outbox with the `REGISTRATION` template (English, Bengali, Hindi; hospitals can reword it). The email service applies its own rules: `EMAIL_ENABLED`, a valid address, the suppression list and email consent.
4. A channel the patient cannot be reached on is left out, never failed. The same welcome is queued once per patient and channel.

## Settings
| Setting | Default | Meaning |
|---|---|---|
| `REGISTRATION_MESSAGE_ENABLED` | on | Send the welcome after registration |
| `REGISTRATION_MESSAGE_CHANNELS` | EMAIL, WHATSAPP | Any of EMAIL, WHATSAPP, SMS |

Nothing leaves the server until a provider is connected (`MESSAGE_PROVIDER=http`, `EMAIL_PROVIDER=http`).

## Data, permissions, audit
`PatientMessage` is tenant-scoped (row-level security), cannot be deleted, and keeps only the masked number, channel and outcome, never the text. Audit event: `REGISTRATION_MESSAGE_SENT` (WhatsApp/SMS); emails appear in the email delivery log.

## Known limitations
- There is no screen yet that lists these messages for staff; check the email log, or the `PatientMessage` table.
- A patient registered with a number but no recorded consent is messaged unless the hospital turned on `REMINDERS_REQUIRE_CONSENT`.
