// W465.A — drift guard for apps/gui-client/src/lib/use-account-me.ts.
// V-534.Q useAccountMe hook. Drift here either drops the
// no-API-key short-circuit (hook reaches fetch with empty Bearer,
// server returns confusing 401 instead of clean 'No API key
// configured' UX) or breaks the manual:true opt-out (hook
// auto-fetches even when caller explicitly opted out, hammering
// the endpoint on every mount).
//
//   • V-534.Q framing pinned + 'Wraps GET /v1/account/me into a
//     state-machine hook so views can pull account info without
//     re-implementing fetch + state every time. SettingsAccountCard
//     (V-534.L) currently rolls its own equivalent; this hook is
//     the shared version views should migrate to (the card stays
//     as-is — refactoring it under the hook is a follow-up).'
//   • Imports: useCallback + useEffect + useState from react +
//     readApiErrorMessage from api-errors + useSettings from
//     SettingsContext.
//   • AccountMeData: nested account object (id + email + tier
//     strings).
//   • AccountMeState 4-variant union (idle | loading | ready
//     | error).
//   • UseAccountMeOpts: manual? optional 'Disable auto-fetch on
//     mount. Default false.'
//   • Initial state ternary: manual===true → 'idle' else 'loading'.
//   • Fetcher: no-apiKey → error 'No API key configured.';
//     trailing-slash strip; Bearer auth + accept JSON; !res.ok →
//     error via readApiErrorMessage; ready spread; catch err
//     instance-of-Error narrowing.
//   • useEffect: skip if manual===true; void fetcher() else.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-account-me.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W465.A apps/gui-client/src/lib/use-account-me.ts content parity', () => {
  const body = read(LIB);

  it("V-534.Q framing pinned: 'V-534.Q — useAccountMe hook.' + 'Wraps GET /v1/account/me into a state-machine hook so views can pull account info without re-implementing fetch + state every time. SettingsAccountCard (V-534.L) currently rolls its own equivalent; this hook is the shared version views should migrate to (the card stays as-is — refactoring it under the hook is a follow-up).'", () => {
    expect(body).toMatch(/\/\/ V-534\.Q — useAccountMe hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/account\/me into a state-machine hook so views can\s*\n?\s*\/\/ pull account info without re-implementing fetch \+ state every\s*\n?\s*\/\/ time\. SettingsAccountCard \(V-534\.L\) currently rolls its own\s*\n?\s*\/\/ equivalent; this hook is the shared version views should migrate\s*\n?\s*\/\/ to \(the card stays as-is — refactoring it under the hook is a\s*\n?\s*\/\/ follow-up\)\./,
    );
  });

  it("Imports: useCallback + useEffect + useRef + useState from 'react' + readApiErrorMessage from './api-errors' + useSettings from './SettingsContext' (useRef added by the abort-in-flight audit fix)", () => {
    expect(body).toMatch(/import \{ useCallback, useEffect, useRef, useState \} from 'react';/);
    expect(body).toMatch(/import \{ readApiErrorMessage \} from '\.\/api-errors';/);
    expect(body).toMatch(/import \{ fetchWithDeadline \} from '\.\/fetch-with-deadline';/);
    expect(body).toMatch(/import \{ useSettings \} from '\.\/SettingsContext';/);
  });

  it('AccountMeData: nested account object (id + email + tier all strings); AccountMeState 4-variant union (idle | loading | ready{data} | error{message})', () => {
    expect(body).toMatch(
      /export interface AccountMeData \{\s*\n?\s*account: \{\s*\n?\s*id: string;\s*\n?\s*email: string;\s*\n?\s*tier: string;\s*\n?\s*\};\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export type AccountMeState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'ready'; data: AccountMeData \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
  });

  it("UseAccountMeOpts manual? 'Disable auto-fetch on mount. Default false.' + UseAccountMeResult: { state + refetch: () => Promise<void> }", () => {
    expect(body).toMatch(
      /export interface UseAccountMeOpts \{\s*\n?\s*\/\*\* Disable auto-fetch on mount\. Default false\. \*\/\s*\n?\s*manual\?: boolean;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface UseAccountMeResult \{\s*\n?\s*state: AccountMeState;\s*\n?\s*refetch: \(\) => Promise<void>;\s*\n?\s*\}/,
    );
  });

  it("Initial state ternary: opts.manual === true → {kind:'idle'} else {kind:'loading'}", () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<AccountMeState>\(\s*\n?\s*opts\.manual === true \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\n?\s*\);/,
    );
  });

  it('Fetcher is single-flight and deadline-bounded; no-apiKey → error; trailing-slash strip; Bearer auth + JSON Accept; live-sequence HTTP/ready state', () => {
    expect(body).toMatch(
      /const fetcher = useCallback\(async \(\): Promise<void> => \{\s*\n?\s*if \(inFlightRef\.current\) return;/,
    );
    expect(body).toMatch(
      /if \(!settings\.apiKey\) \{\s*\n?\s*setState\(\{ kind: 'error', message: 'No API key configured\.' \}\);\s*\n?\s*return;/,
    );
    expect(body).toMatch(/const baseUrl = settings\.baseUrl\.replace\(\/\\\/\+\$\/, ''\);/);
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{baseUrl\}\/v1\/account\/me`, \{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: 'application\/json',/,
    );
    expect(body).toMatch(
      /const message = await readApiErrorMessage\(res\);\s*\n?\s*if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'error', message \}\);[\s\S]*?if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: body \}\);/,
    );
  });

  it('dependency/unmount cleanup aborts and invalidates active work; manual opt-out and no-arg refetch contract remain', () => {
    expect(body).toMatch(
      /useEffect\(\s*\n?\s*\(\) => \(\) => \{\s*\n?\s*sequenceRef\.current \+= 1;\s*\n?\s*requestRef\.current\?\.abort\(\);\s*\n?\s*requestRef\.current = null;\s*\n?\s*inFlightRef\.current = false;\s*\n?\s*\},\s*\n?\s*\[settings\.apiKey, settings\.baseUrl\],/,
    );
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*if \(opts\.manual === true\) return;\s*\n?\s*void fetcher\(\);\s*\n?\s*\}, \[fetcher, opts\.manual\]\);\s*\n?\s*return \{ state, refetch: fetcher \};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
