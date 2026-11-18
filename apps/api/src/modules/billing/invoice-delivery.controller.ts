import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Ctx, id, parse, Public, RateLimit, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { sendRendered } from "../print/print.controller";
import { InvoiceDeliveryService, sendBillSchema } from "./invoice-delivery.service";
import { OpdLedgerService, opdLedgerSchema } from "./opd-ledger.service";

const openQuery = z.object({ format: z.enum(["html", "pdf"]).default("html"), download: z.enum(["0", "1"]).default("0") }).strict();

/** Sending the patient the soft copy of a bill by email, WhatsApp or SMS (docs/bill-copy.md). Staff who may read bills can send, retry and see what happened. */
@Controller()
export class InvoiceDeliveryController {
  constructor(private readonly deliveries: InvoiceDeliveryService) {}

  @RequirePermissions("INVOICE_READ")
  @Get("invoice-deliveries/config")
  async config(@Ctx() ctx: RequestContext) { return { data: await this.deliveries.config_(ctx) }; }

  @RequirePermissions("INVOICE_READ")
  @Get("invoices/:id/deliveries")
  async list(@Ctx() ctx: RequestContext, @Param("id") invoiceId: string) { return { data: await this.deliveries.list(ctx, id(invoiceId)) }; }

  @RequirePermissions("INVOICE_READ")
  @RateLimit({ limit: 20, windowMs: 60_000, by: "session" })
  @Post("invoices/:id/deliveries")
  async send(@Ctx() ctx: RequestContext, @Param("id") invoiceId: string, @Body() body: unknown) { return { data: await this.deliveries.sendNow(ctx, id(invoiceId), parse(sendBillSchema, body ?? {})) }; }

  @RequirePermissions("INVOICE_READ")
  @RateLimit({ limit: 20, windowMs: 60_000, by: "session" })
  @Post("invoice-deliveries/:id/retry")
  @HttpCode(200)
  async retry(@Ctx() ctx: RequestContext, @Param("id") deliveryId: string) { return { data: await this.deliveries.retry(ctx, id(deliveryId)) }; }
}

/** The patient's side: opens with the secret link alone, no sign-in. Rate limited by address; a wrong, expired or revoked link all look the same. */
@Controller("public/bills")
export class PublicBillController {
  constructor(private readonly deliveries: InvoiceDeliveryService) {}

  @Public()
  @RateLimit({ limit: 30, windowMs: 60_000, by: "ip" })
  @Get(":token")
  async open(@Param("token") token: string, @Query() query: unknown, @Req() req: Request & { requestId?: string }, @Res() res: Response) {
    const q = parse(openQuery, query);
    sendRendered(res, await this.deliveries.open(token, q.format, req.requestId ?? "public"), q.download === "1");
  }
}

/** The cashier's ledger of the OPD visits reception took (docs/opd-ledger.md). */
@Controller()
export class OpdLedgerController {
  constructor(private readonly ledger: OpdLedgerService) {}

  @RequirePermissions("INVOICE_READ")
  @Get("opd-ledger")
  async day(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.ledger.day(ctx, parse(opdLedgerSchema, query)) }; }
}
