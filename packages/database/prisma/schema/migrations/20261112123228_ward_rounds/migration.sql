-- CreateEnum
CREATE TYPE "RoundStatus" AS ENUM ('NOTIFIED', 'STARTED', 'COMPLETED', 'MISSED');

-- CreateEnum
CREATE TYPE "RoundCondition" AS ENUM ('IMPROVING', 'STABLE', 'WORSENING', 'CRITICAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ROUND_DUE';
ALTER TYPE "NotificationType" ADD VALUE 'ROUND_MISSED';
ALTER TYPE "NotificationType" ADD VALUE 'NURSING_INSTRUCTION';

-- AlterTable
ALTER TABLE "NursingTask" ADD COLUMN     "sourceKey" TEXT;

-- CreateTable
CREATE TABLE "RoundSlot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "minutesOfDay" INTEGER NOT NULL,
    "practitionerId" UUID,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RoundSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WardRound" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "slotId" UUID NOT NULL,
    "roundDate" DATE NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "label" TEXT NOT NULL,
    "status" "RoundStatus" NOT NULL DEFAULT 'NOTIFIED',
    "notifiedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "missedAt" TIMESTAMPTZ(3),
    "patientsTotal" INTEGER,
    "patientsSeen" INTEGER,

    CONSTRAINT "WardRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "roundId" UUID,
    "admissionId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "condition" "RoundCondition",
    "note" TEXT NOT NULL,
    "plan" TEXT,
    "instructions" JSONB,
    "addendumOfId" UUID,
    "status" "NoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "errorReason" TEXT,
    "errorById" UUID,
    "errorAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoundNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcedureRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "serviceId" UUID,
    "name" TEXT NOT NULL,
    "performedAt" TIMESTAMPTZ(3) NOT NULL,
    "performedById" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "chargeId" UUID,
    "status" "NoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "errorReason" TEXT,
    "errorById" UUID,
    "errorAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcedureRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoundSlot_tenantId_facilityId_status_idx" ON "RoundSlot"("tenantId", "facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RoundSlot_tenantId_id_key" ON "RoundSlot"("tenantId", "id");

-- CreateIndex
CREATE INDEX "WardRound_tenantId_facilityId_roundDate_status_idx" ON "WardRound"("tenantId", "facilityId", "roundDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WardRound_tenantId_id_key" ON "WardRound"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WardRound_tenantId_practitionerId_slotId_roundDate_key" ON "WardRound"("tenantId", "practitionerId", "slotId", "roundDate");

-- CreateIndex
CREATE INDEX "RoundNote_tenantId_admissionId_createdAt_idx" ON "RoundNote"("tenantId", "admissionId", "createdAt");

-- CreateIndex
CREATE INDEX "RoundNote_roundId_idx" ON "RoundNote"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "RoundNote_tenantId_id_key" ON "RoundNote"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProcedureRecord_chargeId_key" ON "ProcedureRecord"("chargeId");

-- CreateIndex
CREATE INDEX "ProcedureRecord_tenantId_admissionId_performedAt_idx" ON "ProcedureRecord"("tenantId", "admissionId", "performedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcedureRecord_tenantId_id_key" ON "ProcedureRecord"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NursingTask_tenantId_sourceKey_key" ON "NursingTask"("tenantId", "sourceKey");

-- AddForeignKey
ALTER TABLE "RoundSlot" ADD CONSTRAINT "RoundSlot_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundSlot" ADD CONSTRAINT "RoundSlot_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WardRound" ADD CONSTRAINT "WardRound_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WardRound" ADD CONSTRAINT "WardRound_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WardRound" ADD CONSTRAINT "WardRound_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "RoundSlot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundNote" ADD CONSTRAINT "RoundNote_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "WardRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundNote" ADD CONSTRAINT "RoundNote_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundNote" ADD CONSTRAINT "RoundNote_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundNote" ADD CONSTRAINT "RoundNote_addendumOfId_fkey" FOREIGN KEY ("addendumOfId") REFERENCES "RoundNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcedureRecord" ADD CONSTRAINT "ProcedureRecord_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcedureRecord" ADD CONSTRAINT "ProcedureRecord_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcedureRecord" ADD CONSTRAINT "ProcedureRecord_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- ===== rules the database itself keeps: ward rounds =====
-- Round times: one active slot per time of day for all doctors, and one per doctor.
CREATE UNIQUE INDEX "RoundSlot_one_all_doctors_per_time" ON "RoundSlot" ("tenantId", "facilityId", "minutesOfDay") WHERE "practitionerId" IS NULL AND status = 'ACTIVE';
CREATE UNIQUE INDEX "RoundSlot_one_per_doctor_per_time" ON "RoundSlot" ("tenantId", "facilityId", "practitionerId", "minutesOfDay") WHERE "practitionerId" IS NOT NULL AND status = 'ACTIVE';
ALTER TABLE "RoundSlot" ADD CONSTRAINT round_slot_minutes CHECK ("minutesOfDay" BETWEEN 0 AND 1439 AND length(btrim(label)) > 0);
CREATE TRIGGER round_slot_scope_practitioner BEFORE INSERT OR UPDATE OF "practitionerId" ON "RoundSlot" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Practitioner', 'practitionerId');
CREATE TRIGGER round_slot_no_delete BEFORE DELETE ON "RoundSlot" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"RoundSlot"');

-- A round: one per doctor, time and day; its step is kept in order.
ALTER TABLE "WardRound" ADD CONSTRAINT ward_round_steps CHECK (
  (status <> 'COMPLETED' OR ("startedAt" IS NOT NULL AND "completedAt" IS NOT NULL))
  AND (status <> 'STARTED' OR "startedAt" IS NOT NULL)
  AND (status <> 'MISSED' OR "missedAt" IS NOT NULL)
  AND ("patientsSeen" IS NULL OR ("patientsTotal" IS NOT NULL AND "patientsSeen" BETWEEN 0 AND "patientsTotal")));
CREATE TRIGGER ward_round_scope_practitioner BEFORE INSERT OR UPDATE OF "practitionerId" ON "WardRound" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Practitioner', 'practitionerId');
CREATE TRIGGER ward_round_no_delete BEFORE DELETE ON "WardRound" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_ward_round_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."practitionerId" <> OLD."practitionerId" OR NEW."slotId" <> OLD."slotId"
     OR NEW."roundDate" <> OLD."roundDate" OR NEW."scheduledAt" <> OLD."scheduledAt" OR NEW."notifiedAt" <> OLD."notifiedAt" THEN
    RAISE EXCEPTION 'Who a round is for and when it was due cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'A finished round cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'STARTED' AND NEW.status NOT IN ('STARTED', 'COMPLETED') THEN
    RAISE EXCEPTION 'A round that has started cannot go back' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ward_round_guard BEFORE UPDATE ON "WardRound" FOR EACH ROW EXECUTE FUNCTION medos_ward_round_guard();
SELECT medos_enable_tenant_rls('"WardRound"');

-- Round notes and procedure records are append-only: only the "entered in error" mark may be added, once.
ALTER TABLE "RoundNote" ADD CONSTRAINT round_note_text CHECK (length(btrim(note)) > 0);
ALTER TABLE "RoundNote" ADD CONSTRAINT round_note_error CHECK ((status = 'ENTERED_IN_ERROR') = ("errorAt" IS NOT NULL AND "errorById" IS NOT NULL AND "errorReason" IS NOT NULL));
CREATE TRIGGER round_note_scope_practitioner BEFORE INSERT OR UPDATE OF "practitionerId" ON "RoundNote" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Practitioner', 'practitionerId');
CREATE TRIGGER round_note_scope_round BEFORE INSERT OR UPDATE OF "roundId" ON "RoundNote" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('WardRound', 'roundId');
CREATE TRIGGER round_note_no_delete BEFORE DELETE ON "RoundNote" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_clinical_note_guard() RETURNS trigger AS $$
DECLARE o jsonb := to_jsonb(OLD) - 'status' - 'errorReason' - 'errorById' - 'errorAt'; n jsonb := to_jsonb(NEW) - 'status' - 'errorReason' - 'errorById' - 'errorAt';
BEGIN
  IF o <> n THEN RAISE EXCEPTION 'The text of a clinical note cannot be rewritten; add an addendum' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD.status::text = 'ENTERED_IN_ERROR' THEN RAISE EXCEPTION 'This entry was already marked as entered in error' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER round_note_guard BEFORE UPDATE ON "RoundNote" FOR EACH ROW EXECUTE FUNCTION medos_clinical_note_guard();
SELECT medos_enable_tenant_rls('"RoundNote"');

ALTER TABLE "ProcedureRecord" ADD CONSTRAINT procedure_text CHECK (length(btrim(name)) > 0 AND length(btrim(outcome)) > 0);
ALTER TABLE "ProcedureRecord" ADD CONSTRAINT procedure_error CHECK ((status = 'ENTERED_IN_ERROR') = ("errorAt" IS NOT NULL AND "errorById" IS NOT NULL AND "errorReason" IS NOT NULL));
CREATE TRIGGER procedure_no_delete BEFORE DELETE ON "ProcedureRecord" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER procedure_guard BEFORE UPDATE ON "ProcedureRecord" FOR EACH ROW EXECUTE FUNCTION medos_clinical_note_guard();
SELECT medos_enable_tenant_rls('"ProcedureRecord"');

-- The worker that tells doctors a round is due asks which hospitals have round times (it then works one hospital at a time, like the reminder worker).
CREATE OR REPLACE FUNCTION medos_tenants_with_round_slots() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT s."tenantId" FROM public."RoundSlot" s WHERE s.status = 'ACTIVE' $$;
REVOKE ALL ON FUNCTION medos_tenants_with_round_slots() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_tenants_with_round_slots() TO medos_app;

-- ===== data: the two default round times for every facility, the ward coordinator role, and the permissions each role needs =====
INSERT INTO "RoundSlot" ("tenantId", "facilityId", label, "minutesOfDay", "updatedAt")
SELECT f."tenantId", f.id, v.label, v.minutes, CURRENT_TIMESTAMP FROM "Facility" f CROSS JOIN (VALUES ('Morning round', 420), ('Noon round', 720)) AS v(label, minutes)
WHERE NOT EXISTS (SELECT 1 FROM "RoundSlot" s WHERE s."facilityId" = f.id);
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'WARD_COORDINATOR', true FROM "Tenant" t ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('WARD_COORDINATOR', 'WARD_BOARD_READ'), ('WARD_COORDINATOR', 'ROUND_MANAGE'), ('WARD_COORDINATOR', 'ROUND_READ'), ('WARD_COORDINATOR', 'ADMISSION_READ'), ('WARD_COORDINATOR', 'PATIENT_READ'),
  ('WARD_COORDINATOR', 'NURSING_READ'), ('WARD_COORDINATOR', 'VITALS_READ'), ('WARD_COORDINATOR', 'LIMS_READ'), ('WARD_COORDINATOR', 'RAD_READ'), ('WARD_COORDINATOR', 'LAB_READ'),
  ('WARD_COORDINATOR', 'PRESCRIPTION_READ'), ('WARD_COORDINATOR', 'REPORT_IPD'), ('WARD_COORDINATOR', 'PLANNED_READ'),
  ('DOCTOR', 'ROUND_READ'), ('DOCTOR', 'ROUND_DO'), ('DOCTOR', 'PROCEDURE_RECORD'),
  ('ICU_DOCTOR', 'PROCEDURE_RECORD'),
  ('NURSE', 'ROUND_READ'), ('ICU_NURSE', 'ROUND_READ'),
  ('MANAGER', 'WARD_BOARD_READ'), ('MANAGER', 'ROUND_READ'),
  ('ADMINISTRATOR', 'WARD_BOARD_READ'), ('ADMINISTRATOR', 'ROUND_MANAGE'), ('ADMINISTRATOR', 'ROUND_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration ward_rounds', 'added', jsonb_build_object(
  'WARD_COORDINATOR', 'new role', 'DOCTOR', jsonb_build_array('ROUND_READ', 'ROUND_DO', 'PROCEDURE_RECORD'), 'ICU_DOCTOR', jsonb_build_array('PROCEDURE_RECORD'), 'NURSE', jsonb_build_array('ROUND_READ'),
  'ICU_NURSE', jsonb_build_array('ROUND_READ'), 'MANAGER', jsonb_build_array('WARD_BOARD_READ', 'ROUND_READ'), 'ADMINISTRATOR', jsonb_build_array('WARD_BOARD_READ', 'ROUND_MANAGE', 'ROUND_READ')))
FROM "Tenant" t;

