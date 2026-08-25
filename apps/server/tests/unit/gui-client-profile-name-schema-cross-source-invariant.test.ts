// Cross-source invariant: the gui-client's client-side profile-name pre-flight
// (apps/gui-client/src/lib/profile-name.ts) MUST encode the same rule as the
// server's ProfileNameSchema (packages/api-types/src/profiles.ts). The gui-client
// doesn't depend on @driftstack/api-types, so the regex + 120-char bound are
// replicated there; this guard pins them identical so a value the GUI's pre-flight
// accepts is never rejected server-side (and vice-versa — the whole point of the
// pre-flight is to turn the server's opaque "Validation Failed" into a specific,
// matching message).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const API_TYPES = resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts');
const GUI_LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/profile-name.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// The shared name regex (start/end alphanumeric; inner letters/digits/space/_/-/.;
// or a single alphanumeric). Both sources must carry it verbatim.
const SHARED_NAME_RE = String.raw`/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,118}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/`;

describe('gui-client profile-name pre-flight ↔ server ProfileNameSchema cross-source invariant', () => {
  const apiTypes = read(API_TYPES);
  const guiLib = read(GUI_LIB);

  it('server ProfileNameSchema carries the shared regex + max(120)', () => {
    expect(apiTypes).toContain(SHARED_NAME_RE);
    expect(apiTypes).toMatch(/ProfileNameSchema = z\s*\.string\(\)\s*\.trim\(\)/);
    expect(apiTypes).toMatch(/\.max\(120\)/);
  });

  it('gui-client profile-name.ts replicates the SAME regex + 120 bound', () => {
    expect(guiLib).toContain(SHARED_NAME_RE);
    expect(guiLib).toMatch(/const PROFILE_NAME_MAX = 120;/);
  });

  it('gui-client exports validateProfileName + a specific user-facing message', () => {
    expect(guiLib).toMatch(/export function validateProfileName\(raw: string\): string \| null/);
    expect(guiLib).toMatch(/export const PROFILE_NAME_MESSAGE =/);
  });
});
