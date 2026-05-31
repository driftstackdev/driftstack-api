# 2026-05-31 — MFA challenge has no per-attempt cap / lockout (Agent 2)

**Status: SURFACED, not fixed — needs a stateful attempt-counter + a lockout-policy
decision (founder/security).** Found by a fresh audit of the MFA/TOTP verification
path (not in any audited-clean memory). The TOTP/recovery primitives are sound; the
gap is brute-force bounding on the login-time MFA challenge.

## What's solid (do NOT re-audit)

- **TOTP** (`lib/mfa-totp.ts`): SHA-1 / 30s period / 6 digits, **±1 window** drift
  (90s, 3 valid codes at a time — standard, not over-wide), constant-time per-window
  compare. Correct.
- **Recovery codes** (`services/mfa.ts::verifyCode`): scrypt-hashed at rest,
  single-use (`markRecoveryCodeUsed` on match), `regenerateRecoveryCodes` marks all
  prior unused. Correct.
- **Challenge token** (`services/mfa-challenge-store.ts`): 32-byte entropy, Redis
  `SET … EX 300` (5-min TTL), single-use **on success** (GETDEL), bound to
  account/email/source_ip (IP-mismatch refusal is defense-in-depth, non-consuming so
  the legit user can retry). Correct.

## The gap

`services/auth-flows.ts::completeMfaChallenge` (line ~658): on a wrong code it
**leaves the challenge token alive** ("Route layer enforces a rate limit; service
stays simple") and there is **no per-challenge attempt counter and no per-account
lockout** anywhere — `maxAttempts` appears ONLY in the challenge-store's comment
("caller can retry up to maxAttempts"), never in code. So the sole brute-force
defense on the MFA second factor is the IP `loginGate` (capacity 10, 10/min), shared
with `/login`.

Within one challenge token's 5-minute TTL an attacker can submit unlimited code
guesses (rate-limit permitting); refreshing the token only costs a re-login (the
attacker already has the password in the threat model MFA exists for). The TOTP space
is 1,000,000 with ~3 codes valid at any instant; a password-holding attacker spread
across many IPs (to clear the per-IP gate) can probabilistically grind the second
factor over hours-to-days.

**Severity: MEDIUM** — it's a _second-factor_ brute-force (requires the victim's
password first, which is exactly the case MFA must defend), defended only by
rate-limiting, with no attempt cap or lockout — counter to the design's own stated
"maxAttempts" intent.

**Intersects [[trustproxy gap]]** (`2026-05-31-trustproxy-gap-ip-rate-limit-and-audit.md`):
because Fastify never sets `trustProxy`, `req.ip` is `127.0.0.1`, so the `loginGate`
is currently a _global_ 10/min rather than per-IP. That incidentally throttles a
single attacker but is its own bug; once trustProxy is fixed the per-IP gate returns
and a distributed attacker parallelizes across IPs.

## Fix design (founder/security to choose the policy)

1. **Per-challenge attempt cap (recommended, simplest, no schema):** track a failed
   count for the challenge token (sibling Redis key `mfa-challenge-attempts:<token>`
   via atomic `INCR` + matching TTL; in-memory equivalent for the test store). After
   N failures (e.g. 5) invalidate the token (consume it) → the attacker must re-login
   (password + login rate-limit) every N guesses, raising the cost to ~1M/N logins.
2. **Per-account lockout (defense-in-depth):** a failed-MFA counter on the account
   with a lockout window (e.g. 5 fails in 15 min → MFA locked 15 min). Stronger
   (survives token refresh) but needs a policy decision and carries a legit-user
   lockout-DoS tradeoff — hence founder-gated.
3. **Dedicated tighter gate:** give `/v1/auth/mfa/challenge` its own
   `AUTH_IP_LIMITS.mfaChallenge` (tighter than login) instead of sharing `loginGate`.
   Cheap, but only meaningful once trustProxy is fixed (per-IP).

Recommended: ship (1) + (3) for the immediate bound; consider (2) per founder policy.
The attempt counter is a stateful security change (atomic increment + TTL +
reset-on-success) + a threshold policy, so it's surfaced rather than auto-shipped in
an autopilot wave.

Recorded in memory `project_mfa_challenge_not_attempt_bounded`.
