// V-1932. A request correlator holds `pending` entries keyed by a request id and
// settles them from frames arriving on a SHARED fleet connection — one socket
// carries every session on that node. So a frame that echoes a known request id
// but belongs to a different session (or profile) must be DROPPED, not used to
// settle the pending entry: settling it would hand one account's page output —
// DOM, screenshot, extracted text, cookie jar — to another account's in-flight
// request. `harness-dispatch-correlator` states exactly that, and its guard is
// mirrored across the family.
//
// Each correlator is individually tested today. What nothing checks is the
// FAMILY: add a tenth correlator without the guard and no existing test notices,
// because every one of those tests opens only its own file.
//
// ⛔ The guard is keyed on the CORRELATION KEY, not on `sessionId`. Sweeping for
// `sessionId` reports two false gaps:
//
//   • trim-profile keys on `profileId` — "a profile at rest has no live session"
//     — and drops on `profileId !== pending.profileId`, logging it as a
//     cross-account spoof signal. Same guard, different key.
//   • session-readiness is CONNECTION-LOCAL: each FleetControlConnection owns one
//     instance, so a reconnect is a hard ownership boundary and there is no
//     cross-request correlation to spoof. Exempt, with that reason.
//
// A token-level check would accuse both. This pins the shape and records the two
// variations, so adding a correlator is a decision rather than an omission.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES = resolve(HERE, '..', '..', 'src', 'services');

/**
 * Every correlator, and the key its spoof guard compares. `null` means exempt —
 * the reason is required, and is what a reviewer reads when adding the next one.
 */
const CORRELATORS: Record<string, { key: string | null; why?: string }> = {
  'cookies-request-correlator.ts': { key: 'sessionId' },
  'download-request-correlator.ts': { key: 'sessionId' },
  'harness-dispatch-correlator.ts': { key: 'sessionId' },
  'navigate-history-request-correlator.ts': { key: 'sessionId' },
  'set-cookies-request-correlator.ts': { key: 'sessionId' },
  'set-egress-request-correlator.ts': { key: 'sessionId' },
  'upload-request-correlator.ts': { key: 'sessionId' },
  'trim-profile-request-correlator.ts': { key: 'profileId' },
  'session-readiness-correlator.ts': {
    key: null,
    why: 'connection-local: one instance per FleetControlConnection, so ownership is structural and there is no cross-request correlation to spoof',
  },
  'probe-egress-request-correlator.ts': {
    key: null,
    why: 'node-scoped by contract: a pre-launch egress probe has no session, and the request schema REJECTS a sessionId outright so one can never be attached. There is therefore no session key to compare — the guard this roster checks for would have nothing to compare against. Ownership is instead proven at the layer above: the registry asserts the result frame carries the node_id it dispatched to, and a mismatch is an error outcome rather than a trusted measurement.',
  },
};

function correlatorFilesOnDisk(): string[] {
  return readdirSync(SERVICES)
    .filter((f) => f.endsWith('.ts') && f.includes('correlator'))
    .sort();
}

/** Does the file compare an incoming frame's key against the pending entry's? */
function dropsOnKeyMismatch(file: string, key: string): boolean {
  const body = readFileSync(resolve(SERVICES, file), 'utf8').replace(/\s+/g, ' ');
  // `x !== pending.x` / `pending.x !== x` / `target.x !== y` — the comparison that
  // precedes the drop, in either order and against either holder name.
  const patterns = [
    new RegExp(`${key}\\s*!==\\s*(pending|target)\\.${key}`),
    new RegExp(`(pending|target)\\.${key}\\s*!==\\s*[A-Za-z_.]*${key}`),
  ];
  return patterns.some((p) => p.test(body));
}

describe('every correlator drops a key-mismatched frame', () => {
  it('CRITICAL the correlator roster on disk matches the recorded one', () => {
    // Read from disk, or a tenth correlator is invisible: every arm below only
    // opens files the roster already names.
    expect(correlatorFilesOnDisk()).toEqual(Object.keys(CORRELATORS).sort());
  });

  it('CRITICAL every non-exempt correlator drops on ITS OWN key, not necessarily sessionId', () => {
    const missing = Object.entries(CORRELATORS)
      .filter(([, spec]) => spec.key !== null)
      .filter(([file, spec]) => !dropsOnKeyMismatch(file, spec.key as string))
      .map(([file, spec]) => `${file} (expected a ${spec.key as string} mismatch drop)`);
    expect(missing).toEqual([]);
  });

  it('every exemption carries a reason', () => {
    const unexplained = Object.entries(CORRELATORS)
      .filter(([, spec]) => spec.key === null)
      .filter(([, spec]) => (spec.why ?? '').length < 20)
      .map(([file]) => file);
    expect(unexplained).toEqual([]);
  });

  // Without this the arm above cannot tell a working matcher from one that
  // returns true for everything — which would pass while guarding nothing.
  it('the matcher rejects a correlator that settles without comparing the key', () => {
    expect(dropsOnKeyMismatch('session-readiness-correlator.ts', 'sessionId')).toBe(false);
    expect(dropsOnKeyMismatch('harness-dispatch-correlator.ts', 'sessionId')).toBe(true);
    expect(dropsOnKeyMismatch('trim-profile-request-correlator.ts', 'profileId')).toBe(true);
    // trim-profile guards profileId, so it must NOT satisfy a sessionId check
    expect(dropsOnKeyMismatch('trim-profile-request-correlator.ts', 'sessionId')).toBe(false);
  });
});
