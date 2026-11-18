import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { EMAIL_PROVIDER, EmailError, maskEmail, type EmailProvider } from "../email/email.provider";
import { toHtml } from "../email/email.templates";
import { emailConsentState, reminderConsentState, remindersAllowed } from "../privacy/consent";
import { indianMobile, MESSAGE_PROVIDER, MessageError, type MessageProvider } from "../prescriptions/message.provider";
import type { PrintFormat, Rendered } from "../print/print.service";
import { SettingsService } from "../settings/settings.service";

export const CHANNELS = ["EMAIL", "WHATSAPP", "SMS"] as const;
export type BillChannel = (typeof CHANNELS)[number];
export const sendBillSchema = z.object({ channels: z.array(z.enum(CHANNELS)).min(1).max(3).optional() }).strict();

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const maskMobile = (m: string) => `${"•".repeat(Math.max(0, m.length - 4))}${m.slice(-4)}`;
const notValid = () => new DomainError("NOT_FOUND", "This link is not valid or has expired", 404);
/** Minutes to wait after each failed attempt; the fourth failure gives up (staff can retry by hand). */
const BACKOFF_MINUTES = [1, 5, 30];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
type Outcome = "sent" | "retried" | "failed";

interface Target { channel: BillChannel; mask: string }

/**
 * The soft copy of a bill (docs/bill-copy.md). When a bill is fully paid, the patient is sent a private link to it by email, WhatsApp or SMS (the channels the hospital
 * chose, each only if the patient has an address or number and has not withdrawn consent). Staff can also send it by hand. The link is made when the message is sent,
 * only a hash of its secret is kept, and the text, the address and the full number are never stored. A problem with messaging never stops a payment.
 */
@Injectable()
export class InvoiceDeliveryService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly moduleRef: ModuleRef,
    @Inject(MESSAGE_PROVIDER) private readonly messages: MessageProvider, @Inject(EMAIL_PROVIDER) private readonly emails: EmailProvider, @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private base(): string { return (this.config.PUBLIC_WEB_URL ?? this.config.CORS_ORIGINS.split(",")[0] ?? "http://localhost:3000").trim().replace(/\/+$/, ""); }

  /** What the screen needs to say: what is connected and what the hospital chose. */
  async config_(ctx: RequestContext) {
    const [autoSend, channels, days, emailOn] = await Promise.all([
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "BILL_AUTO_SEND"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "BILL_SEND_CHANNELS"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "BILL_LINK_DAYS"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "EMAIL_ENABLED"),
    ]);
    return { autoSend, channels, linkDays: days, emailEnabled: emailOn, messageProvider: this.messages.name, messagesConnected: this.messages.configured, emailProvider: this.emails.name, emailConnected: this.emails.configured };
  }

  /** The channels this patient can be reached on right now, with who it is for (masked). A channel is left out, never failed, when there is nothing to send to. */
  private async targets(db: Db, tenantId: string, facilityId: string, patientId: string, wanted: readonly BillChannel[]): Promise<Target[]> {
    const p = await db.patient.findFirst({ where: { id: patientId, tenantId }, select: { mobile: true, email: true } });
    if (!p) return [];
    const out: Target[] = [];
    const mobile = indianMobile(p.mobile);
    if (mobile && wanted.some((c) => c === "WHATSAPP" || c === "SMS")) {
      const requireConsent = await this.settings.get(db, tenantId, facilityId, "REMINDERS_REQUIRE_CONSENT");
      if (remindersAllowed(await reminderConsentState(db, tenantId, patientId), requireConsent)) {
        for (const c of wanted) if (c === "WHATSAPP" || c === "SMS") out.push({ channel: c, mask: maskMobile(mobile) });
      }
    }
    const email = p.email?.trim().toLowerCase();
    if (email && wanted.includes("EMAIL") && /^[^@\s]+@[^@\s]+[.][^@\s]+$/.test(email) && (await this.settings.get(db, tenantId, facilityId, "EMAIL_ENABLED"))) {
      const suppressed = await db.emailSuppression.findFirst({ where: { tenantId, address: email }, select: { id: true } });
      const state = await emailConsentState(db, tenantId, patientId);
      const agreed = state === "GRANTED" || (state !== "WITHDRAWN" && !(await this.settings.get(db, tenantId, facilityId, "EMAIL_REQUIRE_CONSENT")));
      if (!suppressed && agreed) out.push({ channel: "EMAIL", mask: maskEmail(email) });
    }
    return out;
  }

  /** Called inside the transaction that takes a payment: when that payment settles the bill, queues the soft copy. Never fails the payment. */
  async queueAuto(tx: Db, ctx: RequestContext, invoiceId: string): Promise<void> {
    try {
      if (!(await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "BILL_AUTO_SEND"))) return;
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, status: true, patientId: true, paidTotal: true, refundedTotal: true } });
      if (!inv || inv.status !== "PAID") return;
      const wanted = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "BILL_SEND_CHANNELS");
      const net = inv.paidTotal.minus(inv.refundedTotal).toFixed(2);
      const targets = await this.targets(tx, ctx.tenantId, ctx.facilityId, inv.patientId, wanted);
      if (targets.length === 0) return;
      await tx.invoiceDelivery.createMany({
        data: targets.map((t) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, invoiceId: inv.id, patientId: inv.patientId, channel: t.channel, toMask: t.mask, trigger: "AUTO", dedupeKey: `AUTO:${inv.id}:${net}:${t.channel}`, createdById: ctx.userId })),
        skipDuplicates: true,
      });
    } catch (e) {
      logJson("error", "invoice_delivery_queue_failed", { invoiceId, errorName: e instanceof Error ? e.name : typeof e });
    }
  }

  /** Staff press Send: queue the soft copy on the chosen channels (or the hospital's) and try at once. */
  async sendNow(ctx: RequestContext, invoiceId: string, input: z.infer<typeof sendBillSchema>) {
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, status: true, patientId: true } });
    if (!inv) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (inv.status === "DRAFT" || inv.status === "CANCELLED") throw new DomainError("INVALID_STATE", "Only an issued bill can be sent to the patient", 409);
    const wanted = input.channels ?? (await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "BILL_SEND_CHANNELS"));
    const targets = await this.targets(this.prisma, ctx.tenantId, ctx.facilityId, inv.patientId, wanted);
    if (targets.length === 0) throw new DomainError("INVALID_STATE", "This patient has no mobile number or email address that a copy can be sent to, or has asked not to be sent messages", 409);
    const ids = await this.prisma.$transaction(async (tx) => {
      const made: string[] = [];
      for (const t of targets) {
        const r = await tx.invoiceDelivery.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, invoiceId: inv.id, patientId: inv.patientId, channel: t.channel, toMask: t.mask, trigger: "MANUAL", createdById: ctx.userId }, select: { id: true } });
        await this.audit.record(tx, actorOf(ctx), { action: "BILL_COPY_SEND_REQUESTED", entityType: "InvoiceDelivery", entityId: r.id, metadata: { invoiceId: inv.id, channel: t.channel, to: t.mask } });
        made.push(r.id);
      }
      return made;
    });
    for (const id of ids) await this.deliverNow(id);
    return this.views(this.prisma, ctx, { ids });
  }

  async retry(ctx: RequestContext, deliveryId: string) {
    const res = await this.prisma.invoiceDelivery.updateMany({ where: { id: deliveryId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "FAILED" }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null } });
    if (res.count !== 1) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "BILL_COPY_SEND_RETRIED", entityType: "InvoiceDelivery", entityId: deliveryId }));
    await this.deliverNow(deliveryId);
    return (await this.views(this.prisma, ctx, { ids: [deliveryId] }))[0];
  }

  async list(ctx: RequestContext, invoiceId: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
    if (!inv) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.views(this.prisma, ctx, { invoiceId });
  }

  private async views(db: Db | PrismaService, ctx: RequestContext, f: { ids?: string[]; invoiceId?: string }) {
    const rows = await db.invoiceDelivery.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(f.ids ? { id: { in: f.ids } } : {}), ...(f.invoiceId ? { invoiceId: f.invoiceId } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id, invoiceId: r.invoiceId, channel: r.channel, to: r.toMask, trigger: r.trigger, status: r.status, attempts: r.attempts, createdAt: r.createdAt, sentAt: r.sentAt,
      provider: r.providerName, sentForReal: r.status === "SENT" && !(r.providerMessageId ?? "").startsWith("log-only:") && !(r.providerMessageId ?? "").startsWith("log:"), error: r.lastError, by: users.get(r.createdById) ?? null,
    }));
  }

  // ───── sending ─────

  private async deliverNow(deliveryId: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.deliverOne(tx, new Date(Date.now() + 5_000), deliveryId)); // a moment ahead: the database clock may run a few milliseconds ahead of this one
  }

  /** Sends what is due, hospital by hospital under each hospital's own scope. Safe on several servers: rows are claimed with SKIP LOCKED. */
  async runDue(now = new Date(), limit = 100): Promise<Record<Outcome, number>> {
    const counts: Record<Outcome, number> = { sent: 0, retried: 0, failed: 0 };
    const tenants = await tenantScope.system("bill copy worker: hospitals with copies due", () =>
      this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_due_invoice_deliveries(${now}::timestamptz)::text AS tenant_id`);
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

  private async deliverOne(tx: Db, now: Date, only?: string): Promise<Outcome | null> {
    const [r] = await tx.$queryRaw<{ id: string; tenantId: string; facilityId: string; invoiceId: string; patientId: string; channel: BillChannel; attempts: number; shareId: string | null; createdById: string }[]>`
      SELECT id, "tenantId", "facilityId", "invoiceId", "patientId", channel, attempts, "shareId", "createdById" FROM "InvoiceDelivery"
      WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now} AND (${only ?? null}::uuid IS NULL OR id = ${only ?? null}::uuid)
      ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!r) return null;
    const where = { id: r.id, tenantId: r.tenantId };
    const providerName = r.channel === "EMAIL" ? this.emails.name : this.messages.name;
    const fail = async (reason: string): Promise<Outcome> => {
      await tx.invoiceDelivery.updateMany({ where, data: { status: "FAILED", lastError: reason, attempts: r.attempts + 1, providerName } });
      logJson("info", "invoice_delivery_not_sent", { deliveryId: r.id, reason });
      return "failed";
    };
    const inv = await tx.invoice.findFirst({ where: { id: r.invoiceId, tenantId: r.tenantId }, select: { id: true, invoiceNumber: true, status: true, total: true, paidTotal: true, refundedTotal: true, patient: { select: { firstName: true, mobile: true, email: true } }, facility: { select: { name: true } } } });
    if (!inv || inv.status === "DRAFT" || inv.status === "CANCELLED") return fail("This bill can no longer be sent");
    // The address, consent and the hospital's switches are looked at again when sending: they may have changed since the copy was queued.
    const target = (await this.targets(tx, r.tenantId, r.facilityId, r.patientId, [r.channel])).find((t) => t.channel === r.channel);
    if (!target) return fail(r.channel === "EMAIL" ? "The patient has no email address that can be used, or has not agreed to email" : "The patient has no mobile number that a message can be sent to, or has asked not to be sent messages");
    const days = await this.settings.get(tx, r.tenantId, r.facilityId, "BILL_LINK_DAYS");
    // A new link for every attempt: the secret of an earlier one is not kept, so it cannot be sent again; the earlier link is withdrawn.
    if (r.shareId) await tx.invoiceShare.updateMany({ where: { id: r.shareId, tenantId: r.tenantId, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now } });
    const token = randomBytes(32).toString("base64url");
    const share = await tx.invoiceShare.create({
      data: { tenantId: r.tenantId, facilityId: r.facilityId, invoiceId: r.invoiceId, patientId: r.patientId, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + days * 86_400_000), createdById: r.createdById },
      select: { id: true },
    });
    await tx.invoiceDelivery.updateMany({ where, data: { shareId: share.id } });
    const link = `${this.base()}/api/bill/${token}`;
    const net = inv.paidTotal.minus(inv.refundedTotal).toFixed(2);
    const paidLine = inv.paidTotal.gt(0) ? ` We received ₹${net}.` : "";
    const text = `Dear ${inv.patient.firstName}, thank you.${paidLine} Your bill ${inv.invoiceNumber ?? ""} from ${inv.facility.name} is ready: ${link} (this link works for ${days} day${days === 1 ? "" : "s"}).`.replace(/\s{2,}/g, " ");
    const attempts = r.attempts + 1;
    try {
      let providerMessageId: string;
      if (r.channel === "EMAIL") {
        const to = inv.patient.email?.trim().toLowerCase() ?? "";
        const [fromName, replyTo] = await Promise.all([this.settings.get(tx, r.tenantId, r.facilityId, "EMAIL_FROM_NAME"), this.settings.get(tx, r.tenantId, r.facilityId, "EMAIL_REPLY_TO")]);
        const body = `Dear ${inv.patient.firstName},\n\nThank you.${paidLine} The soft copy of your bill ${inv.invoiceNumber ?? ""} from ${inv.facility.name} is ready. Open it here: ${link}\nPDF to download or print: ${link}?format=pdf&download=1\n\nThis link works for ${days} day${days === 1 ? "" : "s"}. Please keep this email as a record.\n\n${inv.facility.name}`;
        providerMessageId = (await this.emails.send({ reference: r.id, to, fromAddress: this.config.EMAIL_FROM_ADDRESS ?? "no-reply@example.invalid", fromName: fromName || inv.facility.name, replyTo: replyTo || undefined, subject: `Your bill ${inv.invoiceNumber ?? ""} — ${inv.facility.name}`.replace(/\s{2,}/g, " "), text: body, html: toHtml(body) })).providerMessageId;
      } else {
        const mobile = indianMobile(inv.patient.mobile);
        if (!mobile) return fail("The patient has no mobile number that a message can be sent to");
        providerMessageId = (await this.messages.send({ channel: r.channel, to: mobile, text, reference: r.id })).providerMessageId;
      }
      await tx.invoiceDelivery.updateMany({ where, data: { status: "SENT", attempts, sentAt: new Date(), providerName, providerMessageId: providerMessageId.slice(0, 200), lastError: null } });
      await this.audit.record(tx, { tenantId: r.tenantId, facilityId: r.facilityId, userId: r.createdById }, { action: "BILL_COPY_SENT", entityType: "InvoiceDelivery", entityId: r.id, metadata: { invoiceId: r.invoiceId, channel: r.channel, to: target.mask, provider: providerName } });
      return "sent";
    } catch (e) {
      const reason = e instanceof MessageError || e instanceof EmailError ? e.message : "The copy could not be sent";
      logJson("warn", "invoice_delivery_failed", { deliveryId: r.id, attempt: attempts, errorName: e instanceof Error ? e.name : typeof e });
      await tx.invoiceShare.updateMany({ where: { id: share.id, tenantId: r.tenantId }, data: { status: "REVOKED", revokedAt: now } });
      if (attempts >= MAX_ATTEMPTS) {
        await tx.invoiceDelivery.updateMany({ where, data: { status: "FAILED", attempts, lastError: reason, providerName } });
        return "failed";
      }
      await tx.invoiceDelivery.updateMany({ where, data: { attempts, lastError: reason, providerName, nextAttemptAt: new Date(now.getTime() + (BACKOFF_MINUTES[attempts - 1] ?? 30) * 60_000) } });
      return "retried";
    }
  }

  // ───── the patient's side ─────

  /** No sign-in. The hospital is found from the link's hash, then everything runs in that hospital's own scope. The link reaches only this one bill. */
  async open(token: string, format: PrintFormat, requestId: string): Promise<Rendered> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notValid();
    const found = await tenantScope.system("shared bill link: find the hospital that issued it", () =>
      this.prisma.$queryRaw<{ tenant_id: string; share_id: string }[]>`SELECT tenant_id::text AS tenant_id, share_id::text AS share_id FROM medos_resolve_invoice_share(${sha256(token)})`);
    const hit = found[0];
    if (!hit) throw notValid();
    return tenantScope.run(hit.tenant_id, async () => {
      const share = await this.prisma.invoiceShare.findFirst({ where: { id: hit.share_id, tenantId: hit.tenant_id } });
      if (!share || share.status !== "ACTIVE" || share.expiresAt.getTime() <= Date.now()) throw notValid();
      await this.prisma.$transaction(async (tx) => {
        await tx.invoiceShare.updateMany({ where: { id: share.id, tenantId: share.tenantId }, data: { openCount: { increment: 1 }, lastOpenedAt: new Date() } });
        await this.audit.record(tx, { tenantId: share.tenantId, facilityId: share.facilityId, requestId }, { action: "BILL_SHARE_OPENED", entityType: "InvoiceShare", entityId: share.id, metadata: { invoiceId: share.invoiceId, format } });
      });
      // Looked up here, not injected or imported at the top: the printer itself depends on payments, which queue these copies (a file-level cycle).
      const { PrintService } = await import("../print/print.service");
      return this.moduleRef.get(PrintService, { strict: false }).invoice({ tenantId: share.tenantId, facilityId: share.facilityId, userId: share.createdById, permissions: new Set(), requestId, dataScope: { kind: "ALL" } }, share.invoiceId, format, { quiet: true });
    });
  }
}
