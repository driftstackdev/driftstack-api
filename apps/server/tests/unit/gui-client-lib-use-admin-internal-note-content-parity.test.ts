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
      /\/\/ Wraps PATCH \/v1\/admin\/crypto-orders\/:id\/internal-note \(V-666\.AA\)\.\s*\n?\s*\/\/ Admin-only — caller must hold the `driftstack_internal_admin` scope\.\s*\n?\s*\/\/ Returns a state machine \+ a single `save\(orderId, note\)` action;\s*\n?\s*\/\/ passing null OR an empty string clears the note \(the server-side\s*\n?\s*\/\/ service normalises both to null\)\./,
    );
  });

  it("Imports: useCallback + useState from 'react' (NO useEffect — action hook) + readApiErrorMessage + useSettings + type AdminCryptoOrder from './use-admin-crypto-orders-list'", () => {
    expect(body).toMatch(/import \{ useCallback, useState \} from 'react';/);
    expect(body).toMatch(/import \{ readApiErrorMessage \} from '\.\/api-errors';/);
    expect(body).toMatch(/import \{ useSettings \} from '\.\/SettingsContext';/);
    expect(body).toMatch(
      /import type \{ AdminCryptoOrder \} from '\.\/use-admin-crypto-orders-list';/,
    );
  });

  it('AdminInternalNoteState 4-variant union: idle | submitting{orderId} | succeeded{orderId + order: AdminCryptoOrder} | failed{orderId + status + message}', () => {
    expect(body).toMatch(
      /export type AdminInternalNoteState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'submitting'; orderId: string \}\s*\n?\s*\| \{ kind: 'succeeded'; orderId: string; order: AdminCryptoOrder \}\s*\n?\s*\| \{ kind: 'failed'; orderId: string; status: number; message: string \};/,
    );
  });

  it('UseAdminInternalNoteResult: state + save(orderId, internalNote: string | null) => Promise<void> + reset(): void', () => {
    expect(body).toMatch(
      /export interface UseAdminInternalNoteResult \{\s*\n?\s*state: AdminInternalNoteState;\s*\n?\s*save: \(orderId: string, internalNote: string \| null\) => Promise<void>;\s*\n?\s*reset: \(\) => void;\s*\n?\s*\}/,
    );
  });

  it('save fetch: PATCH `${baseUrl}/v1/admin/crypto-orders/${orderId}/internal-note` + Content-Type application/json (REQUIRED — PATCH carries JSON body) + Authorization Bearer + accept JSON + body JSON.stringify({internal_note: internalNote}) — snake_case server field name', () => {
    expect(body).toMatch(
      /const res = await fetch\(`\$\{baseUrl\}\/v1\/admin\/crypto-orders\/\$\{orderId\}\/internal-note`, \{\s*\n?\s*method: 'PATCH',\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*'content-type': 'application\/json',\s*\n?\s*accept: 'application\/json',\s*\n?\s*\},\s*\n?\s*body: JSON\.stringify\(\{ internal_note: internalNote \}\),\s*\n?\s*\}\);/,
    );
  });

  it("Same V-534.Y action-hook pattern: idle initial state + no-apiKey → failed{status:0, message:'No API key configured.'} + submitting pre-fetch + !res.ok → failed{status: res.status, message} + res.ok → succeeded{orderId, order} + catch → failed{status:0}", () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<AdminInternalNoteState>\(\{ kind: 'idle' \}\);/,
    );
    expect(body).toMatch(
      /if \(!settings\.apiKey\) \{\s*\n?\s*setState\(\{\s*\n?\s*kind: 'failed',\s*\n?\s*orderId,\s*\n?\s*status: 0,\s*\n?\s*message: 'No API key configured\.',\s*\n?\s*\}\);\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*setState\(\{ kind: 'submitting', orderId \}\);/,
    );
    expect(body).toMatch(
      /const order = \(await res\.json\(\)\) as AdminCryptoOrder;\s*\n?\s*setState\(\{ kind: 'succeeded', orderId, order \}\);/,
    );
  });

  it('reset useCallback empty deps; return { state, save, reset } at function bottom', () => {
    expect(body).toMatch(
      /const reset = useCallback\(\(\): void => \{\s*\n?\s*setState\(\{ kind: 'idle' \}\);\s*\n?\s*\}, \[\]\);\s*\n?\s*return \{ state, save, reset \};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
