import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../../common/audit.service";
import { logJson } from "../../common/logger";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { EmailService } from "../email/email.service";
import { indianMobile, MESSAGE_PROVIDER, MessageError, type MessageProvider } from "../prescriptions/message.provider";
import { reminderConsentState, remindersAllowed } from "../privacy/consent";
import { SettingsService } from "../settings/settings.service";

const mask = (m: string) => `${"•".repeat(Math.max(0, m.length - 4))}${m.slice(-4)}`;
/** Minutes to wait after each failed attempt; the fourth failure gives up. */
const BACKOFF_MINUTES = [1, 5, 30];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
type Outcome = "sent" | "retried" | "failed";

/**
 * The welcome a patient gets right after registration (docs/registration-message.md): their Patient ID, by email, WhatsApp or SMS (the channels the hospital chose, each only
 * when the patient has an address or number and has not withdrawn consent). It carries no clinical content. Email is queued through the email outbox; WhatsApp and SMS are
 * queued here and sent by the background worker through the connected message provider (the log-only default sends nothing). A problem with messaging never stops a registration.
 */
@Injectable()
export class PatientMessagesService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly email: EmailService,
    @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider,
  ) {}

  /** Called inside the registration transaction. Never fails it. */
  async queueRegistration(tx: Db, ctx: RequestContext, patientId: string, mrn: string): Promise<void> {
    try {
      if (!(await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "REGISTRATION_MESSAGE_ENABLED"))) return;
      const channels = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "REGISTRATION_MESSAGE_CHANNELS");
      const [p, f] = await Promise.all([
        tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { firstName: true, mobile: true } }),
        tx.facility.findFirst({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { name: true } }),
      ]);
      if (!p || !f) return;
      const mobile = indianMobile(p.mobile);
      if (mobile) {
        const requireConsent = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "REMINDERS_REQUIRE_CONSENT");
        if (remindersAllowed(await reminderConsentState(tx, ctx.tenantId, patientId), requireConsent)) {
          const rows = channels.filter((c): c is "WHATSAPP" | "SMS" => c === "WHATSAPP" || c === "SMS");
          if (rows.length > 0) {
            await tx.patientMessage.createMany({ data: rows.map((channel) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId, kind: "REGISTRATION", channel, toMask: mask(mobile), createdById: ctx.userId })), skipDuplicates: true });
          }
        }
      }
      if (channels.includes("EMAIL")) {
        // The email service checks the address, the hospital's switch, the suppression list and the patient's agreement itself.
        await this.email.enqueue(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, templateKey: "REGISTRATION", patientId, createdById: ctx.userId, vars: { name: p.firstName, mrn, facility: f.name }, entityType: "Patient", entityId: patientId, dedupeKey: `REGISTRATION:${patientId}` });
      }
    } catch (e) {
      logJson("error", "registration_message_queue_failed", { patientId, errorName: e instanceof Error ? e.name : typeof e });
    }
  }

  /** Sends what is due, hospital by hospital under each hospital's own scope. Safe on several servers: rows are claimed with SKIP LOCKED. */
  async runDue(now = new Date(), limit = 100): Promise<Record<Outcome, number>> {
    const counts: Record<Outcome, number> = { sent: 0, retried: 0, failed: 0 };
    const tenants = await tenantScope.system("patient message worker: hospitals with messages due", () =>
      this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_due_patient_messages(${now}::timestamptz)::text AS tenant_id`);
    let done = 0;
    for (const { tenant_id: tenantId } of tenants) {
      while (done < limit) {
        const outcome = await tenantScope.run(tenantId, () => this.prisma.$transaction((tx) => this.deliverOne(tx, now)));
        if (!outcome) break;
        counts[outcome]++;
        done++;
      }
    }
    return counts;
  }

  private async deliverOne(tx: Db, now: Date): Promise<Outcome | null> {
    const [r] = await tx.$queryRaw<{ id: string; tenantId: string; facilityId: string; patientId: string; channel: "WHATSAPP" | "SMS"; attempts: number; createdById: string }[]>`
      SELECT id, "tenantId", "facilityId", "patientId", channel, attempts, "createdById" FROM "PatientMessage"
      WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now} ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!r) return null;
    const where = { id: r.id, tenantId: r.tenantId };
    const fail = async (reason: string): Promise<Outcome> => {
      await tx.patientMessage.updateMany({ where, data: { status: "FAILED", lastError: reason, attempts: r.attempts + 1, providerName: this.provider.name } });
      logJson("info", "patient_message_not_sent", { messageId: r.id, reason });
      return "failed";
    };
    const p = await tx.patient.findFirst({ where: { id: r.patientId, tenantId: r.tenantId }, select: { firstName: true, mobile: true, identifiers: { where: { type: "MRN" }, select: { value: true }, take: 1 } } });
    const f = await tx.facility.findFirst({ where: { id: r.facilityId, tenantId: r.tenantId }, select: { name: true } });
    const mobile = indianMobile(p?.mobile);
    if (!p || !f || !mobile) return fail("The patient has no mobile number that a message can be sent to");
    // Consent is looked at again when sending: it may have been withdrawn since the message was queued.
    if (!remindersAllowed(await reminderConsentState(tx, r.tenantId, r.patientId), false)) return fail("The patient has asked not to be sent messages");
    const text = `Dear ${p.firstName}, welcome to ${f.name}. You are now registered. Your Patient ID is ${p.identifiers[0]?.value ?? ""}. Please quote it when you call or visit.`.replace(/\s{2,}/g, " ");
    const attempts = r.attempts + 1;
    try {
      const d = await this.provider.send({ channel: r.channel, to: mobile, text, reference: r.id });
      await tx.patientMessage.updateMany({ where, data: { status: "SENT", attempts, sentAt: new Date(), providerName: this.provider.name, providerMessageId: d.providerMessageId.slice(0, 200), lastError: null } });
      await this.audit.record(tx, { tenantId: r.tenantId, facilityId: r.facilityId, userId: r.createdById }, { action: "REGISTRATION_MESSAGE_SENT", entityType: "PatientMessage", entityId: r.id, metadata: { patientId: r.patientId, channel: r.channel, to: mask(mobile) } });
      return "sent";
    } catch (e) {
      const reason = e instanceof MessageError ? e.message : "The message could not be sent";
      logJson("warn", "patient_message_failed", { messageId: r.id, attempt: attempts, errorName: e instanceof Error ? e.name : typeof e });
      if (attempts >= MAX_ATTEMPTS) {
        await tx.patientMessage.updateMany({ where, data: { status: "FAILED", attempts, lastError: reason, providerName: this.provider.name } });
        return "failed";
      }
      await tx.patientMessage.updateMany({ where, data: { attempts, lastError: reason, providerName: this.provider.name, nextAttemptAt: new Date(now.getTime() + (BACKOFF_MINUTES[attempts - 1] ?? 30) * 60_000) } });
      return "retried";
    }
  }
}
