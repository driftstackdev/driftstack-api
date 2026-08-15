// The webhook timings we publish are the timings the worker runs.
//
// `webhooks/replay.md` makes three numeric promises a customer plans around:
// how long a replayed delivery takes to re-fire, how many times a failing
// delivery is retried, and the backoff schedule between those retries. All three
// are computable from source, so none of them needs to be believed.
//
// ONE OF THEM WAS WRONG FOR THREE MONTHS. The page said a replay re-fires "on
// the next cycle (within ~30 seconds)". The delivery poller has run at 60s since
// 2026-05-06 (V-232) and the sentence was written 2026-05-08 — so it was never
// true, rather than drift that crept in later. A customer following it would
// check the delivery status, see `pending`, and conclude the replay had failed.
//
// A content-parity pin held that number in place, and its own title said what it
// was for: "Drift to a different cadence would mislead customers about how long
// to wait before checking delivery status." It froze the misleading number while
// naming the harm. That is the third time a pin here has protected a claim
// nobody checked against the system.
//
// So this checks the numbers against the code rather than against the last time
// someone read them:
//
//   cadence   POLLER_INTERVAL_MS       — the interval the delivery poller ticks on
//   retries   MAX_ATTEMPTS - 1         — attempts include the initial send
//   backoff   BACKOFF_MS_BY_ATTEMPT    — the schedule, in order
//
// The wiring arm matters as much as the values. `POLLER_INTERVAL_MS` is shared
// by six pollers, so reading it proves nothing unless webhook delivery is one of
// them — and if webhook delivery is ever given its own interval, which the
// production-readiness assessment recommends, that arm fails and this file has
// to be pointed at the new constant instead of silently reading a stale one.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const BOOTSTRAP = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');
const WORKER = resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/replay.md');
const SPEC = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');
const DURABLE = resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts');

/**
 * Source with comment lines removed.
 *
 * Load-bearing here: the backoff schedule is spelled out in prose directly above
 * the map that defines it ("1: 1 min, 2: 5 min…"), so a scan that reads comments
 * would extract the documentation of the constant instead of the constant.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** The delivery poller's tick interval, in seconds. */
function pollerIntervalSeconds(): number | undefined {
  const raw = /const POLLER_INTERVAL_MS = ([0-9_]+)/.exec(code(BOOTSTRAP))?.[1];
  return raw === undefined ? undefined : Number(raw.replace(/_/g, '')) / 1000;
}

/** True when webhook delivery is actually scheduled on that interval. */
function webhookDeliveryUsesPollerInterval(): boolean {
  const source = code(BOOTSTRAP);
  const marker = source.indexOf('webhookDeliveryTimer');
  if (marker === -1) return false;
  return /POLLER_INTERVAL_MS/.test(source.slice(marker, marker + 1200));
}

/** Retries after the initial send. */
function retriesAfterFirstAttempt(): number | undefined {
  const raw = /const MAX_ATTEMPTS = ([0-9]+)/.exec(code(WORKER))?.[1];
  return raw === undefined ? undefined : Number(raw) - 1;
}

/** The backoff schedule in attempt order, in minutes, from a given file. */
function backoffScheduleMinutesIn(file: string): number[] {
  const block = /BACKOFF_MS_BY_ATTEMPT[^{]*\{([\s\S]*?)\}/.exec(code(file))?.[1];
  if (block === undefined) return [];
  return [...block.matchAll(/([0-9]+):\s*([0-9_*\s]+),/g)]
    .map(([, attempt, expression]) => ({
      attempt: Number(attempt),
      // Values are written as `60_000` or `15 * 60_000`.
      ms: (expression ?? '')
        .split('*')
        .map((part) => Number(part.replace(/[_\s]/g, '')))
        .reduce((a, b) => a * b, 1),
    }))
    .sort((a, b) => a.attempt - b.attempt)
    .map((entry) => entry.ms / 60_000);
}

/** The live worker's schedule — the one the published numbers describe. */
const backoffScheduleMinutes = (): number[] => backoffScheduleMinutesIn(WORKER);

const doc = (): string => readFileSync(DOC, 'utf8');

describe('the documented replay cadence matches the poller', () => {
  it('CRITICAL every value was actually extracted. Each arm below compares a number from source against a number from the page, and an extraction that silently returned undefined or an empty schedule would make its comparison vacuous — passing because nothing was read rather than because the two agree.', () => {
    // MEASURED: 60s poller, 5 retries, [1, 5, 15, 30, 60] minute backoff.
    expect(pollerIntervalSeconds(), 'POLLER_INTERVAL_MS in seconds').toBe(60);
    expect(retriesAfterFirstAttempt(), 'retries after the initial send').toBe(5);
    expect(backoffScheduleMinutes(), 'backoff schedule in minutes').toEqual([1, 5, 15, 30, 60]);
  });

  it('CRITICAL webhook delivery is actually scheduled on the interval this file reads. POLLER_INTERVAL_MS drives six pollers, so reading it proves nothing unless webhook delivery is one of them — and if delivery is given its own interval, as the readiness assessment recommends, this must be pointed at the new constant rather than quietly reading a stale one.', () => {
    expect(
      webhookDeliveryUsesPollerInterval(),
      'the webhook delivery timer uses POLLER_INTERVAL_MS',
    ).toBe(true);
  });

  it('CRITICAL the page states the poller\'s real cadence. It said "within ~30 seconds" while the poller ran at 60s — never true, not drift — so a customer would check a replayed delivery, still see `pending`, and conclude the replay had failed.', () => {
    const seconds = pollerIntervalSeconds();
    expect(doc(), 'the documented cadence is the real one').toMatch(
      new RegExp(`up to ${String(seconds)} seconds`),
    );
    expect(doc(), 'and the number that was never true is gone').not.toMatch(/~30 seconds|~30s/);
  });

  it('CRITICAL the page states the real retry count. "Retries 5 times" has to mean five retries after the initial send, which is MAX_ATTEMPTS minus one — an off-by-one here tells customers to expect a sixth attempt that never comes.', () => {
    expect(doc(), 'documented retry count').toMatch(
      new RegExp(`retries failed webhook deliveries ${String(retriesAfterFirstAttempt())} times`),
    );
  });

  it('CRITICAL the page states the real backoff schedule. Customers size their outage tolerance on it — the difference between the documented schedule and the real one is how long they believe they have before deliveries reach the DLQ.', () => {
    const documented = `(${backoffScheduleMinutes()
      .map((m) => `${String(m)}m`)
      .join(', ')})`;
    expect(doc(), `backoff schedule ${documented}`).toContain(documented);
  });

  // The cadence was published on THREE surfaces and a docs-only grep found two.
  // The OpenAPI spec is the one that matters most for the two it missed: it is
  // served at /openapi.json and is what SDK and client generators read, so a
  // wrong number there propagates into code customers write. A guard that
  // watched a single surface would repeat exactly the mistake it exists to stop.
  it('CRITICAL the published OpenAPI spec states the same cadence as the page. The replay response description carried "within ~30s" too — served at /openapi.json and consumed by client generators, so it reaches customers through their own tooling rather than through the docs site.', () => {
    // Anchored to the CUSTOMER route. Two endpoints reset a delivery to
    // pending — this one and `/v1/admin/webhook-deliveries/{id}/replay` — and a
    // regex for the description alone matched the admin one, which sits earlier
    // in the file and says only "worker will retry". That admin wording is
    // vague rather than wrong, and is deliberately left alone; the number a
    // customer plans around is the one on the self-service route.
    const spec = readFileSync(SPEC, 'utf8');
    const route = spec.indexOf("path: '/v1/webhook-deliveries/{deliveryId}/replay'");
    expect(route, 'the customer self-service replay route was found').toBeGreaterThan(-1);
    const replayDescription = /description:\s*'Delivery reset to pending;[^']*'/.exec(
      spec.slice(route),
    )?.[0];
    expect(replayDescription, 'the replay response description was found').toBeDefined();
    expect(replayDescription, 'and states the real cadence').toContain(
      `up to ${String(pollerIntervalSeconds())}s`,
    );
    expect(replayDescription, 'not the number that was never true').not.toContain('~30s');
  });

  // The V-173 successor carries its OWN copy of both numbers and is awaiting
  // soak time. The assessment already records that its claim query is kept in
  // step with the live one so a cutover cannot reintroduce endpoint starvation;
  // the retry contract deserves the same treatment, because a cutover that
  // changed the schedule would change a published customer promise without
  // touching the page that makes it.
  it('CRITICAL the durable successor publishes the same retry contract. It is unwired today, so nothing else would notice a divergence until the cutover — at which point the documented 1m/5m/15m/30m/60m schedule and 5 retries would silently describe the old worker.', () => {
    const durableSchedule = backoffScheduleMinutesIn(DURABLE);
    expect(durableSchedule, 'durable successor backoff schedule').toEqual(backoffScheduleMinutes());
    const durableMax = /DEFAULT_MAX_ATTEMPTS = ([0-9]+)/.exec(code(DURABLE))?.[1];
    expect(durableMax, 'durable successor DEFAULT_MAX_ATTEMPTS was found').toBeDefined();
    expect(Number(durableMax) - 1, 'durable retries after the initial send').toBe(
      retriesAfterFirstAttempt(),
    );
  });
});
