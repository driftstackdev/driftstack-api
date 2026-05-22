-- 2026-05-22 — add 'incident.reopened' to the admin_audit_action
-- enum. Admin incidents page gains a "Reopen incident" button on
-- resolved incidents (false-alarm correction, regression on a
-- previously-resolved issue). Same ALTER TYPE shape as 0061+0062.
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'incident.reopened';
