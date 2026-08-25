// 2026-05-20 — drift guard for apps/server/src/services/notification-
// event-bus.ts. Pins the v0 event-kind discriminator set + the bus
// surface so a refactor can't silently widen / narrow the schema
// without an explicit doc edit + matching test update.
//
//   • Header framing: in-process pub/sub mirroring AgentSessionEventBus.
//   • Per-accountId scoping (cross-account leakage forbidden).
//   • 4-kind NotificationEvent v0 union:
//       cost.threshold_alert / incident.broadcast /
//       audit.high_severity / session.errored.
//   • Bus shape: subscribe + publish + subscriberCount.
//   • Best-effort handler isolation: try/catch swallow.
//   • Design doc cross-ref: docs/internal/driftstack-telemetry-event-
//     schema-for-gui-panel.md.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/notification-event-bus.ts');
const DESIGN = resolve(
  REPO_ROOT,
  'docs/internal/driftstack-telemetry-event-schema-for-gui-panel.md',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/notification-event-bus.ts content parity', () => {
  const body = read(LIB);

  it('header framing pinned: in-process pub/sub mirroring AgentSessionEventBus + per-accountId scoping + design-doc cross-ref', () => {
    expect(body).toMatch(/\/\/ 2026-05-20 — GUI panel notification stream\./);
    expect(body).toMatch(
      /\/\/ In-process pub\/sub for per-account notifications surfaced in the\s*\/\/ desktop GUI's panel-level view/,
    );
    expect(body).toMatch(/Mirrors the shape of `AgentSessionEventBus`/);
    expect(body).toMatch(
      /\/\/ Subscriber keying: per-`accountId`\. Cross-account leakage is\s*\/\/ impossible by construction/,
    );
    expect(body).toMatch(
      /\/\/ Full design at `docs\/internal\/driftstack-telemetry-event-schema-\s*\/\/ for-gui-panel\.md`\./,
    );
  });

  it('NotificationEvent 4-kind v0 union: cost.threshold_alert + incident.broadcast + audit.high_severity + session.errored', () => {
    expect(body).toMatch(/kind: 'cost\.threshold_alert';/);
    expect(body).toMatch(/severity: 'warn' \| 'critical' \| 'resolved';/);
    expect(body).toMatch(/previousState: ThresholdState \| null;/);
    expect(body).toMatch(/currentState: ThresholdState;/);

    expect(body).toMatch(/kind: 'incident\.broadcast';/);
    expect(body).toMatch(/severity: 'minor' \| 'major' \| 'outage';/);

    expect(body).toMatch(/kind: 'audit\.high_severity';/);
    expect(body).toMatch(/actorType: 'customer' \| 'admin' \| 'system';/);
    expect(body).toMatch(/targetResourceId: string \| null;/);

    expect(body).toMatch(/kind: 'session\.errored';/);
    expect(body).toMatch(/errorClass: string;/);
  });

  it('bus shape pinned: subscribe(accountId, handler) → unsubscribe fn + publish + publishBroadcast (S45) + subscriberCount; best-effort handler isolation via try/catch swallow', () => {
    expect(body).toMatch(/export class NotificationEventBus \{/);
    expect(body).toMatch(
      /subscribe\(accountId: string, handler: NotificationEventHandler\): \(\) => void/,
    );
    expect(body).toMatch(/publish\(event: NotificationEvent\): void/);
    expect(body).toMatch(/subscriberCount\(accountId: string\): number/);
    // The handler-throw isolation contract — pin the try/catch block.
    expect(body).toMatch(/try \{\s*handler\(event\);\s*\} catch \{\s*\/\* swallow \*\/\s*\}/);
  });

  it('S45 publishBroadcast pinned: distributive-omit param type, per-subscriber accountId stamping via the existing publish path, and key-set snapshot before iteration (handlers may unsubscribe mid-fan-out)', () => {
    expect(body).toMatch(/publishBroadcast\(event: BroadcastNotificationEvent\): void \{/);
    expect(body).toMatch(
      // (the spread already narrows to NotificationEvent — no assertion;
      // lint's no-unnecessary-type-assertion strips one if added back)
      /for \(const accountId of Array\.from\(this\.subscribers\.keys\(\)\)\) \{\s*this\.publish\(\{ \.\.\.event, accountId \}\);/,
    );
    expect(body).toMatch(
      /export type BroadcastNotificationEvent = DistributiveOmit<NotificationEvent, 'accountId'>;/,
    );
  });

  it('drop-on-no-subscribers semantics pinned: publish to an accountId with no subscribers returns without throwing', () => {
    expect(body).toMatch(
      /publish\(event: NotificationEvent\): void \{\s*const set = this\.subscribers\.get\(event\.accountId\);\s*if \(!set\) return;/,
    );
  });

  it('design doc exists at canonical path so the bus schema has a single source of truth for cross-file drift', () => {
    expect(existsSync(DESIGN)).toBe(true);
    const designBody = read(DESIGN);
    expect(designBody).toMatch(/# GUI panel telemetry event schema/);
    expect(designBody).toMatch(/NotificationEventBus/);
    // Pin the v0 event-kind list in the design doc itself so a
    // refactor can't widen the bus without updating both.
    expect(designBody).toMatch(/'cost\.threshold_alert'/);
    expect(designBody).toMatch(/'incident\.broadcast'/);
    expect(designBody).toMatch(/'audit\.high_severity'/);
    expect(designBody).toMatch(/'session\.errored'/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
