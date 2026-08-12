// W864 — OptOutableEmailEvent 6-value cross-source invariant.
// One-hundred-ninetieth in the drift-guard series. Pins the V-202
// + V-304a + V-304b opt-outable email-event roster:
//
//   Lifecycle (3): signup-welcome + session-failed-first +
//                  session-success-first.
//   Account (1):  tier-changed.
//   Billing (2): billing-receipt + billing-renewal-reminder.
//
// (The trial-pack-purchased / trial-pack-expired pair was removed
// with the dead trial_pack lifecycle — no production path ever
// emitted those emails.)
//
// stays in lockstep across:
//   - packages/api-types/src/accounts.ts (Zod canonical source).
//   - apps/server/src/services/email-preferences.ts (allEvents
//     defaults list — server iterates this to render the
//     preferences table).
//   - apps/customer-dashboard/src/pages/settings.astro (6
//     toggle entries — one per opt-outable event).
//
// CRITICAL POLICY NOTE: Security + financial emails (signup-
// verification, password-reset, billing-failure) are NEVER
// opt-outable and MUST NOT appear in this enum. Drift to including
// any of those would break the policy that "customers can't disable
// critical-path emails". (S44 2026-07-07 deleted the never-wired
// subscription-cancellation + support-ack templates; their names
// stay in the forbidden list below so a resurrection can't slip
// into the enum unnoticed.)

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OptOutableEmailEventSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const OPT_OUTABLE_EVENTS = [
  'signup-welcome',
  'session-failed-first',
  'session-success-first',
  'tier-changed',
  'billing-receipt',
  'billing-renewal-reminder',
] as const;

const FORBIDDEN_CRITICAL_PATH_EVENTS = [
  'signup-verification',
  'password-reset',
  'billing-failure',
  'subscription-cancellation',
  'support-ack',
  'mfa-enrolled',
  'mfa-disabled',
] as const;

describe('W864 OptOutableEmailEvent cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/accounts.ts OptOutableEmailEventSchema = z.enum([6 values]). The 6-value closed-roster is what email-preference toggle UI + per-event server-side shouldSend gates pivot on.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/export const OptOutableEmailEventSchema = z\.enum\(\[/);
    // EXACT canonical pin: .options must EQUAL the 6-value set, not merely
    // contain it. A 7th value added here would silently pass the body-subset
    // check below — including accidentally adding a critical-path (non-opt-
    // outable) email, breaking the policy note above. .toEqual fails loudly.
    // (Same weak-subset class as the WebhookEventType drift.)
    expect(OptOutableEmailEventSchema.options).toEqual([...OPT_OUTABLE_EVENTS]);
    const m = p.match(/OptOutableEmailEventSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'OptOutableEmailEventSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const e of OPT_OUTABLE_EVENTS) {
      expect(body, `OptOutableEmailEventSchema must include '${e}'`).toMatch(
        new RegExp(`'${e.replace(/-/g, '\\-')}'`),
      );
    }
  });

  it('CRITICAL OptOutableEmailEvent type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /export type OptOutableEmailEvent = z\.infer<typeof OptOutableEmailEventSchema>;/,
    );
  });

  it('CRITICAL V-304a anchor pinned for session-success-first; V-304b anchor pinned for billing-renewal-reminder. These distinguish the milestone-trigger emails added after V-202.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/V-304a — first successful session activation milestone email/);
    expect(p).toMatch(/V-304b — 7-days-before-renewal reminder/);
  });

  it('CRITICAL the api-types inline doc pins the security+financial-emails-never-opt-outable policy. The policy doc is the immutable record of which emails customers cannot disable.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    // Match key phrases of the policy doc; JSDoc wraps across lines.
    expect(p).toMatch(/Security \+ financial emails/);
    expect(p).toMatch(/are never opt-outable/);
    expect(p).toMatch(/the API surface matches the policy/);
  });

  // ─── Server services/email-preferences.ts allEvents list ─────

  it('CRITICAL apps/server/src/services/email-preferences.ts allEvents defaults list iterates ALL 6 opt-outable events. The server renders the preferences API response from this list — drift would silently let an event arrive without a corresponding preference row.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/const allEvents: OptOutableEmailEvent\[\] = \[/);
    const m = p.match(/const allEvents: OptOutableEmailEvent\[\] = \[([\s\S]+?)\];/);
    expect(m, 'allEvents list must be present').not.toBeNull();
    const body = m![1];
    for (const e of OPT_OUTABLE_EVENTS) {
      expect(body, `allEvents must include '${e}'`).toMatch(
        new RegExp(`'${e.replace(/-/g, '\\-')}'`),
      );
    }
  });

  // ─── Customer-dashboard settings.astro toggle entries ────────

  it("CRITICAL apps/customer-dashboard/src/pages/settings.astro renders 6 toggle entries — one per opt-outable event. The dashboard renders 'type: <event-name>' fields for each; drift to missing a toggle would silently let customers be unable to opt out of that event from the UI.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro'));
    for (const e of OPT_OUTABLE_EVENTS) {
      expect(p, `settings.astro missing toggle for '${e}'`).toMatch(
        new RegExp(`type:\\s*'${e.replace(/-/g, '\\-')}'`),
      );
    }
  });

  // ─── Cardinality + category split ────────────────────────────

  it('CRITICAL OptOutableEmailEvent = EXACTLY 6 values across 3 categories — 3 lifecycle (signup/session-failed-first/session-success-first) + 1 account (tier-changed) + 2 billing. The 3/1/2 split is what the dashboard groups by visually.', () => {
    expect(OPT_OUTABLE_EVENTS.length).toBe(6);
    const lifecycle = OPT_OUTABLE_EVENTS.filter(
      (e) =>
        e === 'signup-welcome' || e === 'session-failed-first' || e === 'session-success-first',
    );
    const account = OPT_OUTABLE_EVENTS.filter((e) => e === 'tier-changed');
    const trial = OPT_OUTABLE_EVENTS.filter((e) => e.startsWith('trial-pack-'));
    const billing = OPT_OUTABLE_EVENTS.filter((e) => e.startsWith('billing-'));
    expect(lifecycle.length).toBe(3);
    expect(account.length).toBe(1);
    expect(trial.length).toBe(0);
    expect(billing.length).toBe(2);
  });

  // ─── Critical-path-emails NEVER opt-outable policy ───────────

  it("CRITICAL no critical-path email name (signup-verification / password-reset / billing-failure / subscription-cancellation / support-ack / mfa-enrolled / mfa-disabled) appears in OptOutableEmailEventSchema. The api-types schema is THE source-of-truth for what's opt-outable — drift to including any of these would silently let customers disable critical-path emails (account-recovery / billing-failures / support replies).", () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const m = apiTypes.match(/OptOutableEmailEventSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const forbidden of FORBIDDEN_CRITICAL_PATH_EVENTS) {
      expect(
        body,
        `OptOutableEmailEvent MUST NOT include critical-path '${forbidden}'`,
      ).not.toMatch(new RegExp(`'${forbidden.replace(/-/g, '\\-')}'`));
    }
  });

  // ─── kebab-case naming convention ────────────────────────────

  it("CRITICAL all 6 events follow the 'kebab-case' naming convention (no snake_case, no camelCase, no dots). The naming is uniform across the roster — drift to mixed conventions would break filter UI key-matching.", () => {
    for (const e of OPT_OUTABLE_EVENTS) {
      expect(e, `Event '${e}' must be kebab-case (no _ or . or uppercase)`).toMatch(
        /^[a-z]+(-[a-z]+)+$/,
      );
    }
  });

  // ─── EmailPreference + Set + List schemas reference the enum ──

  it('CRITICAL EmailPreferenceSchema + SetEmailPreferenceRequestSchema use OptOutableEmailEventSchema as the event_type field. The cross-reference enforces typed-event filtering throughout the preference API. Drift to loose z.string() would weaken the type.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /export const EmailPreferenceSchema = z\.object\(\{[\s\S]+?event_type: OptOutableEmailEventSchema/,
    );
    expect(p).toMatch(
      /export const SetEmailPreferenceRequestSchema = z\.object\(\{[\s\S]+?event_type: OptOutableEmailEventSchema/,
    );
  });

  // ── The other half of the policy: names claimed to be ALWAYS sent ──────────────────
  //
  // The checks above prove the six opt-outable events are consistent everywhere, and that no
  // critical-path name has leaked INTO that enum. Neither notices the opposite failure, which
  // is the one that actually happened: a name stays on the "always go out" list after its
  // template is deleted. `subscription cancellation` sat in the settings copy — and in the
  // vendor-facing Postmark deliverability request — long after the S44 2026-07-07 trim removed
  // its template as unused. The page promised mail no code path can send, immediately above the
  // toggle that suppresses `tier-changed`, the only message a cancellation actually produces.

  /** Emails a customer surface claims are always sent, and what would send each. */
  const ALWAYS_SENT: ReadonlyArray<{ phrase: string; template: string | null; why?: string }> = [
    { phrase: 'signup verification', template: 'signup-verification' },
    { phrase: 'password reset', template: 'password-reset' },
    { phrase: 'billing failure', template: 'billing-failure' },
    {
      phrase: 'support replies',
      template: null,
      why: 'Answered by a person at info@driftstack.dev rather than by a template. The automated support-acknowledgement template was deleted in the same S44 trim; a human reply is not preference-gated, so the clause stays true.',
    },
  ];

  function templateKeys(): Set<string> {
    const src = readFileSync(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'), 'utf8');
    const start = src.indexOf('const TEMPLATES');
    const block = src.slice(start, src.indexOf('\n};', start));
    return new Set([...block.matchAll(/^ {2}'?([a-z][a-zA-Z-]*)'?:/gm)].map((m) => m[1]!));
  }

  it('CRITICAL the TEMPLATES scan found the real map. An empty set would make both checks below vacuously true, and the defect they exist for is a name outliving its template — so a silent scan failure would hide exactly what it is meant to catch.', () => {
    const keys = templateKeys();
    expect(keys.size, 'TEMPLATES entries in services/email.ts').toBeGreaterThan(10);
    expect(keys, 'anchor on a template known to exist').toContain('tier-changed');
    // And the deleted ones must still be absent, or the premise has changed.
    expect([...keys].filter((k) => /cancel|support-ack|quota/i.test(k))).toEqual([]);
  });

  it('CRITICAL every email named as ALWAYS SENT still has a template, and none of them is opt-outable. A name that outlives its template promises mail no code path can send; a name that becomes preference-gated promises mail the customer has already switched off.', () => {
    const keys = templateKeys();

    const missing = ALWAYS_SENT.filter((e) => e.template !== null && !keys.has(e.template)).map(
      (e) => `${e.phrase} -> ${String(e.template)}`,
    );
    expect(missing, 'always-sent email(s) whose template does not exist:').toEqual([]);

    const gated = ALWAYS_SENT.filter(
      (e) => e.template !== null && (OPT_OUTABLE_EVENTS as readonly string[]).includes(e.template),
    ).map((e) => `${e.phrase} (${String(e.template)})`);
    expect(gated, 'always-sent claim(s) that are actually opt-outable:').toEqual([]);

    // A `null` template must be explained, so it cannot become a quiet way to keep naming
    // something that nothing sends.
    const unexplained = ALWAYS_SENT.filter(
      (e) => e.template === null && (e.why ?? '').length < 40,
    ).map((e) => e.phrase);
    expect(unexplained, 'template-less entr(ies) without a stated reason:').toEqual([]);
  });

  it('CRITICAL no customer- or vendor-facing surface lists a cancellation email as always-sent while no template can send one. Derived from the TEMPLATES map rather than pinned as prose, so the day a cancellation template is actually added, the copy is free to say so.', () => {
    const SURFACES = [
      'apps/customer-dashboard/src/pages/settings.astro',
      'docs/internal/postmark-approval-request.md',
    ] as const;
    const hasCancellationTemplate = [...templateKeys()].some((k) => /cancel/i.test(k));

    const offenders: string[] = [];
    for (const path of SURFACES) {
      const text = readFileSync(resolve(REPO_ROOT, path), 'utf8');
      // Only the sentence that makes the always-sent claim, not the whole page — elsewhere
      // these files legitimately discuss cancellation.
      const claim =
        /(?:Security \+ financial emails|Critical emails) \(([^)]*)\)/s.exec(text)?.[1] ?? null;
      if (claim === null) {
        offenders.push(`${path}: the always-sent sentence could not be read`);
        continue;
      }
      if (!hasCancellationTemplate && /cancel/i.test(claim)) {
        offenders.push(`${path}: lists cancellation as always-sent, but no template sends one`);
      }
    }

    expect(offenders.sort(), 'surface(s) advertising an email nothing can send:').toEqual([]);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/opt-outable-email-event-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
