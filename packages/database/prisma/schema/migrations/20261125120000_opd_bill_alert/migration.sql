-- OPD: the cashier is told when reception takes an OPD visit, and keeps a ledger of the visits to bill and collect (docs/opd-ledger.md).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'OPD_VISIT_TAKEN';

-- Who is told: cashiers and the billing team (a permission, not a role name, so a hospital can give it to others).
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'OPD_BILL_ALERT' FROM "Role" r WHERE r."isSystem" AND r.name IN ('CASHIER', 'BILLING') ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration opd_bill_alert', 'added', jsonb_build_object('CASHIER', jsonb_build_array('OPD_BILL_ALERT'), 'BILLING', jsonb_build_array('OPD_BILL_ALERT')))
FROM "Tenant" t;
