
-- CreateEnum
CREATE TYPE "OrderRequestKind" AS ENUM ('TEST', 'MEDICINE');

-- CreateEnum
CREATE TYPE "OrderRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ORDER_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_REQUEST_DECIDED';

-- CreateTable
CREATE TABLE "EmergencyBedStay" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "bedId" UUID NOT NULL,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" UUID NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),
    "releasedById" UUID,

    CONSTRAINT "EmergencyBedStay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "kind" "OrderRequestKind" NOT NULL,
    "status" "OrderRequestStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "note" TEXT,
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,

    CONSTRAINT "OrderRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmergencyBedStay_tenantId_caseId_assignedAt_idx" ON "EmergencyBedStay"("tenantId", "caseId", "assignedAt" DESC);

-- CreateIndex
CREATE INDEX "EmergencyBedStay_tenantId_bedId_assignedAt_idx" ON "EmergencyBedStay"("tenantId", "bedId", "assignedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyBedStay_tenantId_id_key" ON "EmergencyBedStay"("tenantId", "id");

-- CreateIndex
CREATE INDEX "OrderRequest_tenantId_encounterId_requestedAt_idx" ON "OrderRequest"("tenantId", "encounterId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "OrderRequest_tenantId_facilityId_status_requestedAt_idx" ON "OrderRequest"("tenantId", "facilityId", "status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRequest_tenantId_id_key" ON "OrderRequest"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "EmergencyBedStay" ADD CONSTRAINT "EmergencyBedStay_tenantId_facilityId_caseId_fkey" FOREIGN KEY ("tenantId", "facilityId", "caseId") REFERENCES "EmergencyCase"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyBedStay" ADD CONSTRAINT "EmergencyBedStay_tenantId_facilityId_bedId_fkey" FOREIGN KEY ("tenantId", "facilityId", "bedId") REFERENCES "Bed"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRequest" ADD CONSTRAINT "OrderRequest_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ===== rules the database itself keeps: the emergency ward bed =====
ALTER TABLE "EmergencyBedStay" ADD CONSTRAINT er_bed_stay_times CHECK (("releasedAt" IS NULL) = ("releasedById" IS NULL) AND ("releasedAt" IS NULL OR "releasedAt" >= "assignedAt"));
-- A patient lies in one bed at a time, and a bed holds one patient at a time.
CREATE UNIQUE INDEX "EmergencyBedStay_one_open_per_case" ON "EmergencyBedStay" ("tenantId", "caseId") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "EmergencyBedStay_one_open_per_bed" ON "EmergencyBedStay" ("tenantId", "bedId") WHERE "releasedAt" IS NULL;

CREATE OR REPLACE FUNCTION medos_er_bed_stay_open() RETURNS trigger AS $$
DECLARE c record;
BEGIN
  SELECT status::text AS status INTO c FROM "EmergencyCase" WHERE id = NEW."caseId" AND "tenantId" = NEW."tenantId" AND "facilityId" = NEW."facilityId";
  IF NOT FOUND OR c.status NOT IN ('ARRIVED', 'TRIAGED', 'IN_TREATMENT') THEN
    RAISE EXCEPTION 'A bed can be given only to a patient who is in the emergency ward' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER er_bed_stay_open BEFORE INSERT ON "EmergencyBedStay" FOR EACH ROW EXECUTE FUNCTION medos_er_bed_stay_open();
CREATE TRIGGER er_bed_stay_scope_bed BEFORE INSERT OR UPDATE OF "bedId" ON "EmergencyBedStay" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Bed', 'bedId');
CREATE TRIGGER er_bed_stay_no_delete BEFORE DELETE ON "EmergencyBedStay" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- Where the patient lay never changes; the stay is only ended, once.
CREATE OR REPLACE FUNCTION medos_er_bed_stay_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."caseId" <> OLD."caseId" OR NEW."bedId" <> OLD."bedId"
     OR NEW."assignedAt" <> OLD."assignedAt" OR NEW."assignedById" <> OLD."assignedById" THEN
    RAISE EXCEPTION 'The record of an emergency bed cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'This stay in the emergency bed has already ended' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER er_bed_stay_guard BEFORE UPDATE ON "EmergencyBedStay" FOR EACH ROW EXECUTE FUNCTION medos_er_bed_stay_guard();
SELECT medos_enable_tenant_rls('"EmergencyBedStay"');

-- ===== rules the database itself keeps: nurse requests =====
ALTER TABLE "OrderRequest" ADD CONSTRAINT order_request_decision CHECK ((status = 'PENDING') = (("decidedById" IS NULL) AND ("decidedAt" IS NULL)));
ALTER TABLE "OrderRequest" ADD CONSTRAINT order_request_summary CHECK (length(btrim(summary)) > 0);
CREATE TRIGGER order_request_scope_encounter BEFORE INSERT OR UPDATE OF "encounterId" ON "OrderRequest" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Encounter', 'encounterId');
CREATE TRIGGER order_request_no_delete BEFORE DELETE ON "OrderRequest" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- What was asked, and by whom, never changes; the request is decided once.
CREATE OR REPLACE FUNCTION medos_order_request_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."encounterId" <> OLD."encounterId" OR NEW."patientId" <> OLD."patientId"
     OR NEW.kind <> OLD.kind OR NEW.summary <> OLD.summary OR NEW.payload <> OLD.payload OR NEW."requestedById" <> OLD."requestedById" OR NEW."requestedAt" <> OLD."requestedAt"
     OR NEW.note IS DISTINCT FROM OLD.note THEN
    RAISE EXCEPTION 'A nurse request cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'This request has already been decided' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER order_request_guard BEFORE UPDATE ON "OrderRequest" FOR EACH ROW EXECUTE FUNCTION medos_order_request_guard();
SELECT medos_enable_tenant_rls('"OrderRequest"');

-- ===== data: the emergency ward (six beds, no bed charge: the emergency fee covers it) for every existing facility =====
INSERT INTO "Ward" ("tenantId", "facilityId", name, code, "updatedAt")
SELECT f."tenantId", f.id, 'Emergency Ward', 'ER', CURRENT_TIMESTAMP FROM "Facility" f ON CONFLICT DO NOTHING;
INSERT INTO "Room" ("tenantId", "facilityId", "wardId", name, code, "updatedAt")
SELECT w."tenantId", w."facilityId", w.id, 'Emergency Room', 'ER-1', CURRENT_TIMESTAMP FROM "Ward" w WHERE w.code = 'ER' AND w.name = 'Emergency Ward' ON CONFLICT DO NOTHING;
INSERT INTO "Bed" ("tenantId", "facilityId", "wardId", "roomId", code, "dailyRate", "updatedAt")
SELECT r."tenantId", r."facilityId", r."wardId", r.id, 'ER' || n, 0, CURRENT_TIMESTAMP
FROM "Room" r CROSS JOIN generate_series(1, 6) AS n WHERE r.code = 'ER-1' AND r.name = 'Emergency Room' ON CONFLICT DO NOTHING;

-- ===== data: the emergency doctor role; the emergency and ICU roles get exactly the permissions their work needs; the manager and administrator get the status overview =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'EMERGENCY_DOCTOR', true FROM "Tenant" t ON CONFLICT DO NOTHING;
DELETE FROM "RolePermission" rp USING "Role" r WHERE rp."roleId" = r.id AND rp."tenantId" = r."tenantId" AND r."isSystem" AND r.name IN ('EMERGENCY_DOCTOR', 'EMERGENCY_NURSE', 'ICU_DOCTOR', 'ICU_NURSE');
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('EMERGENCY_DOCTOR', 'ER_READ'),
  ('EMERGENCY_DOCTOR', 'ER_TREAT'),
  ('EMERGENCY_DOCTOR', 'PATIENT_READ'),
  ('EMERGENCY_DOCTOR', 'VITALS_READ'),
  ('EMERGENCY_DOCTOR', 'VITALS_CREATE'),
  ('EMERGENCY_DOCTOR', 'ALLERGY_WRITE'),
  ('EMERGENCY_DOCTOR', 'PRESCRIPTION_READ'),
  ('EMERGENCY_DOCTOR', 'PRESCRIPTION_CREATE'),
  ('EMERGENCY_DOCTOR', 'PRESCRIPTION_SIGN'),
  ('EMERGENCY_DOCTOR', 'LIMS_READ'),
  ('EMERGENCY_DOCTOR', 'LIMS_ORDER'),
  ('EMERGENCY_DOCTOR', 'LIMS_PRIORITY'),
  ('EMERGENCY_DOCTOR', 'RAD_READ'),
  ('EMERGENCY_DOCTOR', 'LAB_READ'),
  ('EMERGENCY_DOCTOR', 'CONSULTATION_READ'),
  ('EMERGENCY_NURSE', 'ER_READ'),
  ('EMERGENCY_NURSE', 'ER_TRIAGE'),
  ('EMERGENCY_NURSE', 'ORDER_REQUEST'),
  ('EMERGENCY_NURSE', 'LIMS_READ'),
  ('EMERGENCY_NURSE', 'LIMS_COLLECT'),
  ('EMERGENCY_NURSE', 'RAD_READ'),
  ('EMERGENCY_NURSE', 'LAB_READ'),
  ('EMERGENCY_NURSE', 'LAB_COLLECT'),
  ('EMERGENCY_NURSE', 'PATIENT_READ'),
  ('EMERGENCY_NURSE', 'VITALS_READ'),
  ('EMERGENCY_NURSE', 'VITALS_CREATE'),
  ('EMERGENCY_NURSE', 'ALLERGY_WRITE'),
  ('EMERGENCY_NURSE', 'PRESCRIPTION_READ'),
  ('ICU_DOCTOR', 'ICU_READ'),
  ('ICU_DOCTOR', 'ICU_DOCTOR'),
  ('ICU_DOCTOR', 'PATIENT_READ'),
  ('ICU_DOCTOR', 'VITALS_READ'),
  ('ICU_DOCTOR', 'VITALS_CREATE'),
  ('ICU_DOCTOR', 'ALLERGY_WRITE'),
  ('ICU_DOCTOR', 'PRESCRIPTION_READ'),
  ('ICU_DOCTOR', 'PRESCRIPTION_CREATE'),
  ('ICU_DOCTOR', 'PRESCRIPTION_SIGN'),
  ('ICU_DOCTOR', 'LIMS_READ'),
  ('ICU_DOCTOR', 'LIMS_ORDER'),
  ('ICU_DOCTOR', 'LIMS_PRIORITY'),
  ('ICU_DOCTOR', 'RAD_READ'),
  ('ICU_DOCTOR', 'LAB_READ'),
  ('ICU_DOCTOR', 'CONSULTATION_READ'),
  ('ICU_DOCTOR', 'CONSULTATION_CREATE'),
  ('ICU_DOCTOR', 'CONSULTATION_SIGN'),
  ('ICU_DOCTOR', 'CONSULTATION_AMEND'),
  ('ICU_DOCTOR', 'ADMISSION_READ'),
  ('ICU_DOCTOR', 'ADMISSION_DISCHARGE'),
  ('ICU_DOCTOR', 'NURSING_READ'),
  ('ICU_DOCTOR', 'CHARGE_CREATE'),
  ('ICU_NURSE', 'ICU_READ'),
  ('ICU_NURSE', 'ICU_NURSE'),
  ('ICU_NURSE', 'ORDER_REQUEST'),
  ('ICU_NURSE', 'LIMS_READ'),
  ('ICU_NURSE', 'LIMS_COLLECT'),
  ('ICU_NURSE', 'RAD_READ'),
  ('ICU_NURSE', 'LAB_READ'),
  ('ICU_NURSE', 'LAB_COLLECT'),
  ('ICU_NURSE', 'CHARGE_CREATE'),
  ('ICU_NURSE', 'ADMISSION_TRANSFER'),
  ('ICU_NURSE', 'PATIENT_READ'),
  ('ICU_NURSE', 'VITALS_READ'),
  ('ICU_NURSE', 'VITALS_CREATE'),
  ('ICU_NURSE', 'ALLERGY_WRITE'),
  ('ICU_NURSE', 'NURSING_READ'),
  ('ICU_NURSE', 'NURSING_DOCUMENT'),
  ('ICU_NURSE', 'NURSING_MEDICATION_ADMINISTER'),
  ('ICU_NURSE', 'ADMISSION_READ'),
  ('ICU_NURSE', 'PRESCRIPTION_READ'),
  ('ADMINISTRATOR', 'OVERVIEW_READ'),
  ('MANAGER', 'OVERVIEW_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration 20261111220000_ward_beds_requests', 'reset', jsonb_build_object('EMERGENCY_DOCTOR', jsonb_build_array('ER_READ', 'ER_TREAT', 'PATIENT_READ', 'VITALS_READ', 'VITALS_CREATE', 'ALLERGY_WRITE', 'PRESCRIPTION_READ', 'PRESCRIPTION_CREATE', 'PRESCRIPTION_SIGN', 'LIMS_READ', 'LIMS_ORDER', 'LIMS_PRIORITY', 'RAD_READ', 'LAB_READ', 'CONSULTATION_READ'), 'EMERGENCY_NURSE', jsonb_build_array('ER_READ', 'ER_TRIAGE', 'ORDER_REQUEST', 'LIMS_READ', 'LIMS_COLLECT', 'RAD_READ', 'LAB_READ', 'LAB_COLLECT', 'PATIENT_READ', 'VITALS_READ', 'VITALS_CREATE', 'ALLERGY_WRITE', 'PRESCRIPTION_READ'), 'ICU_DOCTOR', jsonb_build_array('ICU_READ', 'ICU_DOCTOR', 'PATIENT_READ', 'VITALS_READ', 'VITALS_CREATE', 'ALLERGY_WRITE', 'PRESCRIPTION_READ', 'PRESCRIPTION_CREATE', 'PRESCRIPTION_SIGN', 'LIMS_READ', 'LIMS_ORDER', 'LIMS_PRIORITY', 'RAD_READ', 'LAB_READ', 'CONSULTATION_READ', 'CONSULTATION_CREATE', 'CONSULTATION_SIGN', 'CONSULTATION_AMEND', 'ADMISSION_READ', 'ADMISSION_DISCHARGE', 'NURSING_READ', 'CHARGE_CREATE'), 'ICU_NURSE', jsonb_build_array('ICU_READ', 'ICU_NURSE', 'ORDER_REQUEST', 'LIMS_READ', 'LIMS_COLLECT', 'RAD_READ', 'LAB_READ', 'LAB_COLLECT', 'CHARGE_CREATE', 'ADMISSION_TRANSFER', 'PATIENT_READ', 'VITALS_READ', 'VITALS_CREATE', 'ALLERGY_WRITE', 'NURSING_READ', 'NURSING_DOCUMENT', 'NURSING_MEDICATION_ADMINISTER', 'ADMISSION_READ', 'PRESCRIPTION_READ')), 'added', jsonb_build_object('ADMINISTRATOR', jsonb_build_array('OVERVIEW_READ'), 'MANAGER', jsonb_build_array('OVERVIEW_READ')))
FROM "Tenant" t;
