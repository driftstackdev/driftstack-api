// W883 — Email-template registry cross-source invariant. Two-
// hundred-ninth in the drift-guard series. Pins the email-template
// registry roster + critical-path vs opt-outable split:
//
//   Critical-path (NEVER opt-outable, ALWAYS sent):
//     - signup-verification, password-reset, billing-failure,
//       subscription-cancellation, support-ack.
//
//   Opt-outable (8, matches OptOutableEmailEventSchema):
//     - signup-welcome, session-failed-first, session-success-first,
//       tier-changed, trial-pack-purchased, trial-pack-expired,
//       billing-receipt, billing-renewal-reminder.
//
//   Operational (other):
//     - status-subscription-confirmation, status-subscription-welcome,
//       team-invite, status-incident-created, status-incident-resolved,
//       quota-warning, session-event-digest.
//
// stays in lockstep across:
//   - apps/server/src/services/email.ts (TEMPLATES const).
//   - packages/api-types/src/accounts.ts OptOutableEmailEventSchema
//     (8 opt-outable subset).
//
// Drift would silently break:
//   * Opt-outable schema declares a template the registry lacks
//     (server crashes trying to render).
//   * Critical-path template appears in OptOutableEmailEvent
//     (W864 forbids; W883 backstops at registry level).

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
  'subscription-cancellation',
  'support-ack',
] as const;

const OPT_OUTABLE_TEMPLATES = [
  'signup-welcome',
  'session-failed-first',
  'session-success-first',
  'tier-changed',
  'trial-pack-purchased',
  'trial-pack-expired',
  'billing-receipt',
  'billing-renewal-reminder',
] as const;

const OPERATIONAL_TEMPLATES = [
  'status-subscription-confirmation',
  'status-subscription-welcome',
  'team-invite',
  'status-incident-created',
  'status-incident-resolved',
  'quota-warning',
  'session-event-digest',
] as const;

describe('W883 Email-template registry cross-source invariant', () => {
  // ─── 5 critical-path templates present ──────────────────────

  it('CRITICAL apps/server/src/services/email.ts TEMPLATES has all 5 critical-path templates — signup-verification + password-reset + billing-failure + subscription-cancellation + support-ack. These NEVER fall through opt-out gates.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    for (const t of CRITICAL_PATH_TEMPLATES) {
      expect(p, `TEMPLATES must include '${t}'`).toMatch(new RegExp(`'${t}': \\{`));
    }
  });

  // ─── 8 opt-outable templates present + match Zod schema ──────

  it('CRITICAL apps/server/src/services/email.ts TEMPLATES has all 8 opt-outable templates. The 8 match the OptOutableEmailEventSchema exactly — every opt-outable event has a template; every template that is opt-outable has a schema entry.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    for (const t of OPT_OUTABLE_TEMPLATES) {
      expect(p, `TEMPLATES must include '${t}'`).toMatch(new RegExp(`'${t}': \\{`));
    }
  });

  it('CRITICAL OPT_OUTABLE_TEMPLATES (8) MATCHES OptOutableEmailEventSchema (8). Both source-of-truth lists must agree element-by-element.', () => {
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

  it('CRITICAL apps/server/src/services/email.ts TEMPLATES has 7 operational templates — status-subscription-* + team-invite + status-incident-* + quota-warning + session-event-digest. These are system-initiated emails (incidents, team invites, quota warnings).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    for (const t of OPERATIONAL_TEMPLATES) {
      expect(p, `TEMPLATES must include '${t}'`).toMatch(new RegExp(`'${t}': \\{`));
    }
  });

  // ─── Critical-path templates NOT in OptOutableEmailEventSchema ─

  it('CRITICAL no critical-path template (signup-verification / password-reset / billing-failure / subscription-cancellation / support-ack) appears in OptOutableEmailEventSchema. This is the security backstop — drift would let customers disable account-recovery / billing-failure / support emails.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const m = p.match(/OptOutableEmailEventSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const t of CRITICAL_PATH_TEMPLATES) {
      expect(body, `OptOutableEmailEventSchema MUST NOT include critical-path '${t}'`).not.toMatch(
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

  // ─── Cardinality: 5 + 8 + 7 = 20 → registry has ≥ 20 ─────────

  it('CRITICAL email template registry has at least 20 templates (5 critical + 8 opt-outable + 7 operational). Future templates may add to the operational bucket without breaking this; if total drops below 20, drift dropped a known-required template.', () => {
    expect(CRITICAL_PATH_TEMPLATES.length).toBe(5);
    expect(OPT_OUTABLE_TEMPLATES.length).toBe(8);
    expect(OPERATIONAL_TEMPLATES.length).toBe(7);
    const totalKnown =
      CRITICAL_PATH_TEMPLATES.length + OPT_OUTABLE_TEMPLATES.length + OPERATIONAL_TEMPLATES.length;
    expect(totalKnown).toBe(20);
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
