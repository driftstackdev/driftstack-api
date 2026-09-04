// W771 — apps/docs api/email-preferences.md content parity. Ninety-
// seventh in the cross-SDK drift-guard series.
//
// /api/email-preferences is the V-204 customer reference for the
// opt-out-able email surface. Drift to the operational-vs-
// transactional split or the 8-event opt-outable catalog would
// mismatch W759 dashboard /settings + V-204 server enforcement.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/email-preferences.md');

describe('W771 docs /api/email-preferences content parity', () => {
  it('api/email-preferences.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Description threads operational-vs-transactional split.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Email preferences\n/,
    );
    expect(p).toMatch(
      /description: Manage which transactional emails Driftstack sends — opt out of welcome \/ activation \/ receipts \/ renewal reminders\. Operational mail \(auth, security, billing failures\) is never opt-outable\./,
    );
  });

  it("CRITICAL operational-vs-transactional 2-category split framing pinned. The 'Operational — non-optional. Required for the service to work' + 'Transactional / informational — opt-outable. Welcome email, first-session activation milestone' wording is the load-bearing customer-comms framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Operational\*\* — non-optional\. Required for the service to/);
    expect(p).toMatch(/work \(signup verification, password reset, billing-failure/);
    expect(p).toMatch(/\*\*Transactional \/ informational\*\* — opt-outable\./);
    expect(p).toMatch(/Welcome\s*\n?\s+email, first-session activation milestone, tier-change/);
  });

  it("CRITICAL per-event-opt-in + no-blanket-opt-out framing pinned. The 'Per-event opt-in is the unit; there\\'s no \"opt out of everything optional\" shorthand because the legal posture (per the [DPA]) requires that we deliver each opt-out as an affirmative customer choice' wording is the load-bearing DPA-compliance framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Per-event opt-in is the unit;\s*\n?there's no "opt out of everything optional" shorthand because\s*\n?the legal posture \(per the \[DPA\]\(https:\/\/driftstack\.io\/legal\/dpa\/\)\) requires that we\s*\n?deliver each opt-out as an affirmative customer choice\./,
    );
    expect(p).not.toMatch(/\[DPA\]\(https:\/\/driftstack\.io\/legal\/dpa\)/);
  });

  it('CRITICAL 6-event opt-outable catalog pinned. Drift to dropping any would let SDK consumers misjudge which events can be silenced. (The trial-pack pair was removed with the dead trial_pack lifecycle.)', () => {
    const p = read(PAGE);

    for (const event of [
      'signup-welcome',
      'session-success-first',
      'session-failed-first',
      'tier-changed',
      'billing-receipt',
      'billing-renewal-reminder',
    ]) {
      expect(p, `opt-outable event ${event}`).toMatch(new RegExp(`"event_type": "${event}"`));
      expect(p, `opt-outable event ${event} table row`).toMatch(new RegExp(`\\| \`${event}\``));
    }
    expect(p).not.toMatch(/"event_type": "trial-pack-purchased"/);
    expect(p).not.toMatch(/"event_type": "trial-pack-expired"/);
  });

  it('CRITICAL critical-emails-not-opt-outable 5-event catalog pinned — signup-verification + password-reset + billing-failure (S44-live trigger wording) + status-incident-* + GDPR Art 34 security notices. Drift to letting any of these be opt-outable would erode customer-comms safety. (S44 2026-07-07 founder-approved trim deleted the never-wired subscription-cancellation + support-ack templates — their bullets are gone and must stay gone.)', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`signup-verification` — required to activate the account\./);
    expect(p).toMatch(/`password-reset` — security-critical\./);
    expect(p).toMatch(/`billing-failure` — fires on a failed subscription charge/);
    expect(p).not.toMatch(/subscription-cancellation/);
    expect(p).not.toMatch(/support-ack/);
    expect(p).toMatch(
      /`status-incident-created` \/ `status-incident-resolved` — only\s*\n?\s+to customers explicitly subscribed via `\/status` \(separate\s*\n?\s+opt-in surface, not part of email preferences\)\./,
    );
    expect(p).toMatch(/Security notices under GDPR Art\. 34/);
  });

  it("CRITICAL OptOutableEmailEventSchema canonical-source framing pinned. The 'The OptOutableEmailEventSchema enum is the canonical opt-outable set — categories absent from that enum are operational by design' wording matches W759 dashboard /settings V-204 schema-mirror comment.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The\s*\n?`OptOutableEmailEventSchema` enum is the canonical opt-outable\s*\n?set — categories absent from that enum are operational by design\./,
    );
  });

  it('CRITICAL X-Driftstack-Account team-RBAC framing — read OK for member+admin, write requires admin pinned. Matches W766 /api/team header-honoring + V-326e write-requires-admin contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /A team member with a valid membership can read the OWNER's\s*\n?preferences by passing `X-Driftstack-Account: acc_<owner-uuid>`\./,
    );
    expect(p).toMatch(/Both `member` and `admin` roles are allowed for the read\./);
    expect(p).toMatch(
      /set on an OWNER's preferences via\s*\n?\s+`X-Driftstack-Account` requires `admin` role on that team;\s*\n?\s+`member` is read-only on writes\./,
    );
  });

  it("CRITICAL PUT body shape — { event_type, opted_in } single-preference framing pinned. The 'Sets the opt-in state for a single category' wording explains the unit-of-change.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Sets the opt-in state for a single category\./);
    expect(p).toMatch(/"event_type": "session-success-first"/);
    expect(p).toMatch(/"opted_in": false/);
  });

  it('CRITICAL PUT returns 204 No Content framing pinned. Drift to a 200-only check would let SDK consumers misclassify success.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Response: `204 No Content`\./);
  });

  it('CRITICAL 400 bad-request on operational-event opt-out attempt pinned. The "e.g. customer tried to opt out of signup-verification, which is operational" wording explains the error-shape mapping.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`400 bad-request` — `event_type` is not in the opt-outable enum\s*\n?\s+\(e\.g\. customer tried to opt out of `signup-verification`, which\s*\n?\s+is operational\)\./,
    );
  });

  it("CRITICAL GET=account_owner AND PUT=account_owner scope framing pinned. S36 2026-07-07 (fable-truth-audit): BOTH service methods gate on 'account_owner' (email-preferences.ts list() :51 + set() :90 throwIfMissingScope(ctx, 'account_owner')), and hasScope does NOT let a broad `write` key satisfy account_owner (only the legacy admin alias) — the old 'write or account_owner' PUT claim would 403 a write-scoped key. Drift would let SDK consumers send wrong-scoped requests.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Required scope: `account_owner` \(the service gates this read on/);
    expect(p).toMatch(
      /Required scope: `account_owner` \(the service gates this write on\s*\n?`account_owner` — a broad `write` key is not sufficient\)\./,
    );
    // Drift sentinels — neither overstated claim may come back.
    expect(p).not.toMatch(/Required scope: `read` or `account_owner`\./);
    expect(p).not.toMatch(/Required scope: `write` or `account_owner`\./);
  });

  it('CRITICAL default-opt-in framing pinned. The "Categories not yet explicitly set return their default state (opt-in for everything, except where a specific email\'s footer already provided a one-click unsubscribe)" wording matches V-204 server-side default-state contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Categories not yet explicitly set return their default state\s*\n?\(opt-in for everything, except where a specific email's footer\s*\n?already provided a one-click unsubscribe\)\./,
    );
  });

  it("CRITICAL customer-dashboard surface cross-reference pinned. The '/settings → Email section on the customer dashboard renders this endpoint visually with toggle switches per category. Changes apply immediately on toggle (no save button)' wording matches W759 dashboard /settings V-204 email-preferences live-wire.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The `\/settings → Email` section on the customer dashboard\s*\n?renders this endpoint visually with toggle switches per\s*\n?category\. Changes apply immediately on toggle \(no save button\)\./,
    );
  });

  it('CRITICAL Source-of-truth pointers pinned — apps/server/src/routes/email-preferences.ts + OptOutableEmailEventSchema + email-preferences service + repo. Drift would lose the canonical impl pointers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Routes: `apps\/server\/src\/routes\/email-preferences\.ts`\./);
    expect(p).toMatch(
      /Schema:\s*\n?`packages\/api-types\/src\/accounts\.ts:OptOutableEmailEventSchema`\./,
    );
    expect(p).toMatch(/Service: `apps\/server\/src\/services\/email-preferences\.ts`\./);
    expect(p).toMatch(/Repo:\s*\n?`apps\/server\/src\/db\/email-preferences-repo\.ts`\./);
  });

  it('CRITICAL 2-endpoint canonical set — GET /v1/account/email-preferences + PUT /v1/account/email-preferences.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/account\/email-preferences`/);
    expect(p).toMatch(/`PUT \/v1\/account\/email-preferences`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-api-email-preferences-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
