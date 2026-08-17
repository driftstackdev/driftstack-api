// A service that is built but never wired is invisible, and this repo has one.
//
// AuditArchiveService bounds five tables on a 90-day window and has never run.
// Nothing caught that, and nothing could have: job-chain-liveness reports a dead
// chain as 0 only for chains on its roster, so a sweep that was never registered
// emits no series at all. Absence of wiring is absence of evidence.
//
// So this enumerates it. Every exported Service/Sweeper/Worker/Reaper is either
// reachable from the wiring roots, or listed below with the reason it is not.
// A sixth dormant class fails here on the day it is added, rather than being
// discovered later by someone wondering why a table never shrinks.
//
// REACHABILITY is computed over class constructions: seeded from bootstrap.ts
// and app.ts, then transitively through the module of anything already reached.
// That is a real approximation and it has a known blind spot — a class reached
// only through a factory FUNCTION is not followed. NoopOtelService is exactly
// that shape, and it is on the list below with that noted, because when I
// checked, its factory turns out to be uncalled too.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/**
 * Classes that exist and are deliberately not wired, with why.
 *
 * Entries may only leave this list by becoming wired (or being deleted). An
 * entry that stops matching a real class fails the last case below, so a stale
 * exemption cannot sit here reading like a decision someone made.
 */
const RECORDED_DORMANT = new Map<string, string>([
  [
    'AuditArchiveService',
    'never scheduled; see audit-archive-is-not-scheduled-and-that-is-recorded — session_events ' +
      'grows without bound because this is the only thing that would prune it',
  ],
  [
    'DurableWebhookDeliveryService',
    'V-173 forward path. Its own header: webhooks.ts is "production today", migration deferred ' +
      'until this has soak time and real-DB integration tests',
  ],
  ['DurableWebhookWorker', 'the worker half of the same V-173 forward path'],
  [
    'NoopOtelService',
    'OTel is not wired at all — createOtelService returns a no-op and is itself called from ' +
      'nowhere. The module carries TODO(post-launch) to branch on OTEL_EXPORTER_OTLP_ENDPOINT',
  ],
  [
    'WebhookSecretForceRotationService',
    'deliberately dark: its sweep discards the plaintext of a rotated secret and the ' +
      'plaintext-once API cannot reveal it afterwards. Guarded by ' +
      'services-webhook-secret-force-rotation-content-parity',
  ],
]);

/** Where wiring starts. */
const ROOTS = ['lib/bootstrap.ts', 'lib/app.ts'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Non-comment lines only. Deliberately line-based: a regex comment stripper
 * cannot tell `/*` in a string from a real block comment, and an earlier version
 * of a sibling guard destroyed two thirds of bootstrap.ts doing exactly that —
 * silently, because the check it fed asserts an ABSENCE.
 */
function codeLines(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const FILES: ReadonlyMap<string, string> = new Map(walk(SRC).map((f) => [f, codeLines(f)]));

/** Exported service-shaped classes, mapped to the file that declares them. */
function serviceClasses(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file] of FILES) {
    for (const m of readFileSync(file, 'utf8').matchAll(
      /export class (\w+(?:Service|Sweeper|Worker|Reaper))\b/g,
    )) {
      out.set(m[1] ?? '', file);
    }
  }
  return out;
}

/** Classes constructible from the roots, following class constructions only. */
function reachable(classes: Map<string, string>): Set<string> {
  const constructedIn = (file: string, name: string): boolean =>
    new RegExp(`new ${name}\\s*\\(`).test(FILES.get(file) ?? '');
  const seeds = ROOTS.map((r) => resolve(SRC, r));
  const found = new Set<string>();
  for (const [name] of classes) {
    if (seeds.some((s) => constructedIn(s, name))) found.add(name);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, home] of classes) {
      if (found.has(name)) continue;
      void home;
      for (const reachedName of found) {
        const reachedHome = classes.get(reachedName);
        if (reachedHome !== undefined && constructedIn(reachedHome, name)) {
          found.add(name);
          changed = true;
          break;
        }
      }
    }
  }
  return found;
}

describe('every service is wired, or recorded as deliberately dormant', () => {
  const classes = serviceClasses();
  const live = reachable(classes);

  it('CRITICAL the reachability scan works — known-wired services are found', () => {
    // The positive control this whole file depends on. Everything below asserts
    // that a set is EMPTY or matches a list; a scan that reached nothing would
    // report every service dormant, and a scan that reached everything would
    // report none. Both directions are checked.
    expect(classes.size, 'no service classes found — the class scan is broken').toBeGreaterThan(40);
    for (const known of ['SessionsService', 'RetentionScrubSweeperService', 'BillingService']) {
      expect(live, `${known} is wired in bootstrap but the scan did not reach it`).toContain(known);
    }
    expect(
      live.size,
      'the scan reached every class, which would make the dormant set vacuously empty',
    ).toBeLessThan(classes.size);
  });

  it('CRITICAL no service is dormant without a recorded reason', () => {
    const unexplained = [...classes.keys()]
      .filter((n) => !live.has(n) && !RECORDED_DORMANT.has(n))
      .sort();
    expect(
      unexplained,
      'this service is never constructed from bootstrap or app, so it does not run in production. ' +
        'That is invisible on its own — nothing monitors a subsystem that was never registered. ' +
        'Wire it, delete it, or add it to RECORDED_DORMANT with the reason',
    ).toEqual([]);
  });

  it('CRITICAL a recorded-dormant service that becomes wired must leave the list', () => {
    // The other direction. An entry claiming "deliberately not running" for
    // something that now runs is worse than no entry: it tells the next reader
    // the opposite of the truth.
    const nowLive = [...RECORDED_DORMANT.keys()].filter((n) => live.has(n)).sort();
    expect(
      nowLive,
      'this service is now reachable from the wiring roots but is still recorded as dormant. ' +
        'Remove the entry — and if it is the audit archive, delete its record file too',
    ).toEqual([]);
  });

  it('CRITICAL every recorded entry still names a real class', () => {
    const stale = [...RECORDED_DORMANT.keys()].filter((n) => !classes.has(n)).sort();
    expect(
      stale,
      'a RECORDED_DORMANT entry names a class that no longer exists — it was deleted or renamed, ' +
        'and the record now documents nothing',
    ).toEqual([]);
  });
});
