// W612 — drift guard for scripts/chaos + scripts/load-test (6 modules).
// V-659 (V-547.B) chaos rehearsal family + V-495 autocannon harness.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const P = (rel: string) => resolve(REPO_ROOT, `scripts/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W612 scripts chaos + load-test content parity', () => {
  it('chaos/lib.sh: V-659 (V-547.B) shared helpers + PASS/FAIL stdout single-line contract (scenario=<N> name=<slug>) + CHAOS_MODE env (dry-run default) + stderr-output convention pinned', () => {
    const body = read(P('chaos/lib.sh'));
    expect(body).toMatch(/^# V-659 \(V-547\.B\) — chaos rehearsal shared helpers\.$/m);
    expect(body).toMatch(/^# Sourced by every scenario script\. All output goes to stderr; the$/m);
    expect(body).toMatch(/^# scenario emits a single line on stdout at the end:$/m);
    expect(body).toMatch(
      /^#\s+"PASS scenario=<N> name=<slug>"\s+or\s+"FAIL scenario=<N> reason=<\.\.\.>"$/m,
    );
    expect(body).toMatch(
      /^# so the runner \(scripts\/chaos\/run-all\.sh\) can grep results without$/m,
    );
    expect(body).toMatch(/^# parsing the rehearsal log\.$/m);
    expect(body).toMatch(/^CHAOS_MODE="\$\{CHAOS_MODE:-dry-run\}"$/m);
    expect(existsSync(P('chaos/lib.sh'))).toBe(true);
  });

  it('chaos/01-postmark-outage.sh: V-659 Scenario 1 + 5-min Postmark outage + buffers to pending_emails + 5-retry-exponential-backoff (1/2/5/15/60min) + after-5-retries-failed+admin-alert + control-plane-stays-HTTP-200 pinned', () => {
    const body = read(P('chaos/01-postmark-outage.sh'));
    expect(body).toMatch(
      /^# V-659 \(V-547\.B\) — Scenario 1: Postmark unavailable for 5 minutes\.$/m,
    );
    expect(body).toMatch(
      /^#\s+- Email-send service buffers messages to `pending_emails` table\.$/m,
    );
    expect(body).toMatch(
      /^#\s+- Retry with exponential backoff \(1m \/ 2m \/ 5m \/ 15m \/ 60m\)\.$/m,
    );
    expect(body).toMatch(/^#\s+- After 5 retries → `failed` \+ admin alert\.$/m);
    expect(body).toMatch(
      /^#\s+- Control plane stays HTTP-200; signup flow queues verification email\.$/m,
    );
    expect(body).toMatch(
      /^#\s+1\. Block api\.postmarkapp\.com \(override \/etc\/hosts → 127\.0\.0\.1\)\./m,
    );
    expect(body).toMatch(/^#\s+2\. Trigger a fresh signup against \/v1\/auth\/signup\.$/m);
    expect(existsSync(P('chaos/01-postmark-outage.sh'))).toBe(true);
  });

  it('chaos/02-stripe-bad-signature.sh: V-659 Scenario 2 + /v1/webhooks/stripe returns 401 on bad sig + no-state-mutation + lowest-risk-pure-HTTP-CI-safe-rehearsal framing pinned', () => {
    const body = read(P('chaos/02-stripe-bad-signature.sh'));
    expect(body).toMatch(
      /^# V-659 \(V-547\.B\) — Scenario 2: Stripe webhook with bad signature\.$/m,
    );
    expect(body).toMatch(
      /^#\s+- \/v1\/webhooks\/stripe returns 401 \(Unauthorized\) on bad sig\.$/m,
    );
    expect(body).toMatch(/^#\s+- No state mutation\./m);
    expect(body).toMatch(/^# This scenario is the lowest-risk rehearsal — pure HTTP, no$/m);
    expect(body).toMatch(/^# infrastructure manipulation\. Safe to run in CI on every PR\.$/m);
    expect(existsSync(P('chaos/02-stripe-bad-signature.sh'))).toBe(true);
  });

  it('chaos/03-nowpayments-bad-signature.sh: V-659/V-547.B Scenario 3 + /v1/webhooks/nowpayments returns 401 on bad sig + 401-on-missing-sig + parallel-to-Stripe-02 + W1039-warn-log-pin framing pinned', () => {
    const body = read(P('chaos/03-nowpayments-bad-signature.sh'));
    expect(body).toMatch(
      /^# V-659 \/ V-547\.B — Scenario 3: NowPayments IPN webhook with bad sig\.$/m,
    );
    expect(body).toMatch(
      /^# Parallel to scenario 02 \(Stripe bad-sig\) but exercises the V-487\//m,
    );
    expect(body).toMatch(/^# V-666 NowPayments IPN handler\./m);
    expect(body).toMatch(
      /^#\s+- \/v1\/webhooks\/nowpayments returns 401 \(Unauthorized\) on bad sig\.$/m,
    );
    expect(body).toMatch(/^#\s+- No state mutation\. The route only logs at warn-level with$/m);
    expect(body).toMatch(/^#\s+component=nowpayments-webhooks \(per W1039 drift-guard pin\) so$/m);
    expect(body).toMatch(
      /^# Pre-req: prod or staging has NOWPAYMENTS_IPN_SECRET wired \(otherwise$/m,
    );
    expect(body).toMatch(/x-nowpayments-sig: \$BAD_SIG/);
    expect(existsSync(P('chaos/03-nowpayments-bad-signature.sh'))).toBe(true);
  });

  it('chaos/06-redis-down.sh: V-659 Scenario 6 + rate-limit fail-open (allow + log) + session-token cache fallback to direct Postgres lookup + control-plane-HTTP-200 + latency-degrades-no-errors + docker-compose stop redis rehearsal pinned', () => {
    const body = read(P('chaos/06-redis-down.sh'));
    expect(body).toMatch(/^# V-659 \(V-547\.B\) — Scenario 6: Redis container exits\.$/m);
    expect(body).toMatch(
      /^#\s+- Rate-limit middleware falls back to fail-open \(allow \+ log\)\.$/m,
    );
    expect(body).toMatch(/^#\s+- Session-token cache falls back to direct Postgres lookup\.$/m);
    expect(body).toMatch(/^#\s+- Control plane stays HTTP-200; latency degrades but no errors\.$/m);
    expect(body).toMatch(
      /^# Rehearsal: `docker compose stop redis`, probe \/health, \/v1\/whoami,$/m,
    );
    expect(body).toMatch(/^# \/version\. Restore at the end\.$/m);
    expect(existsSync(P('chaos/06-redis-down.sh'))).toBe(true);
  });

  it('chaos/run-all.sh: V-659 chaos rehearsal runner + iterates scenario scripts + captures PASS/FAIL lines + CHAOS_MODE inheritance (dry-run default; execute via env override) + non-zero-exit-on-any-FAIL pinned', () => {
    const body = read(P('chaos/run-all.sh'));
    expect(body).toMatch(/^# V-659 \(V-547\.B\) — chaos rehearsal runner\.$/m);
    expect(body).toMatch(/^# Iterates the scenario scripts in order, captures their PASS\/FAIL$/m);
    expect(body).toMatch(/^# lines, and reports a final summary\. Inherits CHAOS_MODE from the$/m);
    expect(body).toMatch(/^# environment \(default dry-run\)\.$/m);
    expect(body).toMatch(
      /^#\s+scripts\/chaos\/run-all\.sh\s+# dry-run, prints what each scenario would do$/m,
    );
    expect(body).toMatch(
      /^#\s+CHAOS_MODE=execute scripts\/chaos\/run-all\.sh\s+# actually run each scenario$/m,
    );
    expect(body).toMatch(/^# Exits non-zero if any scenario emits FAIL\.$/m);
    expect(existsSync(P('chaos/run-all.sh'))).toBe(true);
  });

  it('load-test/run.mjs: V-495 autocannon-based harness + --target/--env/--duration/--connections CLI + 4 profiles (status/health/version public + sessions auth-required staging-only by default) pinned', () => {
    const body = read(P('load-test/run.mjs'));
    expect(body).toMatch(/^#!\/usr\/bin\/env node$/m);
    expect(body).toMatch(/^\/\/ V-495 — autocannon-based load-test harness\.$/m);
    expect(body).toMatch(
      /^\/\/\s+node scripts\/load-test\/run\.mjs --target=status \[--env=staging\|production\]$/m,
    );
    expect(body).toMatch(
      /^\/\/\s+node scripts\/load-test\/run\.mjs --target=status --duration=60 --connections=50$/m,
    );
    expect(body).toMatch(/^\/\/ Profiles available out of the box:$/m);
    expect(body).toMatch(
      /^\/\/\s+- status\s+→ GET \/v1\/status \(public, no auth — safe for staging \+ prod\)$/m,
    );
    expect(body).toMatch(
      /^\/\/\s+- health\s+→ GET \/health\s+\(public, no auth — safe for staging \+ prod\)$/m,
    );
    expect(body).toMatch(
      /^\/\/\s+- version\s+→ GET \/version\s+\(public, no auth — safe for staging \+ prod\)$/m,
    );
    expect(body).toMatch(
      /^\/\/\s+- sessions\s+→ POST \/v1\/sessions \(auth required; STAGING ONLY by default\)$/m,
    );
    expect(existsSync(P('load-test/run.mjs'))).toBe(true);
  });
});
