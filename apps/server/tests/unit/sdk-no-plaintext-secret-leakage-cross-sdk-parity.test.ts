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

// Allow-listed placeholder strings.
//
// EMPTY, and that is the finding rather than an omission. It previously held
// five entries — `ds_live_demo`, a Python fixture key, two `*_REDACTED` env
// placeholders and `whsec_dev_only` — and NOT ONE of them could match any
// pattern above. `ds_live_demo` has four characters after the prefix where the
// pattern needs twenty; `whsec_REDACTED` is not 32 url-safe characters. So the
// list read as "five reviewed exceptions" while exempting nothing at all.
//
// An inert exemption is not harmless. It is the shape that invites a real one to
// be added beside it without anyone re-deriving whether the check still works —
// and the check DID have a hole (see the scan below). The reachability arm
// further down now fails on any entry that cannot match, so this list can only
// ever contain exceptions that genuinely do something.
const ALLOWED_PLACEHOLDERS: string[] = [];

/**
 * The SDK runtime sources this sweep is responsible for, across all three
 * languages. Named once so the reachability check below counts exactly what the
 * scan reads, rather than a second list that could drift away from it.
 */
function sdkProductionFiles(): string[] {
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
  return files.filter(
    (f) => !f.endsWith('_test.go') && !/[/]tests[/]/.test(f) && !/\.test\.[a-z]+$/.test(f),
  );
}

describe('W840 cross-SDK no plaintext-secret leakage', () => {
  it('CRITICAL the scan read real SDK sources and the patterns can still match a secret. The scan asserts per-file INSIDE a loop, so a collection that came back empty makes it vacuously true — reporting all three SDKs clean because it read none. Neutralising the directory read left this file green.', () => {
    const files = sdkProductionFiles();
    expect(files.length, 'SDK runtime sources scanned across TS, Python and Go').toBeGreaterThan(
      50,
    );
    // Every language must actually be represented: two of three roots going
    // missing would still clear a total-count floor.
    for (const ext of ['.ts', '.py', '.go']) {
      expect(
        files.filter((f) => f.endsWith(ext)).length,
        `${ext} runtime sources scanned`,
      ).toBeGreaterThan(5);
    }

    // The patterns, against a synthetic secret and a near-miss. Assembled from
    // fragments rather than written as one literal so this file never contains
    // anything a credential scanner would have to judge.
    const syntheticLive = `sk_${'live_'}${'A1b2C3d4E5f6G7h8I9j0'}`;
    const stripePattern = REAL_SECRET_PATTERNS.find((p) => p.name.startsWith('sk_live_'))!;
    expect(stripePattern.regex.test(syntheticLive), 'a full-length live key is matched').toBe(true);
    expect(
      stripePattern.regex.test(`sk_${'live_'}short`),
      'and a too-short lookalike is not, so the pattern is not matching everything',
    ).toBe(false);
  });

  it('CRITICAL every allow-listed placeholder can actually match a pattern. An entry that matches nothing exempts nothing — it is dead text that reads as a reviewed exception. All five original entries were in exactly that state, which is how a list nobody re-derives ends up sitting next to a check that has a hole in it.', () => {
    const unreachable = ALLOWED_PLACEHOLDERS.filter(
      (ph) => !REAL_SECRET_PATTERNS.some(({ regex }) => regex.test(ph)),
    );
    expect(
      unreachable,
      'allow-listed placeholder(s) that cannot match any secret pattern — delete them, they exempt nothing:',
    ).toEqual([]);
  });

  // ─── SDK runtime source scan ─────────────────────────────────

  it('CRITICAL no SDK runtime source contains real-looking plaintext secrets (sk_live_ / pk_live_ / whsec_<32hex> / ds_live_<24chars> / GitHub PAT / AWS access key). Only placeholder/ellipsis values allowed. Defense against accidental commits of real keys per credential-handling memory rule + AGENTS.md trust pattern.', () => {
    for (const f of sdkProductionFiles()) {
      const p = read(f);
      const rel = relative(REPO_ROOT, f);
      for (const { name, regex } of REAL_SECRET_PATTERNS) {
        // EVERY occurrence, not just the first. `String.match` with a
        // non-global regex returns only the first hit, so a file containing an
        // allow-listed placeholder BEFORE a real secret would have been judged
        // solely on the placeholder and passed. No placeholder could actually
        // match at the time this was found, which is the only reason the hole
        // was latent rather than live — a single reachable placeholder would
        // have opened it.
        const all = [...p.matchAll(new RegExp(regex.source, `${regex.flags}g`))];
        for (const m of all) {
          const isPlaceholder = ALLOWED_PLACEHOLDERS.some((ph) => m[0] === ph);
          expect(isPlaceholder, `${rel} contains real-looking ${name}: '${m[0]}'`).toBe(true);
        }
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

  // ─── the allow-list, now empty by derivation ─────────────────

  it('CRITICAL the allow-list is EMPTY, and stays empty until an entry is needed AND reachable. It previously pinned five names as "the ONLY secret-shaped strings in source" — but none of the five could match any pattern, so the case was pinning the spelling of five inert strings while claiming to bound real exemptions. Emptying it is not a relaxation: the reachability arm above now rejects any entry that exempts nothing, so a future addition has to prove it does something.', () => {
    expect(ALLOWED_PLACEHOLDERS).toEqual([]);
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
