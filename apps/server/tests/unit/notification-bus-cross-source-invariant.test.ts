// 2026-05-20 — cross-source-invariant pinning the v0 NotificationEvent
// schema across THREE surfaces:
//
//   1. apps/server/src/services/notification-event-bus.ts — server union.
//   2. apps/server/src/routes/account-notifications.ts — SSE route that
//      JSON-serializes events into `data:` lines (no transformation).
//   3. apps/gui-client/src/lib/notifications.ts — client union + the
//      NOTIFICATION_EVENT_KINDS constant the GUI uses to wire one
//      addEventListener per kind.
//
// Drift on any of these three legs breaks the customer-visible
// stream (server publishes a new kind the GUI doesn't subscribe to;
// client adds a field the server never populates; etc). The test
// reads each source file as text + extracts the kind list, then
// asserts all three agree.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BUS = resolve(REPO_ROOT, 'apps/server/src/services/notification-event-bus.ts');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-notifications.ts');
const GUI = resolve(REPO_ROOT, 'apps/gui-client/src/lib/notifications.ts');
const DOC = resolve(REPO_ROOT, 'docs/internal/driftstack-telemetry-event-schema-for-gui-panel.md');
const API_DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/account-notifications.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Pull every quoted 'foo.bar' that follows `kind: '` in a TS literal-
// union definition. Filter on the v0 kind namespace prefix so this
// won't pick up incidental `kind: 'something_else'` from unrelated
// types in the same file.
function extractKindLiterals(body: string): string[] {
  const kinds = new Set<string>();
  const re = /kind:\s*'([a-z]+\.[a-z_]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match[1]) kinds.add(match[1]);
  }
  return Array.from(kinds).sort();
}

const V0_KINDS = [
  'audit.high_severity',
  'cost.threshold_alert',
  'incident.broadcast',
  'session.errored',
].sort();

describe('Notification v0 schema cross-source-invariant', () => {
  it('server bus declares exactly the v0 4-kind union', () => {
    const kinds = extractKindLiterals(read(BUS));
    expect(kinds).toEqual(V0_KINDS);
  });

  it('GUI client lib mirrors the server union — same 4 kinds', () => {
    const kinds = extractKindLiterals(read(GUI));
    expect(kinds).toEqual(V0_KINDS);
  });

  it('GUI lib NOTIFICATION_EVENT_KINDS constant declares the same 4 kinds (matches the type union — guards against the addEventListener loop drifting from the discriminated payload type)', () => {
    const guiBody = read(GUI);
    expect(guiBody).toMatch(/NOTIFICATION_EVENT_KINDS: readonly NotificationEventKind\[\] = \[/);
    // The constant is the runtime source of truth for the
    // addEventListener loop; the test extracts the array literal
    // and asserts it matches V0_KINDS.
    // Capture from the array literal `= [` through the closing `]
    // as const` so the regex doesn't trip on the type annotation's
    // `readonly NotificationEventKind[]` first-`]` lure.
    const block = guiBody.match(/NOTIFICATION_EVENT_KINDS[\s\S]*?\] as const/);
    expect(block).not.toBeNull();
    const list = block?.[0] ?? '';
    for (const kind of V0_KINDS) {
      expect(list).toContain(`'${kind}'`);
    }
  });

  it("SSE route serializes by-kind through `event: ${event.kind}\\n` — no allowlist drift between bus + route possible by construction (route is generic), but pin the generic write so a refactor can't silently filter kinds", () => {
    const body = read(ROUTE);
    expect(body).toMatch(/reply\.raw\.write\(`event: \$\{event\.kind\}\\n`\);/);
    expect(body).toMatch(/reply\.raw\.write\(`data: \$\{JSON\.stringify\(event\)\}\\n\\n`\);/);
  });

  it('internal design doc enumerates the same 4 kinds in the v0 union section + Future-publishers section', () => {
    const body = read(DOC);
    for (const kind of V0_KINDS) {
      expect(body).toContain(`'${kind}'`);
    }
  });

  it('public API docs page enumerates the same 4 kinds (h3 headings)', () => {
    const body = read(API_DOC);
    for (const kind of V0_KINDS) {
      // markdown table header `\`${kind}\`` OR ### `kind` heading
      expect(body).toContain(kind);
    }
    expect(body).toMatch(/^### `cost\.threshold_alert`$/m);
    expect(body).toMatch(/^### `incident\.broadcast`$/m);
    expect(body).toMatch(/^### `audit\.high_severity`$/m);
    expect(body).toMatch(/^### `session\.errored`$/m);
  });

  // S45 2026-07-07 — retires the S36 "Declared, not yet firing" state:
  // incident.broadcast now HAS a publisher (bootstrap wires all three
  // public-incident lifecycle hooks through publishBroadcast). These
  // pins keep the publisher wired and the docs page honest about it —
  // if the publisher is ever removed, the docs marker must flip back.
  it('S45: bootstrap publishes incident.broadcast from every public-incident lifecycle hook (created/updated/resolved) via publishBroadcast — the kind is LIVE, not declared-only', () => {
    const bootstrap = read(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'));
    expect(bootstrap).toMatch(
      /notificationEventBus\.publishBroadcast\(\{\s*\n?\s*kind: 'incident\.broadcast',[\s\S]{0,300}?incidentId: `inc_\$\{incident\.id\}`,\s*\n?\s*severity: incident\.severity,\s*\n?\s*title: incident\.title,\s*\n?\s*at: new Date\(\)\.toISOString\(\),/,
    );
    // All three hooks route through the shared helper.
    const publishCalls = bootstrap.match(/publishIncidentNotification\(incident\);/g) ?? [];
    expect(publishCalls.length).toBe(3);
  });

  it('S45: docs page describes incident.broadcast as firing (posted/updated/resolved broadcast), and the S36 declared-not-yet-firing marker stays retired', () => {
    const body = read(API_DOC);
    expect(body).toMatch(/Fires when a public incident is posted, updated, or resolved\./);
    expect(body).toMatch(/every account with an open stream receives the same incident/);
    expect(body).not.toMatch(/Declared, not yet firing/);
    expect(body).not.toMatch(/no publisher emits it today/);
  });
});
