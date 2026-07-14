-- One owner/email may retain accepted invite history, but must have at most
-- one live pending credential/role. Collapse any pre-fence race artifacts to
-- the newest deterministic row before installing the partial unique index.
WITH ranked_pending AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY owner_account_id, invitee_email
      ORDER BY created_at DESC, id DESC
    ) AS duplicate_rank
  FROM team_invites
  WHERE accepted_at IS NULL
)
DELETE FROM team_invites AS invite
USING ranked_pending AS ranked
WHERE invite.id = ranked.id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX "team_invites_owner_email_pending_unique"
  ON "team_invites" ("owner_account_id", "invitee_email")
  WHERE "accepted_at" IS NULL;
