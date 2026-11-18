import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { DomainError } from "@medos/shared";
import { rejectSampleSchema } from "../lab/lab.service";
import { PrintService } from "../print/print.service";
import { sendRendered } from "../print/print.controller";
import { performSchema } from "../radiology/radiology.service";
import { receptionChargesSchema, arriveSchema, LimsBillingService } from "./lims-billing.service";
import { LimsInsightsService, rangeSchema } from "./lims-insights.service";
import { LimsMessagesService, notifySchema } from "./lims-messages.service";
import { availabilitySchema, LimsScheduleService, pressureSchema } from "./lims-schedule.service";
import {
  departmentSchema, exceptionDecisionSchema, exceptionListSchema, exceptionSchema, instrumentSchema, instrumentUpdateSchema, LimsOpsService, qcListSchema, qcReviewSchema, qcSchema,
} from "./lims-ops.service";
import {
  assignSchema, bookSchema, catalogueSchema, collectRequestSchema, declineSchema, groupingSchema, handoverSchema, launchSchema, LimsService, listSchema, orderSchema, pendingSchema, prioritySchema, reasonSchema, staffSchema,
} from "./lims.service";

const kindParam = z.enum(["PATHOLOGY", "RADIOLOGY"]);
const formatQuery = z.object({ format: z.enum(["html", "pdf"]).default("html"), download: z.enum(["0", "1"]).default("0") }).strict();

/**
 * The LIMS portal (docs/lims-portal.md): the laboratory floor for the LIMS manager, the two technicians, the pathologist and the radiologist, the nurse who takes samples,
 * reception's outpatient requests, and the doctor's orders. Each route names the permission it needs; the department-specific steps also check the department's own permission.
 */
@Controller()
export class LimsController {
  constructor(
    private readonly lims: LimsService, private readonly insights: LimsInsightsService, private readonly ops: LimsOpsService, private readonly messages: LimsMessagesService, private readonly schedule: LimsScheduleService,
    private readonly print: PrintService, private readonly batchBillingSvc: LimsBillingService,
  ) {}

  // ───── overview ─────

  @RequirePermissions("LIMS_READ")
  @Get("lims/status")
  async status(@Ctx() ctx: RequestContext) { return { data: await this.messages.status(ctx) }; }

  @RequirePermissions("LIMS_READ")
  @Get("lims/dashboard")
  async dashboard(@Ctx() ctx: RequestContext) { return { data: await this.insights.dashboard(ctx) }; }

  @RequirePermissions("LIMS_REPORTS")
  @Get("lims/reports/performance")
  async performance(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.insights.performance(ctx, parse(rangeSchema, query)) }; }

  @RequirePermissions("LIMS_REPORTS")
  @Get("lims/reports/billing")
  async billing(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.insights.billing(ctx, parse(rangeSchema, query)) }; }

  // ───── departments ─────

  @RequirePermissions("LIMS_READ")
  @Get("lims/departments")
  async departments(@Ctx() ctx: RequestContext) { return { data: await this.lims.departments(ctx) }; }

  @RequirePermissions("LIMS_DEPARTMENTS")
  @Put("lims/departments/:kind")
  async saveDepartment(@Ctx() ctx: RequestContext, @Param("kind") kind: string, @Body() body: unknown) {
    return { data: await this.ops.saveDepartment(ctx, parse(kindParam, kind.toUpperCase()), parse(departmentSchema, body)) };
  }

  // ───── ordering and reception ─────

  @RequirePermissions("LIMS_ORDER")
  @Post("lims/orders")
  async order(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.lims.order(ctx, parse(orderSchema, body)) }; }

  // "Tests advised" (pending, launch, decline): switched off unless the facility turns LIMS_TESTS_ADVISED_ENABLED on. Kept, not deleted.
  @RequirePermissions("LIMS_REQUEST")
  @Feature("LIMS_TESTS_ADVISED_ENABLED")
  @Get("lims/opd/pending")
  async pending(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.lims.pending(ctx, parse(pendingSchema, query)) }; }

  @RequirePermissions("LIMS_REQUEST")
  @Feature("LIMS_TESTS_ADVISED_ENABLED")
  @Post("lims/opd/launch")
  async launch(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.lims.launch(ctx, parse(launchSchema, body)) }; }

  /** Reception books tests for a patient with no doctor's order: the patient agrees and the tests go straight into the queue. */
  /** The date and time an outpatient would be given now, and how busy each lab is today. */
  @RequirePermissions("LIMS_REQUEST")
  @Get("lims/opd/availability")
  async availability(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.schedule.availability(ctx, parse(availabilitySchema, query)) }; }

  /** For the LIMS manager, the administrator and the manager: how full each lab is, day by day. */
  @RequirePermissions("LIMS_REPORTS")
  @Get("lims/reports/pressure")
  async pressure(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.schedule.pressure(ctx, parse(pressureSchema, query)) }; }

  /**
   * Send this booking's email, SMS and WhatsApp now and say, for each, whether it went (the screen shows them as three pop-ups). `SCHEDULED` after registering the patient
   * for tests; `REPORT_READY` when the reports are ready to hand over.
   */
  @RequireAnyPermission("LIMS_REQUEST", "LIMS_ISSUE")
  @Post("lims/batches/:batchId/notify")
  @HttpCode(200)
  async notify(@Ctx() ctx: RequestContext, @Param("batchId") batchId: string, @Body() body: unknown) { return { data: await this.messages.notifyNow(ctx, id(batchId), parse(notifySchema, body).kind) }; }

  /** The cashier's ledger: the laboratory charges reception took when patients reported (today, or `?date=`), with the day's totals. */
  @RequireAnyPermission("TEST_BILL", "LEDGER_READ", "LIMS_REPORTS")
  @Get("lims/reception-charges")
  async receptionCharges(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.batchBillingSvc.receptionCharges(ctx, parse(receptionChargesSchema, query)) }; }

  /** What a booking costs, what the patient has paid or left in advance, and what is still to collect. */
  @RequireAnyPermission("LIMS_REQUEST", "LIMS_REPORTS")
  @Get("lims/batches/:batchId/billing")
  async batchBilling(@Ctx() ctx: RequestContext, @Param("batchId") batchId: string) { return { data: await this.batchBillingSvc.view(ctx, id(batchId)) }; }

  /** The patient has reported at reception: the tests are billed, the advance is used, the rest is taken, and the nurse can take the sample. */
  @RequirePermissions("LIMS_REQUEST", "PAYMENT_CREATE")
  @Post("lims/batches/:batchId/arrive")
  async arrive(@Ctx() ctx: RequestContext, @Param("batchId") batchId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.batchBillingSvc.arrive(ctx, id(batchId), parse(arriveSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("LIMS_REQUEST")
  @Post("lims/opd/book")
  async book(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.lims.book(ctx, parse(bookSchema, body)) }; }

  /** The test list with the department that runs each test, for choosing tests to order or book. */
  @RequireAnyPermission("LIMS_ORDER", "LIMS_REQUEST", "LIMS_MANAGE", "LIMS_DEPARTMENTS", "LAB_MASTERS")
  @Get("lims/catalogue")
  async catalogue(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.lims.catalogue(ctx, parse(catalogueSchema, query)) }; }

  /** Moves a test between Pathology and Radiology. */
  @RequireAnyPermission("LIMS_DEPARTMENTS", "LAB_MASTERS")
  @Put("lims/catalogue/:serviceId")
  async setGrouping(@Ctx() ctx: RequestContext, @Param("serviceId") serviceId: string, @Body() body: unknown) { return { data: await this.lims.setGrouping(ctx, id(serviceId), parse(groupingSchema, body)) }; }

  @RequirePermissions("LIMS_REQUEST")
  @Feature("LIMS_TESTS_ADVISED_ENABLED")
  @Post("lims/opd/decline")
  @HttpCode(200)
  async decline(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.lims.decline(ctx, parse(declineSchema, body)) }; }

  @RequireAnyPermission("LIMS_ASSIGN", "LIMS_REQUEST")
  @Get("lims/staff")
  async staff(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.lims.staff(ctx, parse(staffSchema, query)) }; }

  // ───── requests ─────

  @RequirePermissions("LIMS_READ")
  @Get("lims/requests")
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.lims.list(ctx, parse(listSchema, query)) }; }

  @RequirePermissions("LIMS_READ")
  @Get("lims/requests/:id")
  async detail(@Ctx() ctx: RequestContext, @Param("id") requestId: string) { return { data: await this.lims.detail(ctx, id(requestId)) }; }

  @RequirePermissions("LIMS_READ")
  @Get("encounters/:id/lims")
  async forEncounter(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.lims.forEncounter(ctx, id(encounterId)) }; }

  @RequirePermissions("LIMS_PRIORITY")
  @Post("lims/requests/:id/priority")
  @HttpCode(200)
  async priority(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.lims.setPriority(ctx, id(requestId), parse(prioritySchema, body)) }; }

  @RequirePermissions("LIMS_ASSIGN")
  @Post("lims/requests/:id/assign")
  @HttpCode(200)
  async assign(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.lims.assign(ctx, id(requestId), parse(assignSchema, body)) }; }

  @RequirePermissions("LIMS_COLLECT")
  @Post("lims/requests/:id/collect")
  @HttpCode(200)
  async collect(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.lims.collect(ctx, id(requestId), parse(collectRequestSchema, body ?? {})) }; }

  @RequirePermissions("LAB_RESULT")
  @Post("lims/requests/:id/accept")
  @HttpCode(200)
  async accept(@Ctx() ctx: RequestContext, @Param("id") requestId: string) { return { data: await this.lims.accept(ctx, id(requestId)) }; }

  @RequirePermissions("RAD_PERFORM")
  @Post("lims/requests/:id/perform")
  @HttpCode(200)
  async perform(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.lims.perform(ctx, id(requestId), parse(performSchema, body)) }; }

  @RequireAnyPermission("LAB_RESULT", "RAD_PERFORM")
  @Post("lims/requests/:id/reject-sample")
  @HttpCode(200)
  async rejectSample(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.lims.rejectSample(ctx, id(requestId), parse(rejectSampleSchema, body)) }; }

  @RequireAnyPermission("LAB_RESULT", "RAD_PERFORM")
  @Post("lims/requests/:id/submit")
  @HttpCode(200)
  async submit(@Ctx() ctx: RequestContext, @Param("id") requestId: string) { return { data: await this.lims.submit(ctx, id(requestId)) }; }

  @RequireAnyPermission("LAB_VERIFY", "RAD_REPORT")
  @Post("lims/requests/:id/return")
  @HttpCode(200)
  async returnToTech(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.lims.returnToTech(ctx, id(requestId), parse(reasonSchema, body)) }; }

  @RequirePermissions("LIMS_ISSUE")
  @Post("lims/requests/:id/issue")
  @HttpCode(200)
  async issue(@Ctx() ctx: RequestContext, @Param("id") requestId: string) { return { data: await this.lims.issue(ctx, id(requestId)) }; }

  @RequirePermissions("LIMS_REQUEST")
  @Post("lims/requests/:id/handover")
  @HttpCode(200)
  async handover(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.lims.handover(ctx, id(requestId), parse(handoverSchema, body)) }; }

  @RequirePermissions("LIMS_MANAGE")
  @Post("lims/requests/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.lims.cancel(ctx, id(requestId), parse(reasonSchema, body)) }; }

  /** The printed report of an issued request, for reception to hand to the patient. Only an issued report prints. */
  @RequireAnyPermission("LIMS_REQUEST", "LIMS_ISSUE", "LIMS_MANAGE")
  @Get("lims/requests/:id/report")
  async report(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    const found = await this.lims.requestForPrint(ctx, id(requestId));
    if (found.status !== "ISSUED" && found.status !== "HANDED_OVER") throw new DomainError("INVALID_STATE", "The report has not been issued yet", 409);
    const rendered = found.department === "PATHOLOGY" ? await this.print.labReport(ctx, found.testOrderId, q.format) : await this.print.radiologyReport(ctx, found.testOrderId, q.format);
    sendRendered(res, rendered, q.download === "1");
  }

  // ───── instruments and quality control ─────

  @RequirePermissions("LIMS_READ")
  @Get("lims/instruments")
  async instruments(@Ctx() ctx: RequestContext) { return { data: await this.ops.instruments(ctx) }; }

  @RequirePermissions("LIMS_MANAGE")
  @Post("lims/instruments")
  async createInstrument(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.ops.createInstrument(ctx, parse(instrumentSchema, body)) }; }

  @RequirePermissions("LIMS_MANAGE")
  @Put("lims/instruments/:id")
  async updateInstrument(@Ctx() ctx: RequestContext, @Param("id") instrumentId: string, @Body() body: unknown) { return { data: await this.ops.updateInstrument(ctx, id(instrumentId), parse(instrumentUpdateSchema, body)) }; }

  @RequirePermissions("LIMS_READ")
  @Get("lims/qc")
  async qc(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.ops.qcList(ctx, parse(qcListSchema, query)) }; }

  @RequirePermissions("LIMS_QC")
  @Post("lims/qc")
  async recordQc(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.ops.recordQc(ctx, parse(qcSchema, body)) }; }

  @RequirePermissions("LIMS_MANAGE")
  @Post("lims/qc/:id/review")
  @HttpCode(200)
  async reviewQc(@Ctx() ctx: RequestContext, @Param("id") qcId: string, @Body() body: unknown) { return { data: await this.ops.reviewQc(ctx, id(qcId), parse(qcReviewSchema, body)) }; }

  // ───── exceptions ─────

  @RequireAnyPermission("LIMS_COLLECT", "LIMS_REQUEST", "LIMS_ISSUE", "LIMS_MANAGE")
  @Post("lims/exceptions")
  async raiseException(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.ops.raiseException(ctx, parse(exceptionSchema, body)) }; }

  @RequirePermissions("LIMS_READ")
  @Get("lims/exceptions")
  async exceptions(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.ops.exceptions(ctx, parse(exceptionListSchema, query)) }; }

  @RequirePermissions("LIMS_MANAGE")
  @Post("lims/exceptions/:id/decide")
  @HttpCode(200)
  async decide(@Ctx() ctx: RequestContext, @Param("id") exceptionId: string, @Body() body: unknown) { return { data: await this.ops.decideException(ctx, id(exceptionId), parse(exceptionDecisionSchema, body)) }; }
}
