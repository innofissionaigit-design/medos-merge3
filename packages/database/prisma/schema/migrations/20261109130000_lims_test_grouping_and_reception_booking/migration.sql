-- AlterTable
ALTER TABLE "Encounter" ADD COLUMN     "labOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "limsDepartment" "LimsDepartmentKind";

-- ===== Hand-written invariants and data =====
-- docs/lims-portal.md. Tests on the price list are grouped between the two laboratory departments, so a test ordered from the list reaches the right technician.

-- Only an investigation has a laboratory department.
ALTER TABLE "Service" ADD CONSTRAINT service_lims_department CHECK ("limsDepartment" IS NULL OR category = 'INVESTIGATION');

-- The grouping of the investigations that already exist: imaging by the usual words in the name, everything else is a laboratory (pathology) test.
-- The administrator or the pathologist can change any of them in the app.
UPDATE "Service" SET "limsDepartment" = CASE
  WHEN name ~* '(x[- ]?ray|radiograph|ultrasound|ultrasonograph|sonograph|sonogram|\musg\M|\mct\M|\mmri\M|mammogra|doppler|dexa|\mpet\M|\mecho|fluoroscop|angiogra|barium|hsg|imaging)' THEN 'RADIOLOGY'::"LimsDepartmentKind"
  ELSE 'PATHOLOGY'::"LimsDepartmentKind" END
WHERE category = 'INVESTIGATION' AND "limsDepartment" IS NULL;

-- A visit made only to book laboratory or imaging tests at reception: an outpatient visit with no doctor, closed at once.
ALTER TABLE "Encounter" ADD CONSTRAINT encounter_lab_only CHECK ("labOnly" = false OR (type = 'OPD' AND "practitionerId" IS NULL AND "departmentId" IS NULL));

-- A test booked at reception has source RECEPTION.
ALTER TABLE "TestOrder" DROP CONSTRAINT "TestOrder_source_check";
ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_source_check" CHECK (source IN ('DIGITAL', 'HANDWRITTEN', 'CASHIER', 'LIMS', 'RECEPTION'));
