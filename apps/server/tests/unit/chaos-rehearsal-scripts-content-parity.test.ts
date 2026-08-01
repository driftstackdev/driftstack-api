// W803 — chaos rehearsal scripts content parity. One-hundred-
// twenty-ninth in the drift-guard series. Pins the V-659 (V-547.B)
// chaos rehearsal harness — 5 shell scripts that drive the
// "failure-mode rehearsal catalogue". Drift to a different CHAOS_MODE
// gate, a different PASS/FAIL emit shape, or a missing scenario
// expectation would break the runner and let the catalogue rot.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const LIB = resolve(REPO_ROOT, 'scripts/chaos/lib.sh');
const S01 = resolve(REPO_ROOT, 'scripts/chaos/01-postmark-outage.sh');
const S02 = resolve(REPO_ROOT, 'scripts/chaos/02-stripe-bad-signature.sh');
const S06 = resolve(REPO_ROOT, 'scripts/chaos/06-redis-down.sh');
const RUN = resolve(REPO_ROOT, 'scripts/chaos/run-all.sh');

describe('W803 chaos rehearsal scripts content parity', () => {
  it('all 5 chaos scripts exist at canonical paths', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(existsSync(S01)).toBe(true);
    expect(existsSync(S02)).toBe(true);
    expect(existsSync(S06)).toBe(true);
    expect(existsSync(RUN)).toBe(true);
  });

  it('CRITICAL all 5 scripts use bash shebang + set -euo pipefail strict mode. Drift would let chaos scripts silently swallow errors mid-rehearsal — exactly the failure mode the rehearsal catalogue tests defend against.', () => {
    for (const f of [LIB, S01, S02, S06, RUN]) {
      const p = read(f);
      expect(p.startsWith('#!/usr/bin/env bash\n')).toBe(true);
      expect(p).toMatch(/set -euo pipefail/);
    }
  });

  // ─── lib.sh — shared chaos helpers ────────────────────────────

  it('CRITICAL lib.sh V-659 (V-547.B) provenance anchor pinned. The dual V-number anchor threads chaos-rehearsal to both the V-659 implementation and the V-547.B catalogue.', () => {
    expect(read(LIB)).toMatch(/# V-659 \(V-547\.B\) — chaos rehearsal shared helpers\./);
  });

  it('CRITICAL lib.sh CHAOS_MODE 2-value framing pinned — dry-run (default) + execute. The mode-gate is the load-bearing safety property: dry-run NEVER touches the host. Drift to a different default or missing the dry-run branch would let CI accidentally do real fault injection.', () => {
    const p = read(LIB);
    expect(p).toMatch(/CHAOS_MODE="\$\{CHAOS_MODE:-dry-run\}"/);
    expect(p).toMatch(
      /dry-run\s+\(default\) — print the steps that would execute; touch nothing\./,
    );
    expect(p).toMatch(/execute\s+— actually perform the fault injection/);
  });

  it('CRITICAL lib.sh PASS/FAIL emit-line shape pinned. Scenarios emit a SINGLE line on stdout (rest goes to stderr) so run-all.sh can grep results without parsing the log. Drift would break the runner.', () => {
    const p = read(LIB);
    expect(p).toMatch(
      /All output goes to stderr; the\s*\n# scenario emits a single line on stdout at the end:/,
    );
    expect(p).toMatch(/"PASS scenario=<N> name=<slug>"\s+or\s+"FAIL scenario=<N> reason=<\.\.\.>"/);
    expect(p).toMatch(/emit_pass\(\) \{[\s\S]*?printf 'PASS scenario=%s name=%s\\n' "\$1" "\$2"/);
    expect(p).toMatch(
      /emit_fail\(\) \{[\s\S]*?printf 'FAIL scenario=%s name=%s reason=%s\\n' "\$1" "\$2" "\$3"/,
    );
  });

  it('CRITICAL lib.sh 4-log-color helper set pinned — log_step(blue) + log_warn(yellow) + log_ok(green) + log_fail(red). All emit to stderr so they never contaminate the stdout PASS/FAIL line.', () => {
    const p = read(LIB);
    expect(p).toMatch(
      /log_step\(\)\s+\{ printf '\\033\[1;34m\[chaos\]\\033\[0m %s\\n' "\$\*" >&2; \}/,
    );
    expect(p).toMatch(
      /log_warn\(\)\s+\{ printf '\\033\[1;33m\[chaos\]\\033\[0m %s\\n' "\$\*" >&2; \}/,
    );
    expect(p).toMatch(
      /log_ok\(\)\s+\{ printf '\\033\[1;32m\[chaos\]\\033\[0m %s\\n' "\$\*" >&2; \}/,
    );
    expect(p).toMatch(
      /log_fail\(\)\s+\{ printf '\\033\[1;31m\[chaos\]\\033\[0m %s\\n' "\$\*" >&2; \}/,
    );
  });

  it("CRITICAL lib.sh run_or_describe + assert_http_status helpers pinned. run_or_describe gates fault-injection behind CHAOS_MODE; assert_http_status uses curl with -o /dev/null + -w '%{http_code}' to extract status code only. Drift would let dry-run mode accidentally run commands.", () => {
    const p = read(LIB);
    expect(p).toMatch(
      /run_or_describe\(\) \{[\s\S]*?if \[\[ "\$CHAOS_MODE" == "dry-run" \]\]; then\s*\n\s+log_step "DRY: \$\*"/,
    );
    expect(p).toMatch(/assert_http_status\(\) \{/);
    expect(p).toMatch(/actual=\$\(curl -s -o \/dev\/null -w '%\{http_code\}' "\$@" "\$url"\)/);
  });

  it('CRITICAL lib.sh API_BASE + DOCKER env-var defaults pinned. API_BASE defaults to http://localhost:3000 (local dev control plane); DOCKER defaults to "docker compose" (v2 syntax, not the v1 dash variant).', () => {
    const p = read(LIB);
    expect(p).toMatch(/API_BASE="\$\{API_BASE:-http:\/\/localhost:3000\}"/);
    expect(p).toMatch(/DOCKER="\$\{DOCKER:-docker compose\}"/);
  });

  // ─── 01 postmark-outage ───────────────────────────────────────

  it('CRITICAL 01-postmark-outage V-547 catalogue cross-link + 5-bullet expected-behaviour pinned — buffers to pending_emails + retry backoff (1m/2m/5m/15m/60m) + 5-retries-then-failed + signup queues verification email + control plane stays HTTP-200.', () => {
    const p = read(S01);
    expect(p).toMatch(/# V-659 \(V-547\.B\) — Scenario 1: Postmark unavailable for 5 minutes\./);
    expect(p).toMatch(/Email-send service buffers messages to `pending_emails` table\./);
    expect(p).toMatch(/Retry with exponential backoff \(1m \/ 2m \/ 5m \/ 15m \/ 60m\)\./);
    expect(p).toMatch(/After 5 retries → `failed` \+ admin alert\./);
    expect(p).toMatch(/Control plane stays HTTP-200; signup flow queues verification email\./);
  });

  it('CRITICAL 01-postmark-outage SCENARIO=01 + NAME=postmark-outage + chaos-rehearsal-{N}-{ts}@driftstack.test email pinned. The driftstack.test TLD (RFC 2606) prevents accidentally hitting a real address; the timestamp suffix avoids account-collision on re-runs.', () => {
    const p = read(S01);
    expect(p).toMatch(/^SCENARIO=01$/m);
    expect(p).toMatch(/^NAME=postmark-outage$/m);
    expect(p).toMatch(
      /SIGNUP_EMAIL="chaos-rehearsal-\$\{SCENARIO\}-\$\(date \+%s\)@driftstack\.test"/,
    );
  });

  it('CRITICAL 01-postmark-outage fault-injection shape pinned — /etc/hosts override + curl /v1/auth/signup + assert_http_status 200 /health + execute-mode psql check for pending_emails row. Drift to a different DNS-block mechanism (iptables, dnsmasq) would break the documented sudo dependency.', () => {
    const p = read(S01);
    expect(p).toMatch(
      /run_or_describe "echo '127\.0\.0\.1 api\.postmarkapp\.com' \| sudo tee -a \/etc\/hosts"/,
    );
    expect(p).toMatch(/assert_http_status 200 "\$API_BASE\/v1\/auth\/signup"/);
    expect(p).toMatch(/assert_http_status 200 "\$API_BASE\/health"/);
    expect(p).toMatch(
      /PSQL_URL="\$\{PSQL_URL:-postgresql:\/\/driftstack:driftstack@localhost:5432\/driftstack\}"/,
    );
    expect(p).toMatch(
      /SELECT COUNT\(\*\) FROM pending_emails WHERE to_address = '\$SIGNUP_EMAIL' AND status = 'pending';/,
    );
  });

  it('CRITICAL 01-postmark-outage cleanup restores /etc/hosts via sed -i.bak. Drift to a different cleanup mechanism would leave the host with a broken hosts entry after the rehearsal.', () => {
    const p = read(S01);
    expect(p).toMatch(
      /run_or_describe "sudo sed -i\.bak '\/api\.postmarkapp\.com\/d' \/etc\/hosts"/,
    );
  });

  // ─── 02 stripe-bad-signature ──────────────────────────────────

  it("CRITICAL 02-stripe-bad-signature V-547 catalogue cross-link + 'lowest-risk rehearsal' + '/v1/webhooks/stripe returns 401 on bad sig' + 'No state mutation' + 'Safe to run in CI on every PR' framing pinned. The CI-safe label is the load-bearing 'this is OK to run unattended' anchor.", () => {
    const p = read(S02);
    expect(p).toMatch(/# V-659 \(V-547\.B\) — Scenario 2: Stripe webhook with bad signature\./);
    expect(p).toMatch(/\/v1\/webhooks\/stripe returns 401 \(Unauthorized\) on bad sig\./);
    expect(p).toMatch(/No state mutation\./);
    expect(p).toMatch(
      /This scenario is the lowest-risk rehearsal — pure HTTP, no\s*\n# infrastructure manipulation\. Safe to run in CI on every PR\./,
    );
  });

  it('CRITICAL 02-stripe-bad-signature forged-signature shape pinned — well-formed Stripe event body + BAD_SIG with t=1700000000,v1=<60-char-hex>. The deterministic forged signature lets CI assert the verification path consistently.', () => {
    const p = read(S02);
    expect(p).toMatch(
      /BODY='\{"id":"evt_chaos_002","object":"event","type":"customer\.subscription\.created","data":\{"object":\{\}\}\}'/,
    );
    expect(p).toMatch(
      /BAD_SIG='t=1700000000,v1=deadbeef00deadbeef00deadbeef00deadbeef00deadbeef00deadbeef00dead'/,
    );
  });

  it('CRITICAL 02-stripe-bad-signature 2-step verification pinned — forged-sig 401 AND missing-sig 401. The dual check confirms both the validation-fails-on-bad-sig path AND the validation-fails-on-no-sig path.', () => {
    const p = read(S02);
    expect(p).toMatch(
      /assert_http_status 401 "\$API_BASE\/v1\/webhooks\/stripe"[\s\S]*?stripe-signature: \$BAD_SIG/,
    );
    expect(p).toMatch(/expected-401-on-bad-sig/);
    expect(p).toMatch(/expected-401-on-missing-sig/);
  });

  // ─── 06 redis-down ────────────────────────────────────────────

  it('CRITICAL 06-redis-down V-547 catalogue cross-link + 3-bullet expected-behaviour pinned — rate-limit fail-open + session-token cache fallback to Postgres + control plane HTTP-200 despite degraded latency.', () => {
    const p = read(S06);
    expect(p).toMatch(/# V-659 \(V-547\.B\) — Scenario 6: Redis container exits\./);
    expect(p).toMatch(/Rate-limit middleware falls back to fail-open \(allow \+ log\)\./);
    expect(p).toMatch(/Session-token cache falls back to direct Postgres lookup\./);
    expect(p).toMatch(/Control plane stays HTTP-200; latency degrades but no errors\./);
  });

  it("CRITICAL 06-redis-down /ready-may-correctly-503 framing pinned. The 'readiness 503 tells orchestrators not to route NEW traffic, but existing traffic should still work via fail-open' wording is the load-bearing explanation for why /ready 503 is OK during this rehearsal.", () => {
    const p = read(S06);
    expect(p).toMatch(/\/ready CAN return 503 \(Redis is in readiness checks\)\. That's/);
    expect(p).toMatch(
      /expected — readiness 503 tells orchestrators not to route NEW\s*\n#\s+traffic, but existing traffic should still work via fail-open\./,
    );
  });

  it('CRITICAL 06-redis-down docker stop redis + 200 /health + 200 /version + restore-via-EXIT-trap pinned. Restoring Redis is now the job of one EXIT trap rather than a copy in each fail branch, so it also covers an abort that reaches no branch at all. This pin deliberately no longer counts restore lines: it counted three, and counting them rewarded the weaker mechanism — three copies that each had to be remembered — while a single trap that always runs would have failed it. Whether the restore actually RUNS on the failure and abort paths is checked by executing the script in chaos-scenarios-restore-on-every-exit.test.ts; a count of occurrences never could.', () => {
    const p = read(S06);
    expect(p).toMatch(/run_or_describe "\$DOCKER stop redis"/);
    expect(p).toMatch(/assert_http_status 200 "\$API_BASE\/health"/);
    expect(p).toMatch(/assert_http_status 200 "\$API_BASE\/version"/);
    expect(p, 'the restore is installed as an EXIT trap').toMatch(
      /restore_redis\(\)\s*\{[\s\S]*?run_or_describe "\$DOCKER start redis"[\s\S]*?\}\s*\ntrap restore_redis EXIT/,
    );
  });

  // ─── run-all.sh ───────────────────────────────────────────────

  it('CRITICAL run-all.sh V-659 anchor + 5-scenario set pinned — 01-postmark-outage + 02-stripe-bad-signature + 03-nowpayments-bad-signature + 04-postgres-restart + 06-redis-down. Scenario 04 added 2026-05-16 (PG-restart P0 from V-547 catalogue, leaves 05 gap for future infra scenarios). Scenario 03 added 2026-05-15 to parallel Stripe-02 for V-487/V-666 NowPayments rail coverage.', () => {
    const p = read(RUN);
    expect(p).toMatch(/# V-659 \(V-547\.B\) — chaos rehearsal runner\./);
    expect(p).toMatch(
      /SCENARIOS=\(\s*\n\s+01-postmark-outage\s*\n\s+02-stripe-bad-signature\s*\n\s+03-nowpayments-bad-signature\s*\n\s+04-postgres-restart\s*\n\s+06-redis-down\s*\n\)/,
    );
  });

  it("CRITICAL run-all.sh PASS/FAIL counter shape pinned — PASS_COUNT + FAIL_COUNT + FAIL_LINES[] + 'Exits non-zero if any scenario emits FAIL'. The exit-non-zero behaviour is what makes the runner CI-suitable.", () => {
    const p = read(RUN);
    expect(p).toMatch(/PASS_COUNT=0/);
    expect(p).toMatch(/FAIL_COUNT=0/);
    expect(p).toMatch(/FAIL_LINES=\(\)/);
    expect(p).toMatch(/Exits non-zero if any scenario emits FAIL\./);
    expect(p).toMatch(/if \[\[ \$FAIL_COUNT -gt 0 \]\]; then[\s\S]*?exit 1/);
  });

  it('CRITICAL run-all.sh CHAOS_MODE export pinned. The `export CHAOS_MODE` ensures child scripts inherit the mode — drift to dropping the export would let scenario scripts default to dry-run even when the runner was invoked in execute mode.', () => {
    const p = read(RUN);
    expect(p).toMatch(/CHAOS_MODE="\$\{CHAOS_MODE:-dry-run\}"\s*\nexport CHAOS_MODE/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/chaos-rehearsal-scripts-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
