-- OPD: the doctor of the visit is told when the nurse has recorded the patient's vitals (docs/notifications.md).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VITALS_TAKEN';
