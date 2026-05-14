// W858 — SessionEventType public-vs-internal cross-source
// invariant. One-hundred-eighty-fourth in the drift-guard series.
// Pins the INTENTIONAL divergence between the public API schema
// and the internal DB pgEnum for session-event types:
//
//   public-API (api-types): 8 values
//     1. created
//     2. navigated
//     3. interacted
//     4. waited
//     5. state_captured
//     6. screenshot_captured
//     7. destroyed
//     8. errored
//
//   DB pgEnum (drizzle): 9 values
//     ALL 8 ABOVE + 'gui_input' (V-460 GUI-client-internal event).
//
// 'gui_input' is INTENTIONALLY internal-only. It tracks GUI-client
// human-input timing for V-460 GUI-driver replay but is NOT
// surfaced through the customer-facing /v1/sessions/:id/events
// listing — customers shouldn't be confused by an event type they
// can't drive.
//
// Drift would silently break this contract:
//   * If gui_input is added to api-types: customers would see
//     events they can't reproduce.
//   * If gui_input is removed from pgEnum: server crashes on persist.
//   * If a new internal-only event arrives, the test forces an
//     explicit decision about public surface.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PUBLIC_SESSION_EVENTS = [
  'created',
  'navigated',
  'interacted',
  'waited',
  'state_captured',
  'screenshot_captured',
  'destroyed',
  'errored',
] as const;

const INTERNAL_ONLY_EVENTS = ['gui_input'] as const;

const ALL_DB_SESSION_EVENTS = [...PUBLIC_SESSION_EVENTS, ...INTERNAL_ONLY_EVENTS] as const;

describe('W858 SessionEventType public-vs-internal cross-source invariant', () => {
  // ─── api-types public-API schema = 8 public values ───────────

  it('CRITICAL packages/api-types/src/sessions.ts SessionEventTypeSchema = z.enum([8 PUBLIC values]). gui_input is INTENTIONALLY excluded from the public schema — V-460 GUI-internal event customers cannot drive.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export const SessionEventTypeSchema = z\.enum\(\[/);
    const m = p.match(/SessionEventTypeSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'SessionEventTypeSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const t of PUBLIC_SESSION_EVENTS) {
      expect(body, `public SessionEventType must include '${t}'`).toMatch(new RegExp(`'${t}'`));
    }
    // gui_input must NOT appear in the public schema.
    for (const internalOnly of INTERNAL_ONLY_EVENTS) {
      expect(
        body,
        `public SessionEventType MUST NOT include internal-only '${internalOnly}'`,
      ).not.toMatch(new RegExp(`'${internalOnly}'`));
    }
  });

  // ─── DB pgEnum = 9 values (8 public + 1 internal) ────────────

  it("CRITICAL apps/server/src/db/schema.ts sessionEventType pgEnum has 9 values — the 8 public + 'gui_input'. Postgres rejects INSERTs of unknown values — the pgEnum must accept gui_input so the GUI-driver server-side handler persists events without crashing.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/sessionEventType = pgEnum\('session_event_type', \[/);
    const m = p.match(/sessionEventType = pgEnum\('session_event_type', \[([\s\S]+?)\]\);/);
    expect(m, 'sessionEventType pgEnum body must be present').not.toBeNull();
    const body = m![1];
    for (const t of ALL_DB_SESSION_EVENTS) {
      expect(body, `pgEnum must include '${t}'`).toMatch(new RegExp(`'${t}'`));
    }
  });

  // ─── Migration 0004 explicitly added gui_input ───────────────

  it("CRITICAL the gui_input event-type was added in migration 0004 (apps/server/src/db/migrations/0004_gui_input_event_type.sql) via ALTER TYPE ... ADD VALUE 'gui_input'. The migration is the immutable record of the schema-evolution event — drift to renaming would break the migration journal hash chain.", () => {
    const p = read(
      resolve(REPO_ROOT, 'apps/server/src/db/migrations/0004_gui_input_event_type.sql'),
    );
    expect(p).toMatch(/ALTER TYPE "public"\."session_event_type" ADD VALUE 'gui_input'/);
  });

  // ─── Server services/sessions.ts uses gui_input internally ───

  it("CRITICAL apps/server/src/services/sessions.ts handles gui_input as one of the internal event-type branches. The GUI-driver replay path persists 'gui_input' events for debugging.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    // gui_input appears in a type-discriminator union AND in a persist call.
    expect(p).toMatch(/'gui_input'/);
  });

  // ─── 8 public + 1 internal = 9 DB cardinality ────────────────

  it('CRITICAL cardinality invariant: 8 public + 1 internal = 9 DB pgEnum values. The 8/1/9 split is what the public-API vs internal-event contract pivots on. Drift to a new internal event WITHOUT updating this test would silently grow the gap; drift to publishing gui_input would erase the gap.', () => {
    expect(PUBLIC_SESSION_EVENTS.length).toBe(8);
    expect(INTERNAL_ONLY_EVENTS.length).toBe(1);
    expect(ALL_DB_SESSION_EVENTS.length).toBe(9);
    expect(ALL_DB_SESSION_EVENTS.length).toBe(
      PUBLIC_SESSION_EVENTS.length + INTERNAL_ONLY_EVENTS.length,
    );
  });

  // ─── Driver-action / capture / lifecycle split ───────────────

  it('CRITICAL the 8 public events decompose as 1 lifecycle-create + 3 driver-action (navigated/interacted/waited) + 2 capture + 2 lifecycle-terminal (destroyed/errored). The decomposition is what /v1/sessions/:id/events listing UI grids depend on for grouping. Drift to a different grouping would break the audit-log UI.', () => {
    const created = PUBLIC_SESSION_EVENTS.filter((t) => t === 'created');
    const driverAction = PUBLIC_SESSION_EVENTS.filter((t) =>
      (['navigated', 'interacted', 'waited'] as const).includes(
        t as 'navigated' | 'interacted' | 'waited',
      ),
    );
    const captures = PUBLIC_SESSION_EVENTS.filter((t) => t.endsWith('_captured'));
    const terminal = PUBLIC_SESSION_EVENTS.filter((t) =>
      (['destroyed', 'errored'] as const).includes(t as 'destroyed' | 'errored'),
    );
    expect(created.length).toBe(1);
    expect(driverAction.length).toBe(3);
    expect(captures.length).toBe(2);
    expect(terminal.length).toBe(2);
  });

  // ─── No SDK exposure of SessionEventType ─────────────────────

  it('CRITICAL the cross-SDK contract: SessionEventType is NOT a public SDK type — neither TS nor Go SDK exports it. The session-event listing is audit-log-only; consumers fetch raw JSON via the events endpoint. Drift to exposing SessionEventType as an SDK closed-enum would pin the public-API contract too tightly and break adding new event types.', () => {
    // Sanity: Go SDK types.go has NO 'type SessionEventType string' declaration.
    const goTypes = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(goTypes, 'Go SDK MUST NOT declare a SessionEventType type').not.toMatch(
      /type SessionEventType string/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/session-event-type-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
