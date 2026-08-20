// W867 — PrefixedId 8-prefix roster + helper-regex cross-source
// invariant. One-hundred-ninety-third in the drift-guard series.
// Pins the canonical PrefixedId helper + the 8-prefix roster:
//
//   1. acc  — Account               (common.ts)
//   2. key  — ApiKey                (common.ts)
//   3. ses  — Session               (common.ts)
//   4. evt  — SessionEvent          (common.ts)
//   5. use  — UsageRecord           (common.ts)
//   6. prof — Profile               (profiles.ts)
//   7. whk  — WebhookEndpoint       (webhooks.ts)
//   8. wdl  — WebhookDelivery       (webhooks.ts)
//
// stays in lockstep across:
//   - packages/api-types/src/common.ts (PrefixedId helper +
//     5 core schemas).
//   - packages/api-types/src/profiles.ts (1 schema).
//   - packages/api-types/src/webhooks.ts (2 schemas).
//
// The PrefixedId helper enforces:
//   - `${prefix}_<uuid>` shape where uuid is 8-4-4-4-12 hex.
//   - prefix must be lowercase letters.
//   - regex pattern is what server-side route-param parsers use
//     to validate IDs before passing into service layer.
//
// Drift would silently break:
//   * Server route-param validation (custom prefix would fail
//     PrefixedId regex).
//   * Cross-prefix collision if two resources used the same prefix.
//   * Marketing-prefix-id-sweep (W-NNN) doc-example checks.

// V-1112 — the blind spot, named rather than left implicit. This file covers ids
// built with the PrefixedId helper, and the completeness arm at the end keeps that
// set honest. It does NOT cover every `<prefix>_<uuid>` the product mints: `agt_`
// (agent sessions), `mem_`, `inc_` and `tab_` appear as identifier prefixes in
// comments and in `lib/redact-url.ts`, and none is declared through the helper —
// so none carries its `prefix_8-4-4-4-12` guarantee and none is checked here.
// Whether those should move onto the helper is a design question, not a drift; what
// is not acceptable is a roster that reads as "the product's id prefixes" when it
// means "the ids built through this one constructor".

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// 8 canonical PrefixedId schemas + their file homes.
const PREFIXED_IDS = [
  { schema: 'AccountIdSchema', prefix: 'acc', file: 'common.ts' },
  { schema: 'ApiKeyIdSchema', prefix: 'key', file: 'common.ts' },
  { schema: 'SessionIdSchema', prefix: 'ses', file: 'common.ts' },
  { schema: 'SessionEventIdSchema', prefix: 'evt', file: 'common.ts' },
  { schema: 'UsageRecordIdSchema', prefix: 'use', file: 'common.ts' },
  { schema: 'ProfileIdSchema', prefix: 'prof', file: 'profiles.ts' },
  { schema: 'WebhookEndpointIdSchema', prefix: 'whk', file: 'webhooks.ts' },
  { schema: 'WebhookDeliveryIdSchema', prefix: 'wdl', file: 'webhooks.ts' },
] as const;

describe('W867 PrefixedId roster cross-source invariant', () => {
  // ─── PrefixedId helper declaration ───────────────────────────

  it("CRITICAL packages/api-types/src/common.ts PrefixedId helper exports as 'export const PrefixedId = (prefix: string): z.ZodString =>'. The helper is the source-of-truth for the `${prefix}_<uuid>` shape — every prefixed-id schema delegates to it.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(/export const PrefixedId = \(prefix: string\): z\.ZodString =>/);
  });

  it("CRITICAL PrefixedId regex shape enforces `${prefix}_8-4-4-4-12-hex` (UUIDv4 shape) — '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'. Drift to a different shape would break server-side route-param validation.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(
      /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/,
    );
  });

  it('CRITICAL PrefixedId helper message uses backticks for tagged-template: `must start with "${prefix}_" followed by a UUID`. The dynamic-error-message is what makes server-side 400 responses helpful.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(/must start with "\$\{prefix\}_" followed by a UUID/);
  });

  // ─── 5 schemas in common.ts ──────────────────────────────────

  it('CRITICAL 5 core PrefixedId schemas live in common.ts: AccountIdSchema (acc), ApiKeyIdSchema (key), SessionIdSchema (ses), SessionEventIdSchema (evt), UsageRecordIdSchema (use). The 5 are the cross-cutting IDs used across multiple feature areas.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    const commonSchemas = PREFIXED_IDS.filter((s) => s.file === 'common.ts');
    expect(commonSchemas.length).toBe(5);
    for (const { schema, prefix } of commonSchemas) {
      expect(p, `${schema} must use PrefixedId('${prefix}')`).toMatch(
        new RegExp(`export const ${schema} = PrefixedId\\('${prefix}'\\);`),
      );
    }
  });

  // ─── 1 schema in profiles.ts ─────────────────────────────────

  it("CRITICAL packages/api-types/src/profiles.ts declares ProfileIdSchema = PrefixedId('prof'). The 'prof' prefix is unique across the roster.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(/export const ProfileIdSchema = PrefixedId\('prof'\);/);
  });

  // ─── 2 schemas in webhooks.ts ────────────────────────────────

  it("CRITICAL packages/api-types/src/webhooks.ts declares 2 PrefixedId schemas — WebhookEndpointIdSchema = PrefixedId('whk') + WebhookDeliveryIdSchema = PrefixedId('wdl'). The whk/wdl pair distinguishes endpoint-config rows from per-delivery attempt rows.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/export const WebhookEndpointIdSchema = PrefixedId\('whk'\);/);
    expect(p).toMatch(/export const WebhookDeliveryIdSchema = PrefixedId\('wdl'\);/);
  });

  // ─── Prefix uniqueness ───────────────────────────────────────

  it('CRITICAL all 8 prefixes are UNIQUE — no collision. Two resources sharing a prefix would let an attacker swap an ID from one resource path into another route (e.g. a session-id passed where an api-key-id is expected). The unique-prefix invariant is a defense-in-depth layer.', () => {
    const prefixes = PREFIXED_IDS.map((s) => s.prefix);
    const uniquePrefixes = new Set(prefixes);
    expect(uniquePrefixes.size, 'all prefixes must be unique').toBe(prefixes.length);
    expect(prefixes.length).toBe(8);
  });

  // ─── Prefix length convention (3 or 4 letters) ────────────────

  it('CRITICAL all 8 prefixes are 3-4 letters of lowercase a-z. The short-prefix convention keeps IDs readable + URL-shortener-resistant. Drift to longer/symbol-rich prefixes would break the convention.', () => {
    for (const { prefix } of PREFIXED_IDS) {
      expect(prefix, `prefix '${prefix}' must be 3-4 lowercase letters`).toMatch(/^[a-z]{3,4}$/);
    }
  });

  // ─── No legacy / forbidden prefix names ──────────────────────

  it('CRITICAL no source declares forbidden prefixes (id / pk / fk / token / sig / hash). These are common but ambiguous prefixes that the 8-roster intentionally avoids — drift would let a resource-id look like a generic identifier.', () => {
    const common = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    const profiles = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    const webhooks = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    const forbidden = ['id', 'pk', 'fk', 'token', 'sig', 'hash', 'uuid'];
    for (const f of forbidden) {
      // Pattern: PrefixedId('forbidden_name').
      for (const [name, body] of [
        ['common.ts', common],
        ['profiles.ts', profiles],
        ['webhooks.ts', webhooks],
      ] as const) {
        expect(body, `${name} must NOT use PrefixedId('${f}')`).not.toMatch(
          new RegExp(`PrefixedId\\('${f}'\\)`),
        );
      }
    }
  });

  // ─── Types re-exported via z.infer ───────────────────────────

  it('CRITICAL types re-export from z.infer for PrefixedId schemas — AccountId/ApiKeyId/SessionId/etc. The z.infer pattern is drift-proof (vs hand-written branded types).', () => {
    const common = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(common).toMatch(/export type AccountId = z\.infer<typeof AccountIdSchema>;/);
    expect(common).toMatch(/export type SessionId = z\.infer<typeof SessionIdSchema>;/);
    const profiles = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(profiles).toMatch(/export type ProfileId = z\.infer<typeof ProfileIdSchema>;/);
    const webhooks = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(webhooks).toMatch(
      /export type WebhookEndpointId = z\.infer<typeof WebhookEndpointIdSchema>;/,
    );
  });

  // ─── 8-roster cardinality + 5+1+2 file split ──────────────────

  it('CRITICAL PrefixedId roster = EXACTLY 8 schemas across 3 files (5 in common.ts + 1 in profiles.ts + 2 in webhooks.ts). The 5/1/2 file-split mirrors the cross-cutting vs feature-specific separation. Drift to scattering schemas across more files would fragment the roster discovery.', () => {
    expect(PREFIXED_IDS.length).toBe(8);
    const byFile: Record<string, number> = { 'common.ts': 0, 'profiles.ts': 0, 'webhooks.ts': 0 };
    for (const s of PREFIXED_IDS) {
      byFile[s.file]! += 1;
    }
    expect(byFile['common.ts']).toBe(5);
    expect(byFile['profiles.ts']).toBe(1);
    expect(byFile['webhooks.ts']).toBe(2);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/prefixed-id-roster-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
  it('CRITICAL V-1112 every schema built with the PrefixedId helper is in the roster. The table below is what every arm here iterates, so a ninth PrefixedId schema is not reported as unrostered — it is never looked at, and none of the prefix/UUID-shape assertions reach it. The helper is the whole point: an id built through it carries the `prefix_8-4-4-4-12` guarantee, and an id that merely looks like one carries nothing.', () => {
    const src = resolve(REPO_ROOT, 'packages/api-types/src');
    const DECL = /export const (\w+) = PrefixedId\('([a-z_]+)'\)/g;
    const declared: { schema: string; prefix: string; file: string }[] = [];
    for (const f of readdirSync(src).filter((n) => n.endsWith('.ts'))) {
      const body = readFileSync(resolve(src, f), 'utf8');
      for (const m of body.matchAll(DECL)) {
        declared.push({ schema: m[1] as string, prefix: m[2] as string, file: f });
      }
    }
    expect(declared.length, 'PrefixedId schemas discovered in api-types').toBeGreaterThanOrEqual(8);

    // Widened deliberately: PREFIXED_IDS is `as const`, so a Set built from it
    // is keyed on the eight literals and cannot be asked about a parsed string.
    const rostered = new Set<string>(PREFIXED_IDS.map((e) => e.schema));
    expect(
      declared.filter((d) => !rostered.has(d.schema)).map((d) => `${d.schema} ('${d.prefix}')`),
      'these schemas are built with PrefixedId but have no roster row, so no arm above checks ' +
        'their prefix or their UUID shape:',
    ).toEqual([]);
    expect(
      PREFIXED_IDS.filter((e) => !declared.some((d) => d.schema === e.schema)).map((e) => e.schema),
      'roster rows for schemas that are no longer built with PrefixedId:',
    ).toEqual([]);
    // That second expectation is a BACKSTOP, not new coverage: the per-file arms
    // above already fail when a schema stops being built with the helper —
    // measured, by rewriting SessionEventIdSchema as a bare z.string(). It is
    // kept because it covers all eight uniformly and says why in one line; it is
    // not what makes this arm worth having.

    // Prefix and source-file agreement are NOT re-asserted here: the per-file
    // arms above already fail on a wrong prefix and on a row attributed to the
    // wrong file — both verified by mutation while writing this. A second copy
    // of a check that already fires adds no coverage and one more thing to keep
    // true. What IS new is the direction above: a NEW PrefixedId schema trips
    // nothing else, because every other arm here counts roster rows.
  });
});
