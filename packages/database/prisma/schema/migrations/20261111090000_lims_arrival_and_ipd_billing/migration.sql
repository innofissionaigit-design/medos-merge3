-- Outpatient tests: the patient reports at reception (bill settled) before the nurse takes the sample.

ALTER TYPE "NotificationType" ADD VALUE 'LIMS_PATIENT_ARRIVED';

ALTER TABLE "LimsRequest" ADD COLUMN "arrivedAt" TIMESTAMPTZ(3), ADD COLUMN "arrivedById" UUID;
ALTER TABLE "LimsRequest" ADD CONSTRAINT lims_request_arrival CHECK (("arrivedAt" IS NULL) = ("arrivedById" IS NULL));

-- Once the patient has reported, the time cannot be taken back or changed.
CREATE OR REPLACE FUNCTION medos_lims_arrival_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."arrivedAt" IS NOT NULL AND NEW."arrivedAt" IS DISTINCT FROM OLD."arrivedAt" THEN
    RAISE EXCEPTION 'The time the patient reported cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lims_arrival_guard BEFORE UPDATE ON "LimsRequest" FOR EACH ROW EXECUTE FUNCTION medos_lims_arrival_guard();
