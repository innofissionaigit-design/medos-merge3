-- CreateTable
CREATE TABLE "PatientCredential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "mobile" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatientCredential_tenantId_mobile_key" ON "PatientCredential"("tenantId", "mobile");
CREATE UNIQUE INDEX "PatientCredential_tenantId_id_key" ON "PatientCredential"("tenantId", "id");

ALTER TABLE "PatientCredential" ADD CONSTRAINT patient_credential_values CHECK (mobile ~ '^[6-9][0-9]{9}$' AND "failedAttempts" >= 0);

SELECT medos_enable_tenant_rls('"PatientCredential"');
