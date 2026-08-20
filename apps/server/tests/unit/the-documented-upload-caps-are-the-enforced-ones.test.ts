// The upload reference publishes three caps. The route enforces three caps.
// Nothing connected them.
//
// V-1066 added a fourth, the avatar cap, which had the identical shape in a
// different file. `AVATAR_MAX_BYTES` is pinned as source TEXT by
// `avatar-policy-cross-source-invariant` (which declares its own local copy of
// the value rather than importing it), and `api/account.md`'s "Max raw size:
// 2 MiB" is pinned as doc TEXT by two content-parity files. Both sides frozen,
// neither compared. Raising the cap fails the source pin, whoever raises it
// updates that pin, and the docs pin keeps passing on a figure that is now
// wrong — the customer is told 2 MiB while the server accepts more.
//
// Measured: doubling the per-session lifetime cap
// (`sessionUploadMaxLifetimeBytes` 2 GiB → 4 GiB) left the ENTIRE suite green —
// 28,038 tests, zero reds. Not "only self-referential pins red", as with the
// pricing and session-length findings: nothing at all. The docs would keep
// promising 2 GiB, and no behavioural arm noticed either.
//
// Each cap had three independent copies: the value, the rejection message that
// quotes it back to the customer, and the docs sentence. The messages are now
// DERIVED from the values via binarySizeLabel(), which removes that copy
// entirely — worth doing rather than guarding, because the per-account cap is
// operator-configurable (AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES → config →
// bootstrap → app → route). A deployment that lowered it told the customer
// "at most 512 MB" while rejecting at whatever it actually enforced. No guard
// on a hardcoded string could have made that message right; only deriving it
// could.
//
// That leaves the docs, which describe the DEFAULTS and cannot interpolate.
// This pairs them, restating no figure: the caps are IMPORTED from
// lib/upload-caps.ts and the labels come from the same formatter the messages
// use, so a cap change with stale docs fails here.
//
// SCOPE — corrected. An earlier version of this header said the per-session
// lifetime cap "has no test that exercises the rejection path" and that
// `upload-account-inflight-cap` covered the per-account cap only. Both are
// wrong: that suite drives the lifetime rejection in six arms. What none of
// them exercises is the DEFAULT — every arm injects a small cap, because that
// is the only way to trigger a rejection without moving gigabytes. So the
// defaults are reachable in production and unreachable in the suite, which is
// exactly why doubling the lifetime default once left all 28,038 tests green.
// This file is what covers the default values; the behaviour around them is
// covered there.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVATAR_MAX_BYTES, OpenVpnProxyConfigSchema } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';
import { binarySizeLabel } from '../../src/lib/binary-size-label.js';
import {
  SESSION_UPLOAD_MAX_LIFETIME_BYTES_DEFAULT,
  UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES_DEFAULT,
  UPLOAD_MAX_FILE_BYTES_DEFAULT,
} from '../../src/lib/upload-caps.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ROUTE = resolve(REPO, 'apps', 'server', 'src', 'routes', 'agent-sessions.ts');
const DOC = resolve(REPO, 'apps', 'docs', 'src', 'pages', 'api', 'agent-sessions.md');
const ACCOUNT_DOC = resolve(REPO, 'apps', 'docs', 'src', 'pages', 'api', 'account.md');
const ACCOUNT_ROUTE = resolve(REPO, 'apps', 'server', 'src', 'routes', 'account-me.ts');
const PROXIES_DOC = resolve(REPO, 'apps', 'docs', 'src', 'pages', 'api', 'proxies.md');

interface Cap {
  /** The default the route applies when nothing is injected. */
  enforced: number;
  /** How the docs phrase it, with the figure captured. */
  published: RegExp;
  what: string;
}

const CAPS: readonly Cap[] = [
  {
    what: 'per-file decoded size',
    enforced: UPLOAD_MAX_FILE_BYTES_DEFAULT,
    published: /decoded\s+size is capped at \*\*([\d.]+ [KMG]i?B)\*\* per file/,
  },
  {
    what: 'per-account concurrent volume',
    enforced: UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES_DEFAULT,
    published: /per-account concurrent upload volume \(([\d.]+ [KMG]i?B)\)/,
  },
  {
    what: 'per-session lifetime total',
    enforced: SESSION_UPLOAD_MAX_LIFETIME_BYTES_DEFAULT,
    published: /per-session lifetime totals \(([\d.]+ [KMG]i?B)\)/,
  },
];

describe('the documented upload caps are the enforced ones', () => {
  const route = readFileSync(ROUTE, 'utf-8');
  const doc = readFileSync(DOC, 'utf-8');

  it('CRITICAL the readers find real values on both sides', () => {
    for (const { enforced, published, what } of CAPS) {
      expect(enforced, `${what}: the imported default is not a positive size`).toBeGreaterThan(0);
      expect(published.exec(doc)?.[1], `${what}: claim not found in the docs`).toBeTruthy();
    }
    expect(binarySizeLabel(64 * 2 ** 20)).toBe('64 MiB');
    expect(binarySizeLabel(512 * 2 ** 20)).toBe('512 MiB');
    expect(binarySizeLabel(2 * 2 ** 30)).toBe('2 GiB');
  });

  it('CRITICAL every documented cap equals the cap the route defaults to', () => {
    const wrong: string[] = [];
    for (const { enforced, published, what } of CAPS) {
      const claimed = published.exec(doc)![1]!;
      const expected = binarySizeLabel(enforced);
      if (claimed !== expected)
        wrong.push(`${what}: docs say ${claimed}, the route enforces ${expected}`);
    }
    expect(wrong.sort(), 'the upload reference states a limit the server does not apply').toEqual(
      [],
    );
  });

  it('CRITICAL the rejection messages are derived, so they cannot drift from the caps', () => {
    // A hardcoded size in these messages is the defect this replaced: the
    // per-account cap is configurable, so any literal is wrong for some
    // deployment.
    for (const marker of [
      'at most ${binarySizeLabel(UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES)}',
      'at most ${binarySizeLabel(SESSION_UPLOAD_MAX_LIFETIME_BYTES)}',
      'Max ${binarySizeLabel(UPLOAD_MAX_FILE_BYTES)}',
    ])
      expect(route, `upload rejection message no longer derives its size: ${marker}`).toContain(
        marker,
      );
    // Importing the defaults only proves the docs match those constants; it
    // says nothing about the route still applying them. Link the two.
    for (const applied of [
      'uploadMaxAccountInFlightBytes = UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES_DEFAULT',
      'sessionUploadMaxLifetimeBytes = SESSION_UPLOAD_MAX_LIFETIME_BYTES_DEFAULT',
      'UPLOAD_MAX_FILE_BYTES = UPLOAD_MAX_FILE_BYTES_DEFAULT',
    ])
      expect(route, `the route no longer defaults to the shared constant: ${applied}`).toContain(
        applied,
      );
    expect(
      /at most \d+ ?[KMG]i?B of uploads/.test(route),
      'an upload rejection message hardcodes a size again',
    ).toBe(false);
  });

  it('CRITICAL V-1066 the avatar cap the page publishes is the one the route enforces. Both sides were frozen independently — the constant as source text, the doc sentence as doc text — and nothing compared them, so raising the cap fails the source pin, whoever raises it updates that pin, and the page keeps promising a figure the server no longer applies.', () => {
    const accountDoc = readFileSync(ACCOUNT_DOC, 'utf-8');
    const claimed = /Max raw size: ([\d.]+ [KMG]i?B)/.exec(accountDoc)?.[1];
    expect(claimed, 'the avatar size claim is no longer on api/account.md').toBeTruthy();
    expect(AVATAR_MAX_BYTES, 'AVATAR_MAX_BYTES is not a positive size').toBeGreaterThan(0);
    expect(
      claimed,
      `api/account.md publishes ${String(claimed)} but AVATAR_MAX_BYTES is ` +
        `${binarySizeLabel(AVATAR_MAX_BYTES)}`,
    ).toBe(binarySizeLabel(AVATAR_MAX_BYTES));
  });

  it('CRITICAL the avatar route still rejects against that same constant. Matching the docs to a constant proves nothing if the handler stopped reading it — the same link the upload arm above draws between the imported defaults and the route.', () => {
    const accountRoute = readFileSync(ACCOUNT_ROUTE, 'utf-8');
    expect(accountRoute, 'the avatar route no longer compares against AVATAR_MAX_BYTES').toMatch(
      /bytes\.length > AVATAR_MAX_BYTES/,
    );
    expect(
      accountRoute,
      'the avatar rejection message no longer interpolates the constant, so it can drift from it',
    ).toContain('Max ${AVATAR_MAX_BYTES} bytes.');
  });

  it('CRITICAL V-1066 the .ovpn size the proxies page publishes is the bound the schema applies, read off the schema rather than restated. The source side is covered behaviourally — a too-large blob is rejected in api-types-egress-content-parity — so raising the cap fails there and forces a visit, and the prose is the copy that gets left behind.', () => {
    // `.refine()` wraps the string in a ZodEffects, so the length checks are not
    // on the outer object — walk down to the schema that carries them. Reading a
    // missing `checks` as "no bound" is how a derived check quietly stops
    // deriving anything, so the assertion below insists a bound was found.
    const maxOf = (node: unknown, depth = 0): number | undefined => {
      if (depth > 8) return undefined;
      const def = (node as { _def?: Record<string, unknown> })._def;
      const checks = def?.['checks'] as { kind: string; value?: number }[] | undefined;
      const found = checks?.find((c) => c.kind === 'max')?.value;
      if (found !== undefined) return found;
      for (const key of ['schema', 'innerType', 'in', 'out']) {
        const next = def?.[key];
        if (next !== undefined) {
          const deeper = maxOf(next, depth + 1);
          if (deeper !== undefined) return deeper;
        }
      }
      return undefined;
    };
    const max = maxOf(OpenVpnProxyConfigSchema.shape.config_blob);
    expect(
      max,
      'OpenVpnProxyConfigSchema.config_blob no longer carries a max bound',
    ).toBeGreaterThan(0);

    const proxiesDoc = readFileSync(PROXIES_DOC, 'utf-8');
    const claimed = /up to ([\d.]+ [KMG]i?B)\)/.exec(proxiesDoc)?.[1];
    expect(claimed, 'the .ovpn size claim is no longer on api/proxies.md').toBeTruthy();
    expect(
      claimed,
      `api/proxies.md publishes ${String(claimed)} for config_blob but the schema bounds it at ` +
        `${binarySizeLabel(max ?? 0)}`,
    ).toBe(binarySizeLabel(max ?? 0));
  });
});
