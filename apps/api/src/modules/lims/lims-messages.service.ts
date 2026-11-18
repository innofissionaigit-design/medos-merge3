import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService } from "../../common/audit.service";
import { logJson } from "../../common/logger";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { EmailService } from "../email/email.service";
import { EMAIL_LOG_ONLY_PREFIX, maskEmail } from "../email/email.provider";
import { formatDayTime } from "../email/email.templates";
import { indianMobile, MESSAGE_PROVIDER, MessageError, type MessageChannel, type MessageProvider } from "../prescriptions/message.provider";
import { reminderConsentState, remindersAllowed } from "../privacy/consent";
import { SettingsService } from "../settings/settings.service";
import { reportReadyText, scheduledText } from "./lims.domain";

const mask = (m: string) => `${"•".repeat(Math.max(0, m.length - 4))}${m.slice(-4)}`;
/** Minutes to wait after each failed attempt; the fourth failure gives up. */
const BACKOFF_MINUTES = [1, 5, 30];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
type Outcome = "sent" | "retried" | "failed";
type Kind = "SCHEDULED" | "REPORT_READY";

/** What the screen asks for after registering a patient for a test (SCHEDULED) or when a booking's reports are ready for hand-over (REPORT_READY). */
export const notifySchema = z.object({ kind: z.enum(["SCHEDULED", "REPORT_READY"]) }).strict();
/** One line of the three-popup answer: email, SMS or WhatsApp, and whether it went. */
export interface ChannelResult { channel: "EMAIL" | "SMS" | "WHATSAPP"; ok: boolean; text: string }
const CHANNEL_NAME = { EMAIL: "Email", SMS: "SMS", WHATSAPP: "WhatsApp" } as const;

const LOG_ONLY = "log-only:";
const DEPARTMENT_LABEL: Record<string, string> = { PATHOLOGY: "laboratory", RADIOLOGY: "imaging" };

/**
 * Messages to an OPD patient about their laboratory and imaging tests (docs/lims-portal.md): when to come and what to do beforehand, and later that the report is ready at
 * reception. WhatsApp or SMS go through the connected message provider (the log-only default sends nothing); an email is queued as well when email is on. A message names the
 * department, never the test, and never carries a result. Problems with messaging never stop the laboratory's work.
 */
@Injectable()
export class LimsMessagesService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly email: EmailService,
    @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider,
  ) {}

  /** What the screens say: whether anything real is connected. */
  async status(ctx: RequestContext) {
    const [on, channel] = await Promise.all([this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "LIMS_PATIENT_MESSAGES"), this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "LIMS_MESSAGE_CHANNEL")]);
    return { enabled: on, channel, provider: this.provider.name, connected: this.provider.configured };
  }

  /** The patient is told when to come and what to do. Called inside the launch transaction; never fails it. */
  async queueScheduled(tx: Db, ctx: RequestContext, patientId: string, batchId: string): Promise<void> {
    try {
      await this.queue(tx, ctx, patientId, batchId, "SCHEDULED");
      const reqs = await tx.limsRequest.findMany({ where: { tenantId: ctx.tenantId, batchId }, select: { scheduledFor: true, instructions: true, department: { select: { kind: true, name: true } } } });
      const [p, f] = await Promise.all([
        tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { firstName: true } }),
        tx.facility.findFirst({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { name: true, timezone: true } }),
      ]);
      if (!p || !f || reqs.length === 0) return;
      const scheduled = reqs.map((r) => r.scheduledFor).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      const text = [...new Set(reqs.map((r) => r.instructions).filter((x): x is string => !!x))].join(" ");
      await this.email.enqueue(tx, {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, templateKey: "TEST_SCHEDULED", patientId, createdById: ctx.userId,
        vars: { name: p.firstName, departments: [...new Set(reqs.map((r) => r.department.name))].join(" and "), when: this.when(scheduled ?? new Date(), f.timezone), instructions: text || "No special preparation is needed.", facility: f.name },
        entityType: "LimsRequest", dedupeKey: `TEST_SCHEDULED:${batchId}`,
      });
    } catch (e) {
      logJson("error", "lims_message_queue_failed", { batchId, errorName: e instanceof Error ? e.name : typeof e });
    }
  }

  /** When every report of a visit's batch has been issued, the patient is told they are ready at reception. */
  async queueReportReady(tx: Db, ctx: RequestContext, patientId: string, batchId: string): Promise<void> {
    try {
      const waiting = await tx.limsRequest.count({ where: { tenantId: ctx.tenantId, batchId, status: { notIn: ["ISSUED", "HANDED_OVER", "CANCELLED"] } } });
      if (waiting > 0) return;
      await this.queue(tx, ctx, patientId, batchId, "REPORT_READY");
      const [p, f] = await Promise.all([
        tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { firstName: true } }),
        tx.facility.findFirst({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { name: true, timezone: true } }),
      ]);
      if (!p || !f) return;
      await this.email.enqueue(tx, {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, templateKey: "REPORT_READY", patientId, createdById: ctx.userId,
        vars: { name: p.firstName, facility: f.name, when: this.when(new Date(), f.timezone) }, entityType: "LimsRequest", dedupeKey: `REPORT_READY:batch:${batchId}`,
      });
    } catch (e) {
      logJson("error", "lims_message_queue_failed", { batchId, errorName: e instanceof Error ? e.name : typeof e });
    }
  }

  private when(at: Date, timeZone: string): string {
    return formatDayTime(at, timeZone);
  }

  private async queue(tx: Db, ctx: RequestContext, patientId: string, batchId: string, kind: Kind): Promise<void> {
    if (!(await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "LIMS_PATIENT_MESSAGES"))) return;
    const p = await tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { mobile: true } });
    const mobile = indianMobile(p?.mobile);
    if (!mobile) return;
    if (!remindersAllowed(await reminderConsentState(tx, ctx.tenantId, patientId), false)) return;
    const setting = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "LIMS_MESSAGE_CHANNEL");
    const channels = setting === "BOTH" ? (["WHATSAPP", "SMS"] as const) : ([setting] as const);
    await tx.limsMessage.createMany({ data: channels.map((channel) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId, batchId, kind, channel, toMask: mask(mobile), createdById: ctx.userId })), skipDuplicates: true });
  }

  // ───── sending (the worker) ─────

  /** Sends what is due, hospital by hospital under each hospital's own scope. Safe on several servers: rows are claimed with SKIP LOCKED. */
  async runDue(now = new Date(), limit = 100): Promise<Record<Outcome, number>> {
    const counts: Record<Outcome, number> = { sent: 0, retried: 0, failed: 0 };
    const tenants = await tenantScope.system("lims message worker: hospitals with messages due", () =>
      this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_due_lims_messages(${now}::timestamptz)::text AS tenant_id`);
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

  private async deliverOne(tx: Db, now: Date, onlyId: string | null = null): Promise<Outcome | null> {
    const [r] = await tx.$queryRaw<{ id: string; tenantId: string; facilityId: string; patientId: string; batchId: string; kind: Kind; channel: string; attempts: number; createdById: string; createdAt: Date }[]>`
      SELECT id, "tenantId", "facilityId", "patientId", "batchId", kind, channel, attempts, "createdById", "createdAt" FROM "LimsMessage"
      WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now} AND (${onlyId}::uuid IS NULL OR id = ${onlyId}::uuid)
      ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!r) return null;
    const where = { id: r.id, tenantId: r.tenantId };
    const fail = async (reason: string): Promise<Outcome> => {
      await tx.limsMessage.updateMany({ where, data: { status: "FAILED", lastError: reason, attempts: r.attempts + 1, providerName: this.provider.name } });
      logJson("info", "lims_message_not_sent", { messageId: r.id, reason });
      return "failed";
    };
    const [patient, facility] = await Promise.all([
      tx.patient.findFirst({ where: { id: r.patientId, tenantId: r.tenantId }, select: { firstName: true, mobile: true } }),
      tx.facility.findFirst({ where: { id: r.facilityId, tenantId: r.tenantId }, select: { name: true, timezone: true } }),
    ]);
    const mobile = indianMobile(patient?.mobile);
    if (!patient || !facility || !mobile) return fail("The patient has no mobile number that a message can be sent to");
    // Consent is looked at again when sending: it may have been withdrawn since the message was queued.
    if (!remindersAllowed(await reminderConsentState(tx, r.tenantId, r.patientId), false)) return fail("The patient has asked not to be sent messages");
    const reqs = await tx.limsRequest.findMany({ where: { tenantId: r.tenantId, batchId: r.batchId, status: { not: "CANCELLED" } }, orderBy: { requestNumber: "asc" }, select: { requestNumber: true, scheduledFor: true, instructions: true, department: { select: { kind: true } } } });
    if (reqs.length === 0) return fail("Every test of this booking was cancelled");
    const departments = [...new Set(reqs.map((q) => DEPARTMENT_LABEL[q.department.kind] ?? "laboratory"))];
    const requestNumbers = reqs.map((q) => q.requestNumber);
    const scheduled = reqs.map((q) => q.scheduledFor).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const text = r.kind === "SCHEDULED"
      ? scheduledText({ firstName: patient.firstName, facility: facility.name, departments, when: this.when(scheduled ?? r.createdAt, facility.timezone), instructions: [...new Set(reqs.map((q) => q.instructions).filter((x): x is string => !!x))].join(" ") || null, requestNumbers })
      : reportReadyText({ firstName: patient.firstName, facility: facility.name, requestNumbers, readyAt: this.when(r.createdAt, facility.timezone) });
    const attempts = r.attempts + 1;
    try {
      const d = await this.provider.send({ channel: r.channel as MessageChannel, to: mobile, text, reference: r.id });
      await tx.limsMessage.updateMany({ where, data: { status: "SENT", attempts, sentAt: new Date(), providerName: this.provider.name, providerMessageId: d.providerMessageId, lastError: null } });
      await this.audit.record(tx, { tenantId: r.tenantId, facilityId: r.facilityId, userId: r.createdById }, { action: "LIMS_PATIENT_MESSAGE_SENT", entityType: "LimsMessage", entityId: r.id, metadata: { kind: r.kind, channel: r.channel, to: mask(mobile), provider: this.provider.name, requests: requestNumbers.length } });
      return "sent";
    } catch (e) {
      const reason = e instanceof MessageError ? e.message : "The message could not be sent";
      logJson("warn", "lims_message_failed", { messageId: r.id, attempt: attempts, errorName: e instanceof Error ? e.name : typeof e });
      if (attempts >= MAX_ATTEMPTS) {
        await tx.limsMessage.updateMany({ where, data: { status: "FAILED", attempts, lastError: reason, providerName: this.provider.name } });
        return "failed";
      }
      await tx.limsMessage.updateMany({ where, data: { attempts, lastError: reason, providerName: this.provider.name, nextAttemptAt: new Date(now.getTime() + (BACKOFF_MINUTES[attempts - 1] ?? 30) * 60_000) } });
      return "retried";
    }
  }

  /**
   * Sends this booking's messages right now (instead of waiting for the worker) and says, for each of email, SMS and WhatsApp, whether it went: the three pop-ups the
   * screen shows after a patient is registered for a test or when the reports are ready to hand over. Nothing here is a promise about delivery beyond the provider's own
   * answer: when no message service is connected the line says so (a red cross), never a green tick.
   */
  async notifyNow(ctx: RequestContext, batchId: string, kind: Kind): Promise<{ channels: ChannelResult[] }> {
    const first = await this.prisma.limsRequest.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, batchId }, select: { patientId: true, origin: true } });
    if (!first || first.origin !== "OPD") throw new DomainError("NOT_FOUND", "Resource not found", 404);
    // The patient is told the reports are ready only once every report of the booking is out.
    if (kind === "REPORT_READY" && (await this.prisma.limsRequest.count({ where: { tenantId: ctx.tenantId, batchId, status: { notIn: ["ISSUED", "HANDED_OVER", "CANCELLED"] } } })) > 0) return { channels: [] };
    const emailKey = kind === "SCHEDULED" ? `TEST_SCHEDULED:${batchId}` : `REPORT_READY:batch:${batchId}`;
    const [rows, mail] = await Promise.all([
      this.prisma.limsMessage.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, batchId, kind, status: "PENDING" }, select: { id: true } }),
      this.prisma.emailOutbox.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, dedupeKey: emailKey, status: "PENDING" }, select: { id: true } }),
    ]);
    // All three go out together, so a slow provider does not make the others wait.
    await Promise.all([
      ...rows.map((m) => this.prisma.$transaction((tx) => this.deliverOne(tx, new Date(), m.id)).catch((e: unknown) => logJson("warn", "lims_message_now_failed", { errorName: e instanceof Error ? e.name : typeof e }))),
      ...(mail ? [this.email.deliverNow(mail.id).catch((e: unknown) => logJson("warn", "lims_email_now_failed", { errorName: e instanceof Error ? e.name : typeof e }))] : []),
    ]);
    return { channels: [await this.emailResult(ctx, first.patientId, emailKey), await this.chatResult(ctx, first.patientId, batchId, kind, "SMS"), await this.chatResult(ctx, first.patientId, batchId, kind, "WHATSAPP")] };
  }

  private async chatResult(ctx: RequestContext, patientId: string, batchId: string, kind: Kind, channel: "SMS" | "WHATSAPP"): Promise<ChannelResult> {
    const name = CHANNEL_NAME[channel];
    const m = await this.prisma.limsMessage.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, batchId, kind, channel }, select: { status: true, toMask: true, lastError: true, providerMessageId: true } });
    if (!m) return { channel, ok: false, text: `${name} not sent: ${await this.whyNoChat(ctx, patientId, channel)}` };
    if (m.status === "SENT") {
      return (m.providerMessageId ?? "").startsWith(LOG_ONLY)
        ? { channel, ok: false, text: `${name} not sent: no message service is connected` }
        : { channel, ok: true, text: `${name} sent to ${m.toMask}` };
    }
    if (m.status === "PENDING") return { channel, ok: false, text: `${name} not sent${m.lastError ? `: ${m.lastError}` : ""}. It will be tried again` };
    return { channel, ok: false, text: `${name} not sent${m.lastError ? `: ${m.lastError}` : ""}` };
  }

  private async whyNoChat(ctx: RequestContext, patientId: string, channel: "SMS" | "WHATSAPP"): Promise<string> {
    if (!(await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "LIMS_PATIENT_MESSAGES"))) return "patient messages are switched off";
    const p = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { mobile: true } });
    if (!indianMobile(p?.mobile)) return "the patient has no valid mobile number";
    if (!remindersAllowed(await reminderConsentState(this.prisma, ctx.tenantId, patientId), false)) return "the patient has asked not to be messaged";
    const setting = await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "LIMS_MESSAGE_CHANNEL");
    if (setting !== "BOTH" && setting !== channel) return `${CHANNEL_NAME[channel]} is not switched on for laboratory messages`;
    return "it could not be queued";
  }

  private async emailResult(ctx: RequestContext, patientId: string, key: string): Promise<ChannelResult> {
    const e = await this.prisma.emailOutbox.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, dedupeKey: key }, select: { status: true, toAddress: true, lastError: true, providerMessageId: true } });
    if (!e) {
      if (!(await this.email.enabled(this.prisma, ctx.tenantId, ctx.facilityId))) return { channel: "EMAIL", ok: false, text: "Email not sent: email is switched off" };
      const p = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { email: true } });
      return { channel: "EMAIL", ok: false, text: p?.email ? "Email not sent: the patient has not agreed to email, or the address is blocked" : "Email not sent: the patient has no email address" };
    }
    if (e.status === "SENT") {
      return (e.providerMessageId ?? "").startsWith(EMAIL_LOG_ONLY_PREFIX)
        ? { channel: "EMAIL", ok: false, text: "Email not sent: no email service is connected" }
        : { channel: "EMAIL", ok: true, text: `Email sent to ${maskEmail(e.toAddress)}` };
    }
    return { channel: "EMAIL", ok: false, text: `Email not sent${e.lastError ? `: ${e.lastError}` : ""}${e.status === "PENDING" ? ". It will be tried again" : ""}` };
  }

  /** The messages sent (or not) for one patient's batch, for the reception screen. */
  async forBatch(ctx: RequestContext, batchId: string) {
    const rows = await this.prisma.limsMessage.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, batchId }, orderBy: { createdAt: "asc" }, select: { kind: true, channel: true, toMask: true, status: true, sentAt: true, lastError: true, providerMessageId: true } });
    return rows.map((m) => ({ kind: m.kind, channel: m.channel, to: m.toMask, status: m.status, sentAt: m.sentAt, error: m.lastError, sentForReal: m.status === "SENT" && !(m.providerMessageId ?? "").startsWith("log-only:") }));
  }
}
