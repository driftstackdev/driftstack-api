-- V-202c — first-failure email dedup column.
--
-- Tracks when (and whether) we've sent `session-failed-first` to this
-- account. Null until the very first session.failed event the account
-- experiences; set to the wall clock at email-send time afterwards.
-- The email is a one-shot welcome to debugging ("here's the docs link;
-- here's how to read the error"); resending on every failure would be
-- noise the customer ignores.
--
-- Class A migration per V-198 taxonomy: additive, nullable column with
-- no default. Forward-compatible with existing rows (NULL = "no email
-- sent yet" = same as "newly-created account before V-202c").
--
-- The dedup gate is at the application layer:
--   `AccountLifecycleService.emit({ kind: 'session.failed.first', ... })`
-- atomically checks IS NULL and then sets — concurrent first-failures
-- on the same account result in exactly one email.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS first_failure_email_sent_at timestamptz;
