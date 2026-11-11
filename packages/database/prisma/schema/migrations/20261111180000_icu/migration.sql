-- Intensive care unit: how often vitals are taken, the doctor's instructions for the nurse, the doctor's day-by-day record; the ICU doctor and ICU nurse roles.

-- CreateEnum
CREATE TYPE "IcuInstructionStatus" AS ENUM ('OPEN', 'DONE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ICU_ADMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'ICU_INSTRUCTION';
ALTER TYPE "NotificationType" ADD VALUE 'ICU_VITALS_SCHEDULE';

-- CreateTable
CREATE TABLE "IcuVitalsOrder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "intervalMinutes" INTEGER NOT NULL,
    "reason" TEXT,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IcuVitalsOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IcuInstruction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "status" "IcuInstructionStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneById" UUID,
    "doneAt" TIMESTAMPTZ(3),
    "doneNote" TEXT,

    CONSTRAINT "IcuInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IcuDayNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "text" TEXT NOT NULL,
    "plan" TEXT,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IcuDayNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IcuVitalsOrder_tenantId_admissionId_setAt_idx" ON "IcuVitalsOrder"("tenantId", "admissionId", "setAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "IcuVitalsOrder_tenantId_id_key" ON "IcuVitalsOrder"("tenantId", "id");

-- CreateIndex
CREATE INDEX "IcuInstruction_tenantId_admissionId_status_createdAt_idx" ON "IcuInstruction"("tenantId", "admissionId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "IcuInstruction_tenantId_facilityId_status_idx" ON "IcuInstruction"("tenantId", "facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IcuInstruction_tenantId_id_key" ON "IcuInstruction"("tenantId", "id");

-- CreateIndex
CREATE INDEX "IcuDayNote_tenantId_admissionId_day_createdAt_idx" ON "IcuDayNote"("tenantId", "admissionId", "day" DESC, "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "IcuDayNote_tenantId_id_key" ON "IcuDayNote"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "IcuVitalsOrder" ADD CONSTRAINT "IcuVitalsOrder_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IcuInstruction" ADD CONSTRAINT "IcuInstruction_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IcuDayNote" ADD CONSTRAINT "IcuDayNote_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ===== rules the database itself keeps =====
ALTER TABLE "IcuVitalsOrder" ADD CONSTRAINT icu_vitals_interval CHECK ("intervalMinutes" IN (5, 15, 60, 120) AND ("reason" IS NULL OR length("reason") <= 300));
ALTER TABLE "IcuInstruction" ADD CONSTRAINT icu_instruction_state CHECK (
  length(btrim(text)) >= 3 AND length(text) <= 1000
  AND ((status = 'DONE') = ("doneAt" IS NOT NULL AND "doneById" IS NOT NULL))
  AND ("doneNote" IS NULL OR (status = 'DONE' AND length("doneNote") <= 500)));
ALTER TABLE "IcuDayNote" ADD CONSTRAINT icu_day_note_values CHECK (length(btrim(text)) >= 3 AND length(text) <= 4000 AND ("plan" IS NULL OR length("plan") <= 2000));

-- Something is recorded only on a stay that is still open (the patient is admitted).
CREATE OR REPLACE FUNCTION medos_icu_stay_open() RETURNS trigger AS $$
DECLARE a record;
BEGIN
  SELECT status::text AS status INTO a FROM "Admission" WHERE id = NEW."admissionId" AND "tenantId" = NEW."tenantId" AND "facilityId" = NEW."facilityId";
  IF NOT FOUND OR a.status <> 'ADMITTED' THEN
    RAISE EXCEPTION 'The ICU record can be added to only while the patient is admitted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER icu_vitals_order_open BEFORE INSERT ON "IcuVitalsOrder" FOR EACH ROW EXECUTE FUNCTION medos_icu_stay_open();
CREATE TRIGGER icu_instruction_open BEFORE INSERT ON "IcuInstruction" FOR EACH ROW EXECUTE FUNCTION medos_icu_stay_open();
CREATE TRIGGER icu_day_note_open BEFORE INSERT ON "IcuDayNote" FOR EACH ROW EXECUTE FUNCTION medos_icu_stay_open();

CREATE TRIGGER icu_vitals_order_append_only BEFORE UPDATE OR DELETE ON "IcuVitalsOrder" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER icu_day_note_append_only BEFORE UPDATE OR DELETE ON "IcuDayNote" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER icu_instruction_no_delete BEFORE DELETE ON "IcuInstruction" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- An instruction is changed once: from open to done. Its words, who wrote it and when never change.
CREATE OR REPLACE FUNCTION medos_icu_instruction_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."admissionId" <> OLD."admissionId"
     OR NEW.text <> OLD.text OR NEW.urgent <> OLD.urgent OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'An ICU instruction cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'DONE' THEN
    RAISE EXCEPTION 'This instruction has already been marked done' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER icu_instruction_guard BEFORE UPDATE ON "IcuInstruction" FOR EACH ROW EXECUTE FUNCTION medos_icu_instruction_guard();

SELECT medos_enable_tenant_rls('"IcuVitalsOrder"');
SELECT medos_enable_tenant_rls('"IcuInstruction"');
SELECT medos_enable_tenant_rls('"IcuDayNote"');

-- ===== data: the ICU doctor and the ICU nurse (the doctor's and the nurse's permissions, plus the ICU's), and the ICU permission for the administrator and the manager =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, r.name, true FROM "Tenant" t CROSS JOIN (VALUES ('ICU_DOCTOR'), ('ICU_NURSE')) AS r(name) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT n."tenantId", n.id, p."permission" FROM "Role" n JOIN "Role" b ON b."tenantId" = n."tenantId" AND b.name = CASE n.name WHEN 'ICU_DOCTOR' THEN 'DOCTOR' ELSE 'NURSE' END AND b."isSystem"
JOIN "RolePermission" p ON p."roleId" = b.id AND p."tenantId" = b."tenantId"
WHERE n.name IN ('ICU_DOCTOR', 'ICU_NURSE') AND n."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('ICU_DOCTOR', 'ICU_READ'), ('ICU_DOCTOR', 'ICU_DOCTOR'), ('ICU_NURSE', 'ICU_READ'), ('ICU_NURSE', 'ICU_NURSE'),
  ('ADMINISTRATOR', 'ICU_READ'), ('MANAGER', 'ICU_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration 20261111180000_icu', 'added', jsonb_build_object(
  'ICU_DOCTOR', jsonb_build_array('ICU_READ', 'ICU_DOCTOR', 'and every permission of the DOCTOR role'), 'ICU_NURSE', jsonb_build_array('ICU_READ', 'ICU_NURSE', 'and every permission of the NURSE role'),
  'ADMINISTRATOR', jsonb_build_array('ICU_READ'), 'MANAGER', jsonb_build_array('ICU_READ')))
FROM "Tenant" t;
