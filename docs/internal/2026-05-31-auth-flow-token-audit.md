# 2026-05-31 — Auth-flow token handling audit (Agent 2)

Fresh security audit of the user-facing auth-flow tokens (signup-verify,
magic-link, password-reset, web-session). **Verdict: fundamentally SOUND.** One
LOW-severity hardening note (surfaced, not fixed).

## VERIFIED CLEAN — do not re-audit

- **Token primitive** (`lib/auth-tokens.ts`): 32-byte (256-bit) random token,
  `base64url`; `sha256`-hashed at rest (correct for full-entropy tokens — scrypt
  is reserved for low-entropy passwords); lookup by hash (no reversible material
  stored). Passwords use scrypt (logN=15/r=8/p=1) via the api-keys path.
- **TTLs** sane: signup-verify 30 min, magic-link 15 min, password-reset 60 min,
  web-session 30 days.
- **Single-use vs the realistic threat (sequential replay) is ENFORCED**:
  `consumeAuthToken` (auth-flows-repo.ts:174) is a conditional UPDATE
  (`SET consumed_at WHERE id AND consumed_at IS NULL`), and `findActiveAuthToken`
  filters `consumed_at IS NULL AND expires_at > now`. A used or expired token
  can't be replayed later.
- **Sweeper** (`auth-flows-sweeper.ts`) bulk-deletes stale consumed/expired rows.
- No token enumeration (lookups are by hash of a 256-bit secret), no plaintext at
  rest, plaintext sent once.

## LOW-severity hardening note (surfaced)

> ✅ **RESOLVED since — verified 2026-08-27 (V-2065), annotated here because a reader
> stops at this heading.** `consumeAuthToken` now returns `Promise<boolean>`
> (`rows.length > 0`) with the reasoning in a comment: "0 → already consumed (a
> concurrent winner), so the caller must reject rather than double-run". **And the
> remedy went further than this note proposed.** All three flows call
> `consumeAuthTokenFamily`, which atomically claims every still-unconsumed sibling of
> the same kind and account and returns true only if the presented id was among them
> — so an old or resent link cannot later mint a session — and each of the three gates
> on it with `if (!consumed) throw new AuthFlowError('invalid_auth_token')`. The
> "both callers proceed to act" analysis below no longer describes the code. Note the
> single-token `consumeAuthToken` now has **no production caller**: it survives on the
> repo interface and is exercised by four test files.

All flows do **find → consume → act**, but `consumeAuthToken` returns `void`, so
a caller cannot tell it _lost_ a concurrent race. On a truly-concurrent
double-submit of the **same** valid token (both pass `find` before either
`consume` commits): the conditional UPDATE means only one row-write "wins"
(consumed_at set once — so the row isn't double-consumed), but **both callers
proceed to act** because neither checks the consume result:

- signup-verify / magic-link `markEmailVerified`: idempotent → benign.
- password-reset `setPassword`: same new hash twice → benign.
- magic-link `issueWebSession` (auth-flows.ts:760): mints **two** 30-day
  web-sessions; both are the legit user's own (same account, their own link), one
  returned, one orphaned-but-valid → minor session sprawl, not a breach.

So strict single-use is technically racy under concurrent submit, but the
realistic replay threat is covered and every flow's double-action is
benign-to-minor. **Not a security bug; a hardening opportunity.**

**Fix (if strict single-use is wanted):** have `consumeAuthToken` return the
affected-row count (or the row), and gate the action on winning the claim — the
loser returns the idempotent success (verify/reset already done) or, for
magic-link, reuses/awaits the winner's session rather than minting a second.
Needs a behaviour decision for the loser + careful auth-path testing → do it in a
focused (non-deep-autopilot-session) pass. Recorded in memory
`project_auth_flow_token_audit_2026_05_31`.
