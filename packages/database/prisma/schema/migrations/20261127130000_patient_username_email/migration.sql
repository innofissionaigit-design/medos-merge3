-- A username may also be an email address.
ALTER TABLE "PatientCredential" DROP CONSTRAINT patient_credential_username;
ALTER TABLE "PatientCredential" ADD CONSTRAINT patient_credential_username CHECK (username ~ '^[a-z0-9][a-z0-9._@+-]{3,63}$');
