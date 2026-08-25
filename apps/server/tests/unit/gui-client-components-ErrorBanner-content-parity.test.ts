// W478.A — drift guard for apps/gui-client/src/components/ErrorBanner.tsx.
// Shared inline error banner. Drift here either breaks the
// 'lifted from three views during GUI8 polish' framing (drops
// the shared-component intent and the banner divergence creeps
// back in — three different-looking error surfaces across views)
// or drops the onDismiss callback (banner becomes non-
// dismissable and stays on screen blocking the workflow after
// the user has read the error).
//
//   • Framing pinned: 'Shared inline error banner. Lifted out of
//     three views during GUI8 polish so all error surfaces look
//     identical and dismiss the same way.' — pinned so a
//     refactor doesn't fork the banner back into per-view copies.
//   • Required message + onDismiss fields, with optional retry state.
//   • Markup: status-error border/bg tints + 'Error' section-label
//     + truncated message + Dismiss button with btn-secondary
//     class.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/ErrorBanner.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W478.A apps/gui-client/src/components/ErrorBanner.tsx content parity', () => {
  const body = read(LIB);

  it("Framing pinned: 'Shared inline error banner. Lifted out of three views during GUI8 polish so all error surfaces look identical and dismiss the same way.' — pinned so a refactor doesn't fork the banner back into per-view copies and three different-looking error surfaces creep back in", () => {
    expect(body).toMatch(
      /\/\/ Shared inline error banner\. Lifted out of three views during GUI8\s*\/\/ polish so all error surfaces look identical and dismiss the same way\./,
    );
  });

  it('ErrorBannerProps keeps message + onDismiss required while recovery remains optional', () => {
    expect(body).toMatch(
      /export interface ErrorBannerProps \{[\s\S]*?message: string;\s*onDismiss: \(\) => void;[\s\S]*?onRetry\?: \(\) => void;[\s\S]*?retrying\?: boolean;\s*\}/,
    );
  });

  it('2026-05-20 — message span flipped from `truncate` to `whitespace-pre-line` so multi-line diagnosticFetchError output (newlines + bullets) renders intact instead of collapsing to a single line. Outer flex / border / bg / section-label / Dismiss button shape unchanged.', () => {
    // W609 — a record('error', …) useEffect now sits between the signature
    // and the return (every visible error mirrors into Dev Logs), so the
    // signature + JSX shells are pinned separately.
    expect(body).toMatch(
      /export function ErrorBanner\(\{[\s\S]*?message,[\s\S]*?onDismiss,[\s\S]*?onRetry,[\s\S]*?retrying = false,[\s\S]*?\}: ErrorBannerProps\): JSX\.Element \{/,
    );
    // role="alert" so screen readers announce the error (a11y, 2026-06-15).
    expect(body).toMatch(
      /<div\s*role="alert"\s*className="flex items-start justify-between gap-3 rounded border border-status-error\/30 bg-status-error\/10 px-3 py-2"\s*>\s*<div className="flex flex-col gap-0\.5 min-w-0">\s*<span className="section-label text-status-error\/80">Error<\/span>/,
    );
    expect(body).toMatch(
      /<span className="whitespace-pre-line text-sm text-ink-primary">\{message\}<\/span>[\s\S]*?<button type="button" className="btn-secondary" onClick=\{onDismiss\}>\s*Dismiss\s*<\/button>/,
    );
    expect(body).toMatch(
      /\/\/ 2026-05-20 — whitespace-pre-line so multi-line diagnostic|whitespace-pre-line so multi-line diagnostic/,
    );
  });

  it("W609 — every visible error mirrors into Dev Logs: useEffect keyed on message calls record('error', ['[ui] ' + message]) — pinned so the banner stays the chokepoint that makes the Dev Logs panel useful during user-facing failures (views render friendly messages without touching console.*)", () => {
    expect(body).toMatch(/import \{ record \} from '\.\.\/lib\/log-buffer';/);
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*record\('error', \['\[ui\] ' \+ message\]\);\s*\}, \[message\]\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
