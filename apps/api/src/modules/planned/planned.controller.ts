import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, paginate, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { takeAdvanceSchema } from "../billing/advances.service";
import { PlannedCore } from "./planned.core";
import { estimateSchema, payerSchema, PlannedFinanceService, preauthSchema, requiredDepositSchema, waiveSchema } from "./planned-finance.service";
import { adviseSchema, bedSchema, cancelSchema, consentSchema, doctorSchema, listPlannedSchema, patientReadySchema, PlannedService, raiseSchema, rescheduleSchema, verifySchema } from "./planned.service";

/**
 * Planned admission (docs/planned-admission.md). Every route checks its permission here; the services check the request against the caller's hospital, facility and data scope,
 * the order of the steps, and (for the doctor's steps) that the request is the caller's own.
 */
@Controller()
export class PlannedController {
  constructor(private readonly planned: PlannedService, private readonly finance: PlannedFinanceService, private readonly core: PlannedCore) {}

  @RequirePermissions("PLANNED_READ")
  @Get("planned-admissions")
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listPlannedSchema, query);
    const { items, total } = await this.core.list(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("PLANNED_READ")
  @Get("planned-admissions/summary")
  async summary(@Ctx() ctx: RequestContext) { return { data: await this.core.summary(ctx) }; }

  @RequirePermissions("PLANNED_REQUEST")
  @Post("planned-admissions")
  @HttpCode(201)
  async raise(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.planned.raise(ctx, parse(raiseSchema, body)) }; }

  @RequirePermissions("PLANNED_READ")
  @Get("planned-admissions/:id")
  async get(@Ctx() ctx: RequestContext, @Param("id") planId: string) { return { data: await this.planned.get(ctx, id(planId)) }; }

  /** The OPD doctor's "needs admission" tick for a visit. */
  @RequirePermissions("PLANNED_DOCTOR")
  @Post("encounters/:id/planned-admission")
  @HttpCode(201)
  async advise(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) { return { data: await this.planned.advise(ctx, id(encounterId), parse(adviseSchema, body)) }; }

  @RequireAnyPermission("PLANNED_DOCTOR", "PLANNED_READ")
  @Get("encounters/:id/planned-admission")
  async forEncounter(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.planned.forEncounter(ctx, id(encounterId)) }; }

  @RequirePermissions("PLANNED_REQUEST")
  @Post("planned-admissions/:id/consent")
  @HttpCode(200)
  async consent(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.planned.consent(ctx, id(planId), parse(consentSchema, body)) }; }

  @RequirePermissions("PLANNED_DOCTOR")
  @Post("planned-admissions/:id/doctor")
  @HttpCode(200)
  async doctor(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.planned.decide(ctx, id(planId), parse(doctorSchema, body)) }; }

  @RequireAnyPermission("PLANNED_REQUEST", "PLANNED_DESK")
  @Post("planned-admissions/:id/patient-ready")
  @HttpCode(200)
  async patientReady(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.planned.patientReady(ctx, id(planId), parse(patientReadySchema, body ?? {})) }; }

  @RequirePermissions("PLANNED_DESK")
  @Post("planned-admissions/:id/verify")
  @HttpCode(200)
  async verify(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.planned.verify(ctx, id(planId), parse(verifySchema, body)) }; }

  @RequirePermissions("PLANNED_DESK")
  @Post("planned-admissions/:id/reschedule")
  @HttpCode(200)
  async reschedule(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.planned.reschedule(ctx, id(planId), parse(rescheduleSchema, body)) }; }

  // ───── billing and insurance ─────

  @RequirePermissions("PLANNED_BILLING")
  @Put("planned-admissions/:id/estimate")
  async estimate(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.finance.saveEstimate(ctx, id(planId), parse(estimateSchema, body)) }; }

  @RequireAnyPermission("PLANNED_BILLING", "PLANNED_INSURANCE")
  @Post("planned-admissions/:id/payer")
  @HttpCode(200)
  async payer(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.finance.setPayer(ctx, id(planId), parse(payerSchema, body)) }; }

  @RequireAnyPermission("PLANNED_BILLING", "PLANNED_INSURANCE")
  @Post("planned-admissions/:id/tariff-done")
  @HttpCode(200)
  async tariffDone(@Ctx() ctx: RequestContext, @Param("id") planId: string) { return { data: await this.finance.tariffDone(ctx, id(planId)) }; }

  @RequirePermissions("PLANNED_INSURANCE")
  @Post("planned-admissions/:id/preauth")
  @HttpCode(200)
  async preauth(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.finance.preauth(ctx, id(planId), parse(preauthSchema, body)) }; }

  @RequirePermissions("PLANNED_BILLING")
  @Put("planned-admissions/:id/deposit-required")
  async depositRequired(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.finance.setRequiredDeposit(ctx, id(planId), parse(requiredDepositSchema, body)) }; }

  @RequirePermissions("PLANNED_BILLING", "PAYMENT_CREATE")
  @Post("planned-admissions/:id/deposit")
  async deposit(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.finance.takeDeposit(ctx, id(planId), parse(takeAdvanceSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("PLANNED_APPROVE")
  @Post("planned-admissions/:id/waive")
  @HttpCode(200)
  async waive(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.finance.waive(ctx, id(planId), parse(waiveSchema, body)) }; }

  @RequirePermissions("PLANNED_BILLING")
  @Post("planned-admissions/:id/financial-check")
  @HttpCode(200)
  async financialCheck(@Ctx() ctx: RequestContext, @Param("id") planId: string) { return { data: await this.finance.financialCheck(ctx, id(planId)) }; }

  // ───── the bed, the day, and ending ─────

  @RequirePermissions("PLANNED_BED")
  @Post("planned-admissions/:id/bed")
  @HttpCode(200)
  async bed(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.planned.allocateBed(ctx, id(planId), parse(bedSchema, body)) }; }

  @RequirePermissions("PLANNED_DESK", "ADMISSION_CREATE")
  @Post("planned-admissions/:id/admit")
  @HttpCode(200)
  async admit(@Ctx() ctx: RequestContext, @Param("id") planId: string) { return { data: await this.planned.admit(ctx, id(planId)) }; }

  @RequireAnyPermission("PLANNED_DESK", "PLANNED_REQUEST", "PLANNED_DOCTOR")
  @Post("planned-admissions/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") planId: string, @Body() body: unknown) { return { data: await this.planned.cancel(ctx, id(planId), parse(cancelSchema, body)) }; }
}
