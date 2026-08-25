// W385.B — drift guard for gui-client ApiKeyMaskedSpan component
// source. Existing ApiKeyMaskedSpan.test.tsx covers rendering
// behavior; this guard pins the source-level masking semantics
// that callers across the app depend on. Drift in the known-
// prefix list silently un-masks a new key prefix.
//
//   • V-534.R framing pinned.
//   • 5 known prefixes recognized in order: ds_live_ / ds_test_ /
//     whsec_v1_ / oas_ / oat_.
//   • maskApiKey: null/empty → "—" sentinel.
//   • Default prefix/suffix chars = 4.
//   • Body shorter than prefixChars + suffixChars → returns prefix
//     + body verbatim (no ellipsis when nothing to hide).
//   • Body long enough → "${prefix}${prefixChars}…${suffixChars}".
//   • aria-label="API key (masked)" on the span.
//   • Default className: "font-mono text-sm text-ink-primary".
//   • maskApiKey exported as pure helper (logging-safe).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const COMPONENT = resolve(REPO_ROOT, 'apps/gui-client/src/components/ApiKeyMaskedSpan.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W385.B gui-client ApiKeyMaskedSpan content parity', () => {
  const body = read(COMPONENT);

  it('V-534.R framing pinned + "right key" disambiguation use-case', () => {
    expect(body).toMatch(/V-534\.R — ApiKeyMaskedSpan presentational primitive/);
    expect(body).toMatch(
      /Renders a Driftstack API key as `ds_live_abcd…wxyz` so views can\s*\/\/\s*confirm "this is the right key" without exposing the full secret/,
    );
  });

  it('Props interface: 4 fields (apiKey nullable + visiblePrefixChars + visibleSuffixChars + className)', () => {
    expect(body).toMatch(/apiKey: string \| null \| undefined;/);
    expect(body).toMatch(/visiblePrefixChars\?: number;/);
    expect(body).toMatch(/visibleSuffixChars\?: number;/);
    expect(body).toMatch(/className\?: string;/);
  });

  it('5 known key prefixes recognized in canonical order (ds_live_ / ds_test_ / whsec_v1_ / oas_ / oat_)', () => {
    expect(body).toMatch(/const known = \['ds_live_', 'ds_test_', 'whsec_v1_', 'oas_', 'oat_'\];/);
  });

  it('null/empty input → "—" em-dash sentinel (no risk of mistaking empty for a real masked key)', () => {
    expect(body).toMatch(/if \(!apiKey\) return '—';/);
  });

  it('default prefixChars + suffixChars = 4', () => {
    expect(body).toMatch(/const prefixChars = opts\.visiblePrefixChars \?\? 4;/);
    expect(body).toMatch(/const suffixChars = opts\.visibleSuffixChars \?\? 4;/);
  });

  it('short-body branch: returns prefix + body verbatim (no ellipsis when nothing to hide)', () => {
    expect(body).toMatch(
      /if \(body\.length <= prefixChars \+ suffixChars\) \{\s*return `\$\{prefix\}\$\{body\}`;\s*\}/,
    );
  });

  it('long-body branch: prefix + slice(0, prefixChars) + ellipsis + slice(-suffixChars)', () => {
    expect(body).toMatch(
      /return `\$\{prefix\}\$\{body\.slice\(0, prefixChars\)\}…\$\{body\.slice\(-suffixChars\)\}`;/,
    );
  });

  it('maskApiKey exported as pure helper (logging-safe non-React callers)', () => {
    expect(body).toMatch(/Pure helper exported for tests \+ non-React callers/);
    expect(body).toMatch(/export function maskApiKey\(/);
  });

  it('aria-label="API key (masked)" on the rendered span', () => {
    expect(body).toMatch(/aria-label="API key \(masked\)"/);
  });

  it('default className: "font-mono text-sm text-ink-primary"', () => {
    expect(body).toMatch(/const cls = props\.className \?\? 'font-mono text-sm text-ink-primary';/);
  });

  it('ApiKeyMaskedSpan returns JSX.Element', () => {
    expect(body).toMatch(
      /export function ApiKeyMaskedSpan\(props: ApiKeyMaskedSpanProps\): JSX\.Element/,
    );
  });

  it('component file exists at canonical path', () => {
    expect(existsSync(COMPONENT)).toBe(true);
  });
});
