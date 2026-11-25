-- The operation theatre board (docs/procedures.md): the administrator, the manager, the OT / procedure coordinator and the RMO may read it (THEATRE_READ, read only).
-- The administrator may also refund a payment a patient made online in the patient app (PAYMENT_REFUND, docs/patient-app.md), with a written reason and an audit trail.
-- Data only; new hospitals get both from SYSTEM_ROLES.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission
FROM "Role" r
JOIN (VALUES ('ADMINISTRATOR', 'THEATRE_READ'), ('ADMINISTRATOR', 'PAYMENT_REFUND'), ('MANAGER', 'THEATRE_READ'), ('OT_COORDINATOR', 'THEATRE_READ'), ('RMO', 'THEATRE_READ')) AS p(role, permission)
  ON p.role = r.name
WHERE r."isSystem"
ON CONFLICT DO NOTHING;

INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261128090000_theatre_board_and_admin_refund',
  'added', jsonb_build_object('ADMINISTRATOR', jsonb_build_array('THEATRE_READ', 'PAYMENT_REFUND'), 'MANAGER', jsonb_build_array('THEATRE_READ'), 'OT_COORDINATOR', jsonb_build_array('THEATRE_READ'), 'RMO', jsonb_build_array('THEATRE_READ'))
)
FROM "Tenant" t;
