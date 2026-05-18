-- LK.2 follow-up — admin_audit_action enum gains the
-- mac_node.livekit_registered value.
--
-- Operators register per-Mac LiveKit credentials via
-- POST /v1/mac-nodes/register (LK.2). The action persists per-Mac
-- secret material, so the audit trail needs to show WHO registered
-- WHICH Mac and WHEN. Auditors can reconstruct credential
-- provisioning history without grepping operator logs.
--
-- Pure additive enum extension; same shape as 0027's
-- status_subscriber.force_unsubscribed addition. IF NOT EXISTS
-- guard so reapplying the migration after rollback stays safe.

ALTER TYPE "public"."admin_audit_action"
  ADD VALUE IF NOT EXISTS 'mac_node.livekit_registered';
