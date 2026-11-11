import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { DomainError, type Permission } from "@medos/shared";
import type { Prisma, TestCategory } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { assertEncounterVisible, isRestricted, visitScope } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { ClinicianService } from "../clinical/clinician.service";
import { EncountersService } from "../encounters/encounters.service";
import { LabService, rejectSampleSchema } from "../lab/lab.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NumberingService } from "../numbering/numbering.service";
import { SettingsService } from "../settings/settings.service";
import { performSchema, RadiologyService } from "../radiology/radiology.service";
import { endOfLocalDay, localDateStr } from "../../common/time";
import { computeLine, fmt } from "../billing/billing.domain";
import { LimsBillingService } from "./lims-billing.service";
import { LimsCoreService, type RequestRow } from "./lims-core.service";
import { LimsMessagesService } from "./lims-messages.service";
import { LimsScheduleService } from "./lims-schedule.service";
import {
  addMinutes, categoryOfDepartment, clockStart, DEFAULT_DEPARTMENTS, DEPARTMENT_PERMISSIONS, departmentKindOf, guessDepartment, isDelayed, LIMS_PRIORITIES, LIMS_STATUSES, OPEN_STATUSES, PRIORITY_RANK, targetMinutes,
  type DepartmentKind, type LimsPriority, type LimsStatus,
} from "./lims.domain";

const uuid = z.string().uuid();
const priority = z.enum(LIMS_PRIORITIES);
const instant = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");

/** A test is chosen from the test list (its department decides who runs it), or typed with its kind. A typed name that matches the list is routed by the list. */
export const testItem = z.object({ serviceId: uuid.optional(), name: z.string().trim().min(2).max(120).optional(), category: z.enum(["LABORATORY", "RADIOLOGY"]).optional() }).strict()
  .refine((t) => !!t.serviceId || (!!t.name && !!t.category), "Choose a test from the list, or type its name and kind");

export const orderSchema = z.object({
  encounterId: uuid,
  /** Left out, the test is routine, or an emergency when the patient is in the emergency ward (docs/emergency.md). */
  priority: priority.optional(),
  clinicalNote: z.string().trim().min(3).max(600).optional(),
  tests: z.array(testItem).min(1).max(20),
}).strict();

/** Reception books tests for a patient who has no doctor's order: the patient agrees, and the tests go straight into the queue. */
export const bookSchema = z.object({
  patientId: uuid,
  consent: z.literal(true),
  consentMode: z.enum(["VERBAL", "WRITTEN"]).default("VERBAL"),
  tests: z.array(testItem).min(1).max(20),
  priority: priority.default("ROUTINE"),
  scheduledFor: instant.optional(),
  assignedNurseId: uuid.optional(),
  instructions: z.string().trim().min(3).max(600).optional(),
  /** The outside doctor who sent the patient, if any (shown to the technician and the specialist). */
  referredBy: z.string().trim().min(2).max(80).optional(),
}).strict();

export const catalogueSchema = z.object({ q: z.string().trim().min(1).max(60).optional(), department: z.enum(["PATHOLOGY", "RADIOLOGY"]).optional() }).strict();
export const groupingSchema = z.object({ department: z.enum(["PATHOLOGY", "RADIOLOGY"]) }).strict();

export const launchSchema = z.object({
  encounterId: uuid,
  /** The patient agreed to the tests (said at the desk or signed). Without it nothing is launched. */
  consent: z.literal(true),
  consentMode: z.enum(["VERBAL", "WRITTEN"]).default("VERBAL"),
  testOrderIds: z.array(uuid).min(1).max(20),
  priority: priority.default("ROUTINE"),
  scheduledFor: instant.optional(),
  assignedNurseId: uuid.optional(),
  instructions: z.string().trim().min(3).max(600).optional(),
}).strict();

export const declineSchema = z.object({ encounterId: uuid, testOrderIds: z.array(uuid).min(1).max(20), reason: z.string().trim().min(3).max(200) }).strict();

export const listSchema = z.object({
  status: z.string().trim().max(200).optional(),
  department: z.enum(["PATHOLOGY", "RADIOLOGY"]).optional(),
  origin: z.enum(["OPD", "IPD", "EMERGENCY"]).optional(),
  priority: priority.optional(),
  q: z.string().trim().min(2).max(60).optional(),
  mine: bool.optional(),
  overdue: bool.optional(),
  recollect: bool.optional(),
  /** Outpatients expected today (or earlier and not yet attended), waiting for the sample step. */
  expected: bool.optional(),
  /** With `expected`: only those who have reported at reception (true) or are still to come (false). */
  arrived: bool.optional(),
  unassigned: bool.optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const pendingSchema = z.object({ q: z.string().trim().min(2).max(60).optional() }).strict();
export const prioritySchema = z.object({ priority, reason: z.string().trim().min(3).max(200).optional() }).strict();
export const assignSchema = z.object({ nurseId: uuid.nullable().optional(), techId: uuid.nullable().optional() }).strict().refine((v) => v.nurseId !== undefined || v.techId !== undefined, "Choose a nurse or a technician");
export const collectRequestSchema = z.object({ notes: z.string().trim().max(300).optional() }).strict();
export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();
export const handoverSchema = z.object({ receivedBy: z.string().trim().min(2).max(80) }).strict();
export const staffSchema = z.object({ department: z.enum(["PATHOLOGY", "RADIOLOGY"]).optional() }).strict();

const LIST_SELECT = {
  id: true, requestNumber: true, status: true, priority: true, origin: true, consent: true, scheduledFor: true, dueAt: true, instructions: true, clinicalNote: true, createdAt: true,
  needsRecollection: true, recollectCount: true, returnedCount: true, compromisedSampleApproved: true, assignedNurseId: true, assignedTechId: true,
  arrivedAt: true, collectedAt: true, acceptedAt: true, submittedAt: true, passedAt: true, issuedAt: true, handedOverAt: true, testOrderId: true, encounterId: true, batchId: true, version: true,
  department: { select: { kind: true, name: true } },
  patient: { select: { id: true, firstName: true, lastName: true, gender: true, identifiers: { where: { type: "MRN" as const }, select: { value: true } } } },
  encounter: { select: { encounterNumber: true, practitioner: { select: { displayName: true } }, admission: { select: { admissionNumber: true, assignments: { where: { releasedAt: null }, take: 1, select: { bed: { select: { code: true, ward: { select: { name: true } } } } } } } } } },
  testOrder: { select: { name: true, status: true, labResult: { select: { id: true, version: true, hasCritical: true, criticalAckAt: true } }, radStudy: { select: { id: true, accessionNumber: true, hasCritical: true, criticalAckAt: true } }, labSamples: { where: { status: "COLLECTED" as const }, select: { accessionNumber: true }, take: 1 } } },
} satisfies Prisma.LimsRequestSelect;
type Row = Prisma.LimsRequestGetPayload<{ select: typeof LIST_SELECT }>;

/**
 * The LIMS (docs/lims-portal.md): a doctor orders tests (an admitted patient's go straight to the laboratory; an outpatient's wait at reception until the patient agrees),
 * the nurse takes the sample, the technician takes it in hand and prepares the report, the pathologist or radiologist passes it, and the technician issues it.
 * The clinical work itself is done by the laboratory and radiology services; this service moves the request through the steps and keeps its history.
 */
@Injectable()
export class LimsService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly core: LimsCoreService, private readonly messages: LimsMessagesService, private readonly schedule: LimsScheduleService,
    private readonly numbering: NumberingService, private readonly notifications: NotificationsService, private readonly lab: LabService, private readonly rad: RadiologyService,
    private readonly encounters: EncountersService, private readonly clinicians: ClinicianService, private readonly billing: LimsBillingService, private readonly settings: SettingsService,
  ) {}

  // ───── helpers ─────

  /** The departments this person may see: pathology needs LAB_READ and radiology needs RAD_READ. */
  readableKinds(ctx: RequestContext): DepartmentKind[] {
    return (["PATHOLOGY", "RADIOLOGY"] as const).filter((k) => ctx.permissions.has(DEPARTMENT_PERMISSIONS[k].read));
  }

  /**
   * Which requests this person may list or open: a department's whole queue for people who work in it, and only outpatient requests for reception (which handles the
   * patient-facing steps of both departments but is not shown clinical detail).
   */
  private deptWhere(ctx: RequestContext, only?: DepartmentKind): Prisma.LimsRequestWhereInput {
    const parts: Prisma.LimsRequestWhereInput[] = (["PATHOLOGY", "RADIOLOGY"] as const).filter((k) => !only || k === only).flatMap((k) => {
      if (ctx.permissions.has(DEPARTMENT_PERMISSIONS[k].read)) return [{ department: { kind: k } }];
      if (ctx.permissions.has("LIMS_REQUEST")) return [{ department: { kind: k }, origin: "OPD" as const }];
      return [];
    });
    return parts.length ? { OR: parts } : { id: { in: [] } };
  }

  private need(ctx: RequestContext, kind: DepartmentKind, level: "read" | "work" | "review"): void {
    if (!ctx.permissions.has(DEPARTMENT_PERMISSIONS[kind][level])) throw new DomainError("FORBIDDEN", "You do not have permission for this department's work", 403);
  }

  async ensureDepartments(db: Db | PrismaService, tenantId: string, facilityId: string) {
    const have = await db.limsDepartment.count({ where: { tenantId, facilityId } });
    if (have < DEFAULT_DEPARTMENTS.length) await db.limsDepartment.createMany({ data: DEFAULT_DEPARTMENTS.map((d) => ({ tenantId, facilityId, ...d })), skipDuplicates: true });
    return db.limsDepartment.findMany({ where: { tenantId, facilityId }, orderBy: { kind: "asc" } });
  }

  private async userHas(db: Db, ctx: RequestContext, userId: string, permission: Permission): Promise<boolean> {
    const u = await db.user.findFirst({
      where: { id: userId, tenantId: ctx.tenantId, status: "ACTIVE", isService: false, facilities: { some: { facilityId: ctx.facilityId } }, roles: { some: { role: { permissions: { some: { permission } } } } } },
      select: { id: true },
    });
    return !!u;
  }

  private scopeWhere(ctx: RequestContext): Prisma.LimsRequestWhereInput {
    return isRestricted(ctx) ? { encounter: { AND: [visitScope(ctx)] } } : {};
  }

  private async views(db: Db | PrismaService, ctx: RequestContext, rows: Row[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.assignedNurseId, r.assignedTechId]).filter((x): x is string => !!x))];
    const users = new Map((ids.length ? await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    const now = new Date();
    return rows.map((r) => {
      const clinical = ctx.permissions.has(DEPARTMENT_PERMISSIONS[r.department.kind].read);
      return {
      id: r.id, requestNumber: r.requestNumber, status: r.status, priority: r.priority, origin: r.origin, consent: r.consent,
      department: r.department.kind, departmentName: r.department.name, test: r.testOrder.name, testOrderId: r.testOrderId,
      patient: { id: r.patient.id, name: nameOf(r.patient), gender: r.patient.gender, mrn: r.patient.identifiers[0]?.value ?? null },
      encounterId: r.encounterId, visitNumber: r.encounter.encounterNumber, doctor: r.encounter.practitioner?.displayName ?? null, batchId: r.batchId,
      bed: r.encounter.admission?.assignments[0] ? { code: r.encounter.admission.assignments[0].bed.code, ward: r.encounter.admission.assignments[0].bed.ward.name } : null,
      createdAt: r.createdAt, scheduledFor: r.scheduledFor, arrivedAt: r.arrivedAt, dueAt: r.dueAt, delayed: isDelayed({ status: r.status, dueAt: r.dueAt, issuedAt: r.issuedAt }, now),
      assignedNurse: r.assignedNurseId ? { id: r.assignedNurseId, name: users.get(r.assignedNurseId) ?? null } : null,
      assignedTech: r.assignedTechId ? { id: r.assignedTechId, name: users.get(r.assignedTechId) ?? null } : null,
      needsRecollection: r.needsRecollection, recollectCount: r.recollectCount, returnedCount: r.returnedCount, compromisedSampleApproved: r.compromisedSampleApproved,
      instructions: r.instructions, clinicalNote: clinical ? r.clinicalNote : null, billed: r.testOrder.status === "BILLED", version: r.version,
      accessionNumber: r.testOrder.labSamples[0]?.accessionNumber ?? r.testOrder.radStudy?.accessionNumber ?? null,
      resultId: clinical ? r.testOrder.labResult?.id ?? null : null, resultVersion: clinical ? r.testOrder.labResult?.version ?? null : null, studyId: clinical ? r.testOrder.radStudy?.id ?? null : null,
      critical: clinical && ((r.testOrder.labResult?.hasCritical === true && !r.testOrder.labResult.criticalAckAt) || (r.testOrder.radStudy?.hasCritical === true && !r.testOrder.radStudy.criticalAckAt)),
      stamps: { collectedAt: r.collectedAt, acceptedAt: r.acceptedAt, submittedAt: r.submittedAt, passedAt: r.passedAt, issuedAt: r.issuedAt, handedOverAt: r.handedOverAt },
      };
    });
  }

  // ───── departments ─────

  async departments(ctx: RequestContext) {
    const rows = await this.ensureDepartments(this.prisma, ctx.tenantId, ctx.facilityId);
    const kinds = new Set(this.readableKinds(ctx));
    // A person who can open LIMS sees both department names; the counts are limited to the departments they may read.
    const open = await this.prisma.limsRequest.groupBy({ by: ["departmentId"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { in: [...OPEN_STATUSES] } }, _count: { _all: true } });
    const counts = new Map(open.map((o) => [o.departmentId, o._count._all]));
    return rows.map((d) => ({ id: d.id, kind: d.kind, name: d.name, status: d.status, routineTatMinutes: d.routineTatMinutes, urgentTatMinutes: d.urgentTatMinutes, emergencyTatMinutes: d.emergencyTatMinutes, defaultInstructions: d.defaultInstructions, capacityPerHour: d.capacityPerHour, openMinute: d.openMinute, closeMinute: d.closeMinute, openRequests: kinds.has(d.kind) ? counts.get(d.id) ?? 0 : null, readable: kinds.has(d.kind) }));
  }

  // ───── ordering (doctor) ─────

  /**
   * Turns what was chosen or typed into tests with a kind. A test from the list (or a typed name that matches it) is routed by the department the list groups it with,
   * so it always reaches the right technician whatever box it was typed in; anything else keeps the kind it was given, and is priced later by the cashier.
   */
  private async resolveTests(tx: Db, ctx: RequestContext, items: z.infer<typeof testItem>[]): Promise<{ name: string; category: TestCategory; serviceId: string | null }[]> {
    const services = await tx.service.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, name: true, code: true, category: true, limsDepartment: true } });
    const out = new Map<string, { name: string; category: TestCategory; serviceId: string | null }>();
    for (const t of items) {
      let r: { name: string; category: TestCategory; serviceId: string | null };
      if (t.serviceId) {
        const svc = services.find((x) => x.id === t.serviceId && x.category === "INVESTIGATION");
        if (!svc) throw new DomainError("VALIDATION_FAILED", "That test is not on the test list", 400);
        r = { name: svc.name, serviceId: svc.id, category: categoryOfDepartment(svc.limsDepartment ?? guessDepartment(svc.name)) };
      } else {
        const typed = (t.name ?? "").replace(/\s+/g, " ").trim();
        const hit = services.find((x) => norm(x.name) === norm(typed) || norm(x.code) === norm(typed));
        r = hit?.category === "INVESTIGATION"
          ? { name: hit.name, serviceId: hit.id, category: categoryOfDepartment(hit.limsDepartment ?? guessDepartment(hit.name)) }
          : { name: typed, serviceId: hit?.id ?? null, category: t.category as TestCategory };
      }
      out.set(`${r.category}|${norm(r.name)}`, r);
    }
    return [...out.values()];
  }

  /** Builds the request for a test order: department, number, due time, history, audit. */
  private async createRequest(tx: Db, ctx: RequestContext, o: { testOrderId: string; category: TestCategory; serviceId: string | null; patientId: string; encounterId: string; origin: "OPD" | "IPD" | "EMERGENCY" }, i: {
    batchId: string; priority: LimsPriority; scheduledFor: Date | null; instructions: string | null; clinicalNote: string | null; assignedNurseId: string | null; consent: "NOT_REQUIRED" | "GIVEN";
  }) {
    const kind = departmentKindOf(o.category);
    if (!kind) throw new DomainError("VALIDATION_FAILED", "Only laboratory and imaging tests are run by the LIMS", 400);
    const dept = (await this.ensureDepartments(tx, ctx.tenantId, ctx.facilityId)).find((d) => d.kind === kind);
    if (!dept || dept.status !== "ACTIVE") throw new DomainError("INVALID_STATE", `The ${kind === "PATHOLOGY" ? "pathology" : "radiology"} department is not taking requests right now`, 409);
    const def = o.serviceId ? await tx.labTestDefinition.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, serviceId: o.serviceId, status: "ACTIVE" }, select: { turnaroundHours: true, instructions: true } }) : null;
    const now = new Date();
    const createdAt = now;
    const start = clockStart({ createdAt, scheduledFor: i.scheduledFor });
    const dueAt = addMinutes(start, targetMinutes(dept, i.priority, def?.turnaroundHours));
    const requestNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "LIMS_REQUEST");
    const created = await tx.limsRequest.create({
      data: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: o.patientId, encounterId: o.encounterId, testOrderId: o.testOrderId, departmentId: dept.id, requestNumber, batchId: i.batchId,
        origin: o.origin, priority: i.priority, consent: i.consent, scheduledFor: i.scheduledFor, instructions: i.instructions ?? def?.instructions ?? dept.defaultInstructions ?? null,
        clinicalNote: i.clinicalNote, assignedNurseId: i.assignedNurseId, requestedById: ctx.userId, dueAt, createdAt,
      },
      select: { id: true, requestNumber: true },
    });
    await this.core.event(tx, ctx.tenantId, created.id, "CREATED", ctx.userId, { to: "PENDING_COLLECTION", note: i.priority === "ROUTINE" ? undefined : `priority ${i.priority.toLowerCase()}` });
    return { ...created, department: kind, priority: i.priority };
  }

  /** Tells the nurses (or the assigned nurse) a sample is waiting; an emergency also tells the LIMS manager. */
  private async announce(tx: Db, ctx: RequestContext, made: { id: string; priority: LimsPriority }[], assignedNurseId: string | null): Promise<void> {
    for (const r of made) {
      const to = assignedNurseId ? [assignedNurseId] : await this.core.collectors(tx, ctx, { assignedNurseId: null });
      const managers = r.priority === "EMERGENCY" ? await this.notifications.recipientsWith(tx, ctx.tenantId, ctx.facilityId, ["LIMS_ASSIGN"]) : [];
      await this.core.notify(tx, ctx, [...to, ...managers], assignedNurseId ? "LIMS_ASSIGNED" : "LIMS_COLLECTION_WAITING", r, "new");
    }
  }

  /**
   * The nurse for an admitted patient's sample, chosen automatically: of the nurses who take samples at this facility, the one with the fewest samples waiting (then by name), so
   * the work is shared. The LIMS manager can still change it. Returns null when no nurse is set up, and the nurses are asked together instead.
   */
  private async autoNurse(tx: Db, ctx: RequestContext, prefer?: "ER_TRIAGE" | "ICU_NURSE"): Promise<string | null> {
    const pool = (extra: Prisma.UserWhereInput[]) => tx.user.findMany({
      where: { tenantId: ctx.tenantId, status: "ACTIVE", isService: false, facilities: { some: { facilityId: ctx.facilityId } }, AND: [{ roles: { some: { role: { permissions: { some: { permission: "LIMS_COLLECT" } } } } } }, ...extra] },
      select: { id: true, fullName: true }, orderBy: [{ fullName: "asc" }, { id: "asc" }], take: 200,
    });
    // An emergency patient's sample is taken by an emergency nurse when there is one; otherwise by any nurse who takes samples.
    const preferred = prefer ? await pool([{ roles: { some: { role: { permissions: { some: { permission: prefer } } } } } }]) : [];
    const nurses = preferred.length > 0 ? preferred : await pool([]);
    if (nurses.length === 0) return null;
    const load = await tx.limsRequest.groupBy({ by: ["assignedNurseId"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "PENDING_COLLECTION", assignedNurseId: { in: nurses.map((n) => n.id) } }, _count: { _all: true } });
    const waiting = new Map(load.map((l) => [l.assignedNurseId as string, l._count._all]));
    return [...nurses].sort((a, b) => (waiting.get(a.id) ?? 0) - (waiting.get(b.id) ?? 0))[0]?.id ?? null;
  }

  /**
   * A doctor orders laboratory or imaging tests for a visit. For an admitted patient the tests go straight to the laboratory (no separate consent is asked), and the doctor can
   * mark them urgent or emergency so they come to the top of the queue. For an outpatient the order waits at reception, which launches it once the patient agrees.
   */
  /** Orders tests for a visit. `outer` lets the caller do it inside its own transaction (a doctor accepting a nurse's request). */
  async order(ctx: RequestContext, input: z.infer<typeof orderSchema>, outer?: Db) {
    if (input.priority !== undefined && input.priority !== "ROUTINE" && !ctx.permissions.has("LIMS_PRIORITY")) throw new DomainError("FORBIDDEN", "You may not mark a test urgent or emergency", 403);
    const run = async (tx: Db) => {
      await assertEncounterVisible(tx, ctx, input.encounterId);
      const enc = await this.encounters.assertActive(tx, ctx, input.encounterId);
      // The tests of a patient in the emergency ward are tagged emergency unless the doctor chose otherwise.
      const prio: LimsPriority = input.priority ?? (enc.type === "EMERGENCY" ? "EMERGENCY" : "ROUTINE");
      const toLab = enc.type === "IPD" || enc.type === "EMERGENCY";
      await this.clinicians.requireActive(tx, ctx);
      const wanted = new Map((await this.resolveTests(tx, ctx, input.tests)).map((t) => [`${t.category}|${norm(t.name)}`, t]));
      // A test already on its way for this visit is not ordered twice. A test that was finished earlier may be ordered again (a repeat).
      const active = await tx.testOrder.findMany({ where: { tenantId: ctx.tenantId, encounterId: enc.id, category: { in: ["LABORATORY", "RADIOLOGY"] }, status: { in: ["ORDERED", "BILLED"] } }, select: { category: true, name: true, limsRequest: { select: { status: true } } } });
      for (const a of active) {
        const open = !a.limsRequest || OPEN_STATUSES.includes(a.limsRequest.status);
        if (open && wanted.has(`${a.category}|${norm(a.name)}`)) throw new DomainError("CONFLICT", `${a.name} is already ordered for this visit and has not been completed`, 409);
      }
      const batchId = randomUUID();
      const made: { id: string; priority: LimsPriority }[] = [];
      const orders: { id: string; name: string; category: TestCategory }[] = [];
      // An admitted patient is never held back by how busy the lab is, and the nurse is chosen at once (the LIMS manager can change it).
      // An emergency patient's sample is taken by an emergency nurse, an ICU patient's by an ICU nurse (and the nurse is told), when there is one.
      const icuCode = enc.type === "IPD" ? await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "EMERGENCY_ICU_WARD_CODE") : null;
      const inIcu = icuCode ? (await tx.bedAssignment.count({ where: { tenantId: ctx.tenantId, releasedAt: null, admission: { encounterId: enc.id }, bed: { ward: { code: icuCode } } } })) > 0 : false;
      const nurseId = toLab ? await this.autoNurse(tx, ctx, enc.type === "EMERGENCY" ? "ER_TRIAGE" : inIcu ? "ICU_NURSE" : undefined) : null;
      for (const t of wanted.values()) {
        const m = { serviceId: t.serviceId, name: t.name };
        const order = await tx.testOrder.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId: enc.id, category: t.category, name: m.name, serviceId: m.serviceId, source: "LIMS", orderedById: ctx.userId }, select: { id: true, name: true, category: true } });
        orders.push(order);
        if (toLab) {
          const r = await this.createRequest(tx, ctx, { testOrderId: order.id, category: order.category, serviceId: m.serviceId, patientId: enc.patientId, encounterId: enc.id, origin: enc.type === "EMERGENCY" ? "EMERGENCY" : "IPD" }, {
            batchId, priority: prio, scheduledFor: null, instructions: null, clinicalNote: input.clinicalNote ?? null, assignedNurseId: nurseId, consent: "NOT_REQUIRED",
          });
          if (nurseId) await this.core.event(tx, ctx.tenantId, r.id, "NURSE_ASSIGNED", ctx.userId, { note: "assigned automatically" });
          made.push({ id: r.id, priority: prio });
        }
      }
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_TESTS_ORDERED", entityType: "Encounter", entityId: enc.id, metadata: { tests: orders.length, visitType: enc.type, priority: prio } });
      await this.announce(tx, ctx, made, nurseId);
      return { encounterId: enc.id, visitType: enc.type, priority: prio, routedToLab: toLab, nurseAssigned: nurseId, tests: orders.map((o) => ({ testOrderId: o.id, name: o.name, category: o.category })) };
    };
    return outer ? run(outer) : this.prisma.$transaction(run);
  }

  // ───── reception: outpatient requests ─────

  /** The price list amount of each test (with tax), by price-list item, as shown to reception before the patient pays. */
  private async priceOf(db: Db | PrismaService, ctx: RequestContext, serviceIds: string[]): Promise<Map<string, string>> {
    if (serviceIds.length === 0) return new Map();
    const rows = await db.service.findMany({ where: { tenantId: ctx.tenantId, id: { in: serviceIds } }, select: { id: true, price: true, taxPercent: true } });
    return new Map(rows.map((s) => [s.id, fmt(computeLine({ quantity: 1, unitPrice: s.price.toString(), discountAmount: 0, taxPercent: s.taxPercent.toString() }).total)]));
  }

  /** OPD tests the doctor advised that nobody has launched yet, newest first, for reception. */
  async pending(ctx: RequestContext, q: z.infer<typeof pendingSchema>) {
    const text = q.q?.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
    const where: Prisma.TestOrderWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: { in: ["LABORATORY", "RADIOLOGY"] }, status: { in: ["ORDERED", "BILLED"] }, limsRequest: { is: null },
      encounter: { type: "OPD", status: { not: "CANCELLED" } }, createdAt: { gte: new Date(Date.now() - 14 * 86_400_000) },
      ...(text ? { OR: [{ patient: { searchName: { contains: text } } }, { patient: { identifiers: { some: { type: "MRN" as const, value: { contains: q.q!, mode: "insensitive" as const } } } } }, { patient: { mobile: { contains: q.q!.replace(/\D/g, "") || "#" } } }] } : {}),
    };
    const rows = await this.prisma.testOrder.findMany({
      where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 300,
      select: {
        id: true, name: true, category: true, status: true, serviceId: true, createdAt: true, encounterId: true,
        patient: { select: { id: true, firstName: true, lastName: true, mobile: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } },
        encounter: { select: { id: true, encounterNumber: true, practitioner: { select: { displayName: true } } } },
      },
    });
    const serviceIds = [...new Set(rows.map((r) => r.serviceId).filter((x): x is string => !!x))];
    const prices = await this.priceOf(this.prisma, ctx, serviceIds);
    const defs = serviceIds.length ? await this.prisma.labTestDefinition.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, serviceId: { in: serviceIds }, status: "ACTIVE" }, select: { serviceId: true, instructions: true, specimen: true, turnaroundHours: true } }) : [];
    const defOf = new Map(defs.map((d) => [d.serviceId, d]));
    const depts = await this.ensureDepartments(this.prisma, ctx.tenantId, ctx.facilityId);
    const byEncounter = new Map<string, { encounterId: string; visitNumber: string; doctor: string | null; patient: { id: string; name: string; mrn: string | null; hasMobile: boolean }; orderedAt: Date; tests: { testOrderId: string; name: string; department: DepartmentKind; billed: boolean; amount: string | null; instructions: string | null; specimen: string | null }[] }>();
    for (const r of rows) {
      const kind = departmentKindOf(r.category);
      if (!kind) continue;
      const g = byEncounter.get(r.encounterId) ?? { encounterId: r.encounterId, visitNumber: r.encounter.encounterNumber, doctor: r.encounter.practitioner?.displayName ?? null, patient: { id: r.patient.id, name: nameOf(r.patient), mrn: r.patient.identifiers[0]?.value ?? null, hasMobile: /^[6-9]\d{9}$/.test((r.patient.mobile ?? "").replace(/\D/g, "").slice(-10)) }, orderedAt: r.createdAt, tests: [] };
      const d = r.serviceId ? defOf.get(r.serviceId) : undefined;
      g.tests.push({ testOrderId: r.id, name: r.name, department: kind, billed: r.status === "BILLED", amount: r.serviceId ? prices.get(r.serviceId) ?? null : null, instructions: d?.instructions ?? depts.find((x) => x.kind === kind)?.defaultInstructions ?? null, specimen: d?.specimen ?? null });
      byEncounter.set(r.encounterId, g);
    }
    return [...byEncounter.values()];
  }

  /**
   * Reception launches an outpatient's tests after the patient agrees. Each test enters the laboratory queue; the patient is told when to come and what to do beforehand
   * (WhatsApp or SMS, and email when on); a nurse is asked to take the sample (the assigned one, else any).
   */
  async launch(ctx: RequestContext, input: z.infer<typeof launchSchema>) {
    const result = await this.prisma.$transaction(async (tx) => {
      const enc = await tx.encounter.findFirst({ where: { id: input.encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, type: true, status: true, patientId: true } });
      if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (enc.type !== "OPD") throw new DomainError("INVALID_STATE", "Only outpatient tests are launched at reception. An admitted patient's tests go to the laboratory when the doctor orders them", 409);
      if (enc.status === "CANCELLED") throw new DomainError("INVALID_STATE", "This visit was cancelled", 409);
      if (input.scheduledFor && input.scheduledFor.getTime() < Date.now() - 5 * 60_000) throw new DomainError("VALIDATION_FAILED", "The time to come cannot be in the past", 400);
      const ids = [...new Set(input.testOrderIds)];
      const orders = await tx.testOrder.findMany({ where: { id: { in: ids }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: enc.id }, select: { id: true, category: true, serviceId: true, status: true, limsRequest: { select: { id: true } } } });
      if (orders.length !== ids.length) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      for (const o of orders) {
        if (o.limsRequest) throw new DomainError("CONFLICT", "One of these tests has already been launched", 409);
        if (o.status === "CANCELLED") throw new DomainError("INVALID_STATE", "One of these tests was cancelled", 409);
        if (!departmentKindOf(o.category)) throw new DomainError("VALIDATION_FAILED", "Only laboratory and imaging tests are launched here", 400);
      }
      return this.launchCore(tx, ctx, enc, orders, input, "LIMS_OPD_LAUNCHED");
    });
    return { ...result, messages: await this.messages.forBatch(ctx, result.batchId) };
  }

  /** The part of launching that reception's two routes share: priority, nurse, one request per test, the history, the audit, the nurse's notice and the patient's message. */
  private async launchCore(
    tx: Db, ctx: RequestContext, enc: { id: string; patientId: string }, orders: { id: string; category: TestCategory; serviceId: string | null }[],
    input: { priority: LimsPriority; scheduledFor?: Date | undefined; assignedNurseId?: string | undefined; instructions?: string | undefined; consentMode: "VERBAL" | "WRITTEN"; clinicalNote?: string | null | undefined },
    action: "LIMS_OPD_LAUNCHED" | "LIMS_OPD_BOOKED",
  ) {
    if (input.priority !== "ROUTINE" && !ctx.permissions.has("LIMS_PRIORITY")) throw new DomainError("FORBIDDEN", "You may not mark a test urgent or emergency", 403);
    if (input.assignedNurseId && !(await this.userHas(tx, ctx, input.assignedNurseId, "LIMS_COLLECT"))) throw new DomainError("VALIDATION_FAILED", "That person cannot take samples at this facility", 400);
    // The date comes from the lab load (docs/lims-portal.md): when nobody chose a time, the patient is given the first hour in which every department needed has room.
    // Taken under a lock so two receptionists booking at once do not both take the last place.
    let when = input.scheduledFor ?? null;
    let autoScheduled = false;
    if (!when && input.priority !== "EMERGENCY") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`lims-slot:${ctx.facilityId}`}, 0))`;
      const need: Partial<Record<DepartmentKind, number>> = {};
      for (const o of orders) { const k = departmentKindOf(o.category); if (k) need[k] = (need[k] ?? 0) + 1; }
      when = (await this.schedule.suggest(tx, ctx, need, input.priority)).at;
      autoScheduled = true;
    }
    const batchId = randomUUID();
    const made: { id: string; priority: LimsPriority; requestNumber: string; department: DepartmentKind }[] = [];
    for (const o of orders) {
      const r = await this.createRequest(tx, ctx, { testOrderId: o.id, category: o.category, serviceId: o.serviceId, patientId: enc.patientId, encounterId: enc.id, origin: "OPD" }, {
        batchId, priority: input.priority, scheduledFor: when, instructions: input.instructions ?? null, clinicalNote: input.clinicalNote ?? null, assignedNurseId: input.assignedNurseId ?? null, consent: "GIVEN",
      });
      made.push(r);
    }
    await this.audit.record(tx, actorOf(ctx), {
      action, entityType: "Encounter", entityId: enc.id,
      metadata: { tests: made.length, consent: "GIVEN", consentMode: input.consentMode, priority: input.priority, scheduledFor: when?.toISOString() ?? null, autoScheduled, nurseAssigned: !!input.assignedNurseId },
    });
    await this.announce(tx, ctx, made, input.assignedNurseId ?? null);
    await this.messages.queueScheduled(tx, ctx, enc.patientId, batchId);
    return { batchId, encounterId: enc.id, scheduledFor: when, autoScheduled, requests: made.map((m) => ({ id: m.id, requestNumber: m.requestNumber, department: m.department })) };
  }

  /**
   * Reception books tests for a patient who has no doctor's order (a patient who walks in with a request from outside, or asks for a test): the patient agrees, a
   * laboratory-only visit is opened (no doctor, no consultation; it is left out of the consultation reports), and the tests go straight into the queue and the patient is messaged.
   */
  async book(ctx: RequestContext, input: z.infer<typeof bookSchema>) {
    const result = await this.prisma.$transaction(async (tx) => {
      if (input.scheduledFor && input.scheduledFor.getTime() < Date.now() - 5 * 60_000) throw new DomainError("VALIDATION_FAILED", "The time to come cannot be in the past", 400);
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
      if (!patient) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
      const tests = await this.resolveTests(tx, ctx, input.tests);
      const encounterNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "OPD_VISIT");
      const opened = new Date();
      const enc = await tx.encounter.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: patient.id, encounterNumber, type: "OPD", status: "COMPLETED", startedAt: opened, endedAt: opened, labOnly: true, createdById: ctx.userId },
        select: { id: true, patientId: true },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "ENCOUNTER_OPENED", entityType: "Encounter", entityId: enc.id, metadata: { type: "OPD", encounterNumber, labOnly: true } });
      const orders: { id: string; category: TestCategory; serviceId: string | null }[] = [];
      for (const t of tests) {
        orders.push(await tx.testOrder.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId: enc.id, category: t.category, name: t.name, serviceId: t.serviceId, source: "RECEPTION", orderedById: ctx.userId }, select: { id: true, category: true, serviceId: true } }));
      }
      return this.launchCore(tx, ctx, enc, orders, { ...input, clinicalNote: input.referredBy ? `Referred by ${input.referredBy}` : null }, "LIMS_OPD_BOOKED");
    });
    return { ...result, messages: await this.messages.forBatch(ctx, result.batchId) };
  }

  // ───── the test list, grouped between the two departments ─────

  /** The investigations on the price list with the department that runs each (Pathology or Radiology), for choosing a test. */
  async catalogue(ctx: RequestContext, q: z.infer<typeof catalogueSchema>) {
    const rows = await this.prisma.service.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: "INVESTIGATION", status: "ACTIVE", ...(q.department ? { limsDepartment: q.department } : {}), ...(q.q ? { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { code: { contains: q.q, mode: "insensitive" } }] } : {}) },
      orderBy: { name: "asc" }, take: 500, select: { id: true, code: true, name: true, limsDepartment: true, price: true, taxPercent: true },
    });
    const defs = rows.length ? await this.prisma.labTestDefinition.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, serviceId: { in: rows.map((r) => r.id) }, status: "ACTIVE" }, select: { serviceId: true, specimen: true, instructions: true } }) : [];
    const by = new Map(defs.map((d) => [d.serviceId, d]));
    return rows.map((r) => ({ serviceId: r.id, code: r.code, name: r.name, department: r.limsDepartment ?? guessDepartment(r.name), amount: fmt(computeLine({ quantity: 1, unitPrice: r.price.toString(), discountAmount: 0, taxPercent: r.taxPercent.toString() }).total), specimen: by.get(r.id)?.specimen ?? null, instructions: by.get(r.id)?.instructions ?? null }));
  }

  /** The administrator or the pathologist moves a test to the other department. Requests already in the queue stay where they are. */
  async setGrouping(ctx: RequestContext, serviceId: string, input: z.infer<typeof groupingSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const svc = await tx.service.findFirst({ where: { id: serviceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: "INVESTIGATION" }, select: { id: true, name: true, limsDepartment: true } });
      if (!svc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await tx.service.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: svc.id } }, data: { limsDepartment: input.department } });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_TEST_GROUPING_CHANGED", entityType: "Service", entityId: svc.id, metadata: { test: svc.name, from: svc.limsDepartment ?? "NONE", to: input.department } });
      return { serviceId: svc.id, department: input.department };
    });
  }

  /** The patient does not want some tests done here: they are taken off with the reason. Tests already billed are reversed through billing, not here. */
  async decline(ctx: RequestContext, input: z.infer<typeof declineSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ids = [...new Set(input.testOrderIds)];
      const orders = await tx.testOrder.findMany({ where: { id: { in: ids }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: input.encounterId, encounter: { type: "OPD" } }, select: { id: true, status: true, limsRequest: { select: { id: true } } } });
      if (orders.length !== ids.length) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      for (const o of orders) {
        if (o.limsRequest) throw new DomainError("INVALID_STATE", "A test already in the laboratory is cancelled by the LIMS manager", 409);
        if (o.status !== "ORDERED") throw new DomainError("INVALID_STATE", "A test that is already billed or cancelled cannot be declined here", 409);
      }
      await tx.testOrder.updateMany({ where: { id: { in: ids }, tenantId: ctx.tenantId, status: "ORDERED" }, data: { status: "CANCELLED", cancelReason: `Patient did not agree: ${input.reason}` } });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_OPD_DECLINED", entityType: "Encounter", entityId: input.encounterId, metadata: { tests: ids.length, reason: input.reason } });
      return { declined: ids.length };
    });
  }

  // ───── queues and details ─────

  async list(ctx: RequestContext, q: z.infer<typeof listSchema>) {
    const statuses = q.status ? q.status.split(",").map((s) => s.trim()).filter(Boolean) : null;
    if (statuses && statuses.some((s) => !(LIMS_STATUSES as readonly string[]).includes(s))) throw new DomainError("VALIDATION_FAILED", "Unknown status", 400);
    const and: Prisma.LimsRequestWhereInput[] = [];
    if (q.mine) and.push({ OR: [{ assignedNurseId: ctx.userId }, { assignedTechId: ctx.userId }] });
    if (q.unassigned) and.push({ assignedTechId: null });
    if (q.recollect) and.push({ OR: [{ needsRecollection: true }, { recollectCount: { gt: 0 } }] });
    if (q.overdue) and.push({ status: { in: [...OPEN_STATUSES] }, dueAt: { lt: new Date() } });
    if (q.expected || q.arrived !== undefined) {
      const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
      const endOfToday = endOfLocalDay(localDateStr(new Date(), tz), tz);
      and.push({ origin: "OPD", status: "PENDING_COLLECTION", OR: [{ scheduledFor: null }, { scheduledFor: { lte: endOfToday } }], ...(q.arrived === undefined ? {} : { arrivedAt: q.arrived ? { not: null } : null }) });
    }
    if (q.q) {
      const text = q.q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
      and.push({ OR: [
        ...(text ? [{ patient: { searchName: { contains: text } } }] : []),
        { patient: { identifiers: { some: { type: "MRN" as const, value: { contains: q.q, mode: "insensitive" as const } } } } },
        { requestNumber: { contains: q.q, mode: "insensitive" } },
        { testOrder: { labSamples: { some: { accessionNumber: { contains: q.q, mode: "insensitive" } } } } },
        { testOrder: { radStudy: { is: { accessionNumber: { contains: q.q, mode: "insensitive" } } } } },
      ] });
    }
    const where: Prisma.LimsRequestWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...this.deptWhere(ctx, q.department), ...this.scopeWhere(ctx),
      ...(statuses ? { status: { in: statuses as LimsStatus[] } } : {}), ...(q.origin ? { origin: q.origin } : {}), ...(q.priority ? { priority: q.priority } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00+05:30`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999+05:30`) } : {}) } } : {}),
      ...(and.length ? { AND: and } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.limsRequest.findMany({ where, orderBy: [{ priority: "asc" }, { createdAt: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: LIST_SELECT }),
      this.prisma.limsRequest.count({ where }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: await this.views(this.prisma, ctx, rows) };
  }

  /** One request with its full history. */
  async detail(ctx: RequestContext, id: string) {
    const row = await this.prisma.limsRequest.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...this.deptWhere(ctx), ...this.scopeWhere(ctx) }, select: LIST_SELECT });
    if (!row) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const [events, exceptions, [view]] = await Promise.all([
      this.prisma.limsRequestEvent.findMany({ where: { tenantId: ctx.tenantId, requestId: id }, orderBy: [{ at: "asc" }, { id: "asc" }], take: 200 }),
      this.prisma.limsException.findMany({ where: { tenantId: ctx.tenantId, requestId: id }, orderBy: { raisedAt: "desc" }, take: 20 }),
      this.views(this.prisma, ctx, [row]),
    ]);
    const actorIds = [...new Set([...events.map((e) => e.actorUserId), ...exceptions.flatMap((x) => [x.raisedById, x.decidedById])].filter((x): x is string => !!x))];
    const names = new Map((actorIds.length ? await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: actorIds } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    return {
      ...view!,
      timeline: events.map((e) => ({ kind: e.kind, from: e.fromStatus, to: e.toStatus, at: e.at, by: e.actorUserId ? names.get(e.actorUserId) ?? null : null, note: e.note })),
      exceptions: exceptions.map((x) => ({ id: x.id, kind: x.kind, reason: x.reason, status: x.status, raisedAt: x.raisedAt, raisedBy: names.get(x.raisedById) ?? null, decidedAt: x.decidedAt, decidedBy: x.decidedById ? names.get(x.decidedById) ?? null : null, decisionNote: x.decisionNote })),
    };
  }

  /** The few facts needed to print an issued report. Reception holds neither LAB_READ nor RAD_READ, so this is not limited by department; it is limited to the facility and the caller's data scope. */
  async requestForPrint(ctx: RequestContext, id: string) {
    const r = await this.prisma.limsRequest.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...this.scopeWhere(ctx) }, select: { status: true, testOrderId: true, department: { select: { kind: true } } } });
    if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return { status: r.status, testOrderId: r.testOrderId, department: r.department.kind };
  }

  /** A visit's laboratory and imaging requests, for the doctor's screen. */
  async forEncounter(ctx: RequestContext, encounterId: string) {
    // The visit must exist in this hospital and facility, whatever the caller's data scope (a visit of another hospital looks like it does not exist).
    if (!(await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } }))) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    await assertEncounterVisible(this.prisma, ctx, encounterId);
    const rows = await this.prisma.limsRequest.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, ...this.deptWhere(ctx) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: LIST_SELECT, take: 100 });
    const views = await this.views(this.prisma, ctx, rows);
    // Tests ordered for an outpatient that have not been launched yet are listed too, so the doctor sees they are waiting at reception.
    const unlaunched = await this.prisma.testOrder.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, category: { in: ["LABORATORY", "RADIOLOGY"] }, status: { in: ["ORDERED", "BILLED"] }, limsRequest: { is: null } }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, category: true }, take: 50 });
    return {
      requests: views.map((v) => ({ id: v.id, requestNumber: v.requestNumber, test: v.test, department: v.department, status: v.status, priority: v.priority, dueAt: v.dueAt, delayed: v.delayed, released: v.status === "ISSUED" || v.status === "HANDED_OVER", critical: v.critical, testOrderId: v.testOrderId, needsRecollection: v.needsRecollection })),
      waitingAtReception: unlaunched.map((o) => ({ testOrderId: o.id, test: o.name, department: departmentKindOf(o.category) })),
    };
  }

  /** People who can be given work: nurses who take samples, and each department's technicians. */
  async staff(ctx: RequestContext, q: z.infer<typeof staffSchema>) {
    const base = { tenantId: ctx.tenantId, status: "ACTIVE" as const, isService: false, facilities: { some: { facilityId: ctx.facilityId } } };
    const withPerm = (p: Permission): Prisma.UserWhereInput => ({ ...base, roles: { some: { role: { permissions: { some: { permission: p } } } } } });
    const [nurses, path, rad, issuers] = await Promise.all([
      this.prisma.user.findMany({ where: withPerm("LIMS_COLLECT"), select: { id: true, fullName: true }, orderBy: { fullName: "asc" }, take: 200 }),
      this.prisma.user.findMany({ where: withPerm(DEPARTMENT_PERMISSIONS.PATHOLOGY.work), select: { id: true, fullName: true }, orderBy: { fullName: "asc" }, take: 200 }),
      this.prisma.user.findMany({ where: withPerm(DEPARTMENT_PERMISSIONS.RADIOLOGY.work), select: { id: true, fullName: true }, orderBy: { fullName: "asc" }, take: 200 }),
      this.prisma.user.findMany({ where: withPerm("LIMS_ISSUE"), select: { id: true } , take: 500 }),
    ]);
    const issuing = new Set(issuers.map((u) => u.id));
    const techs = [...(q.department !== "RADIOLOGY" ? path.map((u) => ({ ...u, department: "PATHOLOGY" as const })) : []), ...(q.department !== "PATHOLOGY" ? rad.map((u) => ({ ...u, department: "RADIOLOGY" as const })) : [])].filter((u) => issuing.has(u.id));
    return { nurses, technicians: techs };
  }

  // ───── the steps ─────

  private async load(db: Db, ctx: RequestContext, id: string): Promise<RequestRow> {
    return this.core.byId(db, ctx, id);
  }

  private done(r: { id: string; requestNumber?: string }, status: LimsStatus) { return { id: r.id, status }; }

  /** The nurse took the sample (laboratory) or got the patient ready (radiology). */
  async collect(ctx: RequestContext, id: string, input: z.infer<typeof collectRequestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      if (req.status !== "PENDING_COLLECTION") throw new DomainError("INVALID_STATE", "This request is not waiting for a sample", 409);
      if (req.department.kind === "PATHOLOGY") await this.lab.collectIn(tx, ctx, req.testOrderId, { notes: input.notes });
      else await this.core.afterSampleCollected(tx, ctx, req.testOrderId);
      return this.done(req, "COLLECTED");
    });
  }

  /** The laboratory technician accepts the sample that arrived. (A radiographer performs the scan instead.) */
  async accept(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      if (req.department.kind !== "PATHOLOGY") throw new DomainError("INVALID_STATE", "A scan is accepted by performing it", 409);
      this.need(ctx, req.department.kind, "work");
      await this.core.afterAccepted(tx, ctx, req, "ACCEPTED");
      return this.done(req, "IN_PROCESS");
    });
  }

  /** The radiology technician performs the scan: this accepts the request and creates the study. */
  async perform(ctx: RequestContext, id: string, input: z.infer<typeof performSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      if (req.department.kind !== "RADIOLOGY") throw new DomainError("INVALID_STATE", "Only imaging tests are performed as scans", 409);
      this.need(ctx, req.department.kind, "work");
      const study = await this.rad.performIn(tx, ctx, req.testOrderId, input);
      return { ...this.done(req, "IN_PROCESS"), studyId: study.id, accessionNumber: study.accessionNumber };
    });
  }

  /** The technician cannot use the sample (or the patient was not prepared): it goes back for another with the reason. */
  async rejectSample(ctx: RequestContext, id: string, input: z.infer<typeof rejectSampleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      this.need(ctx, req.department.kind, "work");
      if (req.department.kind === "PATHOLOGY") {
        const sample = await tx.labSample.findFirst({ where: { tenantId: ctx.tenantId, testOrderId: req.testOrderId, status: "COLLECTED" }, select: { id: true } });
        if (!sample) throw new DomainError("INVALID_STATE", "There is no sample to reject", 409);
        await this.lab.rejectSampleIn(tx, ctx, sample.id, input);
      } else {
        if (req.status !== "COLLECTED") throw new DomainError("INVALID_STATE", "Only a patient who has not been scanned yet can be sent back", 409);
        await this.core.afterSampleRejected(tx, ctx, req.testOrderId, input.reason);
      }
      return this.done(req, "PENDING_COLLECTION");
    });
  }

  /** The technician sends the finished work to the pathologist or radiologist. */
  async submit(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      const kind = req.department.kind;
      this.need(ctx, kind, "work");
      if (req.status !== "IN_PROCESS") throw new DomainError("INVALID_STATE", "Only work in progress can be sent for review", 409);
      if (kind === "PATHOLOGY") await this.lab.assertDraftReady(tx, ctx, req.testOrderId);
      else if ((await tx.radStudy.count({ where: { tenantId: ctx.tenantId, testOrderId: req.testOrderId, status: "PERFORMED" } })) === 0) throw new DomainError("INVALID_STATE", "Perform the scan first", 409);
      await this.core.transition(tx, ctx, req, "PENDING_REVIEW", "SUBMITTED", { submittedAt: new Date(), submittedById: ctx.userId });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_SENT_FOR_REVIEW", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, department: kind } });
      await this.core.notify(tx, ctx, await this.core.specialistsOf(tx, ctx, kind), "LIMS_REVIEW_WAITING", req, String(req.returnedCount));
      return this.done(req, "PENDING_REVIEW");
    });
  }

  /** The pathologist or radiologist sends the work back to the technician with the reason. (Passing it is done by verifying or signing the report.) */
  async returnToTech(ctx: RequestContext, id: string, input: z.infer<typeof reasonSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      this.need(ctx, req.department.kind, "review");
      if (req.status !== "PENDING_REVIEW") throw new DomainError("INVALID_STATE", "Only work waiting for review can be sent back", 409);
      await this.core.transition(tx, ctx, req, "IN_PROCESS", "RETURNED", { returnedCount: { increment: 1 }, submittedAt: null, submittedById: null }, input.reason);
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_RETURNED_TO_TECH", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, department: req.department.kind, reason: input.reason } });
      const to = req.assignedTechId ? [req.assignedTechId] : await this.core.techsOf(tx, ctx, req.department.kind);
      await this.core.notify(tx, ctx, to, "LIMS_ASSIGNED", req, `returned${req.returnedCount + 1}`);
      return this.done(req, "IN_PROCESS");
    });
  }

  /** The technician issues a report the pathologist or radiologist has passed: the doctor sees it, and an outpatient is told it is ready at reception. */
  async issue(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      this.need(ctx, req.department.kind, "work");
      if (req.status !== "PASSED") throw new DomainError("INVALID_STATE", "Only a report that has been passed can be issued", 409);
      const reported = req.department.kind === "PATHOLOGY"
        ? await tx.labResult.count({ where: { tenantId: ctx.tenantId, testOrderId: req.testOrderId, status: "VERIFIED" } })
        : await tx.radStudy.count({ where: { tenantId: ctx.tenantId, testOrderId: req.testOrderId, status: "REPORTED" } });
      if (reported === 0) throw new DomainError("INVALID_STATE", "The report has not been signed yet", 409);
      await this.core.transition(tx, ctx, req, "ISSUED", "ISSUED", { issuedAt: new Date(), issuedById: ctx.userId });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_REPORT_ISSUED", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, department: req.department.kind, origin: req.origin } });
      const doctor = await this.notifications.doctorOfEncounter(tx, ctx.tenantId, req.encounterId);
      if (doctor) await this.core.notify(tx, ctx, [doctor], "LIMS_REPORT_ISSUED", req, "v1");
      // An admitted patient's test is charged to the admission now that the report is out (the final bill takes it from there).
      if (req.origin === "IPD") await this.billing.chargeAdmitted(tx, ctx, req);
      // An emergency patient's test goes on the emergency bill (or, once the patient has been sent to the OT or ICU, on the admission).
      if (req.origin === "EMERGENCY") await this.billing.chargeEmergency(tx, ctx, req);
      if (req.origin === "OPD") await this.messages.queueReportReady(tx, ctx, req.patientId, req.batchId);
      return this.done(req, "ISSUED");
    });
  }

  /** Reception gives the report to the patient (or a person they sent). */
  async handover(ctx: RequestContext, id: string, input: z.infer<typeof handoverSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      if (req.origin !== "OPD") throw new DomainError("INVALID_STATE", "An admitted patient's report goes to the doctor, not to reception", 409);
      if (req.status !== "ISSUED") throw new DomainError("INVALID_STATE", "Only an issued report can be handed over", 409);
      await this.core.transition(tx, ctx, req, "HANDED_OVER", "HANDED_OVER", { handedOverAt: new Date(), handedOverById: ctx.userId, handedOverTo: input.receivedBy }, `to ${input.receivedBy}`);
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_REPORT_HANDED_OVER", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber } });
      return this.done(req, "HANDED_OVER");
    });
  }

  /** The LIMS manager cancels a request that has not reached review. */
  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof reasonSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      if (!["PENDING_COLLECTION", "COLLECTED", "IN_PROCESS"].includes(req.status)) throw new DomainError("INVALID_STATE", "A request that has reached review cannot be cancelled", 409);
      await this.core.transition(tx, ctx, req, "CANCELLED", "CANCELLED", { cancelledAt: new Date(), cancelReason: input.reason }, input.reason);
      // The doctor's order is closed with it, unless it has been billed (that is reversed through billing).
      await tx.testOrder.updateMany({ where: { id: req.testOrderId, tenantId: ctx.tenantId, status: "ORDERED" }, data: { status: "CANCELLED", cancelReason: `Cancelled in the laboratory: ${input.reason}` } });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_REQUEST_CANCELLED", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, reason: input.reason } });
      return this.done(req, "CANCELLED");
    });
  }

  /** Marks a request urgent or emergency (it moves up the queue), or lowers it again (manager only). */
  async setPriority(ctx: RequestContext, id: string, input: z.infer<typeof prioritySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      await assertEncounterVisible(tx, ctx, req.encounterId);
      if (!["PENDING_COLLECTION", "COLLECTED", "IN_PROCESS", "PENDING_REVIEW"].includes(req.status)) throw new DomainError("INVALID_STATE", "The priority of a finished request cannot be changed", 409);
      if (req.priority === input.priority) return { id: req.id, priority: req.priority };
      const lowering = PRIORITY_RANK[input.priority] > PRIORITY_RANK[req.priority];
      if (lowering && !ctx.permissions.has("LIMS_MANAGE")) throw new DomainError("FORBIDDEN", "Only the LIMS manager can lower a priority", 403);
      const full = await tx.limsRequest.findFirstOrThrow({ where: { id: req.id, tenantId: ctx.tenantId }, select: { createdAt: true, scheduledFor: true, dueAt: true, testOrder: { select: { serviceId: true } }, department: { select: { routineTatMinutes: true, urgentTatMinutes: true, emergencyTatMinutes: true } } } });
      const def = full.testOrder.serviceId ? await tx.labTestDefinition.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, serviceId: full.testOrder.serviceId, status: "ACTIVE" }, select: { turnaroundHours: true } }) : null;
      const target = targetMinutes(full.department, input.priority, def?.turnaroundHours);
      const now = new Date();
      // Raising starts the shorter clock from now (never later than the old due time); lowering goes back to the clock from the start.
      const dueAt = lowering ? new Date(Math.max(addMinutes(clockStart(full), target).getTime(), now.getTime())) : new Date(Math.min(full.dueAt.getTime(), addMinutes(now, target).getTime()));
      const res = await tx.limsRequest.updateMany({ where: { id: req.id, tenantId: ctx.tenantId, version: req.version }, data: { priority: input.priority, dueAt, version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "This request was changed by someone else. Reload it first", 409);
      await this.core.event(tx, ctx.tenantId, req.id, "PRIORITY_CHANGED", ctx.userId, { note: `${req.priority.toLowerCase()} to ${input.priority.toLowerCase()}${input.reason ? `: ${input.reason}` : ""}` });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_PRIORITY_CHANGED", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, from: req.priority, to: input.priority, ...(input.reason ? { reason: input.reason } : {}) } });
      if (!lowering && input.priority === "EMERGENCY") await this.announce(tx, ctx, req.status === "PENDING_COLLECTION" ? [{ id: req.id, priority: "EMERGENCY" }] : [], req.assignedNurseId);
      return { id: req.id, priority: input.priority, dueAt };
    });
  }

  /** The LIMS manager gives the work to a nurse (to take the sample) or a technician. */
  async assign(ctx: RequestContext, id: string, input: z.infer<typeof assignSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.load(tx, ctx, id);
      if (!OPEN_STATUSES.includes(req.status)) throw new DomainError("INVALID_STATE", "A finished request cannot be assigned", 409);
      const data: Prisma.LimsRequestUncheckedUpdateManyInput = {};
      const notes: string[] = [];
      if (input.nurseId !== undefined) {
        if (req.status !== "PENDING_COLLECTION") throw new DomainError("INVALID_STATE", "The sample has already been taken", 409);
        if (input.nurseId && !(await this.userHas(tx, ctx, input.nurseId, "LIMS_COLLECT"))) throw new DomainError("VALIDATION_FAILED", "That person cannot take samples at this facility", 400);
        data.assignedNurseId = input.nurseId;
        notes.push(input.nurseId ? "nurse assigned" : "nurse unassigned");
      }
      if (input.techId !== undefined) {
        if (input.techId) {
          const ok = (await this.userHas(tx, ctx, input.techId, DEPARTMENT_PERMISSIONS[req.department.kind].work)) && (await this.userHas(tx, ctx, input.techId, "LIMS_ISSUE"));
          if (!ok) throw new DomainError("VALIDATION_FAILED", "That person is not a technician of this department", 400);
        }
        data.assignedTechId = input.techId;
        notes.push(input.techId ? "technician assigned" : "technician unassigned");
      }
      const res = await tx.limsRequest.updateMany({ where: { id: req.id, tenantId: ctx.tenantId, version: req.version }, data: { ...data, version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "This request was changed by someone else. Reload it first", 409);
      if (input.nurseId !== undefined) await this.core.event(tx, ctx.tenantId, req.id, "NURSE_ASSIGNED", ctx.userId, { note: input.nurseId ? undefined : "unassigned" });
      if (input.techId !== undefined) await this.core.event(tx, ctx.tenantId, req.id, "TECH_ASSIGNED", ctx.userId, { note: input.techId ? undefined : "unassigned" });
      await this.audit.record(tx, actorOf(ctx), { action: "LIMS_REQUEST_ASSIGNED", entityType: "LimsRequest", entityId: req.id, metadata: { requestNumber: req.requestNumber, changes: notes.join(", ") } });
      const tag = `${req.version + 1}`;
      if (input.nurseId) await this.core.notify(tx, ctx, [input.nurseId], "LIMS_ASSIGNED", req, `nurse${tag}`);
      if (input.techId) await this.core.notify(tx, ctx, [input.techId], "LIMS_ASSIGNED", req, `tech${tag}`);
      return { id: req.id, assignedNurseId: input.nurseId === undefined ? req.assignedNurseId : input.nurseId, assignedTechId: input.techId === undefined ? req.assignedTechId : input.techId };
    });
  }
}
