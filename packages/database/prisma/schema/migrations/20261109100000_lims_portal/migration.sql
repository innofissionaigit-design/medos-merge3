-- CreateEnum
CREATE TYPE "LimsDepartmentKind" AS ENUM ('PATHOLOGY', 'RADIOLOGY');

-- CreateEnum
CREATE TYPE "LimsOrigin" AS ENUM ('OPD', 'IPD');

-- CreateEnum
CREATE TYPE "LimsPriority" AS ENUM ('EMERGENCY', 'URGENT', 'ROUTINE');

-- CreateEnum
CREATE TYPE "LimsConsent" AS ENUM ('NOT_REQUIRED', 'GIVEN');

-- CreateEnum
CREATE TYPE "LimsStatus" AS ENUM ('PENDING_COLLECTION', 'COLLECTED', 'IN_PROCESS', 'PENDING_REVIEW', 'PASSED', 'ISSUED', 'HANDED_OVER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LimsInstrumentStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE');

-- CreateEnum
CREATE TYPE "LimsQcResult" AS ENUM ('PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "LimsExceptionKind" AS ENUM ('QUEUE_JUMP', 'COMPROMISED_SAMPLE', 'DELAYED_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "LimsExceptionStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'LIMS_COLLECTION_WAITING';
ALTER TYPE "NotificationType" ADD VALUE 'LIMS_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'LIMS_SAMPLE_READY';
ALTER TYPE "NotificationType" ADD VALUE 'LIMS_REVIEW_WAITING';
ALTER TYPE "NotificationType" ADD VALUE 'LIMS_READY_TO_ISSUE';
ALTER TYPE "NotificationType" ADD VALUE 'LIMS_REPORT_ISSUED';
ALTER TYPE "NotificationType" ADD VALUE 'LIMS_EXCEPTION_RAISED';

-- CreateTable
CREATE TABLE "LimsDepartment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "kind" "LimsDepartmentKind" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "routineTatMinutes" INTEGER NOT NULL DEFAULT 1440,
    "urgentTatMinutes" INTEGER NOT NULL DEFAULT 360,
    "emergencyTatMinutes" INTEGER NOT NULL DEFAULT 120,
    "defaultInstructions" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LimsDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimsRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "testOrderId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "batchId" UUID NOT NULL,
    "origin" "LimsOrigin" NOT NULL,
    "priority" "LimsPriority" NOT NULL DEFAULT 'ROUTINE',
    "status" "LimsStatus" NOT NULL DEFAULT 'PENDING_COLLECTION',
    "consent" "LimsConsent" NOT NULL,
    "scheduledFor" TIMESTAMPTZ(3),
    "instructions" TEXT,
    "clinicalNote" TEXT,
    "assignedNurseId" UUID,
    "assignedTechId" UUID,
    "requestedById" UUID NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "recollectCount" INTEGER NOT NULL DEFAULT 0,
    "needsRecollection" BOOLEAN NOT NULL DEFAULT false,
    "returnedCount" INTEGER NOT NULL DEFAULT 0,
    "compromisedSampleApproved" BOOLEAN NOT NULL DEFAULT false,
    "collectedAt" TIMESTAMPTZ(3),
    "collectedById" UUID,
    "acceptedAt" TIMESTAMPTZ(3),
    "acceptedById" UUID,
    "submittedAt" TIMESTAMPTZ(3),
    "submittedById" UUID,
    "passedAt" TIMESTAMPTZ(3),
    "passedById" UUID,
    "issuedAt" TIMESTAMPTZ(3),
    "issuedById" UUID,
    "handedOverAt" TIMESTAMPTZ(3),
    "handedOverById" UUID,
    "handedOverTo" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LimsRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimsRequestEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" "LimsStatus",
    "toStatus" "LimsStatus",
    "actorUserId" UUID,
    "note" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LimsRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimsInstrument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "serialNumber" TEXT,
    "status" "LimsInstrumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastCalibratedAt" TIMESTAMPTZ(3),
    "nextCalibrationDue" TIMESTAMPTZ(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LimsInstrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimsQcRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "instrumentId" UUID,
    "subject" TEXT NOT NULL,
    "level" TEXT,
    "unit" TEXT,
    "expected" DECIMAL(12,3),
    "observed" DECIMAL(12,3),
    "lowLimit" DECIMAL(12,3),
    "highLimit" DECIMAL(12,3),
    "result" "LimsQcResult" NOT NULL,
    "note" TEXT,
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewNote" TEXT,
    "actionRequired" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LimsQcRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimsException" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "kind" "LimsExceptionKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LimsExceptionStatus" NOT NULL DEFAULT 'PENDING',
    "raisedById" UUID NOT NULL,
    "raisedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,

    CONSTRAINT "LimsException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimsMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
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

    CONSTRAINT "LimsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LimsDepartment_tenantId_id_key" ON "LimsDepartment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LimsDepartment_tenantId_facilityId_kind_key" ON "LimsDepartment"("tenantId", "facilityId", "kind");

-- CreateIndex
CREATE INDEX "LimsRequest_tenantId_facilityId_departmentId_status_priorit_idx" ON "LimsRequest"("tenantId", "facilityId", "departmentId", "status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "LimsRequest_tenantId_facilityId_status_dueAt_idx" ON "LimsRequest"("tenantId", "facilityId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "LimsRequest_tenantId_assignedNurseId_status_idx" ON "LimsRequest"("tenantId", "assignedNurseId", "status");

-- CreateIndex
CREATE INDEX "LimsRequest_tenantId_assignedTechId_status_idx" ON "LimsRequest"("tenantId", "assignedTechId", "status");

-- CreateIndex
CREATE INDEX "LimsRequest_tenantId_encounterId_idx" ON "LimsRequest"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "LimsRequest_tenantId_batchId_idx" ON "LimsRequest"("tenantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "LimsRequest_tenantId_id_key" ON "LimsRequest"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LimsRequest_tenantId_testOrderId_key" ON "LimsRequest"("tenantId", "testOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "LimsRequest_tenantId_facilityId_requestNumber_key" ON "LimsRequest"("tenantId", "facilityId", "requestNumber");

-- CreateIndex
CREATE INDEX "LimsRequestEvent_tenantId_requestId_at_idx" ON "LimsRequestEvent"("tenantId", "requestId", "at");

-- CreateIndex
CREATE INDEX "LimsRequestEvent_tenantId_kind_at_idx" ON "LimsRequestEvent"("tenantId", "kind", "at");

-- CreateIndex
CREATE UNIQUE INDEX "LimsRequestEvent_tenantId_id_key" ON "LimsRequestEvent"("tenantId", "id");

-- CreateIndex
CREATE INDEX "LimsInstrument_tenantId_facilityId_departmentId_status_idx" ON "LimsInstrument"("tenantId", "facilityId", "departmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LimsInstrument_tenantId_id_key" ON "LimsInstrument"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LimsInstrument_tenantId_facilityId_name_key" ON "LimsInstrument"("tenantId", "facilityId", "name");

-- CreateIndex
CREATE INDEX "LimsQcRecord_tenantId_facilityId_departmentId_recordedAt_idx" ON "LimsQcRecord"("tenantId", "facilityId", "departmentId", "recordedAt" DESC);

-- CreateIndex
CREATE INDEX "LimsQcRecord_tenantId_facilityId_result_reviewedAt_idx" ON "LimsQcRecord"("tenantId", "facilityId", "result", "reviewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LimsQcRecord_tenantId_id_key" ON "LimsQcRecord"("tenantId", "id");

-- CreateIndex
CREATE INDEX "LimsException_tenantId_facilityId_status_raisedAt_idx" ON "LimsException"("tenantId", "facilityId", "status", "raisedAt");

-- CreateIndex
CREATE INDEX "LimsException_tenantId_requestId_idx" ON "LimsException"("tenantId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "LimsException_tenantId_id_key" ON "LimsException"("tenantId", "id");

-- CreateIndex
CREATE INDEX "LimsMessage_status_nextAttemptAt_idx" ON "LimsMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "LimsMessage_tenantId_id_key" ON "LimsMessage"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LimsMessage_tenantId_batchId_kind_channel_key" ON "LimsMessage"("tenantId", "batchId", "kind", "channel");

-- AddForeignKey
ALTER TABLE "LimsDepartment" ADD CONSTRAINT "LimsDepartment_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimsRequest" ADD CONSTRAINT "LimsRequest_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimsRequest" ADD CONSTRAINT "LimsRequest_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimsRequest" ADD CONSTRAINT "LimsRequest_tenantId_testOrderId_fkey" FOREIGN KEY ("tenantId", "testOrderId") REFERENCES "TestOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimsRequest" ADD CONSTRAINT "LimsRequest_tenantId_departmentId_fkey" FOREIGN KEY ("tenantId", "departmentId") REFERENCES "LimsDepartment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimsRequestEvent" ADD CONSTRAINT "LimsRequestEvent_tenantId_requestId_fkey" FOREIGN KEY ("tenantId", "requestId") REFERENCES "LimsRequest"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimsInstrument" ADD CONSTRAINT "LimsInstrument_tenantId_departmentId_fkey" FOREIGN KEY ("tenantId", "departmentId") REFERENCES "LimsDepartment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimsQcRecord" ADD CONSTRAINT "LimsQcRecord_tenantId_departmentId_fkey" FOREIGN KEY ("tenantId", "departmentId") REFERENCES "LimsDepartment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimsQcRecord" ADD CONSTRAINT "LimsQcRecord_tenantId_instrumentId_fkey" FOREIGN KEY ("tenantId", "instrumentId") REFERENCES "LimsInstrument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimsException" ADD CONSTRAINT "LimsException_tenantId_requestId_fkey" FOREIGN KEY ("tenantId", "requestId") REFERENCES "LimsRequest"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ===== Hand-written invariants =====
-- LIMS portal: docs/lims-portal.md. A request follows one test order through the laboratory; its history is append-only; clinical records stay where they are.

-- A sample, result or study may now belong to a test that the LIMS has taken in (an OPD test launched after the patient agreed, or an admitted patient's test), not only to a
-- billed test: billing is a separate step that can happen before or after the work (docs/lims-portal.md, "Billing"). A cancelled test is still refused.
CREATE OR REPLACE FUNCTION medos_lab_order_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "TestOrder" o WHERE o.id = NEW."testOrderId" AND o."tenantId" = NEW."tenantId" AND o."facilityId" = NEW."facilityId" AND o."patientId" = NEW."patientId"
                 AND o."encounterId" = NEW."encounterId" AND o.category = 'LABORATORY'
                 AND (o.status = 'BILLED' OR (o.status = 'ORDERED' AND EXISTS (SELECT 1 FROM "LimsRequest" r WHERE r."tenantId" = o."tenantId" AND r."testOrderId" = o.id AND r.status <> 'CANCELLED')))) THEN
    RAISE EXCEPTION 'A sample or result must belong to a billed laboratory test (or one the LIMS has taken in) of the same patient, visit and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION medos_rad_study_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "TestOrder" o WHERE o.id = NEW."testOrderId" AND o."tenantId" = NEW."tenantId" AND o."facilityId" = NEW."facilityId" AND o."patientId" = NEW."patientId"
                 AND o."encounterId" = NEW."encounterId" AND o.category = 'RADIOLOGY'
                 AND (o.status = 'BILLED' OR (o.status = 'ORDERED' AND EXISTS (SELECT 1 FROM "LimsRequest" r WHERE r."tenantId" = o."tenantId" AND r."testOrderId" = o.id AND r.status <> 'CANCELLED')))) THEN
    RAISE EXCEPTION 'A radiology study must belong to a billed radiology test (or one the LIMS has taken in) of the same patient, visit and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- A doctor can also order a test straight into the LIMS (an admitted patient's tests have no consultation to come from): source LIMS.
ALTER TABLE "TestOrder" DROP CONSTRAINT "TestOrder_source_check";
ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_source_check" CHECK (source IN ('DIGITAL', 'HANDWRITTEN', 'CASHIER', 'LIMS'));

-- ===== departments =====
ALTER TABLE "LimsDepartment" ADD CONSTRAINT lims_department_values CHECK (length(btrim(name)) BETWEEN 2 AND 80 AND "routineTatMinutes" BETWEEN 5 AND 43200
  AND "urgentTatMinutes" BETWEEN 5 AND "routineTatMinutes" AND "emergencyTatMinutes" BETWEEN 5 AND "urgentTatMinutes" AND ("defaultInstructions" IS NULL OR length("defaultInstructions") <= 600));
CREATE OR REPLACE FUNCTION medos_lims_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted; make them inactive or cancel them instead', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lims_department_no_delete BEFORE DELETE ON "LimsDepartment" FOR EACH ROW EXECUTE FUNCTION medos_lims_no_delete();
CREATE TRIGGER lims_instrument_no_delete BEFORE DELETE ON "LimsInstrument" FOR EACH ROW EXECUTE FUNCTION medos_lims_no_delete();
CREATE TRIGGER lims_request_no_delete BEFORE DELETE ON "LimsRequest" FOR EACH ROW EXECUTE FUNCTION medos_lims_no_delete();
CREATE TRIGGER lims_qc_no_delete BEFORE DELETE ON "LimsQcRecord" FOR EACH ROW EXECUTE FUNCTION medos_lims_no_delete();
CREATE TRIGGER lims_exception_no_delete BEFORE DELETE ON "LimsException" FOR EACH ROW EXECUTE FUNCTION medos_lims_no_delete();

-- ===== requests =====
ALTER TABLE "LimsRequest" ADD CONSTRAINT lims_request_state CHECK (
  length(btrim("requestNumber")) >= 4 AND "recollectCount" >= 0 AND "returnedCount" >= 0 AND version >= 1
  AND (consent = 'NOT_REQUIRED') = (origin = 'IPD')
  AND (status NOT IN ('COLLECTED', 'IN_PROCESS', 'PENDING_REVIEW', 'PASSED', 'ISSUED', 'HANDED_OVER') OR "collectedAt" IS NOT NULL)
  AND (status NOT IN ('IN_PROCESS', 'PENDING_REVIEW', 'PASSED', 'ISSUED', 'HANDED_OVER') OR "acceptedAt" IS NOT NULL)
  AND (status NOT IN ('PENDING_REVIEW', 'PASSED', 'ISSUED', 'HANDED_OVER') OR "submittedAt" IS NOT NULL)
  AND (status NOT IN ('PASSED', 'ISSUED', 'HANDED_OVER') OR "passedAt" IS NOT NULL)
  AND (status NOT IN ('ISSUED', 'HANDED_OVER') OR "issuedAt" IS NOT NULL)
  AND (status <> 'HANDED_OVER' OR ("handedOverAt" IS NOT NULL AND origin = 'OPD'))
  AND ((status = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 3))
  AND ("instructions" IS NULL OR length("instructions") <= 800) AND ("clinicalNote" IS NULL OR length("clinicalNote") <= 600));

-- A request belongs to a laboratory or radiology test of the same patient, visit and facility that has not been cancelled; the department matches the kind of test;
-- an OPD visit needs the patient's agreement and an admitted patient does not.
CREATE OR REPLACE FUNCTION medos_lims_request_scope() RETURNS trigger AS $$
DECLARE o record; d record; etype text;
BEGIN
  SELECT * INTO o FROM "TestOrder" WHERE id = NEW."testOrderId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR o."facilityId" <> NEW."facilityId" OR o."patientId" <> NEW."patientId" OR o."encounterId" <> NEW."encounterId" OR o.status = 'CANCELLED' OR o.category NOT IN ('LABORATORY', 'RADIOLOGY') THEN
    RAISE EXCEPTION 'A LIMS request must belong to a laboratory or radiology test of the same patient, visit and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO d FROM "LimsDepartment" WHERE id = NEW."departmentId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR d."facilityId" <> NEW."facilityId" OR (o.category = 'LABORATORY') <> (d.kind = 'PATHOLOGY') THEN
    RAISE EXCEPTION 'The LIMS department does not match the kind of test' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT type::text INTO etype FROM "Encounter" WHERE id = NEW."encounterId" AND "tenantId" = NEW."tenantId";
  IF etype IS DISTINCT FROM NEW.origin::text THEN
    RAISE EXCEPTION 'The request origin must match the visit type' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lims_request_scope BEFORE INSERT ON "LimsRequest" FOR EACH ROW EXECUTE FUNCTION medos_lims_request_scope();

CREATE OR REPLACE FUNCTION medos_lims_request_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."encounterId" <> OLD."encounterId"
     OR NEW."testOrderId" <> OLD."testOrderId" OR NEW."departmentId" <> OLD."departmentId" OR NEW."requestNumber" <> OLD."requestNumber" OR NEW."batchId" <> OLD."batchId"
     OR NEW.origin <> OLD.origin OR NEW.consent <> OLD.consent OR NEW."requestedById" <> OLD."requestedById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'A LIMS request cannot be moved to another patient, visit, test or department' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING_COLLECTION' AND NEW.status IN ('COLLECTED', 'CANCELLED'))
    OR (OLD.status = 'COLLECTED' AND NEW.status IN ('IN_PROCESS', 'PENDING_COLLECTION', 'CANCELLED'))
    OR (OLD.status = 'IN_PROCESS' AND NEW.status IN ('PENDING_REVIEW', 'PENDING_COLLECTION', 'CANCELLED'))
    OR (OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('PASSED', 'IN_PROCESS'))
    OR (OLD.status = 'PASSED' AND NEW.status = 'ISSUED')
    OR (OLD.status = 'ISSUED' AND NEW.status = 'HANDED_OVER')) THEN
    RAISE EXCEPTION 'A LIMS request cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (OLD."issuedAt" IS NOT NULL AND NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt") OR (OLD."handedOverAt" IS NOT NULL AND NEW."handedOverAt" IS DISTINCT FROM OLD."handedOverAt")
     OR (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt") OR (OLD."passedAt" IS NOT NULL AND NEW.status IN ('ISSUED', 'HANDED_OVER') AND NEW."passedAt" IS DISTINCT FROM OLD."passedAt") THEN
    RAISE EXCEPTION 'The time a report was passed, issued or handed over, or a request cancelled, cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lims_request_guard BEFORE UPDATE ON "LimsRequest" FOR EACH ROW EXECUTE FUNCTION medos_lims_request_guard();

-- ===== history =====
ALTER TABLE "LimsRequestEvent" ADD CONSTRAINT lims_event_values CHECK (length(btrim(kind)) BETWEEN 1 AND 40 AND (note IS NULL OR length(note) <= 500));
CREATE TRIGGER lims_event_immutable BEFORE UPDATE OR DELETE ON "LimsRequestEvent" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== instruments and quality control =====
ALTER TABLE "LimsInstrument" ADD CONSTRAINT lims_instrument_values CHECK (length(btrim(name)) BETWEEN 2 AND 80);
ALTER TABLE "LimsQcRecord" ADD CONSTRAINT lims_qc_values CHECK (length(btrim(subject)) BETWEEN 2 AND 120 AND ("lowLimit" IS NULL OR "highLimit" IS NULL OR "lowLimit" <= "highLimit")
  AND ("reviewedAt" IS NULL) = ("reviewedById" IS NULL) AND ("reviewNote" IS NULL OR length("reviewNote") <= 400) AND (note IS NULL OR length(note) <= 400)
  AND ("actionRequired" = false OR "reviewedAt" IS NOT NULL));
-- A quality-control run is a record of what was measured: it is never changed. Only the manager's review is added, once.
CREATE OR REPLACE FUNCTION medos_lims_qc_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."reviewedAt" IS NOT NULL OR NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."departmentId" <> OLD."departmentId"
     OR NEW."instrumentId" IS DISTINCT FROM OLD."instrumentId" OR NEW.subject <> OLD.subject OR NEW.level IS DISTINCT FROM OLD.level OR NEW.expected IS DISTINCT FROM OLD.expected
     OR NEW.observed IS DISTINCT FROM OLD.observed OR NEW."lowLimit" IS DISTINCT FROM OLD."lowLimit" OR NEW."highLimit" IS DISTINCT FROM OLD."highLimit" OR NEW.result <> OLD.result
     OR NEW."recordedById" <> OLD."recordedById" OR NEW."recordedAt" <> OLD."recordedAt" THEN
    RAISE EXCEPTION 'A quality-control record cannot be changed; only a review can be added, once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lims_qc_guard BEFORE UPDATE ON "LimsQcRecord" FOR EACH ROW EXECUTE FUNCTION medos_lims_qc_guard();

-- ===== exceptions =====
ALTER TABLE "LimsException" ADD CONSTRAINT lims_exception_values CHECK (length(btrim(reason)) BETWEEN 5 AND 400 AND (status = 'PENDING') = ("decidedAt" IS NULL AND "decidedById" IS NULL)
  AND (status = 'PENDING' OR "decidedById" <> "raisedById"));
CREATE OR REPLACE FUNCTION medos_lims_exception_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'PENDING' OR NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."requestId" <> OLD."requestId" OR NEW.kind <> OLD.kind OR NEW.reason <> OLD.reason
     OR NEW."raisedById" <> OLD."raisedById" OR NEW."raisedAt" <> OLD."raisedAt" THEN
    RAISE EXCEPTION 'A decided exception cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lims_exception_guard BEFORE UPDATE ON "LimsException" FOR EACH ROW EXECUTE FUNCTION medos_lims_exception_guard();

-- ===== messages to the patient =====
ALTER TABLE "LimsMessage" ADD CONSTRAINT lims_message_values CHECK (kind IN ('SCHEDULED', 'REPORT_READY') AND channel IN ('WHATSAPP', 'SMS') AND attempts >= 0);
CREATE OR REPLACE FUNCTION medos_tenants_with_due_lims_messages(p_now timestamptz) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT d."tenantId" FROM public."LimsMessage" d WHERE d.status = 'PENDING' AND d."nextAttemptAt" <= p_now $$;
REVOKE ALL ON FUNCTION medos_tenants_with_due_lims_messages(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_tenants_with_due_lims_messages(timestamptz) TO medos_app;

SELECT medos_enable_tenant_rls('"LimsDepartment"');
SELECT medos_enable_tenant_rls('"LimsRequest"');
SELECT medos_enable_tenant_rls('"LimsRequestEvent"');
SELECT medos_enable_tenant_rls('"LimsInstrument"');
SELECT medos_enable_tenant_rls('"LimsQcRecord"');
SELECT medos_enable_tenant_rls('"LimsException"');
SELECT medos_enable_tenant_rls('"LimsMessage"');

-- ===== data: the two departments of every existing facility, the three new roles, and the new permissions for existing roles =====
INSERT INTO "LimsDepartment" ("tenantId", "facilityId", kind, name, "routineTatMinutes", "urgentTatMinutes", "emergencyTatMinutes", "updatedAt")
SELECT f."tenantId", f.id, d.kind::"LimsDepartmentKind", d.name, d.routine, d.urgent, d.emergency, CURRENT_TIMESTAMP
FROM "Facility" f CROSS JOIN (VALUES ('PATHOLOGY', 'Pathology', 1440, 360, 120), ('RADIOLOGY', 'Radiology', 1440, 360, 60)) AS d(kind, name, routine, urgent, emergency)
ON CONFLICT DO NOTHING;

INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, r.name, true FROM "Tenant" t CROSS JOIN (VALUES ('LIMS_MANAGER'), ('P_LAB_TECH'), ('R_LAB_TECH')) AS r(name) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('LIMS_MANAGER', 'LIMS_READ'), ('LIMS_MANAGER', 'LIMS_REPORTS'), ('LIMS_MANAGER', 'LIMS_ASSIGN'), ('LIMS_MANAGER', 'LIMS_PRIORITY'), ('LIMS_MANAGER', 'LIMS_MANAGE'), ('LIMS_MANAGER', 'LIMS_QC'),
  ('LIMS_MANAGER', 'LAB_READ'), ('LIMS_MANAGER', 'RAD_READ'), ('LIMS_MANAGER', 'PATIENT_READ'),
  ('P_LAB_TECH', 'LIMS_READ'), ('P_LAB_TECH', 'LIMS_ISSUE'), ('P_LAB_TECH', 'LIMS_QC'), ('P_LAB_TECH', 'LAB_READ'), ('P_LAB_TECH', 'LAB_RESULT'), ('P_LAB_TECH', 'PATIENT_READ'),
  ('R_LAB_TECH', 'LIMS_READ'), ('R_LAB_TECH', 'LIMS_ISSUE'), ('R_LAB_TECH', 'LIMS_QC'), ('R_LAB_TECH', 'RAD_READ'), ('R_LAB_TECH', 'RAD_PERFORM'), ('R_LAB_TECH', 'PATIENT_READ'),
  ('ADMINISTRATOR', 'LIMS_READ'), ('ADMINISTRATOR', 'LIMS_REPORTS'), ('ADMINISTRATOR', 'LIMS_DEPARTMENTS'),
  ('MANAGER', 'LIMS_READ'), ('MANAGER', 'LIMS_REPORTS'),
  ('RECEPTIONIST', 'LIMS_READ'), ('RECEPTIONIST', 'LIMS_REQUEST'), ('RECEPTIONIST', 'LIMS_PRIORITY'),
  ('DOCTOR', 'LIMS_READ'), ('DOCTOR', 'LIMS_ORDER'), ('DOCTOR', 'LIMS_PRIORITY'),
  ('NURSE', 'LIMS_READ'), ('NURSE', 'LIMS_COLLECT'),
  ('PATHOLOGIST', 'LIMS_READ'), ('RADIOLOGIST', 'LIMS_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration 20261109100000_lims_portal', 'added', jsonb_build_object(
  'LIMS_MANAGER', jsonb_build_array('LIMS_READ', 'LIMS_REPORTS', 'LIMS_ASSIGN', 'LIMS_PRIORITY', 'LIMS_MANAGE', 'LIMS_QC', 'LAB_READ', 'RAD_READ', 'PATIENT_READ'),
  'P_LAB_TECH', jsonb_build_array('LIMS_READ', 'LIMS_ISSUE', 'LIMS_QC', 'LAB_READ', 'LAB_RESULT', 'PATIENT_READ'),
  'R_LAB_TECH', jsonb_build_array('LIMS_READ', 'LIMS_ISSUE', 'LIMS_QC', 'RAD_READ', 'RAD_PERFORM', 'PATIENT_READ'),
  'ADMINISTRATOR', jsonb_build_array('LIMS_READ', 'LIMS_REPORTS', 'LIMS_DEPARTMENTS'), 'MANAGER', jsonb_build_array('LIMS_READ', 'LIMS_REPORTS'),
  'RECEPTIONIST', jsonb_build_array('LIMS_READ', 'LIMS_REQUEST', 'LIMS_PRIORITY'), 'DOCTOR', jsonb_build_array('LIMS_READ', 'LIMS_ORDER', 'LIMS_PRIORITY'),
  'NURSE', jsonb_build_array('LIMS_READ', 'LIMS_COLLECT'), 'PATHOLOGIST', jsonb_build_array('LIMS_READ'), 'RADIOLOGIST', jsonb_build_array('LIMS_READ')))
FROM "Tenant" t;
