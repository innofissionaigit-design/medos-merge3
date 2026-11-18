-- OPD: nurses are told when a patient joins the queue and is waiting for vitals (docs/notifications.md).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'NURSE_VITALS_DUE';

-- Who is told: nurses (a permission, not a role name, so a hospital can give it to others).
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'VITALS_QUEUE_ALERT' FROM "Role" r WHERE r."isSystem" AND r.name = 'NURSE' ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration nurse_vitals_alert', 'added', jsonb_build_object('NURSE', jsonb_build_array('VITALS_QUEUE_ALERT')))
FROM "Tenant" t;
