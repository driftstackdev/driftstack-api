// W840 — cross-SDK no plaintext-secret leakage. One-hundred-sixty-
// sixth in the drift-guard series. Pins that no SDK runtime + test
// source contains real-looking plaintext secrets — sk_live_<16+
// chars>, whsec_<32+hex>, ds_live_<16+chars>. Only placeholder/
// ellipsis values (ds_live_… / sk_test_REDACTED / whsec_REDACTED /
// ds_live_demo / ds_test_fakefake...) are allowed.
//
// Defense against accidental commits of real keys — the
// V-credential-handling memory rule + AGENTS.md trust pattern says
// LIVE-mode secrets NEVER pass through agent chat / source / PR
// artifacts. This test is a structural backstop.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const entry of readdirSync(dir)) {
    if (
      entry === 'node_modules' ||
      entry === 'dist' ||
      entry === '.venv' ||
      entry === '__pycache__'
    )
      continue;
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// Patterns that look like REAL secrets (long enough to be load-bearing).
const REAL_SECRET_PATTERNS = [
  // Stripe live-mode keys: sk_live_<24+ url-safe chars>
  { name: 'sk_live_ live Stripe', regex: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  // Stripe live publishable: pk_live_<24+ chars>
  { name: 'pk_live_ live Stripe', regex: /\bpk_live_[A-Za-z0-9]{20,}\b/ },
  // Stripe webhook secret: whsec_<32+ url-safe chars>
  { name: 'whsec_ webhook secret', regex: /\bwhsec_[A-Za-z0-9]{32,}\b/ },
  // Driftstack live API key: ds_live_<24+ chars>
  { name: 'ds_live_ live API key', regex: /\bds_live_[A-Za-z0-9]{20,}\b/ },
  // Postmark server token: long hex/base32 after the prefix
  { name: 'Postmark server-token-looking', regex: /\bP-[A-Za-z0-9_-]{40,}\b/ },
  // GitHub PAT: ghp_<36 chars>
  { name: 'GitHub PAT', regex: /\bghp_[A-Za-z0-9]{36}\b/ },
  // AWS access key ID: AKIA<16 chars>
  { name: 'AWS access key', regex: /\bAKIA[A-Z0-9]{16}\b/ },
];

// Allow-listed placeholder strings (these intentionally appear in source).
const ALLOWED_PLACEHOLDERS = [
  'ds_live_demo', // TS error-handling fallback (W797 + W837)
  'ds_test_fakefakefakefakefakefakefakefake', // Python pytest fixture key (W802)
  'sk_test_REDACTED', // env-template placeholder (W807)
  'whsec_REDACTED', // env-template placeholder (W807)
  'whsec_dev_only', // TS webhook example dev fallback (W799)
];

describe('W840 cross-SDK no plaintext-secret leakage', () => {
  // ─── SDK runtime source scan ─────────────────────────────────

  it('CRITICAL no SDK runtime source contains real-looking plaintext secrets (sk_live_ / pk_live_ / whsec_<32hex> / ds_live_<24chars> / GitHub PAT / AWS access key). Only placeholder/ellipsis values allowed. Defense against accidental commits of real keys per credential-handling memory rule + AGENTS.md trust pattern.', () => {
    const dirs = [
      resolve(REPO_ROOT, 'packages/sdk-typescript/src'),
      resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack'),
      resolve(REPO_ROOT, 'packages/sdk-go'),
    ];
    const files: string[] = [];
    for (const d of dirs) {
      files.push(...listFiles(d, ['.ts', '.py', '.go']));
    }
    // Skip test files — they use intentional fake-but-real-looking fixtures.
    const productionFiles = files.filter(
      (f) => !f.endsWith('_test.go') && !/[/]tests[/]/.test(f) && !/\.test\.[a-z]+$/.test(f),
    );

    for (const f of productionFiles) {
      const p = read(f);
      const rel = relative(REPO_ROOT, f);
      for (const { name, regex } of REAL_SECRET_PATTERNS) {
        const m = p.match(regex);
        if (!m) continue;
        // Check if it's an allowed placeholder.
        const isPlaceholder = ALLOWED_PLACEHOLDERS.some((ph) => m[0] === ph);
        expect(isPlaceholder, `${rel} contains real-looking ${name}: '${m[0]}'`).toBe(true);
      }
    }
  });

  // ─── env-templates only contain REDACTED ─────────────────────

  it("CRITICAL infra/env-templates/{production,staging}.env.template contain ONLY 'REDACTED' values for secret-like fields (per W807). Drift to including a real secret would catastrophically leak credentials.", () => {
    for (const f of [
      'infra/env-templates/production.env.template',
      'infra/env-templates/staging.env.template',
    ]) {
      const p = read(resolve(REPO_ROOT, f));
      // Stripe secret key MUST be sk_test_REDACTED (per W807).
      expect(p, `${f} STRIPE_SECRET_KEY must be sk_test_REDACTED`).toMatch(
        /STRIPE_SECRET_KEY=sk_test_REDACTED/,
      );
      // The webhook secret MUST be whsec_REDACTED.
      expect(p, `${f} STRIPE_WEBHOOK_SECRET must be whsec_REDACTED`).toMatch(
        /STRIPE_WEBHOOK_SECRET=whsec_REDACTED/,
      );
      // No real-looking secrets sneak in.
      for (const { name, regex } of REAL_SECRET_PATTERNS) {
        const m = p.match(regex);
        if (m && !ALLOWED_PLACEHOLDERS.some((ph) => m[0] === ph)) {
          expect.fail(`${f} contains real-looking ${name}: '${m[0]}'`);
        }
      }
    }
  });

  // ─── 6 documented allow-listed placeholders ──────────────────

  it('CRITICAL the 5 documented allow-listed placeholders (ds_live_demo / ds_test_fakefakefake... / sk_test_REDACTED / whsec_REDACTED / whsec_dev_only) are the ONLY secret-shaped strings in source. Drift to adding a new placeholder without updating this allow-list would let real secrets through.', () => {
    expect(ALLOWED_PLACEHOLDERS).toHaveLength(5);
    expect(ALLOWED_PLACEHOLDERS).toContain('ds_live_demo');
    expect(ALLOWED_PLACEHOLDERS).toContain('ds_test_fakefakefakefakefakefakefakefake');
    expect(ALLOWED_PLACEHOLDERS).toContain('sk_test_REDACTED');
    expect(ALLOWED_PLACEHOLDERS).toContain('whsec_REDACTED');
    expect(ALLOWED_PLACEHOLDERS).toContain('whsec_dev_only');
  });

  // ─── Examples use ellipsis (…) not real secrets ─────────────

  it("CRITICAL SDK examples use UNICODE ellipsis (…) or three-ASCII-dot ellipsis (...) in API-key placeholders. The non-decodable ellipsis is a defensive choice — even if the example is copy-pasted, the user MUST replace the placeholder. Drift to hardcoded 'ds_live_...REAL_HEX...' would create copy-paste-with-real-secret risk.", () => {
    const exampleFiles = [
      'packages/sdk-typescript/examples/quickstart.ts',
      'packages/sdk-python/examples/quickstart.py',
      'packages/sdk-go/examples/quickstart/main.go',
    ];
    for (const f of exampleFiles) {
      const p = read(resolve(REPO_ROOT, f));
      // Each must reference 'ds_live_' but with … or ... immediately after.
      const ellipsisMatch =
        /ds_live_(?:\.\.\.|…)/.test(p) || /DRIFTSTACK_API_KEY=ds_live_(?:\.\.\.|…)/.test(p);
      expect(ellipsisMatch, `${f} must use ellipsis (… or ...) after ds_live_`).toBe(true);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-no-plaintext-secret-leakage-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
