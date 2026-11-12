import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { ProceduresService, procedureErrorSchema, procedureSchema } from "./procedures.service";
import { errorSchema, roundNoteSchema, RoundsService, slotSchema, slotUpdateSchema } from "./rounds.service";
import { WardBoardService } from "./ward-board.service";

const activitySchema = z.object({ limit: z.coerce.number().int().min(5).max(100).default(40) }).strict();

/** Ward rounds, the ward board and procedures (docs/ward-rounds.md). */
@Controller()
export class RoundsController {
  constructor(private readonly rounds: RoundsService, private readonly board: WardBoardService, private readonly procedures: ProceduresService) {}

  // ───── round times (the ward coordinator sets them; everyone who takes part can read them) ─────

  @RequireAnyPermission("ROUND_READ", "ROUND_MANAGE", "ROUND_DO", "WARD_BOARD_READ")
  @Get("rounds/slots")
  async slots(@Ctx() ctx: RequestContext) { return { data: await this.rounds.slots(ctx) }; }

  @RequirePermissions("ROUND_MANAGE")
  @Post("rounds/slots")
  @HttpCode(201)
  async createSlot(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.rounds.createSlot(ctx, parse(slotSchema, body)) }; }

  @RequirePermissions("ROUND_MANAGE")
  @Patch("rounds/slots/:id")
  async updateSlot(@Ctx() ctx: RequestContext, @Param("id") slotId: string, @Body() body: unknown) { return { data: await this.rounds.updateSlot(ctx, id(slotId), parse(slotUpdateSchema, body)) }; }

  // ───── the doctor's rounds ─────

  /** The doctor's own round times and today's rounds: what the doctor's profile shows. */
  @RequirePermissions("ROUND_DO")
  @Get("rounds/mine")
  async mine(@Ctx() ctx: RequestContext) { return { data: await this.rounds.myRounds(ctx) }; }

  @RequirePermissions("WARD_BOARD_READ")
  @Get("rounds/today")
  async today(@Ctx() ctx: RequestContext) { return { data: await this.rounds.todaysRounds(ctx) }; }

  @RequirePermissions("ROUND_DO")
  @Get("rounds/:id")
  async round(@Ctx() ctx: RequestContext, @Param("id") roundId: string) { return { data: await this.rounds.round(ctx, id(roundId)) }; }

  @RequirePermissions("ROUND_DO")
  @Post("rounds/:id/start")
  @HttpCode(200)
  async start(@Ctx() ctx: RequestContext, @Param("id") roundId: string) { return { data: await this.rounds.start(ctx, id(roundId)) }; }

  @RequirePermissions("ROUND_DO")
  @Post("rounds/:id/complete")
  @HttpCode(200)
  async complete(@Ctx() ctx: RequestContext, @Param("id") roundId: string) { return { data: await this.rounds.complete(ctx, id(roundId)) }; }

  @RequirePermissions("ROUND_DO")
  @Post("admissions/:id/round-notes")
  @HttpCode(201)
  async addNote(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) { return { data: await this.rounds.addNote(ctx, id(admissionId), parse(roundNoteSchema, body)) }; }

  @RequireAnyPermission("ADMISSION_READ", "ROUND_DO")
  @Get("admissions/:id/round-notes")
  async notes(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) { return { data: await this.rounds.notes(ctx, id(admissionId)) }; }

  @RequirePermissions("ROUND_DO")
  @Post("round-notes/:id/enter-in-error")
  @HttpCode(200)
  async noteError(@Ctx() ctx: RequestContext, @Param("id") noteId: string, @Body() body: unknown) { return { data: await this.rounds.enterInError(ctx, id(noteId), parse(errorSchema, body)) }; }

  // ───── the ward coordinator's board ─────

  @RequirePermissions("WARD_BOARD_READ")
  @Get("ward-board")
  async overview(@Ctx() ctx: RequestContext) { return { data: await this.board.overview(ctx) }; }

  @RequirePermissions("WARD_BOARD_READ")
  @Get("ward-board/activity")
  async activity(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.board.activity(ctx, parse(activitySchema, query).limit) }; }

  // ───── procedures ─────

  @RequireAnyPermission("ADMISSION_READ", "PROCEDURE_RECORD")
  @Get("admissions/:id/procedures")
  async listProcedures(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) { return { data: await this.procedures.list(ctx, id(admissionId)) }; }

  @RequirePermissions("PROCEDURE_RECORD")
  @Post("admissions/:id/procedures")
  @HttpCode(201)
  async recordProcedure(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) { return { data: await this.procedures.record(ctx, id(admissionId), parse(procedureSchema, body)) }; }

  @RequirePermissions("PROCEDURE_RECORD")
  @Post("procedures/:id/enter-in-error")
  @HttpCode(200)
  async procedureError(@Ctx() ctx: RequestContext, @Param("id") procedureId: string, @Body() body: unknown) { return { data: await this.procedures.enterInError(ctx, id(procedureId), parse(procedureErrorSchema, body)) }; }
}
