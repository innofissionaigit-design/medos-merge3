-- CreateEnum
CREATE TYPE "PlannedSource" AS ENUM ('OPD_ADVISED', 'OUTSIDE_ARRANGED', 'OUTSIDE_DIRECT');

-- CreateEnum
CREATE TYPE "PlannedStatus" AS ENUM ('ADVISED', 'DOCTOR_REVIEW', 'AWAITING_PATIENT', 'DESK_REVIEW', 'TARIFF_PAYER', 'PREAUTH', 'DEPOSIT', 'BED_ALLOCATION', 'READY', 'ADMITTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PlannedCloseReason" AS ENUM ('PATIENT_DECLINED', 'DOCTOR_DECLINED', 'OTHER_TREATMENT', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "PlannedAsk" AS ENUM ('CHAMBER', 'REPORTS', 'INVESTIGATIONS');

-- CreateEnum
CREATE TYPE "PlannedPayer" AS ENUM ('SELF_PAY', 'INSURED');

-- CreateEnum
CREATE TYPE "PlannedFinancialBasis" AS ENUM ('DEPOSIT_PAID', 'INSURANCE_APPROVED', 'WAIVED', 'NOT_REQUIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PLANNED_ADMISSION_ADVISED';
ALTER TYPE "NotificationType" ADD VALUE 'PLANNED_ADMISSION_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'PLANNED_ADMISSION_DECIDED';
ALTER TYPE "NotificationType" ADD VALUE 'PLANNED_ADMISSION_STEP';

-- AlterTable
ALTER TABLE "AdvanceDeposit" ADD COLUMN     "plannedAdmissionId" UUID;

-- CreateTable
CREATE TABLE "PlannedAdmission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "source" "PlannedSource" NOT NULL,
    "status" "PlannedStatus" NOT NULL,
    "consultantId" UUID NOT NULL,
    "sourceEncounterId" UUID,
    "details" TEXT NOT NULL,
    "askMode" "PlannedAsk",
    "askNote" TEXT,
    "diagnosis" TEXT,
    "plannedProcedure" TEXT,
    "proposedDate" DATE,
    "expectedStayDays" INTEGER,
    "wardId" UUID,
    "roomNote" TEXT,
    "deskVerifiedAt" TIMESTAMPTZ(3),
    "deskVerifiedById" UUID,
    "consentAt" TIMESTAMPTZ(3),
    "consentById" UUID,
    "consentNote" TEXT,
    "estimateTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "payer" "PlannedPayer",
    "policyId" UUID,
    "claimId" UUID,
    "eligibilityNote" TEXT,
    "preauthRequired" BOOLEAN NOT NULL DEFAULT false,
    "requiredDeposit" DECIMAL(14,2),
    "financialBasis" "PlannedFinancialBasis",
    "financialNote" TEXT,
    "financialClearedAt" TIMESTAMPTZ(3),
    "financialClearedById" UUID,
    "bedId" UUID,
    "bedAllocatedAt" TIMESTAMPTZ(3),
    "bedAllocatedById" UUID,
    "admissionId" UUID,
    "admittedAt" TIMESTAMPTZ(3),
    "closeReason" "PlannedCloseReason",
    "closeNote" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlannedAdmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannedAdmissionEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "plannedId" UUID NOT NULL,
    "fromStatus" "PlannedStatus",
    "toStatus" "PlannedStatus" NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlannedAdmissionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannedEstimateLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "plannedId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "PlannedEstimateLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlannedAdmission_admissionId_key" ON "PlannedAdmission"("admissionId");

-- CreateIndex
CREATE INDEX "PlannedAdmission_tenantId_facilityId_status_createdAt_idx" ON "PlannedAdmission"("tenantId", "facilityId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PlannedAdmission_tenantId_patientId_createdAt_idx" ON "PlannedAdmission"("tenantId", "patientId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PlannedAdmission_tenantId_consultantId_status_idx" ON "PlannedAdmission"("tenantId", "consultantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedAdmission_tenantId_id_key" ON "PlannedAdmission"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedAdmission_tenantId_facilityId_requestNumber_key" ON "PlannedAdmission"("tenantId", "facilityId", "requestNumber");

-- CreateIndex
CREATE INDEX "PlannedAdmissionEvent_tenantId_plannedId_createdAt_idx" ON "PlannedAdmissionEvent"("tenantId", "plannedId", "createdAt");

-- CreateIndex
CREATE INDEX "PlannedEstimateLine_tenantId_plannedId_idx" ON "PlannedEstimateLine"("tenantId", "plannedId");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedEstimateLine_plannedId_lineNo_key" ON "PlannedEstimateLine"("plannedId", "lineNo");

-- CreateIndex
CREATE INDEX "AdvanceDeposit_tenantId_plannedAdmissionId_idx" ON "AdvanceDeposit"("tenantId", "plannedAdmissionId");

-- AddForeignKey
ALTER TABLE "AdvanceDeposit" ADD CONSTRAINT "AdvanceDeposit_plannedAdmissionId_fkey" FOREIGN KEY ("plannedAdmissionId") REFERENCES "PlannedAdmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT "PlannedAdmission_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT "PlannedAdmission_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT "PlannedAdmission_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT "PlannedAdmission_sourceEncounterId_fkey" FOREIGN KEY ("sourceEncounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT "PlannedAdmission_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "Ward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT "PlannedAdmission_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "Bed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT "PlannedAdmission_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "Admission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT "PlannedAdmission_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedAdmissionEvent" ADD CONSTRAINT "PlannedAdmissionEvent_plannedId_fkey" FOREIGN KEY ("plannedId") REFERENCES "PlannedAdmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedEstimateLine" ADD CONSTRAINT "PlannedEstimateLine_plannedId_fkey" FOREIGN KEY ("plannedId") REFERENCES "PlannedAdmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- ===== rules the database itself keeps: planned admissions =====
-- A patient has one planned admission open at a time; a visit advises admission once; a bed is held for one patient at a time.
CREATE UNIQUE INDEX "PlannedAdmission_one_open_per_patient" ON "PlannedAdmission" ("tenantId", "patientId") WHERE status NOT IN ('ADMITTED', 'CLOSED');
CREATE UNIQUE INDEX "PlannedAdmission_one_open_per_visit" ON "PlannedAdmission" ("tenantId", "sourceEncounterId") WHERE "sourceEncounterId" IS NOT NULL AND status NOT IN ('ADMITTED', 'CLOSED');
CREATE UNIQUE INDEX "PlannedAdmission_one_open_per_bed" ON "PlannedAdmission" ("tenantId", "bedId") WHERE "bedId" IS NOT NULL AND status NOT IN ('ADMITTED', 'CLOSED');

ALTER TABLE "PlannedAdmission" ADD CONSTRAINT planned_details CHECK (length(btrim(details)) > 0);
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT planned_stay CHECK ("expectedStayDays" IS NULL OR "expectedStayDays" BETWEEN 1 AND 365);
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT planned_money CHECK ("estimateTotal" >= 0 AND ("requiredDeposit" IS NULL OR "requiredDeposit" >= 0));
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT planned_closed CHECK ((status = 'CLOSED') = ("closeReason" IS NOT NULL) AND ("closeReason" IS NULL OR ("closedAt" IS NOT NULL AND "closedById" IS NOT NULL)));
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT planned_admitted CHECK ((status = 'ADMITTED') = ("admissionId" IS NOT NULL) AND ("admissionId" IS NULL OR "admittedAt" IS NOT NULL));
-- A bed is held only once the request is ready; the day, the details and the money are settled before that.
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT planned_bed_held CHECK (status NOT IN ('READY') OR ("bedId" IS NOT NULL AND "bedAllocatedAt" IS NOT NULL AND "bedAllocatedById" IS NOT NULL));
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT planned_no_early_bed CHECK (status NOT IN ('ADVISED', 'DOCTOR_REVIEW', 'AWAITING_PATIENT', 'DESK_REVIEW', 'TARIFF_PAYER', 'PREAUTH', 'DEPOSIT', 'BED_ALLOCATION') OR "bedId" IS NULL);
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT planned_ready_complete CHECK (status NOT IN ('READY', 'ADMITTED') OR ("financialBasis" IS NOT NULL AND "financialClearedAt" IS NOT NULL AND "proposedDate" IS NOT NULL AND "deskVerifiedAt" IS NOT NULL AND payer IS NOT NULL));
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT planned_insured_policy CHECK (payer IS DISTINCT FROM 'INSURED' OR "policyId" IS NOT NULL);
ALTER TABLE "PlannedAdmission" ADD CONSTRAINT planned_ask CHECK (status <> 'AWAITING_PATIENT' OR "askMode" IS NOT NULL);
CREATE TRIGGER planned_scope_consultant BEFORE INSERT OR UPDATE OF "consultantId" ON "PlannedAdmission" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Practitioner', 'consultantId');
CREATE TRIGGER planned_scope_encounter BEFORE INSERT OR UPDATE OF "sourceEncounterId" ON "PlannedAdmission" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Encounter', 'sourceEncounterId');
CREATE TRIGGER planned_scope_ward BEFORE INSERT OR UPDATE OF "wardId" ON "PlannedAdmission" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Ward', 'wardId');
CREATE TRIGGER planned_scope_bed BEFORE INSERT OR UPDATE OF "bedId" ON "PlannedAdmission" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Bed', 'bedId');
CREATE TRIGGER planned_scope_admission BEFORE INSERT OR UPDATE OF "admissionId" ON "PlannedAdmission" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Admission', 'admissionId');
CREATE TRIGGER planned_scope_claim BEFORE INSERT OR UPDATE OF "claimId" ON "PlannedAdmission" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Claim', 'claimId');
CREATE TRIGGER planned_no_delete BEFORE DELETE ON "PlannedAdmission" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- The claim and the policy must be this patient's.
CREATE OR REPLACE FUNCTION medos_planned_links() RETURNS trigger AS $$
BEGIN
  IF NEW."claimId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Claim" c WHERE c.id = NEW."claimId" AND c."tenantId" = NEW."tenantId" AND c."patientId" = NEW."patientId") THEN
    RAISE EXCEPTION 'The insurance claim of a planned admission must be the patient''s own' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."policyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "PatientPolicy" p WHERE p.id = NEW."policyId" AND p."tenantId" = NEW."tenantId" AND p."patientId" = NEW."patientId") THEN
    RAISE EXCEPTION 'The insurance policy of a planned admission must be the patient''s own' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."admissionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Admission" a WHERE a.id = NEW."admissionId" AND a."tenantId" = NEW."tenantId" AND a."patientId" = NEW."patientId") THEN
    RAISE EXCEPTION 'The admission of a planned admission must be the patient''s own' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER planned_links BEFORE INSERT OR UPDATE OF "claimId", "policyId", "admissionId" ON "PlannedAdmission" FOR EACH ROW EXECUTE FUNCTION medos_planned_links();

-- Who the request is for and where it came from never change; an admitted or closed request is final.
CREATE OR REPLACE FUNCTION medos_planned_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."requestNumber" <> OLD."requestNumber"
     OR NEW.source <> OLD.source OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" OR NEW."sourceEncounterId" IS DISTINCT FROM OLD."sourceEncounterId"
     OR NEW.details <> OLD.details THEN
    RAISE EXCEPTION 'The identity of a planned admission cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('ADMITTED', 'CLOSED') THEN
    RAISE EXCEPTION 'This planned admission has ended and cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER planned_guard BEFORE UPDATE ON "PlannedAdmission" FOR EACH ROW EXECUTE FUNCTION medos_planned_guard();
SELECT medos_enable_tenant_rls('"PlannedAdmission"');

-- The timeline is append-only.
CREATE TRIGGER planned_event_immutable BEFORE UPDATE OR DELETE ON "PlannedAdmissionEvent" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
ALTER TABLE "PlannedAdmissionEvent" ADD CONSTRAINT planned_event_action CHECK (length(btrim(action)) > 0);
SELECT medos_enable_tenant_rls('"PlannedAdmissionEvent"');

-- The estimate can be revised only while billing is working on it.
ALTER TABLE "PlannedEstimateLine" ADD CONSTRAINT planned_line_values CHECK (quantity > 0 AND "unitPrice" >= 0 AND length(btrim(description)) > 0 AND "lineNo" >= 1);
CREATE OR REPLACE FUNCTION medos_planned_line_guard() RETURNS trigger AS $$
DECLARE pid uuid; st text; tid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN pid := OLD."plannedId"; tid := OLD."tenantId"; ELSE pid := NEW."plannedId"; tid := NEW."tenantId"; END IF;
  SELECT status::text INTO st FROM "PlannedAdmission" WHERE id = pid AND "tenantId" = tid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown planned admission' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF st NOT IN ('TARIFF_PAYER', 'PREAUTH', 'DEPOSIT') THEN
    RAISE EXCEPTION 'The estimate of this planned admission can no longer be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER planned_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "PlannedEstimateLine" FOR EACH ROW EXECUTE FUNCTION medos_planned_line_guard();
SELECT medos_enable_tenant_rls('"PlannedEstimateLine"');

-- A deposit asked for a planned admission is the patient's own money at the same facility.
CREATE OR REPLACE FUNCTION medos_advance_planned_scope() RETURNS trigger AS $$
BEGIN
  IF NEW."plannedAdmissionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "PlannedAdmission" p WHERE p.id = NEW."plannedAdmissionId" AND p."tenantId" = NEW."tenantId" AND p."facilityId" = NEW."facilityId" AND p."patientId" = NEW."patientId") THEN
    RAISE EXCEPTION 'A deposit must belong to the same patient and facility as the planned admission' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER advance_planned_scope BEFORE INSERT ON "AdvanceDeposit" FOR EACH ROW EXECUTE FUNCTION medos_advance_planned_scope();

-- A bed held for a patient who is ready to be admitted cannot be freed by hand (the request must be cancelled or the patient admitted).
CREATE OR REPLACE FUNCTION medos_bed_held_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status::text = 'RESERVED' AND NEW.status::text IN ('AVAILABLE', 'CLEANING', 'MAINTENANCE')
     AND EXISTS (SELECT 1 FROM "PlannedAdmission" p WHERE p."bedId" = OLD.id AND p."tenantId" = OLD."tenantId" AND p.status::text = 'READY') THEN
    RAISE EXCEPTION 'This bed is held for a planned admission' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bed_held_guard BEFORE UPDATE OF status ON "Bed" FOR EACH ROW EXECUTE FUNCTION medos_bed_held_guard();

-- ===== data: the admission desk and bed manager roles; the planned-admission permissions of the existing roles =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, r.name, true FROM "Tenant" t CROSS JOIN (VALUES ('ADMISSION_DESK'), ('BED_MANAGER')) AS r(name) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('RECEPTIONIST', 'PLANNED_READ'), ('RECEPTIONIST', 'PLANNED_REQUEST'), ('RECEPTIONIST', 'PLANNED_DESK'),
  ('DOCTOR', 'PLANNED_READ'), ('DOCTOR', 'PLANNED_DOCTOR'),
  ('NURSE', 'PLANNED_READ'),
  ('CASHIER', 'PLANNED_READ'), ('CASHIER', 'PLANNED_BILLING'),
  ('CLAIMS_OFFICER', 'PLANNED_READ'), ('CLAIMS_OFFICER', 'PLANNED_INSURANCE'),
  ('MANAGER', 'PLANNED_READ'), ('MANAGER', 'PLANNED_APPROVE'),
  ('ADMINISTRATOR', 'PLANNED_READ'), ('ADMINISTRATOR', 'PLANNED_APPROVE'),
  ('ADMISSION_DESK', 'PLANNED_READ'), ('ADMISSION_DESK', 'PLANNED_REQUEST'), ('ADMISSION_DESK', 'PLANNED_DESK'), ('ADMISSION_DESK', 'PLANNED_BED'),
  ('ADMISSION_DESK', 'PATIENT_READ'), ('ADMISSION_DESK', 'PATIENT_CREATE'), ('ADMISSION_DESK', 'PATIENT_UPDATE'), ('ADMISSION_DESK', 'DUPLICATE_OVERRIDE'),
  ('ADMISSION_DESK', 'APPOINTMENT_READ'), ('ADMISSION_DESK', 'APPOINTMENT_CREATE'), ('ADMISSION_DESK', 'QUEUE_READ'),
  ('ADMISSION_DESK', 'ADMISSION_READ'), ('ADMISSION_DESK', 'ADMISSION_CREATE'), ('ADMISSION_DESK', 'ADMISSION_TRANSFER'), ('ADMISSION_DESK', 'INVOICE_READ'),
  ('BED_MANAGER', 'PLANNED_READ'), ('BED_MANAGER', 'PLANNED_BED'), ('BED_MANAGER', 'PATIENT_READ'), ('BED_MANAGER', 'ADMISSION_READ'), ('BED_MANAGER', 'ADMISSION_TRANSFER')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration planned_admission', 'added', jsonb_build_object(
  'RECEPTIONIST', jsonb_build_array('PLANNED_READ', 'PLANNED_REQUEST', 'PLANNED_DESK'), 'DOCTOR', jsonb_build_array('PLANNED_READ', 'PLANNED_DOCTOR'), 'NURSE', jsonb_build_array('PLANNED_READ'),
  'CASHIER', jsonb_build_array('PLANNED_READ', 'PLANNED_BILLING'), 'CLAIMS_OFFICER', jsonb_build_array('PLANNED_READ', 'PLANNED_INSURANCE'), 'MANAGER', jsonb_build_array('PLANNED_READ', 'PLANNED_APPROVE'),
  'ADMINISTRATOR', jsonb_build_array('PLANNED_READ', 'PLANNED_APPROVE'), 'ADMISSION_DESK', 'new role', 'BED_MANAGER', 'new role'))
FROM "Tenant" t;

