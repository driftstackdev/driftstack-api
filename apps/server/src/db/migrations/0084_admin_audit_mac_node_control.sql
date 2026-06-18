-- Fleet-admin (§A5) follow-up — admin_audit_action enum gains the
-- mac_node.control value.
--
-- Operators drain/cordon/restart fleet nodes via
-- POST /v1/mac-nodes/:id/control. Those actions change a production
-- worker's availability, so the audit trail must record WHO issued WHICH
-- command against WHICH node (the command + reason ride the payload; never
-- a secret). Auditors reconstruct fleet-control history without grepping
-- operator logs.
--
-- Pure additive enum extension; same shape as 0057's
-- mac_node.livekit_registered addition. IF NOT EXISTS guard so reapplying
-- after a rollback stays safe.

ALTER TYPE "public"."admin_audit_action"
  ADD VALUE IF NOT EXISTS 'mac_node.control';
