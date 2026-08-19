// V-1052 — every webhook event type a customer can subscribe to is emitted by something.
//
// The catalogue work (V-1050, V-1051) closed the email surface in both directions.
// Webhook events are the other subscribable surface, and they carry a sharper
// version of the same failure: a customer does not merely read about an event, they
// write a handler for it and wait. An event type in the enum and in the docs that
// no code path emits is a handler that never fires, and nothing about that looks
// broken from the outside.
//
// Measured today: 9 declared types, all 9 emittable, so this file starts green. The
// value is in what it refuses later — adding a type to `WebhookEventTypeSchema`
// and to `webhook-events.md` without wiring an emitter.
//
// DIVISION OF LABOUR, checked rather than assumed. `docs-api-webhook-events-
// content-parity` already derives from `WebhookEventTypeSchema.options` and asserts
// each type appears in the customer reference, so enum-versus-docs is owned and this
// file does not repeat it. What no guard covered is the third leg: whether anything
// EMITS what both sides advertise. A type can be in the enum, in the docs, in the
// subscribe dropdown, and never sent.
//
// ── Two emit shapes, both real ─────────────────────────────────────────────
//
// Eight types reach customers through `WebhooksService.enqueueEvent(accountId,
// eventType, data)`, which fans out to the endpoints subscribed to that type.
//
// `test.ping` does not, and that is correct rather than an exception to wave
// through: `sendTestEvent` builds `type: 'test.ping'` directly and delivers to ONE
// endpoint, bypassing subscription entirely — the OpenAPI summary for
// `POST /v1/webhooks/{id}/test` says so in as many words. A check that only knew
// about `enqueueEvent` would report the one event customers can trigger on demand
// as the one that never fires.
//
// So the scan accepts either shape: the literal appearing near an `enqueueEvent(`
// call, or near a payload `type:` assignment.
//
// ── One trap, hit while proving this file ──────────────────────────────────
//
// `type:` written without a boundary also matches `event_type:` and `eventType:`,
// and `sendTestEvent` happens to contain all three spellings within a few lines.
// The first version of the last arm passed a mutation that deleted the payload
// construction outright, because it matched the audit-row `event_type:` underneath
// it. Both patterns below are boundary-anchored for that reason.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** Bracket-matched values of a `z.enum([...])` declaration. */
function enumValues(src: string, name: string): string[] {
  const at = src.indexOf(name);
  expect(at, `${name} is no longer declared`).toBeGreaterThan(-1);
  const open = src.indexOf('[', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        const body = src.slice(open + 1, i).replace(/\/\/[^\n]*/g, '');
        return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
      }
    }
  }
  throw new Error(`${name} has an unbalanced value list`);
}

function serverSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (entry === 'node_modules' || entry === 'dist') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(resolve(REPO_ROOT, 'apps/server/src/services'));
  walk(resolve(REPO_ROOT, 'apps/server/src/routes'));
  return out;
}

/** Files where `event` appears close to an emit call or a payload type assignment. */
function emittersOf(event: string): string[] {
  const literal = `'${event}'`;
  const out: string[] = [];
  for (const path of serverSources()) {
    const src = readFileSync(path, 'utf8');
    if (!src.includes(literal)) continue;
    const emits = [...src.matchAll(/enqueueEvent\(|(?<![\w$])type:\s*'/g)].some((m) => {
      const window = src.slice(m.index, m.index + 220);
      return window.includes(literal);
    });
    if (emits) out.push(path.slice(REPO_ROOT.length + 1));
  }
  return out;
}

describe('V-1052 every declared webhook event has an emitter', () => {
  const api = readFileSync(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'), 'utf8');
  const declared = enumValues(api, 'WebhookEventTypeSchema');
  const subscribable = enumValues(api, 'SubscribableWebhookEventTypeSchema');

  it('CRITICAL the enum and the source walk were really read. A value list that came back empty, or a walk that found no files, would make every arm below agree with a server that emits nothing at all.', () => {
    expect(declared.length, 'declared webhook event types').toBeGreaterThanOrEqual(8);
    expect(subscribable.length, 'subscribable types').toBeGreaterThanOrEqual(7);
    expect(serverSources().length, 'server service/route files walked').toBeGreaterThanOrEqual(60);

    // The detector finds a known emitter and does not fire on an absent one.
    expect(emittersOf('session.failed').length, 'session.failed has an emitter').toBeGreaterThan(0);
    expect(emittersOf('nonexistent.event.type'), 'a fabricated type has no emitter').toEqual([]);
  });

  it('CRITICAL every declared event type is emitted somewhere. A type in the enum and the docs with no emitter is a handler a customer wrote and will wait on forever, and nothing about it looks broken from outside.', () => {
    const orphans = declared.filter((ev) => emittersOf(ev).length === 0).sort();
    expect(
      orphans,
      'these webhook event types are declared but no code path emits them — wire an emitter, or ' +
        'remove the type from the enum and from webhook-events.md:',
    ).toEqual([]);
  });

  it('CRITICAL test.ping is emitted by the test endpoint rather than the subscription fan-out, and that stays true. It is the one type a customer can trigger on demand; if it ever loses its direct emitter, the arm above would still pass on some unrelated mention while the endpoint stopped working.', () => {
    const service = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'),
      'utf8',
    );
    expect(service, 'sendTestEvent is gone from the webhooks service').toMatch(
      /async sendTestEvent\(/,
    );
    expect(
      service,
      "sendTestEvent no longer builds a 'test.ping' payload — the send-test endpoint would deliver " +
        'something else, or nothing',
    ).toMatch(/(?<![\w$])type:\s*'test\.ping'/);
  });
});
