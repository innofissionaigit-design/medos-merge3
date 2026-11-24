import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { NotificationsService } from "../notifications/notifications.service";
import { PasswordService } from "../auth/password.service";
import { PatientsService } from "../patients/patients.service";
import { AdvancesService } from "../billing/advances.service";
import { PaymentsService } from "../billing/payments.service";
import { PrismaService } from "../../common/prisma.service";
import type { AuthedRequest, RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { feePaid, feeState } from "../appointments/booking-fee";
import { balanceDue, fmt } from "../billing/billing.domain";
import { NON_OPD_ROLES } from "../masters/masters.service";
import { SettingsService } from "../settings/settings.service";
import { joinWindow, LIVE_APPOINTMENT } from "../telemedicine/telemedicine.domain";
import { indianMobile, MESSAGE_PROVIDER, type MessageProvider } from "../prescriptions/message.provider";
import { assertUnlocked, makeProof, type PortalSession, readProofs } from "./portal.access";
import { RELEASED_ORDER } from "../lims/lims-core.service";

export const OTP_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;
export const OTP_SEND_WINDOW_MINUTES = 15;
export const SESSION_HOURS = 12;
export const PASSWORD_MAX_FAILURES = 5;
export const PASSWORD_LOCK_MINUTES = 15;
export const passwordLoginSchema = z.object({ hospitalCode: z.string().trim().toLowerCase().min(2).max(32), username: z.string().trim().toLowerCase().min(1).max(40), password: z.string().min(1).max(128) }).strict();
export const usernameRule = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._@+-]{3,63}$/, "Username: 4 to 64 letters, numbers or . _ @ + -");
export const registerSchema = z.object({
  hospitalCode: z.string().trim().toLowerCase().min(2).max(32), mobile: z.string().trim().min(10).max(15),
  firstName: z.string().trim().min(1, "Enter your first name").max(60), lastName: z.string().trim().min(1, "Enter your last name").max(60),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNKNOWN"]), dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter your date of birth"),
  username: usernameRule,
  password: z.string().min(8, "Use at least 8 characters").max(128).refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Use letters and at least one number"),
}).strict();
export const setPasswordSchema = z.object({ username: usernameRule, password: z.string().min(8, "Use at least 8 characters").max(128).refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Use letters and at least one number") }).strict();
const TOKEN_PREFIX = "mdp_";
const MAX_PENDING_REQUESTS = 3;

export const UNLOCK_MAX_FAILURES = 5;
export const UNLOCK_FAILURE_WINDOW_MINUTES = 60;
export type { PortalSession };
export interface PortalRequest extends AuthedRequest { portal?: PortalSession }

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-02");

export const otpRequestSchema = z.object({ hospitalCode: z.string().trim().toLowerCase().min(2).max(32), mobile: z.string().trim().min(10).max(15) }).strict();
export const otpVerifySchema = otpRequestSchema.extend({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }).strict();
export const requestSchema = z.object({
  patientId: uuid, practitionerId: uuid.optional(), preferredDate: day, timeOfDay: z.enum(["MORNING", "AFTERNOON", "EVENING", "ANY"]).default("ANY"), reason: z.string().trim().min(3).max(300), mode: z.enum(["IN_PERSON", "VIDEO"]).default("IN_PERSON"),
}).strict();
export const paidRequestSchema = requestSchema.extend({ method: z.enum(["UPI", "CARD"]), key: z.string().trim().min(8).max(64) }).strict();
export const requestFeeQuerySchema = z.object({ mode: z.enum(["IN_PERSON", "VIDEO"]).default("IN_PERSON"), practitionerId: uuid.optional() }).strict();
export const patientQuerySchema = z.object({ patientId: uuid }).strict();
export const unlockSchema = z.object({ patientId: uuid, dateOfBirth: day }).strict();
export const videoFeePaySchema = z.object({ patientId: uuid, appointmentId: uuid, method: z.enum(["UPI", "CARD"]), key: z.string().trim().min(8).max(64) }).strict();
export const onlinePaySchema = z.object({ patientId: uuid, invoiceId: uuid, method: z.enum(["UPI", "CARD"]), key: z.string().trim().min(8).max(64) }).strict();
export const handleRequestSchema = z.object({ decision: z.enum(["BOOKED", "DECLINED"]), note: z.string().trim().max(300).optional(), appointmentId: uuid.optional() }).strict();
export const listRequestsSchema = z.object({ status: z.enum(["PENDING", "BOOKED", "DECLINED", "CANCELLED"]).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");
const ageOf = (p: { dateOfBirth: Date | null; estimatedAgeYears: number | null }) => {
  if (p.dateOfBirth) { const now = new Date(); let a = now.getUTCFullYear() - p.dateOfBirth.getUTCFullYear(); const m = now.getUTCMonth() - p.dateOfBirth.getUTCMonth(); if (m < 0 || (m === 0 && now.getUTCDate() < p.dateOfBirth.getUTCDate())) a -= 1; return a; }
  return p.estimatedAgeYears;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The patient app's guard: a patient's own session token (never a staff token), checked against the database on every request. */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService, @Inject(CONFIG) private readonly config: AppConfig) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const req = ec.switchToHttp().getRequest<PortalRequest>();
    const header = req.headers["authorization"];
    const raw = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const m = /^mdp_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{32,64}$/.exec(raw);
    const fail = () => new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    if (!m) throw fail();
    const tenantId = m[1]!.toLowerCase();
    tenantScope.bind(tenantId);
    const now = new Date();
    const s = await this.prisma.patientSession.findFirst({ where: { tenantId, tokenHash: sha256(raw), revokedAt: null, expiresAt: { gt: now } }, select: { id: true, mobile: true, lastUsedAt: true } });
    if (!s) throw fail();
    const facility = await this.prisma.facility.findFirst({ where: { tenantId, status: "ACTIVE", tenant: { status: "ACTIVE" } }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!facility) throw fail();
    if (!(await this.settings.get(this.prisma, tenantId, facility.id, "PATIENT_PORTAL_ENABLED"))) throw fail();
    if (!s.lastUsedAt || now.getTime() - s.lastUsedAt.getTime() > 60_000) await this.prisma.patientSession.updateMany({ where: { id: s.id, tenantId }, data: { lastUsedAt: now } });
    req.portal = { tenantId, facilityId: facility.id, mobile: s.mobile, sessionId: s.id, unlocked: readProofs(this.config.JWT_ACCESS_SECRET, tenantId, s.id, req.headers["x-patient-proofs"], now.getTime()) };
    return true;
  }
}

/** The hidden user that actions made by patients themselves (online payment, self-registration) are recorded under. It can never sign in. */
async function ensureServiceUser(prisma: PrismaService, tenantId: string, facilityId: string, username: string, fullName: string): Promise<string> {
  const find = () => prisma.user.findFirst({ where: { tenantId, username }, select: { id: true } });
  const found = await find();
  if (found) return found.id;
  try {
    return await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { tenantId, username, fullName, passwordHash: "!service-account", isService: true }, select: { id: true } });
      await tx.userFacility.create({ data: { tenantId, userId: u.id, facilityId } });
      return u.id;
    });
  } catch (e) {
    const again = await find();
    if (again) return again.id;
    throw e;
  }
}

/**
 * Signing in to the patient app (docs/patient-app.md): a six-digit code goes to the mobile number the hospital has on record; typing it opens a session for that number.
 * The answer to "send me a code" is always the same, so nobody can use it to find out who is a patient. Codes expire in minutes, allow a few wrong tries, and are
 * stored only as keyed hashes. Nothing is ever logged: not the code, not the full number.
 */
@Injectable()
export class PortalAuthService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly config: AppConfig, @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider, private readonly passwords: PasswordService, private readonly patients: PatientsService,
  ) {}

  private async openSession(tenantId: string, mobile: string, now: Date, how: "CODE" | "PASSWORD") {
    const token = `${TOKEN_PREFIX}${tenantId}.${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3_600_000);
    const s = await this.prisma.patientSession.create({ data: { tenantId, mobile, tokenHash: sha256(token), expiresAt }, select: { id: true } });
    await this.audit.recordStandalone({ tenantId }, { action: "PATIENT_APP_SIGNED_IN", entityType: "PatientSession", entityId: s.id, metadata: { actor: "PATIENT", how, mobileEnding: mobile.slice(-4) } });
    return { token, expiresAt };
  }

  /** Sign in with the mobile number and the password the patient chose. Every failure gives the same answer; five wrong tries lock the number for a while. */
  async passwordLogin(input: z.infer<typeof passwordLoginSchema>) {
    const fail = () => new DomainError("UNAUTHENTICATED", "The username or password is not correct", 401);
    const tenant = await this.tenantOf(input.hospitalCode);
    if (!tenant) { await this.passwords.verifyDummy(input.password); throw fail(); }
    return tenantScope.run(tenant.id, async () => {
      const now = new Date();
      const cred = await this.prisma.patientCredential.findFirst({ where: { tenantId: tenant.id, username: input.username } });
      const facility = await this.prisma.facility.findFirst({ where: { tenantId: tenant.id, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
      const on = facility ? await this.settings.get(this.prisma, tenant.id, facility.id, "PATIENT_PORTAL_ENABLED") : false;
      if (!cred || !on) { await this.passwords.verifyDummy(input.password); throw fail(); }
      if (cred.lockedUntil && cred.lockedUntil > now) throw new DomainError("RATE_LIMITED", "Too many wrong tries. Please wait a few minutes, or sign in with a code", 429);
      const ok = await this.passwords.verify(input.password, cred.passwordHash);
      if (!ok) {
        const failed = cred.failedAttempts + 1;
        const lock = failed >= PASSWORD_MAX_FAILURES;
        await this.prisma.patientCredential.updateMany({ where: { id: cred.id, tenantId: tenant.id }, data: { failedAttempts: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + PASSWORD_LOCK_MINUTES * 60_000) : null } });
        await this.audit.recordStandalone({ tenantId: tenant.id }, { action: "PATIENT_APP_PASSWORD_FAILED", entityType: "PatientCredential", entityId: cred.id, metadata: { actor: "PATIENT", mobileEnding: cred.mobile.slice(-4), locked: lock } });
        throw fail();
      }
      if (cred.failedAttempts > 0 || cred.lockedUntil) await this.prisma.patientCredential.updateMany({ where: { id: cred.id, tenantId: tenant.id }, data: { failedAttempts: 0, lockedUntil: null } });
      return this.openSession(tenant.id, cred.mobile, now, "PASSWORD");
    });
  }

  /**
   * A new patient creates their own record from the app, with no code. Because nothing proves the phone, only a number the hospital has never seen can be registered this way:
   * a number that already belongs to a patient must sign in with an SMS code, so nobody can reach another person's records. The record is a normal patient (own Patient ID);
   * the registration fee, if the hospital charges one, is left for the front desk.
   */
  async register(input: z.infer<typeof registerSchema>) {
    const fail = () => new DomainError("VALIDATION_FAILED", "Please check the hospital code and the mobile number", 400);
    const mobile = indianMobile(input.mobile);
    const tenant = await this.tenantOf(input.hospitalCode);
    if (!mobile || !tenant) throw fail();
    const dob = new Date(`${input.dateOfBirth}T00:00:00Z`);
    if (Number.isNaN(dob.getTime()) || dob.toISOString().slice(0, 10) !== input.dateOfBirth || dob.getTime() > Date.now()) throw new DomainError("VALIDATION_FAILED", "Enter a valid date of birth", 400);
    return tenantScope.run(tenant.id, async () => {
      const now = new Date();
      const facility = await this.prisma.facility.findFirst({ where: { tenantId: tenant.id, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
      if (!facility || !(await this.settings.get(this.prisma, tenant.id, facility.id, "PATIENT_PORTAL_ENABLED"))) throw fail();
      if (await this.prisma.patient.count({ where: { tenantId: tenant.id, mobile } }) > 0) throw new DomainError("CONFLICT", "This mobile number is already registered with the hospital. Please sign in with an SMS code", 409);
      if (await this.prisma.patientCredential.findFirst({ where: { tenantId: tenant.id, username: input.username }, select: { id: true } })) throw new DomainError("CONFLICT", "That username is already taken. Please choose another", 409);
      if (await this.prisma.patientCredential.findFirst({ where: { tenantId: tenant.id, mobile }, select: { id: true } })) throw new DomainError("CONFLICT", "This mobile number already has an app login. Please sign in", 409);
      const userId = await ensureServiceUser(this.prisma, tenant.id, facility.id, "svc-patient-app", "Patient app (self-registration)");
      const ctx: RequestContext = { tenantId: tenant.id, facilityId: facility.id, userId, permissions: new Set(), requestId: randomUUID(), dataScope: { kind: "ALL" } };
      let patientId: string;
      try {
        const out = await this.patients.create(ctx, { firstName: input.firstName, lastName: input.lastName, gender: input.gender, dateOfBirth: dob, mobile }, `portal-register-${randomUUID()}`, { registration: "PENDING" });
        patientId = out.patient.id;
      } catch (e) {
        if (e instanceof DomainError && e.code === "DUPLICATE_PATIENT_SUSPECTED") throw new DomainError("CONFLICT", "You may already be registered with this hospital. Please sign in with a code by SMS, or ask the front desk", 409);
        throw e;
      }
      const passwordHash = await this.passwords.hash(input.password);
      const cred = await this.prisma.patientCredential.create({ data: { tenantId: tenant.id, mobile, username: input.username, passwordHash }, select: { id: true } });
      await this.audit.recordStandalone({ tenantId: tenant.id }, { action: "PATIENT_APP_REGISTERED", entityType: "Patient", entityId: patientId, metadata: { actor: "PATIENT", credentialId: cred.id, mobileEnding: mobile.slice(-4) } });
      return this.openSession(tenant.id, mobile, now, "PASSWORD");
    });
  }

  async passwordStatus(p: PortalSession): Promise<{ set: boolean; username: string | null }> {
    const c = await this.prisma.patientCredential.findFirst({ where: { tenantId: p.tenantId, mobile: p.mobile }, select: { username: true } });
    return { set: c !== null, username: c?.username ?? null };
  }

  /** Sets or changes the password for the number of this session. The session was opened with a code or the old password, so the phone is already proven. */
  async setPassword(p: PortalSession, input: z.infer<typeof setPasswordSchema>) {
    const passwordHash = await this.passwords.hash(input.password);
    const now = new Date();
    const taken = await this.prisma.patientCredential.findFirst({ where: { tenantId: p.tenantId, username: input.username, NOT: { mobile: p.mobile } }, select: { id: true } });
    if (taken) throw new DomainError("CONFLICT", "That username is already taken. Please choose another", 409);
    const row = await this.prisma.patientCredential.upsert({
      where: { tenantId_mobile: { tenantId: p.tenantId, mobile: p.mobile } },
      create: { tenantId: p.tenantId, mobile: p.mobile, username: input.username, passwordHash }, update: { username: input.username, passwordHash, failedAttempts: 0, lockedUntil: null, updatedAt: now }, select: { id: true },
    });
    await this.audit.recordStandalone({ tenantId: p.tenantId }, { action: "PATIENT_APP_PASSWORD_SET", entityType: "PatientCredential", entityId: row.id, metadata: { actor: "PATIENT", sessionId: p.sessionId, mobileEnding: p.mobile.slice(-4) } });
    return { set: true as const, username: input.username };
  }

  private async tenantOf(code: string): Promise<{ id: string } | null> {
    const rows = await tenantScope.system("patient app: resolve hospital code", () => this.prisma.$queryRaw<{ id: string; status: string }[]>`SELECT id::text AS id, status FROM medos_resolve_tenant(${code})`);
    const t = rows[0];
    return t && t.status === "ACTIVE" ? { id: t.id } : null;
  }

  private hash(tenantId: string, mobile: string, code: string): string {
    return createHmac("sha256", this.config.JWT_ACCESS_SECRET).update(`portal-otp|${tenantId}|${mobile}|${code}`).digest("hex");
  }

  /** Always answers the same. Sends a code only when the hospital has the patient app on, the number belongs to a patient, and the number has not asked too often. */
  async requestCode(input: z.infer<typeof otpRequestSchema>): Promise<{ sent: true }> {
    const answer = { sent: true as const };
    const mobile = indianMobile(input.mobile);
    const tenant = await this.tenantOf(input.hospitalCode);
    if (!mobile || !tenant) return answer;
    return tenantScope.run(tenant.id, async () => {
      const facility = await this.prisma.facility.findFirst({ where: { tenantId: tenant.id, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true, tenant: { select: { name: true } } } });
      if (!facility || !(await this.settings.get(this.prisma, tenant.id, facility.id, "PATIENT_PORTAL_ENABLED"))) return answer;
      if (await this.prisma.patient.count({ where: { tenantId: tenant.id, mobile, status: "ACTIVE", mergedIntoId: null } }) === 0) return answer;
      const since = new Date(Date.now() - OTP_SEND_WINDOW_MINUTES * 60_000);
      if (await this.prisma.patientOtp.count({ where: { tenantId: tenant.id, mobile, createdAt: { gt: since } } }) >= OTP_MAX_SENDS) { logJson("warn", "patient_otp_throttled", { tenantId: tenant.id }); return answer; }
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const row = await this.prisma.patientOtp.create({ data: { tenantId: tenant.id, mobile, codeHash: this.hash(tenant.id, mobile, code), expiresAt: new Date(Date.now() + OTP_MINUTES * 60_000) }, select: { id: true } });
      // Demo-only: with no SMS service connected, a local developer can read the code in the API log. It needs BOTH a local environment (APP_ENV=local, never staging or
      // production) and the explicit switch PATIENT_OTP_DEV_LOG=true. Only the last four digits of the number are written.
      if (this.config.APP_ENV === "local" && this.config.NODE_ENV !== "production" && process.env.PATIENT_OTP_DEV_LOG === "true") logJson("warn", "patient_otp_dev_code", { code, to: `******${mobile.slice(-4)}`, minutes: OTP_MINUTES });
      try {
        await this.provider.send({ channel: "SMS", to: mobile, text: `${code} is your ${facility.tenant.name} patient app code. It works for ${OTP_MINUTES} minutes. Do not share it with anyone.`, reference: row.id });
      } catch (e) {
        logJson("warn", "patient_otp_send_failed", { tenantId: tenant.id, reason: e instanceof Error ? e.constructor.name : "unknown" });
      }
      return answer;
    });
  }

  /** Checks a sign-in code and uses it up. Throws the same error for every kind of failure. */
  private async consumeCode(tenantId: string, mobile: string, code: string, now: Date, fail: () => DomainError): Promise<void> {
      const otp = await this.prisma.patientOtp.findFirst({ where: { tenantId: tenantId, mobile, consumedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
      if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw fail();
      // Count the try first, so two parallel guesses cannot both get the full allowance.
      const counted = await this.prisma.patientOtp.updateMany({ where: { id: otp.id, tenantId: tenantId, attempts: otp.attempts, consumedAt: null }, data: { attempts: otp.attempts + 1 } });
      if (counted.count !== 1) throw fail();
      const a = Buffer.from(this.hash(tenantId, mobile, code)), b = Buffer.from(otp.codeHash);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw fail();
      const used = await this.prisma.patientOtp.updateMany({ where: { id: otp.id, tenantId: tenantId, consumedAt: null }, data: { consumedAt: now } });
      if (used.count !== 1) throw fail();
  }

  /** Checks the code and opens a session. Every failure gives the same answer. */
  async verifyCode(input: z.infer<typeof otpVerifySchema>) {
    const fail = () => new DomainError("UNAUTHENTICATED", "The code is not correct or has expired. Ask for a new one", 401);
    const mobile = indianMobile(input.mobile);
    const tenant = await this.tenantOf(input.hospitalCode);
    if (!mobile || !tenant) throw fail();
    return tenantScope.run(tenant.id, async () => {
      const now = new Date();
      await this.consumeCode(tenant.id, mobile, input.code, now, fail);
      return this.openSession(tenant.id, mobile, now, "CODE");
    });
  }

  /**
   * Opens one patient's records for this session after the date of birth is confirmed. The code proves the phone, not the person: on a shared number each
   * patient is confirmed separately. A patient with no date of birth on file cannot be opened this way (the hospital must add it). Wrong tries are counted per
   * patient, across sessions, so a new sign-in does not reset them; every try is audited.
   */
  async unlock(p: PortalSession, input: z.infer<typeof unlockSchema>) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: p.tenantId, mobile: p.mobile, status: "ACTIVE", mergedIntoId: null }, select: { id: true, dateOfBirth: true } });
      if (!patient) return { kind: "NOT_FOUND" as const };
      if (!patient.dateOfBirth) return { kind: "NO_DOB" as const };
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal-unlock:${p.tenantId}:${patient.id}`}, 0))`;
      const since = new Date(Date.now() - UNLOCK_FAILURE_WINDOW_MINUTES * 60_000);
      const failures = await tx.auditEvent.count({ where: { tenantId: p.tenantId, action: "PATIENT_APP_UNLOCK_FAILED", entityType: "Patient", entityId: patient.id, createdAt: { gt: since } } });
      if (failures >= UNLOCK_MAX_FAILURES) return { kind: "LOCKED_OUT" as const };
      const ok = iso(patient.dateOfBirth) === input.dateOfBirth;
      await this.audit.record(tx, { tenantId: p.tenantId, facilityId: p.facilityId }, { action: ok ? "PATIENT_APP_PROFILE_UNLOCKED" : "PATIENT_APP_UNLOCK_FAILED", entityType: "Patient", entityId: patient.id, metadata: { actor: "PATIENT", sessionId: p.sessionId } });
      return { kind: ok ? ("OK" as const) : ("WRONG" as const) };
    });
    // The failed try is saved above; the error is raised only after the transaction has committed.
    if (outcome.kind === "NOT_FOUND") throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (outcome.kind === "NO_DOB") throw new DomainError("PROFILE_NOT_VERIFIABLE", "The hospital has no date of birth on file for this patient. Please ask the front desk to add it", 409);
    if (outcome.kind === "LOCKED_OUT") throw new DomainError("RATE_LIMITED", "Too many wrong tries. Please try again later or ask the front desk", 429);
    if (outcome.kind === "WRONG") throw new DomainError("PROFILE_VERIFICATION_FAILED", "That date of birth does not match our records", 403);
    return { patientId: input.patientId, ...makeProof(this.config.JWT_ACCESS_SECRET, p.tenantId, p.sessionId, input.patientId) };
  }

  async logout(p: PortalSession): Promise<{ signedOut: true }> {
    await this.prisma.patientSession.updateMany({ where: { id: p.sessionId, tenantId: p.tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.recordStandalone({ tenantId: p.tenantId }, { action: "PATIENT_APP_SIGNED_OUT", entityType: "PatientSession", entityId: p.sessionId, metadata: { actor: "PATIENT" } });
    return { signedOut: true };
  }
}

/**
 * What a signed-in patient may see (docs/patient-app.md): only the records of patients registered with their mobile number, and, when several people share the
 * number, only those whose date of birth this session has confirmed (portal.access.ts). Only signed or verified clinical content, never drafts, and a critical report only after the doctor has seen it. Every query names the hospital and the patient.
 */
@Injectable()
export class PortalService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notifications: NotificationsService, private readonly settings: SettingsService, private readonly payments: PaymentsService, private readonly advances: AdvancesService, @Inject(CONFIG) private readonly config: AppConfig) {}

  // ───── online payment (UPI and card) ─────

  /** Online payment needs a connected payment gateway, which MedOS does not have yet. A local demo can switch on a TEST checkout that moves no money: APP_ENV=local and ONLINE_PAYMENT_PROVIDER=test, never in staging or production. */
  private onlineMode(): "test" | null {
    return this.config.APP_ENV === "local" && this.config.NODE_ENV !== "production" && process.env.ONLINE_PAYMENT_PROVIDER === "test" ? "test" : null;
  }

  paymentOptions(): { available: boolean; mode: "test" | null; methods: ("UPI" | "CARD")[] } {
    const mode = this.onlineMode();
    return { available: mode !== null, mode, methods: mode ? ["UPI", "CARD"] : [] };
  }

  /** The hidden user a patient's online payment is recorded under, because a receipt needs someone who received it. It can never sign in. */
  private onlineUser(tenantId: string, facilityId: string): Promise<string> {
    return ensureServiceUser(this.prisma, tenantId, facilityId, "svc-online-payments", "Online payments (patient app)");
  }

  /**
   * Pays the whole balance of one of the patient's own bills by UPI or card. In test mode the checkout is simulated and the payment is posted exactly like a counter
   * payment (receipt, ledger, audit), under the hidden online-payments user. The same key always returns the same receipt, so a double tap never charges twice.
   */
  async payOnline(p: PortalSession, input: z.infer<typeof onlinePaySchema>) {
    if (!this.onlineMode()) throw new DomainError("INVALID_STATE", "Online payment is not available yet. Please pay at the hospital counter", 409);
    await this.patient(p, input.patientId);
    const inv = await this.prisma.invoice.findFirst({
      where: { id: input.invoiceId, tenantId: p.tenantId, facilityId: p.facilityId, patientId: input.patientId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
      select: { id: true, total: true, paidTotal: true, refundedTotal: true, creditedTotal: true },
    });
    if (!inv) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const due = balanceDue(inv);
    if (due.lte(0)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", "This bill has nothing left to pay", 409);
    const userId = await this.onlineUser(p.tenantId, p.facilityId);
    const ctx: RequestContext = { tenantId: p.tenantId, facilityId: p.facilityId, userId, permissions: new Set(), requestId: randomUUID(), dataScope: { kind: "ALL" } };
    // The reference is fixed by the key, so a retry sends exactly the same payment and gets the same receipt back.
    const reference = `TEST-${input.method}-${createHash("sha256").update(input.key).digest("hex").slice(0, 8).toUpperCase()}`;
    const out = await this.payments.pay(ctx, inv.id, { payments: [{ method: input.method, amount: due, reference }] }, `portal-${input.key}`);
    return { receiptNumber: out.result.receipt.receiptNumber, amount: out.result.receipt.total, method: input.method, reference, mode: "test" as const };
  }

  /**
   * Pays the video consultation fee of one of the patient's own appointments by UPI or card (test checkout, like bills). The fee is the appointment's booking fee, so it is
   * recorded as an advance on that appointment, exactly as the front desk would take it, and the video call opens for joining once it is covered.
   */
  async payVideoFee(p: PortalSession, input: z.infer<typeof videoFeePaySchema>) {
    if (!this.onlineMode()) throw new DomainError("INVALID_STATE", "Online payment is not available yet. Please pay at the hospital counter", 409);
    await this.patient(p, input.patientId);
    const a = await this.prisma.appointment.findFirst({
      where: { id: input.appointmentId, tenantId: p.tenantId, facilityId: p.facilityId, patientId: input.patientId, status: "BOOKED", teleconsults: { some: { status: { not: "CANCELLED" } } } },
      select: { bookingFee: true, feeSkippedAt: true, advanceDeposits: { select: { amount: true, refunds: { select: { amount: true } } } } },
    });
    if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const fee = feeState(a, feePaid(a.advanceDeposits));
    if (fee.status !== "PENDING") throw new DomainError("INVALID_STATE", "There is no video consultation fee to pay", 409);
    const userId = await this.onlineUser(p.tenantId, p.facilityId);
    const ctx: RequestContext = { tenantId: p.tenantId, facilityId: p.facilityId, userId, permissions: new Set(), requestId: randomUUID(), dataScope: { kind: "ALL" } };
    const reference = `TEST-${input.method}-${createHash("sha256").update(input.key).digest("hex").slice(0, 8).toUpperCase()}`;
    const { result } = await this.advances.take(ctx, input.patientId, { tenders: [{ method: input.method, amount: new Decimal(fee.due), reference }], note: "Video consultation fee (patient app, test mode)" }, `portal-video-${input.key}`, input.appointmentId);
    return { receiptNumber: result.receiptNumber, amount: fee.due, method: input.method, reference, mode: "test" as const };
  }

  private async patient(p: PortalSession, patientId: string) {
    const x = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: p.tenantId, mobile: p.mobile, status: "ACTIVE", mergedIntoId: null }, select: { id: true, firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true } });
    if (!x) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    await assertUnlocked(this.prisma, p, patientId);
    return x;
  }

  /**
   * The people on this number. A person who has not been confirmed in this session shows only a first name (so a family can pick who they are), with no
   * record number, age or gender, and the app asks for the date of birth before it shows anything else.
   */
  async profiles(p: PortalSession) {
    const rows = await this.prisma.patient.findMany({ where: { tenantId: p.tenantId, mobile: p.mobile, status: "ACTIVE", mergedIntoId: null }, orderBy: { createdAt: "asc" }, take: 20, select: { id: true, firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } });
    const hospital = await this.prisma.tenant.findFirst({ where: { id: p.tenantId }, select: { name: true } });
    return {
      hospital: hospital?.name ?? null,
      patients: rows.map((r) => {
        const open = rows.length === 1 || p.unlocked.has(r.id);
        return open
          ? { id: r.id, name: nameOf(r), mrn: r.identifiers[0]?.value ?? null, gender: r.gender, age: ageOf(r), locked: false, canUnlock: true }
          : { id: r.id, name: r.firstName, mrn: null, gender: null, age: null, locked: true, canUnlock: r.dateOfBirth !== null };
      }),
    };
  }

  async doctors(p: PortalSession) {
    const rows = await this.prisma.practitioner.findMany({ where: { tenantId: p.tenantId, facilityId: p.facilityId, status: "ACTIVE", NOT: { user: { roles: { some: { role: { name: { in: NON_OPD_ROLES } } } } } } }, orderBy: { displayName: "asc" }, take: 100, select: { id: true, displayName: true, specialty: true, department: { select: { name: true } } } });
    return rows.map((d) => ({ id: d.id, name: d.displayName, specialty: d.specialty, department: d.department?.name ?? null }));
  }

  async appointments(p: PortalSession, patientId: string) {
    await this.patient(p, patientId);
    const now = new Date();
    const select = { id: true, startAt: true, endAt: true, status: true, type: true, bookingFee: true, feeSkippedAt: true, advanceDeposits: { select: { amount: true, refunds: { select: { amount: true } } } }, practitioner: { select: { displayName: true, specialty: true } } } as const;
    const [upcoming, past] = await Promise.all([
      this.prisma.appointment.findMany({ where: { tenantId: p.tenantId, patientId, startAt: { gte: now }, status: { in: ["BOOKED", "CHECKED_IN", "WAITING", "IN_CONSULTATION"] } }, orderBy: { startAt: "asc" }, take: 20, select }),
      this.prisma.appointment.findMany({ where: { tenantId: p.tenantId, patientId, OR: [{ startAt: { lt: now } }, { status: { in: ["COMPLETED", "CANCELLED", "NO_SHOW"] } }] }, orderBy: { startAt: "desc" }, take: 20, select }),
    ]);
    const teles = new Map((await this.prisma.teleconsult.findMany({ where: { tenantId: p.tenantId, patientId, status: { not: "CANCELLED" }, appointmentId: { in: [...upcoming, ...past].map((a) => a.id) } }, select: { id: true, appointmentId: true, status: true, scheduledAt: true, consentAt: true, patientWaitingAt: true, doctorJoinedAt: true } })).map((t) => [t.appointmentId, t]));
    const payFirst = await this.settings.get(this.prisma, p.tenantId, p.facilityId, "TELECONSULT_PAY_BEFORE_JOIN");
    const video = (a: (typeof upcoming)[number]) => {
      const t = teles.get(a.id);
      if (!t) return null;
      const w = joinWindow(t.scheduledAt, now);
      const fee = feeState(a, feePaid(a.advanceDeposits));
      return { id: t.id, status: t.status, consented: !!t.consentAt, waiting: !!t.patientWaitingAt, doctorStarted: !!t.doctorJoinedAt, feeDue: fee.status === "PENDING" ? fee.due : null, payFirst: !!payFirst, opensAt: w.opensAt, canJoin: w.open && (t.status === "SCHEDULED" || t.status === "IN_PROGRESS") && (LIVE_APPOINTMENT as readonly string[]).includes(a.status) };
    };
    const view = (a: (typeof upcoming)[number]) => ({ id: a.id, startAt: a.startAt, endAt: a.endAt, status: a.status, type: a.type, doctor: a.practitioner.displayName, specialty: a.practitioner.specialty, video: video(a) });
    return { upcoming: upcoming.map(view), past: past.map(view) };
  }

  /** Visits with the doctor's signed note (diagnosis and advice) and the signed prescription. Drafts are never shown. */
  async visits(p: PortalSession, patientId: string) {
    await this.patient(p, patientId);
    const rows = await this.prisma.encounter.findMany({
      where: { tenantId: p.tenantId, patientId, type: "OPD", status: { not: "CANCELLED" } }, orderBy: { startedAt: "desc" }, take: 20,
      select: {
        id: true, encounterNumber: true, startedAt: true, practitioner: { select: { displayName: true, specialty: true } },
        diagnoses: { where: { status: "ACTIVE", supersededAtVersion: null }, orderBy: { recordedAt: "asc" }, select: { text: true, type: true } },
        documents: { where: { kind: "CONSULTATION", status: { in: ["SIGNED", "AMENDED"] } }, select: { signedAt: true, versions: { orderBy: { version: "desc" }, take: 1, select: { content: true } } } },
        medicationOrders: { where: { status: "SIGNED" }, orderBy: { signedAt: "asc" }, take: 20, select: { orderNumber: true, signedAt: true, items: { where: { status: "ACTIVE" }, orderBy: { lineNo: "asc" }, select: { genericName: true, brandName: true, strength: true, dosage: true, frequency: true, frequencyText: true, durationDays: true, foodRelation: true, instructions: true } } } },
      },
    });
    return rows.filter((e) => e.documents.length > 0).map((e) => {
      const content = (e.documents[0]?.versions[0]?.content ?? {}) as Record<string, unknown>;
      const advice = typeof content["advice"] === "string" ? (content["advice"] as string) : null;
      const rx = e.medicationOrders[0];
      return {
        id: e.id, visitNumber: e.encounterNumber, date: e.startedAt, doctor: e.practitioner?.displayName ?? null, specialty: e.practitioner?.specialty ?? null,
        diagnoses: e.diagnoses.map((d) => d.text), advice,
        prescription: rx ? { number: rx.orderNumber, signedAt: rx.signedAt, medicines: e.medicationOrders.flatMap((o) => o.items).map((i) => ({ name: [i.brandName ?? i.genericName, i.strength].filter(Boolean).join(" "), dose: i.dosage, frequency: i.frequencyText ?? i.frequency, days: i.durationDays, food: i.foodRelation, note: i.instructions })) } : null,
      };
    });
  }

  /** Verified lab reports and signed radiology reports. A report with a critical value is held back until the doctor has acknowledged it. */
  async reports(p: PortalSession, patientId: string) {
    await this.patient(p, patientId);
    const released = { OR: [{ hasCritical: false }, { criticalAckAt: { not: null } }] };
    const [labs, rads, heldLab, heldRad] = await Promise.all([
      this.prisma.labResult.findMany({ where: { tenantId: p.tenantId, patientId, status: "VERIFIED", testOrder: RELEASED_ORDER, ...released }, orderBy: { updatedAt: "desc" }, take: 30, select: { id: true, name: true, specimen: true, versions: { orderBy: { version: "desc" }, take: 1, select: { values: true, comment: true, verifiedAt: true } } } }),
      this.prisma.radStudy.findMany({ where: { tenantId: p.tenantId, patientId, status: "REPORTED", testOrder: RELEASED_ORDER, ...released }, orderBy: { updatedAt: "desc" }, take: 30, select: { id: true, modality: true, bodyPart: true, testOrder: { select: { name: true } }, reports: { orderBy: { version: "desc" }, take: 1, select: { findings: true, impression: true, signedAt: true } } } }),
      this.prisma.labResult.count({ where: { tenantId: p.tenantId, patientId, status: "VERIFIED", hasCritical: true, criticalAckAt: null } }),
      this.prisma.radStudy.count({ where: { tenantId: p.tenantId, patientId, status: "REPORTED", hasCritical: true, criticalAckAt: null } }),
    ]);
    return {
      withheld: heldLab + heldRad,
      lab: labs.filter((l) => l.versions[0]).map((l) => ({ id: l.id, test: l.name, specimen: l.specimen, reportedAt: l.versions[0]!.verifiedAt, comment: l.versions[0]!.comment, values: ((l.versions[0]!.values ?? []) as unknown as { name: string; unit: string | null; value: string; flag: string; rangeText: string }[]).map((v) => ({ name: v.name, unit: v.unit, value: v.value, flag: v.flag, range: v.rangeText })) })),
      radiology: rads.filter((r) => r.reports[0]).map((r) => ({ id: r.id, test: r.testOrder.name, bodyPart: r.bodyPart, reportedAt: r.reports[0]!.signedAt, findings: r.reports[0]!.findings, impression: r.reports[0]!.impression })),
    };
  }

  /** Issued invoices with what was paid and what is still due, and the receipts. Drafts and cancelled invoices are not shown. */
  async bills(p: PortalSession, patientId: string) {
    await this.patient(p, patientId);
    const rows = await this.prisma.invoice.findMany({
      where: { tenantId: p.tenantId, patientId, status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID", "REFUNDED"] } }, orderBy: { issuedAt: "desc" }, take: 30,
      select: { id: true, invoiceNumber: true, kind: true, status: true, issuedAt: true, total: true, paidTotal: true, refundedTotal: true, creditedTotal: true, receipts: { orderBy: { receivedAt: "asc" }, select: { receiptNumber: true, total: true, receivedAt: true } } },
    });
    return rows.map((i) => ({ id: i.id, number: i.invoiceNumber, kind: i.kind, status: i.status, issuedAt: i.issuedAt, total: fmt(i.total), paid: fmt(i.paidTotal), due: fmt(balanceDue(i)), receipts: i.receipts.map((r) => ({ number: r.receiptNumber, amount: fmt(r.total), at: r.receivedAt })) }));
  }

  // ───── appointment requests ─────

  async requests(p: PortalSession, patientId: string) {
    await this.patient(p, patientId);
    const rows = await this.prisma.appointmentRequest.findMany({ where: { tenantId: p.tenantId, patientId }, orderBy: { createdAt: "desc" }, take: 20 });
    const docs = new Map((await this.prisma.practitioner.findMany({ where: { tenantId: p.tenantId, id: { in: rows.flatMap((r) => (r.practitionerId ? [r.practitionerId] : [])) } }, select: { id: true, displayName: true } })).map((d) => [d.id, d.displayName]));
    return rows.map((r) => ({ mode: r.mode, id: r.id, preferredDate: iso(r.preferredDate), timeOfDay: r.timeOfDay, reason: r.reason, status: r.status, doctor: r.practitionerId ? docs.get(r.practitionerId) ?? null : null, answer: r.status === "DECLINED" || r.status === "BOOKED" ? r.handleNote : null, createdAt: r.createdAt }));
  }

  /**
   * The fee to pay in the app when asking for an appointment. A video consultation is paid for when the request is sent (the chosen doctor's video fee, else the hospital's video
   * fee); a visit in person has no payment step unless the hospital sets a request fee. null means nothing to pay. The app takes it only when online payment is available.
   */
  async requestFee(p: PortalSession, q: z.infer<typeof requestFeeQuerySchema>): Promise<{ amount: string | null; online: boolean }> {
    let amount = new Decimal(0);
    if (q.mode === "VIDEO") {
      const doc = q.practitionerId ? await this.prisma.practitioner.findFirst({ where: { id: q.practitionerId, tenantId: p.tenantId, facilityId: p.facilityId }, select: { videoFee: true } }) : null;
      amount = doc?.videoFee != null ? new Decimal(doc.videoFee.toString()) : new Decimal(await this.settings.get(this.prisma, p.tenantId, p.facilityId, "TELECONSULT_FEE_AMOUNT"));
    } else amount = new Decimal(await this.settings.get(this.prisma, p.tenantId, p.facilityId, "APPOINTMENT_REQUEST_FEE_AMOUNT"));
    return { amount: amount.gt(0) ? amount.toFixed(2) : null, online: this.onlineMode() !== null };
  }

  /** Everything that must be true before a request is accepted (and before any money is taken for it). */
  private async checkRequest(tx: Prisma.TransactionClient, p: PortalSession, input: z.infer<typeof requestSchema>): Promise<Date> {
    const pat = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: p.tenantId, mobile: p.mobile, status: "ACTIVE", mergedIntoId: null }, select: { id: true } });
    if (!pat) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    await assertUnlocked(tx, p, input.patientId);
    const today = new Date(iso(new Date()));
    const date = new Date(input.preferredDate);
    if (date < today || date.getTime() > today.getTime() + 60 * 86_400_000) throw new DomainError("VALIDATION_FAILED", "Choose a date within the next 60 days", 400, [{ path: "preferredDate", message: "Out of range" }]);
    if (input.practitionerId) {
      const d = await tx.practitioner.findFirst({ where: { id: input.practitionerId, tenantId: p.tenantId, facilityId: p.facilityId, status: "ACTIVE" }, select: { id: true } });
      if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    }
    if (await tx.appointmentRequest.count({ where: { tenantId: p.tenantId, patientId: input.patientId, status: "PENDING" } }) >= MAX_PENDING_REQUESTS) throw new DomainError("CONFLICT", "You already have requests waiting. Please wait for the hospital to answer, or cancel one", 409);
    return date;
  }

  async createRequest(p: PortalSession, input: z.infer<typeof requestSchema>, paid?: { amount: string; receiptNumber: string; depositId: string }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal-req:${p.tenantId}:${input.patientId}`}, 0))`;
      if (paid) {
        const again = await tx.appointmentRequest.findFirst({ where: { tenantId: p.tenantId, feeDepositId: paid.depositId }, select: { id: true } });
        if (again) return { id: again.id, status: "PENDING" as const };
      }
      const date = await this.checkRequest(tx, p, input);
      if (!paid && input.mode === "VIDEO") {
        const fee = await this.requestFee(p, { mode: "VIDEO", practitionerId: input.practitionerId });
        if (fee.amount && fee.online) throw new DomainError("INVALID_STATE", "A video consultation is paid for when you ask for it. Please pay to send the request", 409);
      }
      const r = await tx.appointmentRequest.create({ data: { tenantId: p.tenantId, facilityId: p.facilityId, patientId: input.patientId, practitionerId: input.practitionerId ?? null, preferredDate: date, timeOfDay: input.timeOfDay, reason: input.reason, mode: input.mode, ...(paid ? { feeAmount: paid.amount, feeReceiptNumber: paid.receiptNumber, feeDepositId: paid.depositId } : {}) }, select: { id: true } });
      await this.audit.record(tx, { tenantId: p.tenantId, facilityId: p.facilityId }, { action: "APPOINTMENT_REQUESTED", entityType: "AppointmentRequest", entityId: r.id, metadata: { actor: "PATIENT", patientId: input.patientId, ...(paid ? { paidOnline: paid.amount, receipt: paid.receiptNumber } : {}) } });
      await this.notifications.notifyPermission(tx, ["APPOINTMENT_CREATE"], { tenantId: p.tenantId, facilityId: p.facilityId, type: "BOOKING_FROM_OUTSIDE", entityType: "AppointmentRequest", entityId: r.id, dedupeKey: `BOOKING_FROM_OUTSIDE:${r.id}` });
      return { id: r.id, status: "PENDING" as const };
    });
  }

  /**
   * Asks for an appointment and pays the booking fee in one step (test checkout, like bills). The request is checked first, so money is never taken for a request that would be
   * refused. The money is held as the patient's advance; the receipt number and amount are written on the request for the front desk.
   */
  async createPaidRequest(p: PortalSession, input: z.infer<typeof paidRequestSchema>) {
    const { method, key, ...request } = input;
    const fee = await this.requestFee(p, { mode: request.mode, practitionerId: request.practitionerId });
    if (!fee.amount || !fee.online) throw new DomainError("INVALID_STATE", "No payment is needed to ask for this appointment", 409);
    await this.prisma.$transaction((tx) => this.checkRequest(tx, p, request));
    const userId = await this.onlineUser(p.tenantId, p.facilityId);
    const ctx: RequestContext = { tenantId: p.tenantId, facilityId: p.facilityId, userId, permissions: new Set(), requestId: randomUUID(), dataScope: { kind: "ALL" } };
    const reference = `TEST-${method}-${createHash("sha256").update(key).digest("hex").slice(0, 8).toUpperCase()}`;
    const { result } = await this.advances.take(ctx, request.patientId, { tenders: [{ method, amount: new Decimal(fee.amount), reference }], note: request.mode === "VIDEO" ? "Video consultation fee (patient app, test mode)" : "Appointment request fee (patient app, test mode)" }, `portal-reqfee-${key}`);
    const r = await this.createRequest(p, request, { amount: fee.amount, receiptNumber: result.receiptNumber, depositId: result.id });
    return { requestId: r.id, receiptNumber: result.receiptNumber, amount: fee.amount, method, reference, mode: "test" as const };
  }

  async cancelRequest(p: PortalSession, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.appointmentRequest.findFirst({ where: { id, tenantId: p.tenantId, patient: { mobile: p.mobile, mergedIntoId: null } }, select: { id: true, patientId: true } });
      if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await assertUnlocked(tx, p, r.patientId);
      const res = await tx.appointmentRequest.updateMany({ where: { id, tenantId: p.tenantId, status: "PENDING" }, data: { status: "CANCELLED", handledAt: new Date() } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This request has already been answered", 409);
      await this.audit.record(tx, { tenantId: p.tenantId, facilityId: p.facilityId }, { action: "APPOINTMENT_REQUEST_CANCELLED", entityType: "AppointmentRequest", entityId: id, metadata: { actor: "PATIENT", patientId: r.patientId } });
      return { id, status: "CANCELLED" as const };
    });
  }

  // ───── the front desk's side ─────

  async listForStaff(ctx: RequestContext, q: z.infer<typeof listRequestsSchema>) {
    const where: Prisma.AppointmentRequestWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.appointmentRequest.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { patient: { select: { id: true, firstName: true, lastName: true, mobile: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } } } }),
      this.prisma.appointmentRequest.count({ where }),
    ]);
    const docs = new Map((await this.prisma.practitioner.findMany({ where: { tenantId: ctx.tenantId, id: { in: rows.flatMap((r) => (r.practitionerId ? [r.practitionerId] : [])) } }, select: { id: true, displayName: true } })).map((d) => [d.id, d.displayName]));
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r) => ({ mode: r.mode, paidOnline: r.feeAmount ? { amount: r.feeAmount.toFixed(2), receipt: r.feeReceiptNumber } : null, id: r.id, patientId: r.patientId, patient: nameOf(r.patient), mrn: r.patient.identifiers[0]?.value ?? null, mobile: r.patient.mobile, doctor: r.practitionerId ? docs.get(r.practitionerId) ?? null : null, practitionerId: r.practitionerId, preferredDate: iso(r.preferredDate), timeOfDay: r.timeOfDay, reason: r.reason, status: r.status, handleNote: r.handleNote, appointmentId: r.appointmentId, createdAt: r.createdAt })) };
  }

  /** The front desk answers: booked (optionally naming the appointment they made) or declined with a note the patient can read. */
  async handle(ctx: RequestContext, id: string, input: z.infer<typeof handleRequestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.appointmentRequest.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true, feeAmount: true, feeReceiptNumber: true } });
      if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (input.decision === "DECLINED" && (input.note?.length ?? 0) < 3) throw new DomainError("VALIDATION_FAILED", "Tell the patient why", 400, [{ path: "note", message: "Required" }]);
      if (input.appointmentId) {
        const a = await tx.appointment.findFirst({ where: { id: input.appointmentId, tenantId: ctx.tenantId, patientId: r.patientId }, select: { id: true } });
        if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        // The patient already paid online with the request: the booking fee of this appointment must not be collected again. The money stays the patient's advance, to be set against the bill.
        if (input.decision === "BOOKED" && r.feeAmount) {
          await tx.appointment.updateMany({ where: { id: input.appointmentId, tenantId: ctx.tenantId, bookingFee: { not: null }, feeSkippedAt: null }, data: { feeSkippedAt: new Date(), feeSkippedById: ctx.userId, feeSkipReason: "PAID_ONLINE", version: { increment: 1 }, feeSkipNote: `Paid online with the request (receipt ${r.feeReceiptNumber ?? ""})` } });
        }
      }
      const res = await tx.appointmentRequest.updateMany({ where: { id, tenantId: ctx.tenantId, status: "PENDING" }, data: { status: input.decision, handledById: ctx.userId, handledAt: new Date(), handleNote: input.note ?? null, appointmentId: input.appointmentId ?? null } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This request has already been answered or cancelled", 409);
      await this.audit.record(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId, requestId: ctx.requestId }, { action: "APPOINTMENT_REQUEST_ANSWERED", entityType: "AppointmentRequest", entityId: id, metadata: { decision: input.decision } });
      return { id, status: input.decision };
    });
  }
}
