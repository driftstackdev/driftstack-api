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
//   • ErrorBannerProps 2-field: message + onDismiss callback.
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
      /\/\/ Shared inline error banner\. Lifted out of three views during GUI8\s*\n?\s*\/\/ polish so all error surfaces look identical and dismiss the same way\./,
    );
  });

  it('ErrorBannerProps 2-field: message: string + onDismiss: () => void — pinned so the banner stays dismissable and never sticks on screen blocking the workflow after the user has read the error', () => {
    expect(body).toMatch(
      /export interface ErrorBannerProps \{\s*\n?\s*message: string;\s*\n?\s*onDismiss: \(\) => void;\s*\n?\s*\}/,
    );
  });

  it("Render: destructured {message, onDismiss} signature + outer flex with status-error/30 border + status-error/10 bg tints + 'Error' section-label (status-error/80) + truncated message text-ink-primary + Dismiss button with btn-secondary class + type='button'", () => {
    expect(body).toMatch(
      /export function ErrorBanner\(\{ message, onDismiss \}: ErrorBannerProps\): JSX\.Element \{\s*\n?\s*return \(\s*\n?\s*<div className="flex items-start justify-between gap-3 rounded border border-status-error\/30 bg-status-error\/10 px-3 py-2">\s*\n?\s*<div className="flex flex-col gap-0\.5 min-w-0">\s*\n?\s*<span className="section-label text-status-error\/80">Error<\/span>\s*\n?\s*<span className="text-sm text-ink-primary truncate">\{message\}<\/span>\s*\n?\s*<\/div>\s*\n?\s*<button type="button" className="btn-secondary" onClick=\{onDismiss\}>\s*\n?\s*Dismiss\s*\n?\s*<\/button>\s*\n?\s*<\/div>\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
