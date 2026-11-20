-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "Consciousness" AS ENUM ('ALERT', 'DROWSY', 'CONFUSED', 'UNRESPONSIVE');

-- CreateEnum
CREATE TYPE "MobilityLevel" AS ENUM ('INDEPENDENT', 'NEEDS_HELP', 'BEDBOUND');

-- CreateTable
CREATE TABLE "NursingAdmissionAssessment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "taskId" UUID,
    "assessedById" UUID NOT NULL,
    "assessedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consciousness" "Consciousness" NOT NULL,
    "mobility" "MobilityLevel" NOT NULL,
    "painScore" INTEGER NOT NULL,
    "allergyChecked" BOOLEAN NOT NULL,
    "allergyNote" TEXT,
    "fallRisk" "RiskLevel" NOT NULL,
    "pressureRisk" "RiskLevel" NOT NULL,
    "nutritionRisk" "RiskLevel" NOT NULL,
    "dietNote" TEXT,
    "idBandChecked" BOOLEAN NOT NULL,
    "consentChecked" BOOLEAN NOT NULL,
    "belongingsNote" TEXT,
    "note" TEXT,

    CONSTRAINT "NursingAdmissionAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NursingAdmissionAssessment_tenantId_facilityId_assessedAt_idx" ON "NursingAdmissionAssessment"("tenantId", "facilityId", "assessedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NursingAdmissionAssessment_tenantId_admissionId_key" ON "NursingAdmissionAssessment"("tenantId", "admissionId");

-- CreateIndex
CREATE UNIQUE INDEX "NursingAdmissionAssessment_tenantId_id_key" ON "NursingAdmissionAssessment"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "NursingAdmissionAssessment" ADD CONSTRAINT "NursingAdmissionAssessment_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingAdmissionAssessment" ADD CONSTRAINT "NursingAdmissionAssessment_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== Hand-written invariants =====
-- ===== rules the database itself keeps: nursing admission assessment =====
ALTER TABLE "NursingAdmissionAssessment" ADD CONSTRAINT naa_pain CHECK ("painScore" BETWEEN 0 AND 10);
ALTER TABLE "NursingAdmissionAssessment" ADD CONSTRAINT naa_allergy_note CHECK ("allergyChecked" OR length(btrim(coalesce("allergyNote", ''))) > 0);
CREATE TRIGGER naa_scope_task BEFORE INSERT OR UPDATE OF "taskId" ON "NursingAdmissionAssessment" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('NursingTask', 'taskId');
CREATE TRIGGER naa_no_change BEFORE UPDATE OR DELETE ON "NursingAdmissionAssessment" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"NursingAdmissionAssessment"');
