// The webhook retry schedule is the same durations in every place that states
// it — compared as NUMBERS, and including the two edges nothing compared.
//
// The schedule is declared four times: `webhook-worker.ts` (the legacy path),
// `durable-webhook-delivery.ts` (the forward path, exported), the in-memory
// package the suite runs against, and `webhooks/events.md`, which tells
// customers "6 attempts ... with exponential backoff at 1m, 5m, 15m, 30m, 60m".
//
// Being exact about what is new here, because the first draft of this file
// claimed more than it added and the prior art was read properly only after
// the mutation refused to behave as predicted.
//
// ALREADY COVERED: webhook-worker vs durable-webhook-delivery.
// `webhook-worker-cross-source-invariant` reads both files and asserts each
// contains the same five literals, so those two cannot drift apart. The arm
// below overlaps it deliberately and adds only derivation — it compares the
// files to EACH OTHER rather than both to a list of expected literals kept in
// a test, so there is no third copy of the numbers to update. That is a modest
// benefit and is not the reason this file exists.
//
// NEW: the customer-facing schedule is never compared to the code. The only
// check on it is `expect(root).toContain('1m, 5m, 15m, 30m, 60m')` — the page
// still says what it said. Nothing reads those durations as numbers and holds
// them against what the server schedules, so a coordinated change to both
// implementations leaves the published promise stale and green.
//
// NEW: the in-memory package's durations are compared to nothing. It is read
// for MAX_ATTEMPTS and pinned against its own text, never against the service
// it stands in for — and it is what most of the suite exercises, so a
// divergence there means tests prove retry behaviour the deployed paths do not
// have.
//
// The two implementations diverging is not hypothetical for this subsystem:
// `durable-webhook-signature-sdk-verify` exists because the durable path once
// signed bare hex the SDK silently rejected, which "would have broken every
// customer's signature verification on cutover".

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS_BY_ATTEMPT as DURABLE,
  DEFAULT_MAX_ATTEMPTS,
} from '../../src/services/durable-webhook-delivery.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const WORKER = resolve(REPO, 'apps/server/src/services/webhook-worker.ts');
const PKG = resolve(REPO, 'packages/webhook-delivery/src/in-memory.ts');
const DOCS = resolve(REPO, 'apps/docs/src/pages/webhooks/events.md');

/**
 * Read a `BACKOFF_MS_BY_ATTEMPT` table out of TypeScript source as numbers.
 *
 * Entries are written either bare (`1: 60_000,`) or as minute arithmetic
 * (`3: 15 * 60_000,`), so both forms are evaluated rather than matched. A
 * regex that only understood one form would silently return a short table,
 * which is why the caller floors the entry count.
 */
function tableFromSource(file: string): Map<number, number> {
  const src = readFileSync(file, 'utf8');
  const block = /BACKOFF_MS_BY_ATTEMPT[^=]*=\s*\{([\s\S]*?)\}/.exec(src);
  const out = new Map<number, number>();
  if (block === null) return out;
  for (const m of (block[1] ?? '').matchAll(/(\d+):\s*(\d[\d_]*)\s*(?:\*\s*(\d[\d_]*))?/g)) {
    const lhs = Number((m[2] ?? '').replace(/_/g, ''));
    const rhs = m[3] === undefined ? 1 : Number(m[3].replace(/_/g, ''));
    out.set(Number(m[1]), lhs * rhs);
  }
  return out;
}

/**
 * Read the schedule out of the sentence customers actually read.
 *
 * Deliberately parsed from the published prose — "backoff at 1m, 5m, 15m, 30m,
 * 60m" — rather than from a constant restated in this file. A page rewritten to
 * promise a different schedule has to fail here, and it can only do that if the
 * page is the input.
 */
function scheduleFromDocs(): number[] {
  const md = readFileSync(DOCS, 'utf8');
  const m = /exponential backoff at ([0-9hm,\s]+?)\./.exec(md);
  if (m === null) return [];
  return (m[1] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => {
      const value = Number(p.replace(/[^0-9]/g, ''));
      return p.endsWith('h') ? value * 60 * 60_000 : value * 60_000;
    });
}

describe('the webhook backoff schedule agrees in every place it is stated', () => {
  it('CRITICAL all four sources parsed into real schedules. Each comparison below reports equality, and two empty tables are equal — a parse that found nothing would agree with itself and report the whole invariant clean.', () => {
    const worker = tableFromSource(WORKER);
    const pkg = tableFromSource(PKG);
    const docs = scheduleFromDocs();

    expect(worker.size, 'entries parsed from webhook-worker.ts').toBe(5);
    expect(pkg.size, 'entries parsed from the in-memory package').toBe(5);
    expect(Object.keys(DURABLE).length, 'entries exported by the durable service').toBe(5);
    expect(docs.length, 'durations parsed from the customer-facing sentence').toBe(5);

    // The arithmetic form is evaluated, not matched: 15 * 60_000 is fifteen
    // minutes. If this read 15 the whole comparison would still be internally
    // consistent and completely wrong.
    expect(worker.get(3), 'minute arithmetic is evaluated, not taken literally').toBe(900_000);
  });

  it('CRITICAL the legacy worker and the durable service schedule identical delays. These are two hand-maintained copies and the durable one is the forward path — the same pairing that once shipped a signature format the SDK rejected.', () => {
    const worker = tableFromSource(WORKER);
    const mismatched = [...worker.entries()]
      .filter(([k, v]) => DURABLE[k] !== v)
      .map(
        ([k, v]) =>
          `attempt ${String(k)}: worker ${String(v)}ms vs durable ${String(DURABLE[k])}ms`,
      );
    expect(mismatched, 'attempt(s) whose delay differs between the two implementations:').toEqual(
      [],
    );
  });

  it('CRITICAL the in-memory package schedules the same delays. Tests run against it, so a divergence here means the suite is proving retry behaviour the deployed paths do not have.', () => {
    const pkg = tableFromSource(PKG);
    const mismatched = [...pkg.entries()]
      .filter(([k, v]) => DURABLE[k] !== v)
      .map(
        ([k, v]) =>
          `attempt ${String(k)}: package ${String(v)}ms vs durable ${String(DURABLE[k])}ms`,
      );
    expect(mismatched, 'attempt(s) whose delay differs from the durable service:').toEqual([]);
  });

  it('CRITICAL the schedule customers are promised is the schedule that runs. The existing pins assert the page still contains the string and the worker still contains the literal; neither notices the two describing different numbers.', () => {
    const docs = scheduleFromDocs();
    const actual = [1, 2, 3, 4, 5].map((k) => DURABLE[k]);
    expect(docs, 'the published schedule, in milliseconds, against the implemented one:').toEqual(
      actual,
    );
  });
  // V-2020 — the fallbacks are unreachable, and this is what keeps them that way.
  //
  // Each lookup ends in a defensive default, and the two rails DISAGREE by a
  // factor of sixty: the durable service reads `?? 60 * 60_000`, the worker
  // `?? 60_000`. An archived entry checked that divergence and proved it inert —
  // both lookups sit behind a DLQ boundary at 6, and both tables carry keys 1
  // through 5, so no reachable attempt number misses. It recorded the argument in
  // prose and changed nothing, which was right at the time.
  //
  // ⛔ Nothing tied the two constants together. Raise the boundary to 7 without
  // extending the tables and attempt 6 becomes reachable on both rails: the same
  // failing endpoint then retries after ONE HOUR on the durable path and ONE
  // MINUTE on the worker. The existing arms would stay green — they pin each
  // table's SIZE at 5 and compare the tables to each other, and both remain true.
  //
  // The archived argument only examined the UPPER bound. The lower one holds too,
  // checked while writing this: the durable rail indexes `attemptNumber` and the
  // worker `delivery.attempts + 1`, so neither can present 0 to a table keyed
  // from 1. That is why the expected set starts at 1 rather than 0.
  it('CRITICAL every attempt number the DLQ boundary admits has a backoff entry, on both rails. The per-lookup fallbacks differ by 60x and are only unreachable because the boundary and the key range agree — nothing else asserts that they do.', () => {
    const workerMax = /const MAX_ATTEMPTS = (\d+);/.exec(readFileSync(WORKER, 'utf8'))?.[1];
    expect(workerMax, 'MAX_ATTEMPTS parsed from webhook-worker.ts').toBeDefined();

    const reachable = (max: number): number[] =>
      Array.from({ length: max - 1 }, (_unused, i) => i + 1);

    expect(
      Object.keys(DURABLE)
        .map(Number)
        .sort((a, b) => a - b),
      'durable table keys vs the attempt numbers DEFAULT_MAX_ATTEMPTS admits',
    ).toEqual(reachable(DEFAULT_MAX_ATTEMPTS));

    expect(
      [...tableFromSource(WORKER).keys()].sort((a, b) => a - b),
      'worker table keys vs the attempt numbers MAX_ATTEMPTS admits',
    ).toEqual(reachable(Number(workerMax)));
  });
});
