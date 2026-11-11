-- ICU equipment in use on a patient, charged for every day in use; default ICU equipment in the price list.

-- CreateTable
CREATE TABLE "IcuEquipmentUse" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedById" UUID NOT NULL,
    "stoppedAt" TIMESTAMPTZ(3),
    "stoppedById" UUID,

    CONSTRAINT "IcuEquipmentUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IcuEquipmentUse_tenantId_admissionId_startedAt_idx" ON "IcuEquipmentUse"("tenantId", "admissionId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "IcuEquipmentUse_tenantId_id_key" ON "IcuEquipmentUse"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "IcuEquipmentUse" ADD CONSTRAINT "IcuEquipmentUse_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IcuEquipmentUse" ADD CONSTRAINT "IcuEquipmentUse_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ===== rules the database itself keeps =====
ALTER TABLE "IcuEquipmentUse" ADD CONSTRAINT icu_equipment_times CHECK (("stoppedAt" IS NULL) = ("stoppedById" IS NULL) AND ("stoppedAt" IS NULL OR "stoppedAt" >= "startedAt"));
-- A piece of equipment is in use on a patient once at a time.
CREATE UNIQUE INDEX "IcuEquipmentUse_one_active" ON "IcuEquipmentUse" ("tenantId", "admissionId", "serviceId") WHERE "stoppedAt" IS NULL;
CREATE TRIGGER icu_equipment_open BEFORE INSERT ON "IcuEquipmentUse" FOR EACH ROW EXECUTE FUNCTION medos_icu_stay_open();
CREATE TRIGGER icu_equipment_scope_service BEFORE INSERT OR UPDATE OF "serviceId" ON "IcuEquipmentUse" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Service', 'serviceId');
CREATE TRIGGER icu_equipment_no_delete BEFORE DELETE ON "IcuEquipmentUse" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- What was used, and when it started, never changes; it is stopped once.
CREATE OR REPLACE FUNCTION medos_icu_equipment_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."admissionId" <> OLD."admissionId" OR NEW."serviceId" <> OLD."serviceId"
     OR NEW."startedAt" <> OLD."startedAt" OR NEW."startedById" <> OLD."startedById" THEN
    RAISE EXCEPTION 'The record of equipment in use cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."stoppedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'This equipment was already stopped' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER icu_equipment_guard BEFORE UPDATE ON "IcuEquipmentUse" FOR EACH ROW EXECUTE FUNCTION medos_icu_equipment_guard();

SELECT medos_enable_tenant_rls('"IcuEquipmentUse"');

-- ===== data: ICU equipment for the price list of every existing facility (category "Room and bed"); the hospital changes the prices or adds equipment in its price list =====
INSERT INTO "Service" ("tenantId", "facilityId", code, name, category, price, "taxPercent", "updatedAt")
SELECT f."tenantId", f.id, e.code, e.name, 'ROOM_BED'::"ServiceCategory", e.price, 0, CURRENT_TIMESTAMP
FROM "Facility" f CROSS JOIN (VALUES
  ('ICU-VENT', 'ICU ventilator (per day)', 2500), ('ICU-MON', 'ICU cardiac monitor (per day)', 800), ('ICU-PUMP', 'ICU infusion pump (per day)', 300),
  ('ICU-SYR', 'ICU syringe pump (per day)', 300), ('ICU-O2', 'ICU oxygen concentrator (per day)', 400)
) AS e(code, name, price) ON CONFLICT DO NOTHING;
