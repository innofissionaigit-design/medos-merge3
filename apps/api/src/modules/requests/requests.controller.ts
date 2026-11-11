import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { createRequestSchema, decideRequestSchema, listRequestsSchema, RequestsService } from "./requests.service";

/** Nurse requests for a test or a medicine (docs/emergency.md, docs/icu.md). The service checks the visit against the caller's tenant, facility, ward and data scope. */
@Controller("order-requests")
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @RequirePermissions("ORDER_REQUEST")
  @Post()
  @HttpCode(201)
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.requests.create(ctx, parse(createRequestSchema, body)) }; }

  @RequireAnyPermission("ORDER_REQUEST", "ER_TREAT", "ICU_DOCTOR")
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.requests.list(ctx, parse(listRequestsSchema, query)) }; }

  @RequireAnyPermission("ER_TREAT", "ICU_DOCTOR")
  @Post(":id/decision")
  @HttpCode(200)
  async decide(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.requests.decide(ctx, id(requestId), parse(decideRequestSchema, body)) }; }

  @RequirePermissions("ORDER_REQUEST")
  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") requestId: string) { return { data: await this.requests.cancel(ctx, id(requestId)) }; }
}
