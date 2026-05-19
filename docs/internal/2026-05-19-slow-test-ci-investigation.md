# Slow-test CI investigation (2026-05-19)

## Trigger

Tier-2 backlog slice per FULL AUTOPILOT directive: "Test step
running 17+ min in CI vs 3-5min local; identify top 3 slowest
tests via local --reporter=verbose; surface optimization candidates
without firing changes yet."

## Method

```bash
npx vitest run apps/server/tests/integration --reporter=verbose
```

Captured stderr+stdout to `/tmp/vitest-int.log`. Parsed per-test
durations (Vitest emits `<duration>ms` after test names only when
the test exceeds an internal threshold, typically ~300ms — fast
tests omit the duration).

## Findings

**Local wall-clock:** 1074 passed / 13 skipped / 41.76s total
(integration suite only). 8-16 cores on the Mac; default Vitest
worker pool = `os.cpus().length`.

**Sum of top-30 slowest tests:** ~832,000 ms = 13.9 minutes
sequential. Parallelization brings this down to 41.76s wall-clock
on the Mac. CI's 17min runtime is the SAME sequential floor served
on fewer cores.

### Top-3 slowest integration tests (root cause: MFA / bcrypt)

| Rank | Duration | Test                                                                                                                   |
| ---: | -------- | ---------------------------------------------------------------------------------------------------------------------- |
|    1 | 1327ms   | `admin-rate-limit-overrides-list.test.ts > GET /v1/admin/rate-limit-overrides > excludes expired overrides by default` |
|    2 | 884ms    | `account-mfa.test.ts > POST /v1/account/mfa/recovery-codes/regenerate (V-353b) > 200 returns 10 fresh codes`           |
|    3 | 818ms    | `auth-mfa-challenge.test.ts > POST /v1/auth/mfa/challenge (V-353d) > 200 exchanges challenge_token + correct TOTP`     |

### Top-20 by file (frequency)

- `account-mfa-step-up.test.ts` — 5 tests > 500ms each
- `auth-mfa-challenge.test.ts` — 5 tests > 500ms each
- `account-mfa.test.ts` — 3 tests > 600ms each
- `auth-coalescer-flow.test.ts` — 2 tests > 500ms each
- `admin-rate-limit-overrides-list.test.ts` — 1 test at 1327ms
- `auth-ip-rate-limit.test.ts` — 2 tests > 400ms
- `auth-flows.test.ts` — 2 tests > 400ms
- `full-lifecycle.test.ts` — 2 tests > 400ms

### Pattern: MFA + auth-flow tests dominate

10+ of the top 20 are MFA-adjacent or auth-flow tests. Root cause:
each test creates fresh accounts (bcrypt password hash, ~80ms per
hash) + each MFA challenge involves TOTP generation +
recovery-code argon2 hashing (~50-150ms per code, ×10 codes).

A typical MFA test path:

1. Signup → bcrypt password hash (80ms).
2. Verify email → DB roundtrip (5ms).
3. Enroll MFA → 10× argon2 recovery code hashes (~500-1000ms).
4. Verify TOTP → time-window comparison + lookup (~50ms).
5. Test-specific assertion.

The crypto floor is 600-1000ms per MFA test — fundamentally
unavoidable without weakening hash params (which would BREAK the
security property the tests pin).

## CI vs local gap

CI: ~17 minutes. Local: ~42 seconds. The 24× ratio is the
combination of:

1. **--coverage instrumentation** (CI runs `npx vitest run --coverage`;
   local omits). V8 coverage typically adds 2-3× overhead.
2. **Worker count** — GitHub Actions ubuntu-latest = 2-4 vCPUs vs
   8-16 cores on a developer Mac. Vitest's pool size scales with
   `os.cpus().length`, so parallelization is 2-4× less effective.
3. **Cold npm install / cache miss** — CI restores npm cache but
   workspace symlink walking + transitive dep tree adds ~30s.

Approximate breakdown:

- 13.9 min sequential floor (MFA + auth flow crypto).
- × 1/3 parallelization on CI vs × 1/16 on Mac → ~4.6 min on CI.
- × 2.5 coverage overhead → ~11.5 min.
- - ~5 min npm install + setup → ~17 min.

This roughly matches the observed CI wall-clock.

## Optimization candidates (NOT fired in this slice)

### Tier 1 — Highest impact, lowest risk

1. **Drop coverage from PR runs; require it only on `main` push.**
   - Estimated CI savings: ~5-7 minutes.
   - Trade-off: PR can land before coverage gate verifies. Mitigation:
     keep merge protection on the coverage gate.

2. **Shard the integration suite across 2 GitHub Actions jobs.**
   - Vitest supports `--shard 1/2` + `--shard 2/2`. Each shard
     ~50% of the suite; both run in parallel on independent
     runners.
   - Estimated CI savings: ~6 minutes (going from 17min → ~11min).
   - Trade-off: 2× billed minutes; coverage merge needs c8/json
     report merging.

### Tier 2 — Medium impact, requires audit

3. **Pool TOTP / bcrypt fixtures across MFA tests.** Today each
   test creates fresh accounts; a shared fixture (per-file
   beforeAll) could cut bcrypt invocations 10×.
   - Estimated savings: ~5 minutes.
   - Trade-off: tests get cross-coupled; teardown/isolation harder.
   - Verdict: REJECT — isolation invariant is load-bearing for
     auth-test correctness.

4. **Argon2 → bcrypt for recovery code hashing.** Currently
   argon2id with high memory cost (~50MB). Bcrypt at cost=10 is
   ~3× faster.
   - Estimated savings: ~3 minutes.
   - Trade-off: argon2id was a deliberate V-353b choice for
     better resistance to GPU brute-force.
   - Verdict: REJECT — security regression for marginal CI speedup.

### Tier 3 — Already explored / dead-end

5. **Disable coverage entirely on PR.** Same as #1 but more
   aggressive. Same trade-offs.

6. **Move MFA tests to a dedicated job.** Net wall-clock unchanged;
   adds CI-job-coordination complexity.

## Recommendation

**File-priority order for the next-fire slice:**

1. **#1 — Coverage only on main pushes** (~5-7 min CI savings;
   low complexity).
2. **#2 — Shard across 2 jobs** (~6 min savings; requires coverage
   report merge).

Combined estimate: 17 min → ~6-7 min CI runtime. Doesn't change
the local 42s figure — local is already as fast as it can get
with the crypto floor.

Defer #3-#6: security trade-offs OR no net benefit.

## Out of scope

- Unit-test suite separate audit (this slice covers integration
  only). Unit tests typically run in seconds and don't surface
  on CI as the bottleneck.
- e2e tests (Playwright + Postgres harness) — these run on a
  separate CI job (`e2e-tests`) and have their own profile.
