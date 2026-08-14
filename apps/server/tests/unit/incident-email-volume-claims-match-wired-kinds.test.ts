// A subscriber-facing volume promise may not claim fewer emails than the code can send.
//
// The status site told subscribers "Two emails per incident maximum" in three places, and the
// welcome email said "when it's posted and again when it's resolved — nothing else". A THIRD
// kind is wired in production: `bootstrap.ts` constructs `IncidentNotificationsService` WITH the
// throttle repo — so the `if (!this.throttle) return;` no-op in `notifyUpdated` is not taken —
// and registers `onPublicUpdated`, which fans out `status-incident-updated` on every operator
// update. The only bound is a SLIDING one-hour window per subscriber per incident
// (`UPDATE_THROTTLE_MS`); there is no total cap. With the hourly cadence the incident policy
// itself promises, an 8-hour Major incident sends roughly ten emails, not two.
//
// Why that matters more than a wording slip: the promise is the stated consent basis for a
// double-opt-in list. Volume far above it invites spam complaints, and Postmark suppression
// then silently kills the created/resolved emails the subscriber actually wanted.
//
// CROSS-SOURCE. The count is derived from the template registry and the bootstrap wiring, so
// wiring a fourth kind fails this test rather than quietly making the copy false again.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const EMAIL = resolve(REPO_ROOT, 'apps/server/src/services/email.ts');
const BOOTSTRAP = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');

/** Subscriber-facing incident email templates that exist AND are wired to a hook. */
function wiredIncidentEmailKinds(): string[] {
  const email = readFileSync(EMAIL, 'utf8');
  const boot = readFileSync(BOOTSTRAP, 'utf8');
  const declared = [...email.matchAll(/'(status-incident-[a-z]+)':/g)].map((m) => m[1]!);
  const HOOK = {
    'status-incident-created': /onPublicCreated:/,
    'status-incident-updated': /onPublicUpdated:/,
    'status-incident-resolved': /onPublicResolved:/,
  } as Record<string, RegExp>;
  return [...new Set(declared)].filter((k) => {
    const hook = HOOK[k];
    // A kind with no known hook is counted rather than dropped: an unrecognised template is a
    // reason to look, not a reason to lower the floor.
    return hook === undefined ? true : hook.test(boot);
  });
}

/** Every surface that makes a volume promise to a status subscriber. */
const SURFACES = [
  'apps/status-site/src/pages/subscribe.astro',
  'apps/status-site/src/pages/subscribe/confirm.astro',
  'apps/server/src/services/email.ts',
] as const;

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

describe('incident-email volume claims match the kinds actually wired', () => {
  const kinds = wiredIncidentEmailKinds();

  it('CRITICAL the derivation found the real wiring. A kind list that came back short would lower the floor the check below enforces, which is the direction that lets a false cap through.', () => {
    expect(kinds.sort(), 'wired subscriber-facing incident email kinds').toEqual([
      'status-incident-created',
      'status-incident-resolved',
      'status-incident-updated',
    ]);
    // The per-update fan-out is the one that broke the promise, so its wiring is asserted
    // explicitly rather than only via the count.
    expect(readFileSync(BOOTSTRAP, 'utf8'), 'the per-update hook must still be wired').toMatch(
      /onPublicUpdated:/,
    );
    for (const s of SURFACES) expect(existsSync(resolve(REPO_ROOT, s)), s).toBe(true);
  });

  it('CRITICAL no subscriber-facing surface promises a numeric cap below the number of email kinds that can actually be sent — and none promises a total cap at all, because the per-update fan-out is bounded only by a sliding hourly window', () => {
    const offenders: string[] = [];
    for (const surface of SURFACES) {
      const text = readFileSync(resolve(REPO_ROOT, surface), 'utf8');
      for (const m of text.matchAll(/(\w+)\s+emails?\s+per\s+incident/gi)) {
        const raw = m[1]!.toLowerCase();
        const n = WORD_NUMBERS[raw] ?? Number(raw);
        // A total cap cannot be honest here at any number: updates are unbounded in count.
        offenders.push(
          `${surface}: claims "${m[0]}" but ${String(kinds.length)} kinds are wired and updates are uncapped`,
        );
        void n;
      }
    }

    expect(
      offenders.sort(),
      'subscriber-facing volume promise(s) the code does not honour:',
    ).toEqual([]);
  });

  it('CRITICAL the welcome email does not tell a new subscriber that posted+resolved is all they will get — that body is the first thing a confirmed subscriber reads', () => {
    const email = readFileSync(EMAIL, 'utf8');
    const start = email.indexOf("'status-subscription-welcome'");
    expect(start, 'the welcome template must still exist').toBeGreaterThan(-1);
    const body = email.slice(start, start + 1600);

    expect(body, 'the welcome body must mention the update emails').toMatch(
      /once an hour while it stays open/,
    );
    expect(body).not.toMatch(/posted and again when it's resolved — nothing else/);
  });
});
