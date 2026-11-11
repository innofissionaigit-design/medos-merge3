import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { addChargeSchema, cancelEmergencySchema, decisionSchema, emergencyNoteSchema, EmergencyService, listEmergencySchema, registerEmergencySchema, triageSchema } from "./emergency.service";

/** The emergency ward (docs/emergency.md). Every route checks its permission here, and the service checks the case against the caller's tenant, facility and data scope. */
@Controller("emergency")
export class EmergencyController {
  constructor(private readonly emergency: EmergencyService) {}

  @RequirePermissions("ER_READ")
  @Get("cases")
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listEmergencySchema, query);
    const { items, total } = await this.emergency.list(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  /** The red alert: what this person has to act on now. */
  @RequirePermissions("ER_READ")
  @Get("alerts")
  async alerts(@Ctx() ctx: RequestContext) { return { data: await this.emergency.alerts(ctx) }; }

  @RequirePermissions("ER_REGISTER")
  @Get("doctors")
  async doctors(@Ctx() ctx: RequestContext) { return { data: await this.emergency.doctors(ctx) }; }

  @RequirePermissions("ER_TREAT")
  @Get("icu-doctors")
  async icuDoctors(@Ctx() ctx: RequestContext) { return { data: await this.emergency.icuDoctors(ctx) }; }

  @RequirePermissions("ER_READ")
  @Get("beds")
  async beds(@Ctx() ctx: RequestContext) { return { data: await this.emergency.beds(ctx) }; }

  @RequirePermissions("ER_REGISTER")
  @Post("cases")
  async register(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.emergency.register(ctx, parse(registerEmergencySchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("ER_READ")
  @Get("cases/:id")
  async get(@Ctx() ctx: RequestContext, @Param("id") caseId: string) { return { data: await this.emergency.get(ctx, id(caseId)) }; }

  @RequirePermissions("ER_TRIAGE")
  @Post("cases/:id/triage")
  @HttpCode(201)
  async triage(@Ctx() ctx: RequestContext, @Param("id") caseId: string, @Body() body: unknown) { return { data: await this.emergency.triage(ctx, id(caseId), parse(triageSchema, body)) }; }

  @RequirePermissions("ER_TREAT")
  @Post("cases/:id/accept")
  @HttpCode(200)
  async accept(@Ctx() ctx: RequestContext, @Param("id") caseId: string) { return { data: await this.emergency.accept(ctx, id(caseId)) }; }

  @RequirePermissions("ER_TREAT")
  @Post("cases/:id/notes")
  @HttpCode(201)
  async note(@Ctx() ctx: RequestContext, @Param("id") caseId: string, @Body() body: unknown) { return { data: await this.emergency.addNote(ctx, id(caseId), parse(emergencyNoteSchema, body)) }; }

  @RequirePermissions("ER_TREAT")
  @Post("cases/:id/decision")
  async decide(@Ctx() ctx: RequestContext, @Param("id") caseId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.emergency.decide(ctx, id(caseId), parse(decisionSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("ER_REGISTER")
  @Post("cases/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") caseId: string, @Body() body: unknown) { return { data: await this.emergency.cancel(ctx, id(caseId), parse(cancelEmergencySchema, body)) }; }

  @RequirePermissions("ER_BILL")
  @Post("cases/:id/bill/charges")
  @HttpCode(201)
  async addCharge(@Ctx() ctx: RequestContext, @Param("id") caseId: string, @Body() body: unknown) { return { data: await this.emergency.addCharge(ctx, id(caseId), parse(addChargeSchema, body)) }; }

  @RequirePermissions("ER_BILL")
  @Post("cases/:id/bill/issue")
  @HttpCode(200)
  async issueBill(@Ctx() ctx: RequestContext, @Param("id") caseId: string) { return { data: await this.emergency.issueBill(ctx, id(caseId)) }; }
}
