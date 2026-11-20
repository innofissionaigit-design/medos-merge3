-- Bed turnover: one for every bed an admission leaves, not only the bed it goes home from.
-- Before, a bed transfer set the old bed to "cleaning" with no turnover, so housekeeping never saw it and nobody could release it.

-- DropIndex
DROP INDEX "BedTurnover_admissionId_key";
DROP INDEX "BedTurnover_tenantId_facilityId_admissionId_key";

-- CreateIndex
CREATE INDEX "BedTurnover_tenantId_facilityId_admissionId_idx" ON "BedTurnover"("tenantId", "facilityId", "admissionId");
CREATE UNIQUE INDEX "BedTurnover_admissionId_bedId_vacatedAt_key" ON "BedTurnover"("admissionId", "bedId", "vacatedAt");

-- A bed that an earlier transfer left in cleaning, with no turnover: give it one now, so housekeeping can release it.
INSERT INTO "BedTurnover" ("tenantId", "facilityId", "bedId", "admissionId", "vacatedAt")
SELECT ba."tenantId", b."facilityId", ba."bedId", ba."admissionId", ba."releasedAt"
FROM "BedAssignment" ba
JOIN "Bed" b ON b.id = ba."bedId" AND b."tenantId" = ba."tenantId"
WHERE ba."releasedAt" IS NOT NULL AND b.status = 'CLEANING'
  AND NOT EXISTS (SELECT 1 FROM "BedTurnover" t WHERE t."bedId" = ba."bedId" AND t."tenantId" = ba."tenantId" AND t."readyAt" IS NULL)
  AND ba."releasedAt" = (SELECT max(x."releasedAt") FROM "BedAssignment" x WHERE x."bedId" = ba."bedId" AND x."tenantId" = ba."tenantId" AND x."releasedAt" IS NOT NULL);
