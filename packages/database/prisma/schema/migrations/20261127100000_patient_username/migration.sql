-- Patients sign in with a username they choose. Existing rows get a temporary one from the mobile number.
ALTER TABLE "PatientCredential" ADD COLUMN "username" TEXT;
UPDATE "PatientCredential" SET "username" = 'patient' || "mobile";
ALTER TABLE "PatientCredential" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "PatientCredential_tenantId_username_key" ON "PatientCredential"("tenantId", "username");
ALTER TABLE "PatientCredential" ADD CONSTRAINT patient_credential_username CHECK (username ~ '^[a-z][a-z0-9._]{3,29}$');
