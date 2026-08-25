// W470.C — drift guard for apps/gui-client/src/lib/use-admin-internal-note.ts.
// V-534.AL useAdminInternalNote action hook. Drift here either
// breaks the null/empty-string → server-normalises-to-null
// framing (admin clears a note but the GUI shows it persisted as
// empty string instead of cleared) or drops the Content-Type
// header (server rejects the PATCH because it can't parse the
// JSON body — silent admin-panel failure).
//
//   • V-534.AL framing pinned: 'useAdminInternalNote hook.' +
//     'Wraps PATCH /v1/admin/crypto-orders/:id/internal-note
//     (V-666.AA). Admin-only — caller must hold the
//     `driftstack_internal_admin` scope. Returns a state machine
//     + a single `save(orderId, note)` action; passing null OR
//     an empty string clears the note (the server-side service
//     normalises both to null).'
//   • Type import AdminCryptoOrder from './use-admin-crypto-orders-list'.
//   • AdminInternalNoteState 4-variant union: idle | submitting
//     {orderId} | succeeded{orderId + order: AdminCryptoOrder}
//     | failed{orderId + status + message}.
//   • UseAdminInternalNoteResult 3-method (state + save + reset).
//   • save signature: (orderId, internalNote: string | null) =>
//     Promise<void>.
//   • Request: PATCH + Content-Type application/json + Authorization
//     Bearer + accept JSON + body JSON.stringify({internal_note}).
//   • Same failed/succeeded state-machine pattern as V-534.Y +
//     reset useCallback empty deps.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-admin-internal-note.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W470.C apps/gui-client/src/lib/use-admin-internal-note.ts content parity', () => {
  const body = read(LIB);

  it("V-534.AL framing pinned: 'V-534.AL — useAdminInternalNote hook.' + 'Wraps PATCH /v1/admin/crypto-orders/:id/internal-note (V-666.AA). Admin-only — caller must hold the `driftstack_internal_admin` scope. Returns a state machine + a single `save(orderId, note)` action; passing null OR an empty string clears the note (the server-side service normalises both to null).'", () => {
    expect(body).toMatch(/\/\/ V-534\.AL — useAdminInternalNote hook\./);
    expect(body).toMatch(
      /\/\/ Wraps PATCH \/v1\/admin\/crypto-orders\/:id\/internal-note \(V-666\.AA\)\.\s*\/\/ Admin-only — caller must hold the `driftstack_internal_admin` scope\.\s*\/\/ Returns a state machine \+ a single `save\(orderId, note\)` action;\s*\/\/ passing null OR an empty string clears the note \(the server-side\s*\/\/ service normalises both to null\)\./,
    );
  });

  it('Imports lifecycle primitives + shared deadline/bounded decode/safe errors + useSettings + type AdminCryptoOrder', () => {
    expect(body).toMatch(/import \{ useCallback, useEffect, useRef, useState \} from 'react';/);
    expect(body).toMatch(/import \{ readApiErrorMessage \} from '\.\/api-errors';/);
    expect(body).toMatch(/import \{ fetchWithDeadline \} from '\.\/fetch-with-deadline';/);
    expect(body).toMatch(/import \{ humanizeError \} from '\.\/humanize-error';/);
    expect(body).toMatch(/import \{ readBoundedApiJson \} from '\.\/read-bounded-json';/);
    expect(body).toMatch(/import \{ useSettings \} from '\.\/SettingsContext';/);
    expect(body).toMatch(
      /import type \{ AdminCryptoOrder \} from '\.\/use-admin-crypto-orders-list';/,
    );
  });

  it('AdminInternalNoteState 4-variant union: idle | submitting{orderId} | succeeded{orderId + order: AdminCryptoOrder} | failed{orderId + status + message}', () => {
    expect(body).toMatch(
      /export type AdminInternalNoteState =\s*\| \{ kind: 'idle' \}\s*\| \{ kind: 'submitting'; orderId: string \}\s*\| \{ kind: 'succeeded'; orderId: string; order: AdminCryptoOrder \}\s*\| \{ kind: 'failed'; orderId: string; status: number; message: string \};/,
    );
  });

  it('UseAdminInternalNoteResult: state + save(orderId, internalNote: string | null) => Promise<void> + reset(): void', () => {
    expect(body).toMatch(
      /export interface UseAdminInternalNoteResult \{\s*state: AdminInternalNoteState;\s*save: \(orderId: string, internalNote: string \| null\) => Promise<void>;\s*reset: \(\) => void;\s*\}/,
    );
  });

  it('save transport: deadline-bounded PATCH with encoded id, abort signal, JSON/auth headers, and exact snake_case nullable body', () => {
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(\s*`\$\{baseUrl\}\/v1\/admin\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/internal-note`,\s*\{\s*method: 'PATCH',\s*signal: controller\.signal,\s*headers: \{\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*'content-type': 'application\/json',\s*accept: 'application\/json',\s*\},\s*body: JSON\.stringify\(\{ internal_note: internalNote \}\),/,
    );
  });

  it("Same V-534.Y action-hook pattern: idle initial state + no-apiKey → failed{status:0, message:'No API key configured.'} + submitting pre-fetch + !res.ok → failed{status: res.status, message} + res.ok → succeeded{orderId, order} + catch → failed{status:0}", () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<AdminInternalNoteState>\(\{ kind: 'idle' \}\);/,
    );
    expect(body).toMatch(
      /if \(!settings\.apiKey\) \{[\s\S]*?kind: 'failed',[\s\S]*?status: 0,[\s\S]*?message: 'No API key configured\.',[\s\S]*?return;\s*\}/,
    );
    expect(body).toMatch(
      /inFlightRef\.current = true;\s*const sequence = \+\+sequenceRef\.current;\s*const controller = new AbortController\(\);\s*requestRef\.current = controller;\s*setState\(\{ kind: 'submitting', orderId \}\);/,
    );
    const boundedSuccess =
      /const order = await readBoundedApiJson<AdminCryptoOrder>\(res\);\s*if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'succeeded', orderId, order \}\);/;
    expect(body).toMatch(boundedSuccess);
    expect(body.replace('readBoundedApiJson<AdminCryptoOrder>(res)', 'res.json()')).not.toMatch(
      boundedSuccess,
    );
    expect(body).toMatch(
      /err instanceof DOMException && err\.name === 'AbortError'\s*\? 'Saving the internal note timed out\. Check your connection and try again\.'\s*: humanizeError\(err, "Couldn't save the internal note\. Try again\."\)/,
    );
    const rawErrorMutation = body.replace('humanizeError(err,', 'String(err) || (');
    expect(rawErrorMutation).not.toMatch(/humanizeError\(err,/);
  });

  it('save is single-flight; reset and unmount abort/invalidate active work; return contract remains', () => {
    expect(body).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(body).toMatch(
      /const reset = useCallback\(\(\): void => \{\s*sequenceRef\.current \+= 1;\s*requestRef\.current\?\.abort\(\);\s*requestRef\.current = null;\s*inFlightRef\.current = false;\s*setState\(\{ kind: 'idle' \}\);/,
    );
    expect(body).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{\s*sequenceRef\.current \+= 1;\s*requestRef\.current\?\.abort\(\);[\s\S]*?\},\s*\[\],\s*\);\s*return \{ state, save, reset \};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
