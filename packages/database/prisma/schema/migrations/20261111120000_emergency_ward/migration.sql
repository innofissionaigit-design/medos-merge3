-- Emergency ward: the emergency case, the triage record and the doctor's notes; an emergency visit type that becomes an inpatient visit at the OT or ICU; the emergency bill;
-- the OT and ICU wards with their rooms and beds; the emergency receptionist and emergency nurse roles.

-- CreateEnum
CREATE TYPE "EmergencyStatus" AS ENUM ('ARRIVED', 'TRIAGED', 'IN_TREATMENT', 'HANDED_OVER', 'DISCHARGED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmergencyArrival" AS ENUM ('WALK_IN', 'AMBULANCE', 'POLICE', 'REFERRED', 'OTHER');

-- CreateEnum
CREATE TYPE "EmergencyDisposition" AS ENUM ('OT', 'ICU', 'DISCHARGE');

-- CreateEnum
CREATE TYPE "TriageLevel" AS ENUM ('RED', 'ORANGE', 'YELLOW', 'GREEN', 'BLUE');

-- CreateEnum
CREATE TYPE "TriageConsciousness" AS ENUM ('ALERT', 'VOICE', 'PAIN', 'UNRESPONSIVE');

-- CreateEnum
CREATE TYPE "EmergencyNoteKind" AS ENUM ('ASSESSMENT', 'PROGRESS');

-- AlterEnum
ALTER TYPE "EncounterType" ADD VALUE 'EMERGENCY';

-- AlterEnum
ALTER TYPE "InvoiceKind" ADD VALUE 'EMERGENCY';

-- AlterEnum
ALTER TYPE "LimsOrigin" ADD VALUE 'EMERGENCY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'EMERGENCY_ARRIVAL';
ALTER TYPE "NotificationType" ADD VALUE 'EMERGENCY_TRIAGED';
ALTER TYPE "NotificationType" ADD VALUE 'EMERGENCY_DECISION';

-- CreateTable
CREATE TABLE "EmergencyCase" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "status" "EmergencyStatus" NOT NULL DEFAULT 'ARRIVED',
    "arrivalMode" "EmergencyArrival" NOT NULL DEFAULT 'WALK_IN',
    "chiefComplaint" TEXT NOT NULL,
    "broughtBy" TEXT,
    "doctorId" UUID NOT NULL,
    "arrivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registeredById" UUID NOT NULL,
    "triageLevel" "TriageLevel",
    "doctorAcceptedAt" TIMESTAMPTZ(3),
    "doctorAcceptedById" UUID,
    "disposition" "EmergencyDisposition",
    "dispositionNote" TEXT,
    "dispositionAt" TIMESTAMPTZ(3),
    "dispositionById" UUID,
    "admissionId" UUID,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmergencyCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyTriage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "level" "TriageLevel" NOT NULL,
    "consciousness" "TriageConsciousness" NOT NULL,
    "airwayClear" BOOLEAN NOT NULL,
    "breathingOk" BOOLEAN NOT NULL,
    "circulationOk" BOOLEAN NOT NULL,
    "painScore" INTEGER,
    "complaint" TEXT NOT NULL,
    "note" TEXT,
    "triagedById" UUID NOT NULL,
    "triagedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyTriage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "kind" "EmergencyNoteKind" NOT NULL,
    "text" TEXT NOT NULL,
    "diagnosis" TEXT,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyCase_encounterId_key" ON "EmergencyCase"("encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyCase_admissionId_key" ON "EmergencyCase"("admissionId");

-- CreateIndex
CREATE INDEX "EmergencyCase_tenantId_facilityId_status_arrivedAt_idx" ON "EmergencyCase"("tenantId", "facilityId", "status", "arrivedAt" DESC);

-- CreateIndex
CREATE INDEX "EmergencyCase_tenantId_patientId_arrivedAt_idx" ON "EmergencyCase"("tenantId", "patientId", "arrivedAt" DESC);

-- CreateIndex
CREATE INDEX "EmergencyCase_tenantId_doctorId_status_idx" ON "EmergencyCase"("tenantId", "doctorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyCase_tenantId_id_key" ON "EmergencyCase"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyCase_tenantId_facilityId_id_key" ON "EmergencyCase"("tenantId", "facilityId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyCase_tenantId_facilityId_caseNumber_key" ON "EmergencyCase"("tenantId", "facilityId", "caseNumber");

-- CreateIndex
CREATE INDEX "EmergencyTriage_tenantId_caseId_triagedAt_idx" ON "EmergencyTriage"("tenantId", "caseId", "triagedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyTriage_tenantId_id_key" ON "EmergencyTriage"("tenantId", "id");

-- CreateIndex
CREATE INDEX "EmergencyNote_tenantId_caseId_createdAt_idx" ON "EmergencyNote"("tenantId", "caseId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyNote_tenantId_id_key" ON "EmergencyNote"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "EmergencyCase" ADD CONSTRAINT "EmergencyCase_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyCase" ADD CONSTRAINT "EmergencyCase_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyCase" ADD CONSTRAINT "EmergencyCase_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyCase" ADD CONSTRAINT "EmergencyCase_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyCase" ADD CONSTRAINT "EmergencyCase_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "Admission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyTriage" ADD CONSTRAINT "EmergencyTriage_tenantId_caseId_fkey" FOREIGN KEY ("tenantId", "caseId") REFERENCES "EmergencyCase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyNote" ADD CONSTRAINT "EmergencyNote_tenantId_caseId_fkey" FOREIGN KEY ("tenantId", "caseId") REFERENCES "EmergencyCase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ===== emergency case: rules the database itself keeps =====
ALTER TABLE "EmergencyCase" ADD CONSTRAINT emergency_case_state CHECK (
  length(btrim("caseNumber")) >= 4 AND length(btrim("chiefComplaint")) >= 3 AND version >= 1
  AND (status NOT IN ('HANDED_OVER', 'DISCHARGED') OR (disposition IS NOT NULL AND "dispositionAt" IS NOT NULL AND "dispositionById" IS NOT NULL AND "dispositionNote" IS NOT NULL AND length(btrim("dispositionNote")) >= 3))
  AND (status <> 'HANDED_OVER' OR (disposition IN ('OT', 'ICU') AND "admissionId" IS NOT NULL))
  AND (status <> 'DISCHARGED' OR (disposition = 'DISCHARGE' AND "admissionId" IS NULL))
  AND (status IN ('HANDED_OVER', 'DISCHARGED') OR disposition IS NULL)
  AND ((status = 'CANCELLED') = ("cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 3))
  AND (("doctorAcceptedAt" IS NULL) = ("doctorAcceptedById" IS NULL)));

CREATE TRIGGER emergency_case_scope_encounter BEFORE INSERT OR UPDATE OF "encounterId" ON "EmergencyCase" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Encounter', 'encounterId');
CREATE TRIGGER emergency_case_scope_doctor BEFORE INSERT OR UPDATE OF "doctorId" ON "EmergencyCase" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Practitioner', 'doctorId');
CREATE TRIGGER emergency_case_scope_admission BEFORE INSERT OR UPDATE OF "admissionId" ON "EmergencyCase" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Admission', 'admissionId');
-- A patient is in the emergency ward once at a time.
CREATE UNIQUE INDEX "EmergencyCase_one_open_per_patient" ON "EmergencyCase" ("tenantId", "patientId") WHERE status IN ('ARRIVED', 'TRIAGED', 'IN_TREATMENT');
CREATE TRIGGER emergency_case_no_delete BEFORE DELETE ON "EmergencyCase" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- A case is opened on an emergency visit of the same patient and facility, once.
CREATE OR REPLACE FUNCTION medos_emergency_case_scope() RETURNS trigger AS $$
DECLARE e record;
BEGIN
  SELECT * INTO e FROM "Encounter" WHERE id = NEW."encounterId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR e.type::text <> 'EMERGENCY' OR e."patientId" <> NEW."patientId" OR e."facilityId" <> NEW."facilityId" THEN
    RAISE EXCEPTION 'An emergency case must belong to an emergency visit of the same patient and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER emergency_case_scope BEFORE INSERT ON "EmergencyCase" FOR EACH ROW EXECUTE FUNCTION medos_emergency_case_scope();

-- Who and what a case is cannot change; its status only moves forward; once the doctor has decided (or it was cancelled) it is closed.
CREATE OR REPLACE FUNCTION medos_emergency_case_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."encounterId" <> OLD."encounterId"
     OR NEW."caseNumber" <> OLD."caseNumber" OR NEW."doctorId" <> OLD."doctorId" OR NEW."arrivedAt" <> OLD."arrivedAt" OR NEW."registeredById" <> OLD."registeredById" OR NEW."chiefComplaint" <> OLD."chiefComplaint" THEN
    RAISE EXCEPTION 'An emergency case cannot be moved to another patient, visit or doctor' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('HANDED_OVER', 'DISCHARGED', 'CANCELLED') THEN
    RAISE EXCEPTION 'This emergency case is closed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'ARRIVED' AND NEW.status IN ('TRIAGED', 'IN_TREATMENT', 'HANDED_OVER', 'DISCHARGED', 'CANCELLED'))
    OR (OLD.status = 'TRIAGED' AND NEW.status IN ('IN_TREATMENT', 'HANDED_OVER', 'DISCHARGED'))
    OR (OLD.status = 'IN_TREATMENT' AND NEW.status IN ('HANDED_OVER', 'DISCHARGED'))) THEN
    RAISE EXCEPTION 'An emergency case cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."doctorAcceptedAt" IS NOT NULL AND NEW."doctorAcceptedAt" IS DISTINCT FROM OLD."doctorAcceptedAt" THEN
    RAISE EXCEPTION 'The time the doctor accepted the patient cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER emergency_case_guard BEFORE UPDATE ON "EmergencyCase" FOR EACH ROW EXECUTE FUNCTION medos_emergency_case_guard();

-- ===== triage records and doctor's notes: append-only, only while the case is open =====
ALTER TABLE "EmergencyTriage" ADD CONSTRAINT emergency_triage_values CHECK (("painScore" IS NULL OR "painScore" BETWEEN 0 AND 10) AND length(btrim(complaint)) >= 3 AND length(complaint) <= 300 AND (note IS NULL OR length(note) <= 1000));
ALTER TABLE "EmergencyNote" ADD CONSTRAINT emergency_note_values CHECK (length(btrim(text)) >= 3 AND length(text) <= 4000 AND (diagnosis IS NULL OR length(diagnosis) <= 300));

CREATE OR REPLACE FUNCTION medos_emergency_child_scope() RETURNS trigger AS $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM "EmergencyCase" WHERE id = NEW."caseId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR c."facilityId" <> NEW."facilityId" THEN
    RAISE EXCEPTION 'The record must belong to an emergency case of the same facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF c.status IN ('HANDED_OVER', 'DISCHARGED', 'CANCELLED') THEN
    RAISE EXCEPTION 'This emergency case is closed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER emergency_triage_scope BEFORE INSERT ON "EmergencyTriage" FOR EACH ROW EXECUTE FUNCTION medos_emergency_child_scope();
CREATE TRIGGER emergency_note_scope BEFORE INSERT ON "EmergencyNote" FOR EACH ROW EXECUTE FUNCTION medos_emergency_child_scope();
CREATE TRIGGER emergency_triage_append_only BEFORE UPDATE OR DELETE ON "EmergencyTriage" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER emergency_note_append_only BEFORE UPDATE OR DELETE ON "EmergencyNote" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"EmergencyCase"');
SELECT medos_enable_tenant_rls('"EmergencyTriage"');
SELECT medos_enable_tenant_rls('"EmergencyNote"');

-- ===== an emergency visit becomes an inpatient visit when the doctor sends the patient to the OT or the ICU (the only change of type that is allowed) =====
CREATE OR REPLACE FUNCTION medos_encounter_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId"
     OR NEW."encounterNumber" <> OLD."encounterNumber" THEN
    RAISE EXCEPTION 'Encounter identity fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.type <> OLD.type THEN
    IF NOT (OLD.type::text = 'EMERGENCY' AND NEW.type::text = 'IPD' AND OLD.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM "EmergencyCase" c WHERE c."encounterId" = OLD.id AND c."tenantId" = OLD."tenantId")) THEN
      RAISE EXCEPTION 'Encounter identity fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('COMPLETED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'Invalid encounter status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===== the laboratory: an emergency patient's tests need no consent and go straight to the laboratory, like an admitted patient's =====
ALTER TABLE "LimsRequest" DROP CONSTRAINT lims_request_state;
ALTER TABLE "LimsRequest" ADD CONSTRAINT lims_request_state CHECK (
  length(btrim("requestNumber")) >= 4 AND "recollectCount" >= 0 AND "returnedCount" >= 0 AND version >= 1
  AND (consent = 'NOT_REQUIRED') = (origin::text IN ('IPD', 'EMERGENCY'))
  AND (status NOT IN ('COLLECTED', 'IN_PROCESS', 'PENDING_REVIEW', 'PASSED', 'ISSUED', 'HANDED_OVER') OR "collectedAt" IS NOT NULL)
  AND (status NOT IN ('IN_PROCESS', 'PENDING_REVIEW', 'PASSED', 'ISSUED', 'HANDED_OVER') OR "acceptedAt" IS NOT NULL)
  AND (status NOT IN ('PENDING_REVIEW', 'PASSED', 'ISSUED', 'HANDED_OVER') OR "submittedAt" IS NOT NULL)
  AND (status NOT IN ('PASSED', 'ISSUED', 'HANDED_OVER') OR "passedAt" IS NOT NULL)
  AND (status NOT IN ('ISSUED', 'HANDED_OVER') OR "issuedAt" IS NOT NULL)
  AND (status <> 'HANDED_OVER' OR ("handedOverAt" IS NOT NULL AND origin::text = 'OPD'))
  AND ((status = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 3))
  AND ("instructions" IS NULL OR length("instructions") <= 800) AND ("clinicalNote" IS NULL OR length("clinicalNote") <= 600));

-- ===== data: the emergency department, the operation theatre and the intensive care unit of every existing facility =====
INSERT INTO "Department" ("tenantId", "facilityId", name, code, "updatedAt")
SELECT f."tenantId", f.id, 'Emergency Medicine', 'EM', CURRENT_TIMESTAMP FROM "Facility" f ON CONFLICT DO NOTHING;

INSERT INTO "Ward" ("tenantId", "facilityId", name, code, "updatedAt")
SELECT f."tenantId", f.id, w.name, w.code, CURRENT_TIMESTAMP FROM "Facility" f CROSS JOIN (VALUES ('Operation Theatre', 'OT'), ('Intensive Care Unit', 'ICU')) AS w(name, code) ON CONFLICT DO NOTHING;

-- Two operating rooms and three ICU rooms, each with one bed (the operating table, the ICU bed).
INSERT INTO "Room" ("tenantId", "facilityId", "wardId", name, code, "updatedAt")
SELECT w."tenantId", w."facilityId", w.id, r.name, r.code, CURRENT_TIMESTAMP
FROM "Ward" w JOIN (VALUES ('OT', 'Operating Room 1', 'OT-1'), ('OT', 'Operating Room 2', 'OT-2'), ('ICU', 'ICU Room 1', 'ICU-1'), ('ICU', 'ICU Room 2', 'ICU-2'), ('ICU', 'ICU Room 3', 'ICU-3')) AS r(ward, name, code) ON r.ward = w.code
ON CONFLICT DO NOTHING;

INSERT INTO "Bed" ("tenantId", "facilityId", "wardId", "roomId", code, "dailyRate", "updatedAt")
SELECT r."tenantId", r."facilityId", r."wardId", r.id, b.bed, b.rate, CURRENT_TIMESTAMP
FROM "Room" r JOIN (VALUES ('OT-1', 'OT1', 3000), ('OT-2', 'OT2', 3000), ('ICU-1', 'ICU1', 6000), ('ICU-2', 'ICU2', 6000), ('ICU-3', 'ICU3', 6000)) AS b(room, bed, rate) ON b.room = r.code
ON CONFLICT DO NOTHING;

-- ===== data: the two new roles, and the new permissions for the doctor and the oversight roles =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, r.name, true FROM "Tenant" t CROSS JOIN (VALUES ('EMERGENCY_RECEPTIONIST'), ('EMERGENCY_NURSE')) AS r(name) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('EMERGENCY_RECEPTIONIST', 'ER_READ'), ('EMERGENCY_RECEPTIONIST', 'ER_REGISTER'), ('EMERGENCY_RECEPTIONIST', 'ER_BILL'),
  ('EMERGENCY_RECEPTIONIST', 'PATIENT_READ'), ('EMERGENCY_RECEPTIONIST', 'PATIENT_CREATE'), ('EMERGENCY_RECEPTIONIST', 'PATIENT_UPDATE'), ('EMERGENCY_RECEPTIONIST', 'DUPLICATE_OVERRIDE'), ('EMERGENCY_RECEPTIONIST', 'REGISTRATION_FEE_EXEMPT'),
  ('EMERGENCY_RECEPTIONIST', 'INVOICE_READ'), ('EMERGENCY_RECEPTIONIST', 'PAYMENT_CREATE'), ('EMERGENCY_RECEPTIONIST', 'CASHIER_SHIFT_MANAGE'),
  ('EMERGENCY_NURSE', 'ER_READ'), ('EMERGENCY_NURSE', 'ER_TRIAGE'),
  ('EMERGENCY_NURSE', 'LIMS_READ'), ('EMERGENCY_NURSE', 'LIMS_COLLECT'), ('EMERGENCY_NURSE', 'RAD_READ'), ('EMERGENCY_NURSE', 'LAB_READ'), ('EMERGENCY_NURSE', 'LAB_COLLECT'), ('EMERGENCY_NURSE', 'CHARGE_CREATE'), ('EMERGENCY_NURSE', 'ADMISSION_TRANSFER'),
  ('EMERGENCY_NURSE', 'PATIENT_READ'), ('EMERGENCY_NURSE', 'VITALS_READ'), ('EMERGENCY_NURSE', 'VITALS_CREATE'), ('EMERGENCY_NURSE', 'ALLERGY_WRITE'), ('EMERGENCY_NURSE', 'NURSING_READ'), ('EMERGENCY_NURSE', 'NURSING_DOCUMENT'),
  ('EMERGENCY_NURSE', 'NURSING_MEDICATION_ADMINISTER'), ('EMERGENCY_NURSE', 'ADMISSION_READ'), ('EMERGENCY_NURSE', 'PRESCRIPTION_READ'), ('EMERGENCY_NURSE', 'QUEUE_READ'), ('EMERGENCY_NURSE', 'REPORT_IPD'),
  ('DOCTOR', 'ER_READ'), ('DOCTOR', 'ER_TREAT'),
  ('ADMINISTRATOR', 'ER_READ'), ('MANAGER', 'ER_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration 20261111120000_emergency_ward', 'added', jsonb_build_object(
  'EMERGENCY_RECEPTIONIST', jsonb_build_array('ER_READ', 'ER_REGISTER', 'ER_BILL', 'PATIENT_READ', 'PATIENT_CREATE', 'PATIENT_UPDATE', 'DUPLICATE_OVERRIDE', 'REGISTRATION_FEE_EXEMPT', 'INVOICE_READ', 'PAYMENT_CREATE', 'CASHIER_SHIFT_MANAGE'),
  'EMERGENCY_NURSE', jsonb_build_array('ER_READ', 'ER_TRIAGE', 'and every permission of the NURSE role'), 'DOCTOR', jsonb_build_array('ER_READ', 'ER_TREAT'), 'ADMINISTRATOR', jsonb_build_array('ER_READ'), 'MANAGER', jsonb_build_array('ER_READ')))
FROM "Tenant" t;
