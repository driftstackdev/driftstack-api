-- 2026-06-09 — W393 challenge-handling. Adds the `session.challenge_detected`
-- value to the existing webhook_event_type enum so the control plane can relay
-- harness ChallengeDetector events to customer webhook endpoints (+ accept
-- subscriptions to it) without the "22P02 invalid input value for enum" insert
-- error.
--
-- Same ALTER TYPE ADD VALUE pattern as 0064 (crypto-order events) / 0055
-- (egress_capability_changed). Runs outside a transaction; idempotent via
-- IF NOT EXISTS.
ALTER TYPE "webhook_event_type" ADD VALUE IF NOT EXISTS 'session.challenge_detected';
