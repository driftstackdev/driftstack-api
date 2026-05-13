// W610 — drift guard for scripts: dev-bootstrap + dr-rehearse + extract-sdk-repos + generate-changelog.
// 4 operational shell scripts in one suite.

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

describe('W610 scripts bootstrap quartet content parity', () => {
  it('dev-bootstrap.sh: V-262 end-to-end dev key in one command + 5-step flow (signup→verify-email→legal/documents→legal/accept ×4→api-keys mint) + AUTH_EXPOSE_DEBUG_TOKEN gate + 4 env overrides (API_BASE/EMAIL/PASSWORD/KEY_NAME) + jq+curl prereqs + pre-launch-only rationale pinned', () => {
    const body = read(P('dev-bootstrap.sh'));
    expect(body).toMatch(/^# V-262 — dev-bootstrap\.sh: end-to-end dev key in one command\.$/m);
    expect(body).toMatch(
      /^# Spins through the same flow V-261 walked the founder through manually:$/m,
    );
    expect(body).toMatch(
      /^#\s+1\. POST \/v1\/auth\/signup → get debug_token \(requires AUTH_EXPOSE_DEBUG_TOKEN=true\)$/m,
    );
    expect(body).toMatch(
      /^#\s+2\. POST \/v1\/auth\/verify-email with that token → get a web session token$/m,
    );
    expect(body).toMatch(
      /^#\s+3\. GET \/v1\/legal\/documents → fetch the four current document hashes$/m,
    );
    expect(body).toMatch(
      /^#\s+4\. POST \/v1\/legal\/accept ×4 \(tos, privacy, dpa, aup\) with version \+ content_hash$/m,
    );
    expect(body).toMatch(
      /^#\s+5\. POST \/v1\/api-keys with name \+ scopes:\["account_owner"\] → emit the plaintext key$/m,
    );
    expect(body).toMatch(/^#\s+API_BASE\s+— default http:\/\/localhost:3000$/m);
    expect(body).toMatch(
      /^#\s+EMAIL\s+— default founder-dev-\$\(date \+%s\)@local\.test \(unique per run\)$/m,
    );
    expect(body).toMatch(/^#\s+PASSWORD\s+— default "correct horse battery staple"$/m);
    expect(body).toMatch(/^#\s+KEY_NAME\s+— default "dev-bootstrap"$/m);
    expect(body).toMatch(
      /^# Pre-launch only\. The debug_token plumbing is gated on AUTH_EXPOSE_DEBUG_TOKEN$/m,
    );
    expect(body).toMatch(/^# in the server config; production deployments won't have this set\.$/m);
    expect(body).toMatch(/^set -euo pipefail$/m);
    expect(body).toMatch(/^API_BASE="\$\{API_BASE:-http:\/\/localhost:3000\}"$/m);
    expect(body).toMatch(/^EMAIL="\$\{EMAIL:-founder-dev-\$\(date \+%s\)@local\.test\}"$/m);
    expect(body).toMatch(/^PASSWORD="\$\{PASSWORD:-correct horse battery staple\}"$/m);
    expect(body).toMatch(/^KEY_NAME="\$\{KEY_NAME:-dev-bootstrap\}"$/m);
    expect(body).toMatch(/echo "error: jq is required \(brew install jq\)" >&2/);
    expect(body).toMatch(/echo "error: server not reachable at \$API_BASE" >&2/);
    expect(existsSync(P('dev-bootstrap.sh'))).toBe(true);
  });

  it('dr-rehearse.sh: V-510 DR rehearsal harness + 5 local-runnable scenarios (2 PG-PITR / 4 Redis loss / 6 signing-key rotation / 7 bad deploy / 8 cert renewal) + refuse-on-production safety + PRODUCTION_HOST_PATTERNS allowlist (api / staging-api) pinned', () => {
    const body = read(P('dr-rehearse.sh'));
    expect(body).toMatch(/^# V-510 — DR rehearsal harness\./m);
    expect(body).toMatch(
      /^#\s+scripts\/dr-rehearse\.sh scenario-2\s+# PG corruption \(PITR proxy\)$/m,
    );
    expect(body).toMatch(/^#\s+scripts\/dr-rehearse\.sh scenario-4\s+# Redis loss$/m);
    expect(body).toMatch(/^#\s+scripts\/dr-rehearse\.sh scenario-6\s+# signing-key rotation$/m);
    expect(body).toMatch(
      /^#\s+scripts\/dr-rehearse\.sh scenario-7\s+# bad deploy of broken code$/m,
    );
    expect(body).toMatch(/^#\s+scripts\/dr-rehearse\.sh scenario-8\s+# cert renewal stop-gap$/m);
    expect(body).toMatch(/^# Refuses to act on production\./m);
    expect(body).toMatch(/^PRODUCTION_HOST_PATTERNS=\($/m);
    expect(body).toMatch(/^\s+"api\.driftstack\.dev"$/m);
    expect(body).toMatch(/^\s+"staging-api\.driftstack\.dev"$/m);
    expect(body).toMatch(/^refuse_on_production\(\) \{$/m);
    expect(body).toMatch(/echo "✗ Refusing to run dr-rehearse on host matching '\$pattern'\."/);
    expect(existsSync(P('dr-rehearse.sh'))).toBe(true);
  });

  it('extract-sdk-repos.sh: V-525 + git-subtree-split into 3 standalone-repo-shaped branches (sdk-typescript + sdk-python + sdk-go) + idempotent re-split + local-refs-never-pushed safety + V-205 violator warning (63a20c1 / ef649a1) gated on V-528 privatization pinned', () => {
    const body = read(P('extract-sdk-repos.sh'));
    expect(body).toMatch(
      /^# V-525 — extract 3 SDK packages into standalone-repo-shaped branches\./m,
    );
    expect(body).toMatch(
      /^# Uses `git subtree split` to rewrite each `packages\/sdk-<lang>\/` subtree$/m,
    );
    expect(body).toMatch(
      /^# Idempotent: re-running deletes existing extraction branches and re-splits\./m,
    );
    expect(body).toMatch(/^# Safe: branches are local refs — never pushed by this script\./m);
    expect(body).toMatch(/^V205_VIOLATORS=\($/m);
    expect(body).toMatch(/^\s+"63a20c1"$/m);
    expect(body).toMatch(/^\s+"ef649a1"$/m);
    expect(body).toMatch(/^SDKS=\($/m);
    expect(body).toMatch(/^\s+"typescript:packages\/sdk-typescript"$/m);
    expect(body).toMatch(/^\s+"python:packages\/sdk-python"$/m);
    expect(body).toMatch(/^\s+"go:packages\/sdk-go"$/m);
    expect(body).toMatch(/echo "V-525 SDK extraction — generating 3 standalone-repo branches"/);
    expect(existsSync(P('extract-sdk-repos.sh'))).toBe(true);
  });

  it('generate-changelog.sh: V-544 + git-log-reverse <from>..<to> + per-V-NNN wave-commit split + md|plain output format + skip-merge-commits + behaviour-keeps-V-NNN-labels (V-526.B/V-545 strip them on customer-facing publish) pinned', () => {
    const body = read(P('generate-changelog.sh'));
    expect(body).toMatch(
      /^# V-544 — generate a CHANGELOG\.md fragment from commit messages between$/m,
    );
    expect(body).toMatch(/^# two refs\.$/m);
    expect(body).toMatch(
      /^#\s+scripts\/generate-changelog\.sh <from-ref> <to-ref> \[--format md\|plain\]$/m,
    );
    expect(body).toMatch(/^#\s+scripts\/generate-changelog\.sh v0\.1\.6 HEAD$/m);
    expect(body).toMatch(/^# Output format \(default `md`\):$/m);
    expect(body).toMatch(/^#\s+- V-NNN — slice subject \(commit SHA-short\)$/m);
    expect(body).toMatch(/^# Behaviour:$/m);
    expect(body).toMatch(
      /^# - Walks `git log --reverse <from>\.\.<to>` to get commits chronologically\.$/m,
    );
    expect(body).toMatch(/^# - For each commit, extracts the subject line\./m);
    expect(body).toMatch(/^# - Skips merge commits\./m);
    expect(body).toMatch(
      /^# - Strips V-NNN labels from non-wave subjects\? No — keeps them; they're$/m,
    );
    expect(body).toMatch(
      /^#\s+internal artifacts that future cleanup \(V-526\.B \/ V-545\) removes for$/m,
    );
    expect(body).toMatch(/^# Exit codes:$/m);
    expect(body).toMatch(/^#\s+0 — output written successfully\.$/m);
    expect(body).toMatch(/^#\s+1 — bad arguments or git invocation failure\.$/m);
    expect(existsSync(P('generate-changelog.sh'))).toBe(true);
  });
});
