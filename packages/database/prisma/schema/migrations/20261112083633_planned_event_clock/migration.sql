-- AlterTable
ALTER TABLE "PlannedAdmissionEvent" ALTER COLUMN "createdAt" SET DEFAULT clock_timestamp(),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(6);
