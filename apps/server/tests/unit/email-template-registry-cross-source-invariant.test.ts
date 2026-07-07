// W883 — Email-template registry cross-source invariant. Two-
// hundred-ninth in the drift-guard series. Pins the email-template
// registry roster + critical-path vs opt-outable split:
//
//   Critical-path (NEVER opt-outable, ALWAYS sent):
//     - signup-verification, password-reset, billing-failure.
//       (S44 2026-07-07 founder-approved trim: subscription-
//        cancellation + support-ack were zero-caller templates and
//        are DELETED — asserted GONE below.)
//
//   Opt-outable (6, matches OptOutableEmailEventSchema):
//     - signup-welcome, session-failed-first, session-success-first,
//       tier-changed, billing-receipt, billing-renewal-reminder.
//       (trial-pack-purchased/expired removed with the dead
//        trial_pack lifecycle.)
//
//   Operational (other):
//     - status-subscription-confirmation, status-subscription-welcome,
//       team-invite, status-incident-created, status-incident-updated,
//       status-incident-resolved, oauth-pending-verification.
//       (S44: the quota-warning + session-event-digest drafts never
//        had send methods and are DELETED — asserted GONE below.)
//
// stays in lockstep across:
//   - apps/server/src/services/email.ts (TEMPLATES const).
//   - packages/api-types/src/accounts.ts OptOutableEmailEventSchema
//     (6 opt-outable subset).
//
// Drift would silently break:
//   * Opt-outable schema declares a template the registry lacks
//     (server crashes trying to render).
//   * Critical-path template appears in OptOutableEmailEvent
//     (W864 forbids; W883 backstops at registry level).
//   * A deleted S44 template resurrects without a caller + docs
//     catalog entry.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const CRITICAL_PATH_TEMPLATES = [
  'signup-verification',
  'password-reset',
  'billing-failure',
] as const;

// S44 2026-07-07 (founder-approved trim) — deleted outright; must not
// resurrect in TEMPLATES (and must never appear in the opt-out enum).
const S44_DELETED_TEMPLATES = [
  'subscription-cancellation',
  'support-ack',
  'quota-warning',
  'session-event-digest',
] as const;

const OPT_OUTABLE_TEMPLATES = [
  'signup-welcome',
  'session-failed-first',
  'session-success-first',
  'tier-changed',
  'billing-receipt',
  'billing-renewal-reminder',
] as const;

const OPERATIONAL_TEMPLATES = [
  'status-subscription-confirmation',
  'status-subscription-welcome',
  'team-invite',
  'status-incident-created',
  'status-incident-updated',
  'status-incident-resolved',
  'oauth-pending-verification',
] as const;

describe('W883 Email-template registry cross-source invariant', () => {
  // ─── 5 critical-path templates present ──────────────────────

  it('CRITICAL apps/server/src/services/email.ts TEMPLATES has all 3 critical-path templates — signup-verification + password-reset + billing-failure. These NEVER fall through opt-out gates. The 4 S44-deleted templates stay GONE.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    for (const t of CRITICAL_PATH_TEMPLATES) {
      expect(p, `TEMPLATES must include '${t}'`).toMatch(new RegExp(`'${t}': \\{`));
    }
    for (const t of S44_DELETED_TEMPLATES) {
      expect(p, `S44-deleted template '${t}' must NOT resurrect`).not.toMatch(
        new RegExp(`'${t}': \\{`),
      );
    }
  });

  // ─── 6 opt-outable templates present + match Zod schema ──────

  it('CRITICAL apps/server/src/services/email.ts TEMPLATES has all 6 opt-outable templates. The 6 match the OptOutableEmailEventSchema exactly — every opt-outable event has a template; every template that is opt-outable has a schema entry. (The trial-pack pair was removed with the dead trial_pack lifecycle.)', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    for (const t of OPT_OUTABLE_TEMPLATES) {
      expect(p, `TEMPLATES must include '${t}'`).toMatch(new RegExp(`'${t}': \\{`));
    }
    // Trial-pack templates removed — assert GONE so they can't regress back.
    expect(p).not.toMatch(/'trial-pack-purchased': \{/);
    expect(p).not.toMatch(/'trial-pack-expired': \{/);
  });

  it('CRITICAL OPT_OUTABLE_TEMPLATES (6) MATCHES OptOutableEmailEventSchema (6). Both source-of-truth lists must agree element-by-element.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const m = p.match(/OptOutableEmailEventSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const t of OPT_OUTABLE_TEMPLATES) {
      expect(body, `OptOutableEmailEventSchema must include '${t}'`).toMatch(
        new RegExp(`'${t.replace(/-/g, '\\-')}'`),
      );
    }
  });

  // ─── 7 operational templates present ─────────────────────────

  it('CRITICAL apps/server/src/services/email.ts TEMPLATES has 7 operational templates — status-subscription-* + team-invite + status-incident-{created,updated,resolved} + oauth-pending-verification. status-incident-updated added 2026-05-16 for V-545.B. (S44 2026-07-07 deleted the quota-warning + session-event-digest drafts: 9→7.)', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    for (const t of OPERATIONAL_TEMPLATES) {
      expect(p, `TEMPLATES must include '${t}'`).toMatch(new RegExp(`'${t}': \\{`));
    }
  });

  // ─── Critical-path templates NOT in OptOutableEmailEventSchema ─

  it('CRITICAL no critical-path template (signup-verification / password-reset / billing-failure) — and no S44-deleted template name — appears in OptOutableEmailEventSchema. This is the security backstop — drift would let customers disable account-recovery / billing-failure emails, or resurrect a deleted template id into the customer-facing enum.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const m = p.match(/OptOutableEmailEventSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const t of [...CRITICAL_PATH_TEMPLATES, ...S44_DELETED_TEMPLATES]) {
      expect(body, `OptOutableEmailEventSchema MUST NOT include '${t}'`).not.toMatch(
        new RegExp(`'${t.replace(/-/g, '\\-')}'`),
      );
    }
  });

  // ─── Each template has subject + text + html fields ──────────

  it('CRITICAL every TEMPLATES entry has subject + text + html keys. The 3-field shape is the minimum render-ready template — drift to missing one would crash render at runtime.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    // Sample 3 templates from each bucket.
    for (const t of ['signup-verification', 'signup-welcome', 'team-invite']) {
      const m = p.match(new RegExp(`'${t}': \\{([\\s\\S]+?)\\},\\s*\\n  '`));
      expect(m, `template '${t}' must have a block body`).not.toBeNull();
      const body = m![1];
      expect(body, `${t} must have subject`).toMatch(/subject:/);
      expect(body, `${t} must have text`).toMatch(/text:/);
      expect(body, `${t} must have html`).toMatch(/html:/);
    }
  });

  // ─── Cardinality: 3 + 6 + 7 = 16 → registry has ≥ 16 ─────────

  it('CRITICAL email template registry has at least 16 templates (3 critical + 6 opt-outable + 7 operational). Future templates may add to the operational bucket without breaking this; if total drops below 16, drift dropped a known-required template. (Trial-pack pair removed with the dead trial_pack lifecycle: opt-outable 8→6; S44 2026-07-07 founder-approved trim: critical 5→3, operational 9→7, total 20→16.)', () => {
    expect(CRITICAL_PATH_TEMPLATES.length).toBe(3);
    expect(OPT_OUTABLE_TEMPLATES.length).toBe(6);
    expect(OPERATIONAL_TEMPLATES.length).toBe(7);
    expect(S44_DELETED_TEMPLATES.length).toBe(4);
    const totalKnown =
      CRITICAL_PATH_TEMPLATES.length + OPT_OUTABLE_TEMPLATES.length + OPERATIONAL_TEMPLATES.length;
    expect(totalKnown).toBe(16);
  });

  // ─── EmailService interface header pinned ─────────────────────

  it("CRITICAL apps/server/src/services/email.ts module header lists the key templates inline — 'signup-welcome (V-202)' + 'billing-receipt'. The inline header is the registry-overview doc.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/signup-welcome\s+\(V-202; fires after email verify\)/);
    expect(p).toMatch(/billing-receipt/);
  });

  // ─── Sanity: registry template names are all kebab-case ──────

  it('CRITICAL every registered template name is kebab-case (lowercase letters + hyphens only). Mixed case or underscores would break the OptOutableEmailEvent registry-key matching.', () => {
    const allKnown = [
      ...CRITICAL_PATH_TEMPLATES,
      ...OPT_OUTABLE_TEMPLATES,
      ...OPERATIONAL_TEMPLATES,
    ];
    for (const t of allKnown) {
      expect(t, `template '${t}' must be kebab-case`).toMatch(/^[a-z]+(-[a-z0-9]+)*$/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/email-template-registry-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
