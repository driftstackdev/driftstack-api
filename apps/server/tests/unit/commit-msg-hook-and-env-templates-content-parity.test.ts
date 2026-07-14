// W807 — V-527 commit-msg hook + install + env-templates content
// parity. One-hundred-thirty-third in the drift-guard series. Pins
// the 2 V-205/V-211 enforcement files (commit-msg + install-git-
// hooks.sh) and 2 .env templates (production + staging). Drift in
// the reject patterns would let attribution / anonymity leaks land;
// drift in env-template required-var list would silently break
// production boot.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const HOOK = resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg');
const INSTALL = resolve(REPO_ROOT, 'scripts/install-git-hooks.sh');
const ENV_PROD = resolve(REPO_ROOT, 'infra/env-templates/production.env.template');
const ENV_STG = resolve(REPO_ROOT, 'infra/env-templates/staging.env.template');

describe('W807 commit-msg hook + install + env-templates parity', () => {
  it('all 4 files exist at canonical paths', () => {
    for (const f of [HOOK, INSTALL, ENV_PROD, ENV_STG]) {
      expect(existsSync(f)).toBe(true);
    }
  });

  // ─── commit-msg hook — V-527 ──────────────────────────────────

  it("CRITICAL commit-msg V-527 anchor + 2-policy framing pinned. The 'Extends V-205-CLEANUP.C pattern' + 'V-205 attribution — Driftstack-only commit attribution. ZERO third-party tooling trailers' + 'V-211 anonymity — ZERO founder framing, ZERO personal-name references' wording is the load-bearing policy contract.", () => {
    const p = read(HOOK);
    expect(p).toMatch(/# V-527 — commit-msg hook \(rejects attribution \+ anonymity leaks\)\./);
    expect(p).toMatch(/Extends the V-205-CLEANUP\.C pattern from driftstack \+ webkit-driftstack/);
    expect(p).toMatch(
      /V-205 attribution — Driftstack-only commit attribution\. ZERO third-\s*\n#\s+party tooling trailers, ZERO "Generated with" footers, ZERO robot\s*\n#\s+emoji markers, ZERO noreply@<tool>\.com addresses\./,
    );
    expect(p).toMatch(
      /V-211 anonymity\s+— ZERO founder framing, ZERO personal-name\s*\n#\s+references \(currently: Joel, Joeltheunissen, Theunissen\) in\s*\n#\s+commit subject or body\./,
    );
  });

  it('CRITICAL commit-msg V-205 9-reject-pattern set pinned — Co-Authored-By: Claude / claude / anthropic / GPT / Copilot variants + 🤖 robot emoji + Generated with [Claude + noreply@anthropic.com + noreply@github.com. Drift to dropping any would let that vector through.', () => {
    const p = read(HOOK);
    expect(p).toMatch(/REJECT_PATTERNS_V205=\(/);
    expect(p).toMatch(/'Co-Authored-By: Claude'/);
    expect(p).toMatch(/'Co-Authored-By:\.\*claude'/);
    expect(p).toMatch(/'Co-Authored-By:\.\*anthropic'/);
    expect(p).toMatch(/'Co-Authored-By:\.\*GPT'/);
    expect(p).toMatch(/'Co-Authored-By:\.\*Copilot'/);
    expect(p).toMatch(/'🤖'/);
    expect(p).toMatch(/'Generated with \\\[Claude'/);
    expect(p).toMatch(/'noreply@anthropic\\\.com'/);
    expect(p).toMatch(/'noreply@github\\\.com'/);
  });

  it("CRITICAL commit-msg V-211 4-reject-pattern set pinned — Founder + Joel + Theunissen + Joeltheunissen with word-boundary [^[:alnum:]] guards. The (^|[^[:alnum:]])X([^[:alnum:]]|$) shape lets compounds like 'foundered' / 'foundation' / 'Joeline' through while catching the bare tokens.", () => {
    const p = read(HOOK);
    expect(p).toMatch(/REJECT_PATTERNS_V211=\(/);
    expect(p).toMatch(/'\(\^\|\[\^\[:alnum:\]\]\)\[Ff\]ounder\(\[\^\[:alnum:\]\]\|\$\)'/);
    expect(p).toMatch(/'\(\^\|\[\^\[:alnum:\]\]\)\[Jj\]oel\(\[\^\[:alnum:\]\]\|\$\)'/);
    expect(p).toMatch(/'\(\^\|\[\^\[:alnum:\]\]\)\[Tt\]heunissen\(\[\^\[:alnum:\]\]\|\$\)'/);
    expect(p).toMatch(/'\(\^\|\[\^\[:alnum:\]\]\)\[Jj\]oeltheunissen\(\[\^\[:alnum:\]\]\|\$\)'/);
  });

  it('CRITICAL commit-msg V-205 uses grep -iqE (case-INsensitive) vs V-211 uses grep -qE (case-SENsitive). The case-distinction matters because V-211 patterns already include [Ff]/[Jj]/[Tt] character-classes that would over-match if -i were added.', () => {
    const p = read(HOOK);
    expect(p).toMatch(/grep -iqE "\$PATTERN"/);
    expect(p).toMatch(/grep -qE "\$PATTERN"/);
  });

  it("CRITICAL commit-msg fail() helper shape pinned — prints 'commit-msg HOOK REJECTED' + matched pattern + policy + 'remove the offending line(s)' fix hint + exit 1. Drift to a different error format would break tooling that parses hook output.", () => {
    const p = read(HOOK);
    expect(p).toMatch(/✗ commit-msg HOOK REJECTED: contains banned pattern/);
    expect(p).toMatch(/matched: \$pattern/);
    expect(p).toMatch(/policy: +\$policy/);
    expect(p).toMatch(/remove the offending line\(s\) from your commit/);
    expect(p).toMatch(/exit 1/);
  });

  it("CRITICAL commit-msg 2-loop apply: V-205 patterns iterated first (most common attribution leak), then V-211 (anonymity). Both loops share the same fail() helper. Drift to reordering wouldn't break correctness but the V-205-first convention matches the V-205-CLEANUP-C ancestry.", () => {
    const p = read(HOOK);
    expect(p).toMatch(
      /for PATTERN in "\$\{REJECT_PATTERNS_V205\[@\]\}"; do[\s\S]*?fail "\$PATTERN" "V-205 attribution[\s\S]*?for PATTERN in "\$\{REJECT_PATTERNS_V211\[@\]\}"; do[\s\S]*?fail "\$PATTERN" "V-211 anonymity/,
    );
  });

  // ─── install-git-hooks.sh — V-527 ─────────────────────────────

  it("CRITICAL install-git-hooks.sh V-527 anchor + 'per-clone (not tracked) → copy canonical hooks from scripts/git-hooks/' framing pinned. Drift would lose the canonical-source-vs-runtime-install distinction.", () => {
    const p = read(INSTALL);
    expect(p).toMatch(/# V-527 — install git hooks from canonical source\./);
    expect(p).toMatch(
      /\.git\/hooks\/ is per-clone \(not tracked\)\. This script copies the\s*\n# canonical, version-controlled hooks from scripts\/git-hooks\//,
    );
    expect(p).toMatch(
      /Run once after cloning, and again whenever scripts\/git-hooks\/\s*\n# changes\. Idempotent: overwrites existing hooks of the same name\./,
    );
  });

  it('CRITICAL install-git-hooks.sh SRC + DST + per-hook loop shape pinned. SRC=$REPO_ROOT/scripts/git-hooks + DST=$REPO_ROOT/.git/hooks + cp+chmod+x loop + idempotent install. Drift would either install hooks in the wrong place or skip the executable bit.', () => {
    const p = read(INSTALL);
    expect(p).toMatch(/SRC="\$REPO_ROOT\/scripts\/git-hooks"/);
    expect(p).toMatch(/DST="\$REPO_ROOT\/\.git\/hooks"/);
    expect(p).toMatch(/for HOOK in "\$SRC"\/\*; do/);
    expect(p).toMatch(/cp "\$HOOK" "\$DST\/\$NAME"/);
    expect(p).toMatch(/chmod \+x "\$DST\/\$NAME"/);
  });

  it('CRITICAL install-git-hooks.sh pre-flight refuses missing-source-dir + missing-dest-dir (must be run from a git clone). Drift to either check missing would let install silently succeed in a non-git-checkout.', () => {
    const p = read(INSTALL);
    expect(p).toMatch(
      /if \[\[ ! -d "\$SRC" \]\]; then\s*\n\s+echo "✗ source dir not found: \$SRC"/,
    );
    expect(p).toMatch(
      /if \[\[ ! -d "\$DST" \]\]; then\s*\n\s+echo "✗ destination dir not found: \$DST \(run from a git clone\)"/,
    );
  });

  // ─── env-templates: production + staging ──────────────────────

  it("CRITICAL both env-templates V-278 anchor + 'DO NOT commit a populated copy' framing pinned. Drift to dropping the warning would let a developer push real secrets.", () => {
    expect(read(ENV_PROD)).toMatch(/# V-278\.A — production \.env template\./);
    expect(read(ENV_STG)).toMatch(/# V-278\.F — staging \.env template\./);
    expect(read(ENV_PROD)).toMatch(
      /DO NOT commit a populated copy of this file\. The deploy step writes\s*\n# \/opt\/driftstack\/api\/\.env from DEPLOY_DOTENV_BASE64/,
    );
  });

  it('CRITICAL both env-templates declare NODE_ENV=production + PORT=7780. Even staging uses NODE_ENV=production so Fastify enables prod optimizations + LOG_LEVEL differentiates the environments instead.', () => {
    for (const f of [ENV_PROD, ENV_STG]) {
      expect(read(f)).toMatch(/^NODE_ENV=production$/m);
      expect(read(f)).toMatch(/^PORT=7780$/m);
    }
    expect(read(ENV_PROD)).toMatch(/^LOG_LEVEL=info$/m);
    expect(read(ENV_STG)).toMatch(/^LOG_LEVEL=debug$/m);
    expect(read(ENV_STG)).toMatch(/^DRIFTSTACK_DEPLOY_ENV=staging$/m);
  });

  it('CRITICAL env templates pin different Neon hosts: production ep-aged-pond and staging ep-lingering-math. Drift to one host destroys staging isolation.', () => {
    expect(read(ENV_PROD)).toMatch(
      /DATABASE_URL=postgresql:\/\/neondb_owner:REDACTED@ep-aged-pond-al77cutb\.c-3\.eu-central-1\.aws\.neon\.tech\/neondb\?sslmode=require/,
    );
    expect(read(ENV_STG)).toMatch(
      /DATABASE_URL=postgresql:\/\/neondb_owner:REDACTED@ep-lingering-math-alnalhby-pooler\.c-3\.eu-central-1\.aws\.neon\.tech\/neondb\?sslmode=require/,
    );
  });

  it('CRITICAL Upstash Redis REST URL pinned to welcome-antelope-114301; staging uses REDIS_KEY_PREFIX=stg: to share the prod database (pre-V-278.K split). Drift would either cause prod/staging key collision or break Redis access.', () => {
    expect(read(ENV_PROD)).toMatch(
      /UPSTASH_REDIS_REST_URL=https:\/\/welcome-antelope-114301\.upstash\.io/,
    );
    expect(read(ENV_STG)).toMatch(
      /UPSTASH_REDIS_REST_URL=https:\/\/welcome-antelope-114301\.upstash\.io/,
    );
    expect(read(ENV_STG)).toMatch(/^REDIS_KEY_PREFIX=stg:$/m);
    expect(read(ENV_STG)).toMatch(/V-278\.K isolation[\s\S]*?deploy-bridge\.sh fails closed/);
  });

  it('CRITICAL R2_ACCOUNT_ID pinned to 7260371ac521e2a08a27ba8c7bdd5f43 cross-env; prod buckets driftstack-prod-{avatars,uploads} + staging driftstack-staging-{avatars,uploads}. The bucket-name namespacing matches the V-NNN convention; drift would collide prod/staging blob storage.', () => {
    for (const f of [ENV_PROD, ENV_STG]) {
      expect(read(f)).toMatch(/^R2_ACCOUNT_ID=7260371ac521e2a08a27ba8c7bdd5f43$/m);
    }
    expect(read(ENV_PROD)).toMatch(/^R2_BUCKET_AVATARS=driftstack-prod-avatars$/m);
    expect(read(ENV_PROD)).toMatch(/^R2_BUCKET_UPLOADS=driftstack-prod-uploads$/m);
    expect(read(ENV_PROD)).toMatch(/^R2_PUBLIC_BASE_URL=https:\/\/avatars\.driftstack\.dev$/m);
    expect(read(ENV_STG)).toMatch(/^R2_BUCKET_AVATARS=driftstack-staging-avatars$/m);
    expect(read(ENV_STG)).toMatch(/^R2_BUCKET_UPLOADS=driftstack-staging-uploads$/m);
    expect(read(ENV_STG)).toMatch(
      /^R2_PUBLIC_BASE_URL=https:\/\/avatars\.staging\.driftstack\.dev$/m,
    );
  });

  it('CRITICAL Postmark FROM addresses pinned cross-env — POSTMARK_FROM_TRANSACTIONAL=noreply@driftstack.dev + POSTMARK_FROM_DEFAULT=info@driftstack.dev. Drift would either break SPF/DKIM (changed sender domain) or get filtered as not-from-our-domain.', () => {
    for (const f of [ENV_PROD, ENV_STG]) {
      expect(read(f)).toMatch(/^POSTMARK_FROM_TRANSACTIONAL=noreply@driftstack\.dev$/m);
      expect(read(f)).toMatch(/^POSTMARK_FROM_DEFAULT=info@driftstack\.dev$/m);
    }
  });

  it('CRITICAL Sentry DSN shared cross-env; ENV vs RELEASE differs. SENTRY_TRACES_SAMPLE_RATE 0.05 (prod 5% sampling) vs 1.0 (staging full sampling). Drift to high prod sampling would explode the Sentry bill.', () => {
    expect(read(ENV_PROD)).toMatch(/SENTRY_TRACES_SAMPLE_RATE=0\.05/);
    expect(read(ENV_PROD)).toMatch(/SENTRY_ENVIRONMENT=production/);
    expect(read(ENV_STG)).toMatch(/SENTRY_TRACES_SAMPLE_RATE=1\.0/);
    expect(read(ENV_STG)).toMatch(/SENTRY_ENVIRONMENT=staging/);
    for (const f of [ENV_PROD, ENV_STG]) {
      expect(read(f)).toMatch(/SENTRY_RELEASE=PLACEHOLDER_GIT_SHA/);
    }
  });

  it("CRITICAL Stripe TEST-mode-pre-launch framing pinned in prod template. The 'TEST mode pre-launch (per Stripe credential-handling memory rule). Live keys swap in via SSH-write after BV KvK closure (~2026-05-21)' wording matches the credential-handling memory rule.", () => {
    const p = read(ENV_PROD);
    expect(p).toMatch(/TEST mode pre-launch \(per Stripe credential-handling memory rule\)\./);
    expect(p).toMatch(/Live keys swap in via SSH-write after BV KvK closure \(~2026-05-21\)\./);
    expect(p).toMatch(/STRIPE_SECRET_KEY=sk_test_REDACTED/);
    expect(p).toMatch(/STRIPE_PUBLISHABLE_KEY=pk_test_REDACTED/);
    expect(p).toMatch(/STRIPE_WEBHOOK_SECRET=whsec_REDACTED/);
  });

  it('CRITICAL both env-templates declare 6 auth signing secrets — SESSION + EMAIL_VERIFICATION + PASSWORD_RESET + MAGIC_LINK + MFA_ENCRYPTION_KEY + WEBHOOK_DEFAULT_SIGNING_SEED. Each rotates independently per V-296b rotation cycle.', () => {
    for (const f of [ENV_PROD, ENV_STG]) {
      const p = read(f);
      expect(p).toMatch(/^SESSION_SIGNING_SECRET=REDACTED$/m);
      expect(p).toMatch(/^EMAIL_VERIFICATION_SIGNING_SECRET=REDACTED$/m);
      expect(p).toMatch(/^PASSWORD_RESET_SIGNING_SECRET=REDACTED$/m);
      expect(p).toMatch(/^MAGIC_LINK_SIGNING_SECRET=REDACTED$/m);
      expect(p).toMatch(/^MFA_ENCRYPTION_KEY=REDACTED$/m);
      expect(p).toMatch(/^WEBHOOK_DEFAULT_SIGNING_SEED=REDACTED$/m);
    }
    expect(read(ENV_PROD)).toMatch(
      /These rotate independently of code deploys; rotation cycle V-296b\./,
    );
  });

  it('CRITICAL CORS_ALLOWED_ORIGINS pins the exact production and staging browser surfaces without a wildcard', () => {
    expect(read(ENV_PROD)).toMatch(
      /^CORS_ALLOWED_ORIGINS=https:\/\/app\.driftstack\.dev,https:\/\/admin\.driftstack\.dev,https:\/\/status\.driftstack\.dev,https:\/\/driftstack\.dev,https:\/\/www\.driftstack\.dev,https:\/\/docs\.driftstack\.dev$/m,
    );
    expect(read(ENV_STG)).toMatch(
      /^CORS_ALLOWED_ORIGINS=https:\/\/staging\.driftstack\.dev,https:\/\/staging\.driftstack-customer-dashboard\.pages\.dev,https:\/\/staging\.driftstack-admin-panel\.pages\.dev,https:\/\/staging\.driftstack-status\.pages\.dev,https:\/\/app\.driftstack\.dev,https:\/\/driftstack\.dev,https:\/\/docs\.driftstack\.dev$/m,
    );
    for (const f of [ENV_PROD, ENV_STG]) {
      expect(read(f)).not.toMatch(/^CORS_ALLOWED_ORIGINS=.*\*/m);
      expect(read(f)).not.toMatch(/^CORS_ALLOWED_ORIGINS=.*,,/m);
    }
  });

  it('CRITICAL environment base URLs pin production hosts and the live staging API plus stable Dashboard Pages alias', () => {
    expect(read(ENV_PROD)).toMatch(/^DASHBOARD_BASE_URL=https:\/\/app\.driftstack\.dev$/m);
    expect(read(ENV_STG)).toMatch(
      /^DASHBOARD_BASE_URL=https:\/\/staging\.driftstack-customer-dashboard\.pages\.dev$/m,
    );
    expect(read(ENV_PROD)).toMatch(/^PUBLIC_BASE_URL=https:\/\/api\.driftstack\.dev$/m);
    expect(read(ENV_STG)).toMatch(/^PUBLIC_BASE_URL=https:\/\/staging\.driftstack\.dev$/m);
    expect(read(ENV_STG)).toMatch(
      /^DASHBOARD_ORIGIN=https:\/\/staging\.driftstack-customer-dashboard\.pages\.dev$/m,
    );
  });

  it('CRITICAL both env-templates declare GIT_SHA=PLACEHOLDER_GIT_SHA + TRUST_PROXY=1. The placeholder gets sed-replaced by deploy-api.sh; TRUST_PROXY=1 lets Fastify read X-Forwarded-* headers from the nginx upstream.', () => {
    for (const f of [ENV_PROD, ENV_STG]) {
      expect(read(f)).toMatch(/^GIT_SHA=PLACEHOLDER_GIT_SHA$/m);
      expect(read(f)).toMatch(/^TRUST_PROXY=1$/m);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/commit-msg-hook-and-env-templates-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
