// Drift-guard for the keyset-cursor UUID fix (aba776b0): a Drizzle repo that
// resolves a keyset pagination cursor by raw row id — `eq(<table>.id, <X>.cursor)`
// — against a `uuid` Postgres column would 500 on a malformed (non-UUID) cursor
// with PG's "invalid input syntax for type uuid". Every such repo MUST guard the
// cursor with `parseUuidCursor` (lib/keyset-cursor.ts) so a bad cursor falls back
// to the first page instead of throwing.
//
// Repos whose `id` is a TEXT primary key (e.g. recipes' `rec_<uuid>`) are exempt:
// a text column can't uuid-cast-error, AND the repo's own cursor is the prefixed
// `rec_<uuid>` which is not bare-UUID-shaped — so applying the guard would wrongly
// reject its valid cursor. Such repos are allow-listed below and must NOT carry
// the guard (if one switches to a uuid PK, move it off the allowlist + add the
// guard in the same change).
//
// This is the "static guard catches what review missed" pattern — the same shape
// as route-mutation-ratelimit-coverage-invariant.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(HERE, '..', '..', 'src', 'db');

// Raw-id keyset cursor lookup: `eq(<table>.id, <var>.cursor)`.
const CURSOR_ID_LOOKUP = /eq\(\w+\.id,\s*\w+\.cursor\)/;

// Text-PK repos (id is `text(...)`, not `uuid(...)`) — exempt + MUST NOT guard.
// agent-sessions-repo's id is `agt_<uuid>` text (sweep-3 added its keyset
// pagination); it guards the cursor with AGENT_SESSION_ID_RE (the prefixed
// shape), not parseUuidCursor (which only accepts a bare uuid).
const TEXT_PK_EXEMPT = new Set(['recipes-repo.ts', 'agent-sessions-repo.ts']);

describe('keyset-cursor UUID-guard coverage invariant', () => {
  const repos = readdirSync(DB_DIR).filter((f) => f.endsWith('-repo.ts'));
  const withCursorLookup = repos.filter((f) =>
    CURSOR_ID_LOOKUP.test(readFileSync(resolve(DB_DIR, f), 'utf8')),
  );

  it('the scan finds the raw-id cursor repos (regex did not drift to match nothing)', () => {
    expect(withCursorLookup.length).toBeGreaterThanOrEqual(8);
  });

  it('every TEXT_PK_EXEMPT entry still exists + still does a raw-id cursor lookup (no rot)', () => {
    for (const f of TEXT_PK_EXEMPT) {
      expect(
        withCursorLookup,
        `${f} is allow-listed but no longer scans as a cursor-by-id repo`,
      ).toContain(f);
    }
  });

  for (const file of withCursorLookup) {
    const body = readFileSync(resolve(DB_DIR, file), 'utf8');
    if (TEXT_PK_EXEMPT.has(file)) {
      it(`${file}: text-PK — exempt, must NOT apply the UUID guard`, () => {
        expect(
          body.includes('parseUuidCursor'),
          `${file} is TEXT_PK_EXEMPT (text id PK) but now uses parseUuidCursor — if its PK became a uuid, drop it from the allowlist; otherwise remove the guard (it rejects the repo's own prefixed cursor).`,
        ).toBe(false);
      });
    } else {
      it(`${file}: uuid-PK keyset cursor is parseUuidCursor-guarded`, () => {
        expect(
          body.includes('parseUuidCursor'),
          `${file} resolves a keyset cursor via eq(id, cursor) against a uuid column but does NOT guard it with parseUuidCursor — a malformed cursor would 500 (PG "invalid input syntax for type uuid"). Guard it like the other list repos (lib/keyset-cursor.ts), or allow-list it if its id PK is text.`,
        ).toBe(true);
      });
    }
  }
});
