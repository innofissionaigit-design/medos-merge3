ALTER TABLE "AppointmentRequest" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'IN_PERSON';
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT appointment_request_mode CHECK (mode IN ('IN_PERSON', 'VIDEO'));
