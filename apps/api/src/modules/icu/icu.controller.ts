import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { dayNoteSchema, IcuService, instructionDoneSchema, instructionSchema, listStaysSchema, vitalsScheduleSchema } from "./icu.service";

/** The intensive care unit (docs/icu.md). Each route checks its permission here; the service checks the stay against the caller's tenant, facility and data scope. */
@Controller("icu")
export class IcuController {
  constructor(private readonly icu: IcuService) {}

  @RequirePermissions("ICU_READ")
  @Get("stays")
  async stays(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listStaysSchema, query);
    const { items, total } = await this.icu.stays(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  /** What the ICU nurse must act on now: vitals overdue and urgent instructions still open. */
  @RequirePermissions("ICU_READ")
  @Get("alerts")
  async alerts(@Ctx() ctx: RequestContext) { return { data: await this.icu.alerts(ctx) }; }

  @RequirePermissions("ICU_READ")
  @Get("stays/:id")
  async get(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) { return { data: await this.icu.get(ctx, id(admissionId)) }; }

  @RequirePermissions("ICU_DOCTOR")
  @Post("stays/:id/vitals-schedule")
  @HttpCode(200)
  async schedule(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) { return { data: await this.icu.setSchedule(ctx, id(admissionId), parse(vitalsScheduleSchema, body)) }; }

  @RequirePermissions("ICU_DOCTOR")
  @Post("stays/:id/instructions")
  @HttpCode(201)
  async instruct(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) { return { data: await this.icu.addInstruction(ctx, id(admissionId), parse(instructionSchema, body)) }; }

  @RequirePermissions("ICU_DOCTOR")
  @Post("stays/:id/notes")
  @HttpCode(201)
  async note(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) { return { data: await this.icu.addDayNote(ctx, id(admissionId), parse(dayNoteSchema, body)) }; }

  @RequirePermissions("ICU_NURSE")
  @Post("instructions/:id/done")
  @HttpCode(200)
  async done(@Ctx() ctx: RequestContext, @Param("id") instructionId: string, @Body() body: unknown) { return { data: await this.icu.completeInstruction(ctx, id(instructionId), parse(instructionDoneSchema, body ?? {})) }; }
}
