-- Welcome message to a newly registered patient by WhatsApp or SMS (docs/registration-message.md). Email uses the email outbox.
CREATE TABLE "PatientMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "toMask" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerName" TEXT,
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    CONSTRAINT "PatientMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PatientMessage_tenantId_id_key" ON "PatientMessage"("tenantId", "id");
CREATE UNIQUE INDEX "PatientMessage_tenantId_patientId_kind_channel_key" ON "PatientMessage"("tenantId", "patientId", "kind", "channel");
CREATE INDEX "PatientMessage_status_nextAttemptAt_idx" ON "PatientMessage"("status", "nextAttemptAt");
ALTER TABLE "PatientMessage" ADD CONSTRAINT patient_message_values CHECK (channel IN ('WHATSAPP', 'SMS') AND kind IN ('REGISTRATION') AND attempts >= 0);
CREATE TRIGGER patient_message_no_delete BEFORE DELETE ON "PatientMessage" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"PatientMessage"');

CREATE OR REPLACE FUNCTION medos_tenants_with_due_patient_messages(p_now timestamptz) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT d."tenantId" FROM public."PatientMessage" d WHERE d.status = 'PENDING' AND d."nextAttemptAt" <= p_now $$;
REVOKE ALL ON FUNCTION medos_tenants_with_due_patient_messages(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_tenants_with_due_patient_messages(timestamptz) TO medos_app;
