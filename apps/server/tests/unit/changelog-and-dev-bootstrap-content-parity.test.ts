// W809 — changelog pipeline + dev-bootstrap content parity. One-
// hundred-thirty-fifth in the drift-guard series. Pins 3 files: V-544
// generate-changelog.sh (wave-commit → V-NNN bullet emitter) + V-664
// scripts/tests/generate-changelog.test.ts (the script's own
// regression suite) + V-262 dev-bootstrap.sh (5-step signup→verify
// →accept-legal→API-key flow).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const CHANGELOG = resolve(REPO_ROOT, 'scripts/generate-changelog.sh');
const CHANGELOG_TEST = resolve(REPO_ROOT, 'scripts/tests/generate-changelog.test.ts');
const DEV_BOOT = resolve(REPO_ROOT, 'scripts/dev-bootstrap.sh');

describe('W809 changelog pipeline + dev-bootstrap parity', () => {
  it('all 3 files exist at canonical paths', () => {
    for (const f of [CHANGELOG, CHANGELOG_TEST, DEV_BOOT]) {
      expect(existsSync(f)).toBe(true);
    }
  });

  // ─── V-544 generate-changelog.sh ──────────────────────────────

  it("CRITICAL generate-changelog.sh V-544 anchor + 'two refs → CHANGELOG fragment' framing pinned. The 'walks git log --reverse <from>..<to> to get commits chronologically' wording is the load-bearing chronological-order contract.", () => {
    const p = read(CHANGELOG);
    expect(p).toMatch(
      /# V-544 — generate a CHANGELOG\.md fragment from commit messages between\s*\n# two refs\./,
    );
    expect(p).toMatch(/Walks `git log --reverse <from>\.\.<to>` to get commits chronologically\./);
  });

  it("CRITICAL generate-changelog.sh wave-commit pattern pinned. The bash regex `^(V-[0-9]+(\\.[A-Z])?(\\ /\\ V-[0-9]+(\\.[A-Z])?)*):\\ wave\\ [0-9]+\\ —\\ (.+)$` matches subjects like 'V-NNN / V-NNN: wave N — slice subject'. Drift would either over-match (eat normal commits) or miss real wave commits.", () => {
    const p = read(CHANGELOG);
    expect(p).toMatch(
      /\^\(V-\[0-9\]\+\(\\\.\[A-Z\]\)\?\(\\ \/\\ V-\[0-9\]\+\(\\\.\[A-Z\]\)\?\)\*\):\\ wave\\ \[0-9\]\+\\ —\\ \(\.\+\)\$/,
    );
  });

  it("CRITICAL generate-changelog.sh V-NNN split-on-' / ' pinned. For wave commits like 'V-100 / V-200: wave 5 — slice', the script splits V-NNN_GROUP on ' / ' and emits ONE bullet per V-NNN. Drift would either collapse multi-slice waves into one entry or fail to split.", () => {
    const p = read(CHANGELOG);
    expect(p).toMatch(/IFS=' \/ ' read -ra VNNN_LIST <<<"\$VNNN_GROUP"/);
    expect(p).toMatch(/for vnnn in "\$\{VNNN_LIST\[@\]\}"; do/);
  });

  it('CRITICAL generate-changelog.sh skips merge commits via --no-merges. Drift would let "Merge branch X" lines pollute the customer changelog.', () => {
    const p = read(CHANGELOG);
    expect(p).toMatch(
      /COMMITS=\$\(git log --reverse --no-merges --format='%h%x09%s' "\$\{FROM_REF\}\.\.\$\{TO_REF\}"\)/,
    );
    expect(p).toMatch(/- Skips merge commits\./);
  });

  it("CRITICAL generate-changelog.sh 2-format set pinned — md (default) + plain. md adds '## <to-ref-short> (YYYY-MM-DD)' header + bullet with `SHA` backticks; plain skips the header + uses 'V-NNN subject SHA' shape. The dual-format lets it feed both CHANGELOG.md edits and tooling pipelines.", () => {
    const p = read(CHANGELOG);
    expect(p).toMatch(
      /--format: 'md' \(default; Markdown bullet list\) or 'plain' \(one line per slice\)\./,
    );
    expect(p).toMatch(
      /if \[\[ "\$FORMAT" == "md" \]\]; then\s*\n\s+echo "## \$\{TO_SHORT\} \(\$\{TO_DATE\}\)"/,
    );
    expect(p).toMatch(/echo "- \$\{vnnn\} — \$\{REST\} \(\\`\$\{SHA\}\\`\)"/);
    expect(p).toMatch(/echo "\$\{vnnn\} \$\{REST\} \$\{SHA\}"/);
  });

  it("CRITICAL generate-changelog.sh both refs verified before any output. Drift to skipping verification would let typos hit the git log call and produce confusing 'unknown revision' partial output.", () => {
    const p = read(CHANGELOG);
    expect(p).toMatch(
      /if ! git rev-parse --verify --quiet "\$\{FROM_REF\}\^\{commit\}" >\/dev\/null; then\s*\n\s+echo "error: from-ref '\$\{FROM_REF\}' does not resolve"/,
    );
    expect(p).toMatch(
      /if ! git rev-parse --verify --quiet "\$\{TO_REF\}\^\{commit\}" >\/dev\/null; then\s*\n\s+echo "error: to-ref '\$\{TO_REF\}' does not resolve"/,
    );
  });

  it('CRITICAL generate-changelog.sh date format %cs (committer date, short ISO YYYY-MM-DD) pinned. Drift to %ci (long with timezone) or %ad (author date) would either bloat the header or pick a misleading date for rebased commits.', () => {
    const p = read(CHANGELOG);
    expect(p).toMatch(/TO_DATE=\$\(git show -s --format='%cs' "\$\{TO_REF\}"\)/);
  });

  it("CRITICAL generate-changelog.sh empty-range 'No commits in range.' framing pinned. The md-format-only branch produces _No commits in range._; plain format prints nothing. Drift would either crash on empty ranges or print blank output.", () => {
    const p = read(CHANGELOG);
    expect(p).toMatch(
      /if \[\[ -z "\$COMMITS" \]\]; then\s*\n\s+if \[\[ "\$FORMAT" == "md" \]\]; then\s*\n\s+echo "_No commits in range\._"/,
    );
  });

  // ─── V-664 generate-changelog.test.ts ─────────────────────────

  it("CRITICAL changelog test V-664 anchor + 'V-544 shipped without tests; this slice adds them' provenance + spawnSync-against-disposable-git-repo design pinned. The hermetic-test pattern is reusable for any shell-script suite.", () => {
    const p = read(CHANGELOG_TEST);
    expect(p).toMatch(/\/\/ V-664 — regression tests for scripts\/generate-changelog\.sh\./);
    expect(p).toMatch(/V-544 shipped the script without tests; this slice adds them\./);
    expect(p).toMatch(
      /Test design: each test creates a fresh disposable git repo in\s*\n\/\/ \$tmpdir/,
    );
  });

  it('CRITICAL changelog test makeRepo() helper pinned. The git init -b main + user.email=dev@driftstack.dev + user.name=Driftstack + commit.gpgsign=false + seed-commit shape is the canonical hermetic-repo fixture; drift would break determinism.', () => {
    const p = read(CHANGELOG_TEST);
    expect(p).toMatch(/execFileSync\('git', \['init', '-q', '-b', 'main'\], \{ cwd: dir \}\);/);
    expect(p).toMatch(/execFileSync\('git', \['config', 'user\.email', 'dev@driftstack\.dev'\]/);
    expect(p).toMatch(/execFileSync\('git', \['config', 'user\.name', 'Driftstack'\]/);
    expect(p).toMatch(/execFileSync\('git', \['config', 'commit\.gpgsign', 'false'\]/);
    expect(p).toMatch(/\/\/ Seed commit so we have a base to range against\./);
  });

  it("CRITICAL changelog test 4-describe-block set pinned — basic argument handling + md output format + plain output format + merge-commit handling. The 4-block organization mirrors the script's 4 surfaces; drift would lose coverage of one branch.", () => {
    const p = read(CHANGELOG_TEST);
    expect(p).toMatch(/describe\('V-664 generate-changelog\.sh — basic argument handling'/);
    expect(p).toMatch(/describe\('V-664 generate-changelog\.sh — md output format'/);
    expect(p).toMatch(/describe\('V-664 generate-changelog\.sh — plain output format'/);
    expect(p).toMatch(/describe\('V-664 generate-changelog\.sh — merge-commit handling'/);
  });

  it('CRITICAL changelog test 4-bad-args + exit-non-zero set pinned — no args, one arg, invalid --format=banana, unresolvable from-ref. Each rejects with non-zero exit + appropriate stderr.', () => {
    const p = read(CHANGELOG_TEST);
    expect(p).toMatch(/it\('exits non-zero without arguments'/);
    expect(p).toMatch(/it\('exits non-zero with one argument'/);
    expect(p).toMatch(/it\('exits non-zero when --format is invalid'/);
    expect(p).toMatch(/it\('exits non-zero when from-ref does not resolve'/);
    expect(p).toMatch(/expect\(r\.stderr\)\.toContain\('Usage'\)/);
    expect(p).toMatch(/expect\(r\.stderr\)\.toContain\('does not resolve'\)/);
  });

  it("CRITICAL changelog test wave-split assertion pinned — 'V-100 / V-200: wave 5 — example slice combo' produces 2 bullets each containing the V-NNN + the slice body. The V-530.A / V-531.B sub-slice-suffix test pins the (\\.[A-Z])? regex branch.", () => {
    const p = read(CHANGELOG_TEST);
    expect(p).toMatch(/repo\.commit\('V-100 \/ V-200: wave 5 — example slice combo'\);/);
    expect(p).toMatch(/expect\(lines\[0\]\)\.toContain\('V-100'\)/);
    expect(p).toMatch(/expect\(lines\[1\]\)\.toContain\('V-200'\)/);
    expect(p).toMatch(/repo\.commit\('V-530\.A \/ V-531\.B: wave 7 — sub-slice combo'\);/);
    expect(p).toMatch(/expect\(lines\[0\]\)\.toContain\('V-530\.A'\)/);
    expect(p).toMatch(/expect\(lines\[1\]\)\.toContain\('V-531\.B'\)/);
  });

  it('CRITICAL changelog test md-header regex pinned — /^## [0-9a-f]{7,12} \\(\\d{4}-\\d{2}-\\d{2}\\)/. The 7-12-char SHA + ISO YYYY-MM-DD shape locks the V-544 header format.', () => {
    const p = read(CHANGELOG_TEST);
    expect(p).toMatch(
      /expect\(r\.stdout\)\.toMatch\(\/\^## \[0-9a-f\]\{7,12\} \\\(\\d\{4\}-\\d\{2\}-\\d\{2\}\\\)\/\)/,
    );
  });

  it('CRITICAL changelog test merge-commit-skip assertion pinned. Creates a feature branch, --no-ff merges back, asserts the merge commit subject does NOT appear in output while both contributing commits DO. Drift would let merge noise pollute customer changelogs.', () => {
    const p = read(CHANGELOG_TEST);
    expect(p).toMatch(/it\('skips merge commits'/);
    expect(p).toMatch(/execFileSync\('git', \['checkout', '-q', '-b', 'feature'\]/);
    expect(p).toMatch(/execFileSync\('git', \['merge', '-q', '--no-ff', '--no-edit', 'feature'\]/);
    expect(p).toMatch(
      /expect\(lines\.some\(\(l\) => l\.includes\('Merge branch'\)\)\)\.toBe\(false\)/,
    );
  });

  // ─── V-262 dev-bootstrap.sh ───────────────────────────────────

  it("CRITICAL dev-bootstrap.sh V-262 anchor + 'end-to-end dev key in one command' framing pinned. The 'spins through the same flow V-261 walked the founder through manually' provenance is the load-bearing 'why this exists' anchor.", () => {
    const p = read(DEV_BOOT);
    expect(p).toMatch(/# V-262 — dev-bootstrap\.sh: end-to-end dev key in one command\./);
    expect(p).toMatch(/Spins through the same flow V-261 walked the founder through manually/);
  });

  it('CRITICAL dev-bootstrap.sh 5-step flow framing pinned — signup → verify-email → fetch legal docs → accept 4 (tos/privacy/dpa/aup) → create API key with scopes:["read","write","account_owner"]. Drift would skip a step and break the canonical dev-account-ready state.', () => {
    const p = read(DEV_BOOT);
    expect(p).toMatch(
      /1\. POST \/v1\/auth\/signup → get debug_token \(requires AUTH_EXPOSE_DEBUG_TOKEN=true\)\s*\n#\s+2\. POST \/v1\/auth\/verify-email with that token → get a web session token\s*\n#\s+3\. GET \/v1\/legal\/documents → fetch the four current document hashes\s*\n#\s+4\. POST \/v1\/legal\/accept ×4 \(tos, privacy, dpa, aup\) with version \+ content_hash\s*\n#\s+5\. POST \/v1\/api-keys with name \+ scopes:\["read","write","account_owner"\] → emit the plaintext key/,
    );
  });

  it("CRITICAL dev-bootstrap.sh AUTH_EXPOSE_DEBUG_TOKEN gate framing pinned. The 'production deployments won't have this set' wording is the load-bearing 'dev-only — this is not a prod vector' safety anchor.", () => {
    const p = read(DEV_BOOT);
    expect(p).toMatch(
      /The debug_token plumbing is gated on AUTH_EXPOSE_DEBUG_TOKEN\s*\n# in the server config; production deployments won't have this set\./,
    );
  });

  it("CRITICAL dev-bootstrap.sh 4 optional env-var overrides pinned — API_BASE (default localhost:3000) + EMAIL (founder-dev-{ts}@local.test) + PASSWORD ('correct horse battery staple') + KEY_NAME (dev-bootstrap). The local.test TLD prevents accidental real-email signups.", () => {
    const p = read(DEV_BOOT);
    expect(p).toMatch(/API_BASE="\$\{API_BASE:-http:\/\/localhost:3000\}"/);
    expect(p).toMatch(/EMAIL="\$\{EMAIL:-founder-dev-\$\(date \+%s\)@local\.test\}"/);
    expect(p).toMatch(/PASSWORD="\$\{PASSWORD:-correct horse battery staple\}"/);
    expect(p).toMatch(/KEY_NAME="\$\{KEY_NAME:-dev-bootstrap\}"/);
  });

  it("CRITICAL dev-bootstrap.sh jq + server-reachable pre-flight pinned. The 2-pre-flight (jq missing + server unreachable) fails-fast with helpful 'brew install' + 'AUTH_EXPOSE_DEBUG_TOKEN=true' hints.", () => {
    const p = read(DEV_BOOT);
    expect(p).toMatch(
      /if ! command -v jq >\/dev\/null 2>&1; then\s*\n\s+echo "error: jq is required \(brew install jq\)"/,
    );
    expect(p).toMatch(
      /if ! curl -sf "\$API_BASE\/v1\/status" >\/dev\/null 2>&1; then\s*\n\s+echo "error: server not reachable at \$API_BASE"/,
    );
    expect(p).toMatch(/AUTH_EXPOSE_DEBUG_TOKEN=true npm run dev --workspace apps\/server/);
  });

  it('CRITICAL dev-bootstrap.sh 4-legal-document for-loop pinned — tos + privacy + dpa + aup. Matches the V-NNN four-doc set (no terms.md long-form per legal-filename memory rule); each is accepted with version + content_hash from the server.', () => {
    const p = read(DEV_BOOT);
    expect(p).toMatch(/for k in tos privacy dpa aup; do/);
    expect(p).toMatch(
      /jq -r --arg k "\$k" '\.data\[\] \| select\(\.document_key==\$k\) \| \.content_hash'/,
    );
    expect(p).toMatch(
      /jq -r --arg k "\$k" '\.data\[\] \| select\(\.document_key==\$k\) \| \.version'/,
    );
  });

  it('CRITICAL dev-bootstrap.sh ✓ output shape pinned — prints Email + Account + Base URL + API key + 2-line export hint (DRIFTSTACK_API_KEY + DRIFTSTACK_BASE_URL). The dual-export matches W796 cross-SDK quickstart env-var convention.', () => {
    const p = read(DEV_BOOT);
    expect(p).toMatch(/✓ dev account ready/);
    expect(p).toMatch(/Email: +\$EMAIL/);
    expect(p).toMatch(/Account: +\$ACCOUNT_ID/);
    expect(p).toMatch(/Base URL: +\$API_BASE/);
    expect(p).toMatch(/API key: +\$PLAINTEXT/);
    expect(p).toMatch(/export DRIFTSTACK_API_KEY="\$PLAINTEXT"/);
    expect(p).toMatch(/export DRIFTSTACK_BASE_URL="\$API_BASE"/);
  });

  it("CRITICAL dev-bootstrap.sh GUI-client wizard hint pinned. The 'Paste into the GUI client wizard (Self-hosted mode + the base URL above)' wording closes the dev→GUI loop for the Tauri 2.x client.", () => {
    const p = read(DEV_BOOT);
    expect(p).toMatch(
      /Paste into the GUI client wizard \(Self-hosted mode \+ the base URL above\),\s*\nor export for SDK calls:/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/changelog-and-dev-bootstrap-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
