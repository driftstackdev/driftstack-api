// W475.A — drift guard for apps/gui-client/src/components/ApiKeyMaskedSpan.tsx.
// V-534.R API-key masking primitive. Drift here either drops the
// 5-prefix `known` list (whsec_v1_/oas_/oat_ keys lose their type
// indicator in the masked form — operators can't tell at a glance
// whether the on-screen string is a webhook secret, OAuth client
// secret, or access token) or breaks the body-length<=prefix+suffix
// short-circuit (a key shorter than 8 chars overflows the ellipsis
// splice and renders ds_live_…ab — looks like data corruption).
//
//   • V-534.R framing pinned: 'ApiKeyMaskedSpan presentational
//     primitive.' + 'Renders a Driftstack API key as `ds_live_
//     abcd…wxyz` so views can confirm "this is the right key"
//     without exposing the full secret on-screen.'
//   • ApiKeyMaskedSpanProps 4-field (apiKey nullable|undefined +
//     visiblePrefixChars? + visibleSuffixChars? + className?).
//   • maskApiKey exported pure helper: 5-prefix `known` list
//     (ds_live_/ds_test_/whsec_v1_/oas_/oat_) + null/undefined →
//     '—' fallback + visiblePrefixChars/visibleSuffixChars default 4
//     + body.length<=prefix+suffix short-circuit + slice(0,prefix)
//     + '…' (U+2026) + slice(-suffix).
//   • Component aria-label 'API key (masked)' + className default
//     'font-mono text-sm text-ink-primary'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/ApiKeyMaskedSpan.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W475.A apps/gui-client/src/components/ApiKeyMaskedSpan.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.R framing pinned: 'V-534.R — ApiKeyMaskedSpan presentational primitive.' + 'Renders a Driftstack API key as `ds_live_abcd…wxyz` so views can confirm \"this is the right key\" without exposing the full secret on-screen. Used by SettingsView's \"connected\" banner today (which rolls its own mask); standalone primitive keeps the masking rule in one place.'", () => {
    expect(body).toMatch(/\/\/ V-534\.R — ApiKeyMaskedSpan presentational primitive\./);
    expect(body).toMatch(
      /\/\/ Renders a Driftstack API key as `ds_live_abcd…wxyz` so views can\s*\/\/ confirm "this is the right key" without exposing the full secret\s*\/\/ on-screen\. Used by SettingsView's "connected" banner today \(which\s*\/\/ rolls its own mask\); standalone primitive keeps the masking rule\s*\/\/ in one place\./,
    );
  });

  it("ApiKeyMaskedSpanProps 4-field: apiKey 'string | null | undefined' (3-way for missing vs null vs unset) + visiblePrefixChars? 'Number of leading chars to show (after the prefix). Default 4.' + visibleSuffixChars? 'Number of trailing chars to show. Default 4.' + className?", () => {
    expect(body).toMatch(
      /export interface ApiKeyMaskedSpanProps \{\s*\/\*\* Plaintext API key, or null when no key is configured\. \*\/\s*apiKey: string \| null \| undefined;\s*\/\*\* Number of leading chars to show \(after the prefix\)\. Default 4\. \*\/\s*visiblePrefixChars\?: number;\s*\/\*\* Number of trailing chars to show\. Default 4\. \*\/\s*visibleSuffixChars\?: number;\s*\/\*\* Class to apply to the wrapping span\. \*\/\s*className\?: string;\s*\}/,
    );
  });

  it("maskApiKey exported with 5-prefix known list ['ds_live_', 'ds_test_', 'whsec_v1_', 'oas_', 'oat_'] — pinned so the webhook-secret + OAuth-client + access-token prefixes don't get dropped from the type-indicator surface", () => {
    expect(body).toMatch(
      /export function maskApiKey\(\s*apiKey: string \| null \| undefined,\s*opts: \{ visiblePrefixChars\?: number; visibleSuffixChars\?: number \} = \{\},\s*\): string \{/,
    );
    expect(body).toMatch(/const known = \['ds_live_', 'ds_test_', 'whsec_v1_', 'oas_', 'oat_'\];/);
  });

  it("maskApiKey logic: !apiKey → '—' (em-dash U+2014) fallback + prefixChars/suffixChars default 4 + for-of known prefix detection + body.length <= prefixChars + suffixChars short-circuit returns ${prefix}${body} unmasked + otherwise ${prefix}${body.slice(0, prefixChars)}…${body.slice(-suffixChars)} with '…' (U+2026 horizontal ellipsis)", () => {
    expect(body).toMatch(/if \(!apiKey\) return '—';/);
    expect(body).toMatch(/const prefixChars = opts\.visiblePrefixChars \?\? 4;/);
    expect(body).toMatch(/const suffixChars = opts\.visibleSuffixChars \?\? 4;/);
    expect(body).toMatch(
      /for \(const p of known\) \{\s*if \(apiKey\.startsWith\(p\)\) \{\s*prefix = p;\s*body = apiKey\.slice\(p\.length\);\s*break;\s*\}\s*\}\s*if \(body\.length <= prefixChars \+ suffixChars\) \{\s*return `\$\{prefix\}\$\{body\}`;\s*\}\s*return `\$\{prefix\}\$\{body\.slice\(0, prefixChars\)\}…\$\{body\.slice\(-suffixChars\)\}`;/,
    );
  });

  it("ApiKeyMaskedSpan component: spread-undefined-skip props (visiblePrefixChars/visibleSuffixChars only passed when !== undefined to keep maskApiKey's ?? 4 default intact) + className default 'font-mono text-sm text-ink-primary' + aria-label 'API key (masked)'", () => {
    expect(body).toMatch(
      /export function ApiKeyMaskedSpan\(props: ApiKeyMaskedSpanProps\): JSX\.Element \{\s*const masked = maskApiKey\(props\.apiKey, \{\s*\.\.\.\(props\.visiblePrefixChars !== undefined\s*\? \{ visiblePrefixChars: props\.visiblePrefixChars \}\s*: \{\}\),\s*\.\.\.\(props\.visibleSuffixChars !== undefined\s*\? \{ visibleSuffixChars: props\.visibleSuffixChars \}\s*: \{\}\),\s*\}\);\s*const cls = props\.className \?\? 'font-mono text-sm text-ink-primary';\s*return \(\s*<span className=\{cls\} aria-label="API key \(masked\)">\s*\{masked\}\s*<\/span>\s*\);\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
