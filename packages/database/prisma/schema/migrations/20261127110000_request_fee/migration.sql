-- A request paid online from the patient app records what was paid and which advance holds the money.
ALTER TABLE "AppointmentRequest" ADD COLUMN "feeAmount" DECIMAL(12,2), ADD COLUMN "feeReceiptNumber" TEXT, ADD COLUMN "feeDepositId" UUID;
CREATE UNIQUE INDEX "AppointmentRequest_feeDepositId_key" ON "AppointmentRequest"("feeDepositId");
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT appointment_request_fee CHECK (("feeAmount" IS NULL) = ("feeDepositId" IS NULL) AND ("feeAmount" IS NULL OR "feeAmount" > 0));
