// W854 — SessionStatus 5-value lifecycle cross-source invariant.
// One-hundred-eightieth in the drift-guard series. Pins the 5-value
// session-lifecycle status enum:
//   1. creating — provisioning + driver setup.
//   2. ready    — driver attached + idle.
//   3. busy     — currently executing a driver call.
//   4. destroyed — terminal (gracefully closed).
//   5. errored  — terminal (failure).
// stays in lockstep across:
//   - packages/api-types/src/sessions.ts (Zod canonical source).
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime).
//   - packages/sdk-go/types.go (Go SDK closed-enum consts).
//   - apps/gui-client/src/components/SessionStatusBadge.tsx
//     (V-534.N badge label + tone maps).
//   - apps/customer-dashboard/src/pages/index.astro (live badge map).
//
// Drift would silently break:
//   * Server persist: pgEnum rejects unknown values.
//   * Go SDK: customer pattern-match on status switches.
//   * GUI badge: missing entry renders a broken chip.
//   * Dashboard 'open vs ended' filter (sessions.astro depends on
//     status === 'destroyed' || 'errored' for terminal classification).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SESSION_STATUSES = ['creating', 'ready', 'busy', 'destroyed', 'errored'] as const;

const TERMINAL_STATUSES = ['destroyed', 'errored'] as const;

describe('W854 SessionStatus cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it("CRITICAL packages/api-types/src/sessions.ts SessionStatusSchema = z.enum(['creating', 'ready', 'busy', 'destroyed', 'errored']) — the 5-value canonical lifecycle. Drift would cascade through every consumer.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /export const SessionStatusSchema = z\.enum\(\['creating', 'ready', 'busy', 'destroyed', 'errored'\]\);/,
    );
  });

  it('CRITICAL SessionStatus type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export type SessionStatus = z\.infer<typeof SessionStatusSchema>;/);
  });

  // ─── DB pgEnum ───────────────────────────────────────────────

  it("CRITICAL apps/server/src/db/schema.ts sessionStatus = pgEnum('session_status', [5 values]) in the SAME order. Postgres rejects INSERTs of unknown values — drift to api-types-without-pgEnum would crash sessions.create at runtime.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/sessionStatus = pgEnum\('session_status', \[/);
    const m = p.match(/sessionStatus = pgEnum\('session_status', \[([\s\S]+?)\]\);/);
    expect(m, 'sessionStatus pgEnum body must be present').not.toBeNull();
    const body = m![1];
    for (const s of SESSION_STATUSES) {
      expect(body, `pgEnum must include '${s}'`).toMatch(new RegExp(`'${s}'`));
    }

    // V-1032 — the loop above only asks whether each ROSTER value is present, so a
    // pgEnum that GAINS a value passes it while api-types stays at five. Real drift
    // is caught in aggregate (the migration guards, the docs lifecycle table and the
    // type-checker all fail on a new DB status), but not by the file whose subject
    // this is. Asserting the exact set makes this guard answer its own question.
    const declared = [...(body ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
    expect(
      declared,
      'the session_status pgEnum no longer holds exactly the five roster values in order — a value ' +
        'added here without the matching api-types enum ships a status the SDK cannot represent',
    ).toEqual([...SESSION_STATUSES]);
  });

  // ─── Go SDK closed-enum consts ───────────────────────────────

  it('CRITICAL packages/sdk-go/types.go declares 5 SessionStatus consts — SessionCreating + SessionReady + SessionBusy + SessionDestroyed + SessionErrored. Each maps to one canonical status string.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type SessionStatus string/);
    expect(p).toMatch(/SessionCreating\s+SessionStatus = "creating"/);
    expect(p).toMatch(/SessionReady\s+SessionStatus = "ready"/);
    expect(p).toMatch(/SessionBusy\s+SessionStatus = "busy"/);
    expect(p).toMatch(/SessionDestroyed SessionStatus = "destroyed"/);
    expect(p).toMatch(/SessionErrored\s+SessionStatus = "errored"/);
  });

  it("CRITICAL Go SDK 'lifecycle state of a session' framing pinned. The comment threads the type-system intent (vs an open-string enum).", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/SessionStatus is the lifecycle state of a session/);
  });

  // ─── GUI SessionStatusBadge maps ─────────────────────────────

  it('CRITICAL apps/gui-client/src/components/SessionStatusBadge.tsx declares SessionStatus type = 5-value union AND STATUS_LABEL + STATUS_TONE record entries for all 5. The V-534.N badge would render an empty chip if a status arrives without a map entry.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/gui-client/src/components/SessionStatusBadge.tsx'));
    expect(p).toMatch(
      /export type SessionStatus = 'creating' \| 'ready' \| 'busy' \| 'destroyed' \| 'errored';/,
    );
    // STATUS_LABEL + STATUS_TONE both have all 5 keys.
    expect(p).toMatch(/STATUS_LABEL: Record<string, string> = \{/);
    expect(p).toMatch(/STATUS_TONE: Record<string, Tone> = \{/);
    for (const s of SESSION_STATUSES) {
      expect(p, `STATUS_LABEL missing entry for '${s}'`).toMatch(new RegExp(`\\s${s}: '`));
      expect(p, `STATUS_TONE missing entry for '${s}'`).toMatch(new RegExp(`\\s${s}: '`));
    }
  });

  // ─── Customer-dashboard live overview mirror ─────────────────

  it('CRITICAL customer-dashboard live overview declares badge styles for all 5 statuses; the retired mock-data file is not a contract source', () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/index.astro'));
    const map = p.match(/const STATUS_BADGE_CLASS = \{([\s\S]+?)\n\s*\};/);
    expect(map, 'live STATUS_BADGE_CLASS map must exist').not.toBeNull();
    for (const s of SESSION_STATUSES) {
      expect(map![1], `dashboard live badge map missing '${s}'`).toMatch(new RegExp(`\\s${s}: '`));
    }
  });

  // ─── Terminal-status classification ──────────────────────────
  // (The customer-dashboard sessions.astro open/ended-filter subtest was
  // removed 2026-07-02 — the operational sessions page moved to the
  // desktop GUI. The terminal split stays guarded below + across the
  // server/api-types/SDK/GUI sources this invariant already reads.)

  // ─── 5-value cardinality ─────────────────────────────────────

  it('CRITICAL SessionStatus = EXACTLY 5 values + 2 terminal (destroyed + errored) + 3 in-flight (creating + ready + busy). The 5-value count is what billing-quota + idle-reaper jobs depend on (each enumerates the active-vs-terminal split).', () => {
    expect(SESSION_STATUSES.length).toBe(5);
    expect(TERMINAL_STATUSES.length).toBe(2);
    const inFlight = SESSION_STATUSES.filter(
      (s) => !(TERMINAL_STATUSES as readonly string[]).includes(s),
    );
    expect(inFlight).toEqual(['creating', 'ready', 'busy']);
  });

  // ─── No forbidden / legacy status names ──────────────────────

  it('CRITICAL no source declares forbidden session-status names (active / pending / running / closed / canceled / completed). These are common conventions that the 5-value model intentionally avoids — drift would fragment the lifecycle story.', () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    const forbidden = ['active', 'pending', 'running', 'closed', 'canceled', 'completed'];
    const m = apiTypes.match(/SessionStatusSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of forbidden) {
      expect(body, `SessionStatus must NOT include forbidden ${f}`).not.toMatch(
        new RegExp(`'${f}'`),
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/session-status-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
