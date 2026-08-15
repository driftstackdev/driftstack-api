import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const body = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md'), 'utf8');

describe('/webhooks/events live detail coverage', () => {
  // Derived from the schema rather than hand-listed. `test.ping` is appended
  // because it is documented here but deliberately NOT subscribable — the test
  // endpoint dispatches it regardless of subscription.
  //
  // This was nine hardcoded strings, which made the payload sections a
  // hand-maintained copy of a schema-owned set. Measured before changing it: with
  // a tenth value added to the subscribable enum, this file still reported 12
  // passed — it demanded nothing. The sibling enum-coverage guard would not have
  // caught the omission either, because its quick-index assertion is satisfied by
  // the one-line table row and its citation assertion is a whole-body
  // `toContain`, which that same row satisfies. So a new event could ship listed
  // but with no documented payload — the part customers actually integrate
  // against.
  // Set, not a plain append: if `test.ping` ever becomes subscribable this still
  // yields one case for it rather than two identically-named ones.
  for (const event of new Set<string>([
    ...SubscribableWebhookEventTypeSchema.options,
    'test.ping',
  ])) {
    it(`documents ${event}`, () => {
      expect(body).toContain(`### \`${event}\``);
    });
  }

  // V-749 — session.completed has THREE emitters (destroy, autoDestroyExpired,
  // destroyAllForAccount) and the automatic two add `auto_destroyed` + `reason`.
  // The doc previously described only the DELETE trigger with a two-field payload,
  // so a customer attributing completions could not tell a cap-expired or
  // suspension-reclaimed session from one they asked for. Pinned because the
  // omission is invisible: the two-field payload was not WRONG, just incomplete,
  // and nothing else fails when it drifts back.
  it('session.completed documents all three destroy triggers + the auto_destroyed/reason fields', () => {
    const section = body.slice(
      body.indexOf('### `session.completed`'),
      body.indexOf('### `session.failed`'),
    );
    expect(section).toMatch(/Three things destroy a session/);
    expect(section).toMatch(/free-tier session duration cap/);
    expect(section).toMatch(/account suspended/);
    expect(section).toMatch(/"auto_destroyed": true/);
    expect(section).toMatch(/absent rather than `false`/);
    // All three emitter method names, so the "Emitter: … destroy()" singular form
    // cannot come back.
    expect(section).toMatch(/`destroy\(\)`/);
    expect(section).toMatch(/`autoDestroyExpired\(\)`/);
    expect(section).toMatch(/`destroyAllForAccount\(\)`/);
    expect(section).not.toMatch(
      /^Emitter: `apps\/server\/src\/services\/sessions\.ts` `destroy\(\)`\.$/m,
    );
  });

  // V-749 — the documented session.failed example used to show
  // error_name "DriverTimeoutError" / error_message "Page load exceeded 30000ms".
  // NEITHER is reachable: sessionFailureCopy() maps every failure onto four
  // classes with fixed copy, and "DriverTimeoutError" existed nowhere in the
  // source — only in this doc. A customer branching on the documented value would
  // never match, and one parsing the message for a timeout figure would never find
  // one. Pin the closed set and forbid the fabricated values.
  it('session.failed documents the CLOSED classed error set and no unreachable example values', () => {
    const section = body.slice(
      body.indexOf('### `session.failed`'),
      body.indexOf('### `api_key.revoked`'),
    );
    for (const name of [
      'SessionTimeoutError',
      'DriverError',
      'DriverNotIntegratedError',
      'UnknownError',
    ]) {
      expect(section).toContain(name);
    }
    expect(section).toMatch(/closed, classed set/);
    expect(section).toMatch(/Branch on `error_name`/);
    // The fabricated values must not come back anywhere in the page.
    expect(body).not.toContain('DriverTimeoutError');
    expect(body).not.toContain('Page load exceeded 30000ms');
  });

  it('contains no aspirational event status or silent quota subscription', () => {
    expect(body).not.toMatch(/\[(?:LIVE|DECLARED|PLANNED)\]/);
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded|Planned events/);
  });
});
