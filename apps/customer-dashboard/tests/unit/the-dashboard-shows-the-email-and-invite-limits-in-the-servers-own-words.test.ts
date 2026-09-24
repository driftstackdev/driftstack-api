// Security sweep 2026-09-24, findings #4-#6 — the new refusals reach the customer
// in the server's own words: what happened and when to try again.
//
// The dashboard never reflects server prose except for messages it lists and
// matches WHOLE. Without these entries a refused password reset, sign-in link or
// team invite read "A usage limit was reached. Wait a moment or review your plan"
// — wrong on both counts, since the wait can be an hour and no plan changes it.
// The free-plan invite refusal has its own list under `forbidden`, so no sign-in
// message is ever shown under that type.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAYOUT = resolve(HERE, '..', '..', 'src', 'layouts', 'DashboardLayout.astro');
const SERVER = resolve(HERE, '..', '..', '..', 'server', 'src');
const layout = readFileSync(LAYOUT, 'utf8');

const body = layout.match(
  /window\.driftstackResponseError = function \(response, body\) \{[\s\S]*?\n        \};(?=\n        window\.driftstackFetchWithDeadline)/,
)?.[0];
if (!body) throw new Error('dashboard response-error helper not found');
const scope = { window: {} as Record<string, unknown> };
new Function('window', body)(scope.window);
const responseError = scope.window.driftstackResponseError as (
  response: { status: number },
  problem: unknown,
) => Error & { customerSafe?: boolean };

const RATE = 'https://errors.driftstack.dev/rate-limited';
const FORBIDDEN = 'https://errors.driftstack.dev/forbidden';
const GENERIC_RATE =
  'A usage limit was reached. Wait a moment or review your plan, then try again.';
const GENERIC_FORBIDDEN = 'You do not have permission to perform this action.';

describe('the dashboard shows the email and invite limits in the server’s own words', () => {
  it('CRITICAL each per-address and team-invite refusal is shown word for word', () => {
    const shown = [
      'Too many verification emails have been requested for this address. Try again in 60 minutes.',
      'Too many sign-in links have been requested for this address. Try again in 1 minute.',
      'Too many password reset emails have been requested for this address. Try again in 23 hours.',
      'Too many confirmation emails have been requested for this address. Try again in 42 minutes.',
      'This address has been sent too many team invites recently. Try again in 3 hours.',
      'An invite was emailed to this address less than 10 minutes ago. You can send it again in 9 minutes.',
      'Your team has 20 invites waiting to be accepted, the most allowed at once. Try again when one is accepted, or in 7 days, when the oldest expires.',
    ];
    for (const detail of shown) {
      const error = responseError({ status: 429 }, { type: RATE, detail });
      expect(error.message).toBe(detail);
      expect(error.customerSafe).toBe(true);
    }
    const plan =
      'Inviting teammates is available on paid plans. Upgrade your plan to invite people to your account.';
    expect(responseError({ status: 403 }, { type: FORBIDDEN, detail: plan }).message).toBe(plan);
  });

  it('reflects nothing but a whole match, and nothing under the wrong type', () => {
    const near = [
      'Too many sign-in links have been requested for this address. Try again in 60 minutes. host=db.private',
      'Too many pizzas have been requested for this address. Try again in 60 minutes.',
      'This address has been sent too many team invites recently. Try again in soon.',
    ];
    for (const detail of near) {
      expect(responseError({ status: 429 }, { type: RATE, detail }).message).toBe(GENERIC_RATE);
    }
    // The plan refusal under the rate-limited type, and a rate message under forbidden.
    expect(
      responseError(
        { status: 429 },
        {
          type: RATE,
          detail:
            'Inviting teammates is available on paid plans. Upgrade your plan to invite people to your account.',
        },
      ).message,
    ).toBe(GENERIC_RATE);
    expect(
      responseError(
        { status: 403 },
        {
          type: FORBIDDEN,
          detail:
            'Too many sign-in links have been requested for this address. Try again in 60 minutes.',
        },
      ).message,
    ).toBe(GENERIC_FORBIDDEN);
  });

  it('lists only messages the server still writes', () => {
    const limit = readFileSync(resolve(SERVER, 'services', 'recipient-email-limit.ts'), 'utf8');
    const team = readFileSync(resolve(SERVER, 'services', 'team-members.ts'), 'utf8');
    for (const fragment of [
      "'verification emails'",
      "'sign-in links'",
      "'password reset emails'",
      "'confirmation emails'",
      'have been requested for this address. Try again in ${wait}.',
      'This address has been sent too many team invites recently. Try again in ${wait}.',
    ]) {
      expect(limit, fragment).toContain(fragment);
    }
    for (const fragment of [
      'An invite was emailed to this address less than ${cooldownMinutes.toString()} minutes ago. You can send it again in ${describeWait(outcome.retryAfterMs)}.',
      'invites waiting to be accepted, the most allowed at once. Try again when one is accepted, or in ${describeWait(outcome.retryAfterMs)}, when the oldest expires.',
      "'Inviting teammates is available on paid plans. Upgrade your plan to invite people to your account.'",
    ]) {
      expect(team, fragment).toContain(fragment);
    }
  });
});
