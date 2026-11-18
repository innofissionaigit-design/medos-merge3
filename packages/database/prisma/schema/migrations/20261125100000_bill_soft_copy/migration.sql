-- Soft copy of a bill sent to the patient after payment, by email, WhatsApp or SMS (docs/bill-copy.md).

CREATE TABLE "InvoiceShare" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "lastOpenedAt" TIMESTAMPTZ(3),
    CONSTRAINT "InvoiceShare_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InvoiceShare_tokenHash_key" ON "InvoiceShare"("tokenHash");
CREATE UNIQUE INDEX "InvoiceShare_tenantId_id_key" ON "InvoiceShare"("tenantId", "id");
CREATE INDEX "InvoiceShare_tenantId_invoiceId_createdAt_idx" ON "InvoiceShare"("tenantId", "invoiceId", "createdAt" DESC);
ALTER TABLE "InvoiceShare" ADD CONSTRAINT "InvoiceShare_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "InvoiceDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "shareId" UUID,
    "channel" TEXT NOT NULL,
    "toMask" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerName" TEXT,
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    CONSTRAINT "InvoiceDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InvoiceDelivery_tenantId_id_key" ON "InvoiceDelivery"("tenantId", "id");
CREATE UNIQUE INDEX "InvoiceDelivery_tenantId_dedupeKey_key" ON "InvoiceDelivery"("tenantId", "dedupeKey");
CREATE INDEX "InvoiceDelivery_status_nextAttemptAt_idx" ON "InvoiceDelivery"("status", "nextAttemptAt");
CREATE INDEX "InvoiceDelivery_tenantId_invoiceId_createdAt_idx" ON "InvoiceDelivery"("tenantId", "invoiceId", "createdAt" DESC);
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InvoiceShare" ADD CONSTRAINT invoice_share_expiry CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '31 days');
CREATE OR REPLACE FUNCTION medos_invoice_share_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."invoiceId" <> OLD."invoiceId" OR NEW."patientId" <> OLD."patientId" OR NEW."tokenHash" <> OLD."tokenHash" OR NEW."expiresAt" <> OLD."expiresAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'A shared bill link cannot be changed, only revoked' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'A revoked link cannot be reopened' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_share_guard BEFORE UPDATE ON "InvoiceShare" FOR EACH ROW EXECUTE FUNCTION medos_invoice_share_guard();
CREATE TRIGGER invoice_share_no_delete BEFORE DELETE ON "InvoiceShare" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT invoice_delivery_values CHECK (channel IN ('EMAIL', 'WHATSAPP', 'SMS') AND trigger IN ('AUTO', 'MANUAL') AND attempts >= 0);
CREATE TRIGGER invoice_delivery_no_delete BEFORE DELETE ON "InvoiceDelivery" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"InvoiceShare"');
SELECT medos_enable_tenant_rls('"InvoiceDelivery"');

-- The patient opens a link without signing in, so the hospital is found from the link's hash (the caller must hold the link). Everything after it runs under that hospital's own scope.
CREATE OR REPLACE FUNCTION medos_resolve_invoice_share(p_hash text) RETURNS TABLE (tenant_id uuid, share_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT s."tenantId", s.id FROM public."InvoiceShare" s WHERE s."tokenHash" = p_hash $$;
REVOKE ALL ON FUNCTION medos_resolve_invoice_share(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_resolve_invoice_share(text) TO medos_app;

-- The background worker asks which hospitals have a bill copy due, then serves each under its own scope.
CREATE OR REPLACE FUNCTION medos_tenants_with_due_invoice_deliveries(p_now timestamptz) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT d."tenantId" FROM public."InvoiceDelivery" d WHERE d.status = 'PENDING' AND d."nextAttemptAt" <= p_now $$;
REVOKE ALL ON FUNCTION medos_tenants_with_due_invoice_deliveries(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_tenants_with_due_invoice_deliveries(timestamptz) TO medos_app;
