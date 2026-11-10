-- AlterTable
ALTER TABLE "LimsDepartment" ADD COLUMN     "capacityPerHour" INTEGER NOT NULL DEFAULT 6,
ADD COLUMN     "closeMinute" INTEGER NOT NULL DEFAULT 1080,
ADD COLUMN     "openMinute" INTEGER NOT NULL DEFAULT 480;

-- ===== Hand-written invariants and data =====
-- docs/lims-portal.md, "Lab load and the outpatient's date". How many outpatient tests a department can take in an hour, and when it works.
ALTER TABLE "LimsDepartment" ADD CONSTRAINT lims_department_capacity CHECK ("capacityPerHour" BETWEEN 1 AND 500 AND "openMinute" >= 0 AND "closeMinute" <= 1440 AND "openMinute" + 60 <= "closeMinute");
-- Starting figures for the departments that already exist (the administrator can change them): a laboratory takes more tests in an hour than a scanner.
UPDATE "LimsDepartment" SET "capacityPerHour" = CASE WHEN kind = 'PATHOLOGY' THEN 8 ELSE 3 END;
