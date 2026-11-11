import { Controller, Get } from "@nestjs/common";
import { Ctx, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { OverviewService } from "./overview.service";

/** The hospital manager's read-only status overview (docs/manager-overview.md). Nothing here changes anything. */
@Controller("overview")
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @RequirePermissions("OVERVIEW_READ")
  @Get()
  async get(@Ctx() ctx: RequestContext) { return { data: await this.overview.get(ctx) }; }
}
