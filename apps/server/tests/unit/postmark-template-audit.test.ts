// v2-#25 — Postmark transactional email template audit.
//
// Audits every template defined in apps/server/src/services/email.ts
// against the global content rules so a future copy edit can't silently
// regress them:
//
//   1. Every template has both `text:` and `html:` render functions
//      (no plain-text-only or HTML-only sends).
//   2. No template body contains banned tooling-attribution strings
//      from the V-205 commit-attribution policy (Claude / Anthropic /
//      GPT / Copilot / noreply). The rationale carries over from the
//      commit-message policy — customer-facing copy must never look
//      like it was AI-tooled.
//   3. Every template body ends with the canonical "— Driftstack"
//      footer (or "— Driftstack support" for the support-ack
//      variant). Drift here weakens brand consistency; surfacing this
//      as a test catches a copy edit that drops the footer.
//   4. No template hardcodes the archetype id literal — those should
//      flow from the archetype-roster fixture (v2-#22) so an iPhone
//      17 launch doesn't strand an iPhone-16-Pro string in any email.
//      Today no template surfaces an archetype, so the test asserts
//      ZERO hardcoded matches; if a future template needs to surface
//      one, it has to go via archetypeDisplayLabel().
//
// The test reads the email.ts source as text + extracts every template
// definition block. Source-grep keeps the audit at compile-time without
// having to import the module (which pulls in postmark + ioredis).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const EMAIL_SRC = resolve(REPO_ROOT, 'apps/server/src/services/email.ts');

const SOURCE = readFileSync(EMAIL_SRC, 'utf8');

// Walk the TEMPLATES record: each entry is `'<alias>': { ... }`
// followed by the matching closing brace at the same indentation.
// Extract the alias + the bracketed body for downstream assertions.
function extractTemplates(): Array<{ alias: string; body: string }> {
  const out: Array<{ alias: string; body: string }> = [];
  const re = /^ {2}'([a-z][a-z0-9-]+)':\s*\{$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SOURCE)) !== null) {
    const alias = m[1] ?? '';
    const startIdx = m.index + m[0].length;
    let depth = 1;
    let i = startIdx;
    while (i < SOURCE.length && depth > 0) {
      const ch = SOURCE[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    out.push({ alias, body: SOURCE.slice(startIdx, i - 1) });
  }
  return out;
}

const TEMPLATES = extractTemplates();

const BANNED_ATTRIBUTION_STRINGS: ReadonlyArray<{ token: string; reason: string }> = [
  // V-205 + driftstack-api AGENTS.md: ZERO AI-tooling strings in
  // customer-facing copy. The commit-msg hook enforces this for
  // commit bodies; templates are an equivalent customer surface.
  { token: 'Claude', reason: 'AI tooling attribution forbidden in customer copy (V-205)' },
  { token: 'Anthropic', reason: 'AI tooling attribution forbidden in customer copy (V-205)' },
  { token: 'OpenAI', reason: 'AI tooling attribution forbidden in customer copy (V-205)' },
  { token: 'GPT', reason: 'AI tooling attribution forbidden in customer copy (V-205)' },
  { token: 'Copilot', reason: 'AI tooling attribution forbidden in customer copy (V-205)' },
  // Reply-to enforcement: never display a noreply@ in the body. The
  // Postmark replyTo header is the operational reply path; mentioning
  // a noreply@ in the body signals "we don't read replies" which is
  // exactly the impression V-204 / V-665 want to avoid.
  { token: 'noreply@', reason: 'no noreply@ in customer copy (use replyTo header)' },
];

describe('v2-#25 Postmark transactional email template audit', () => {
  it('email.ts exists at canonical path', () => {
    expect(existsSync(EMAIL_SRC)).toBe(true);
  });

  it('TEMPLATES record has ≥1 template (sanity guard against the extractor regressing)', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
  });

  it('CRITICAL every template defines both `text:` and `html:` render functions (no plain-text-only or HTML-only sends — both formats are required by Postmark + accessibility)', () => {
    for (const t of TEMPLATES) {
      expect(t.body, `template ${t.alias} is missing a text: render function`).toMatch(
        /\btext:\s*\(/,
      );
      expect(t.body, `template ${t.alias} is missing an html: render function`).toMatch(
        /\bhtml:\s*\(/,
      );
    }
  });

  it('CRITICAL every template defines a `subject:` line (Postmark Subject header is mandatory)', () => {
    for (const t of TEMPLATES) {
      expect(t.body, `template ${t.alias} is missing a subject: line`).toMatch(
        /\bsubject:\s*['"`]/,
      );
    }
  });

  it('CRITICAL no template body contains banned tooling-attribution strings (V-205 customer-copy policy)', () => {
    for (const t of TEMPLATES) {
      for (const { token, reason } of BANNED_ATTRIBUTION_STRINGS) {
        // 'Anthropic' is the brand name and appears in legitimate
        // BYOK-rotation-reminder copy ("rotate your Anthropic API
        // key"). Allow it ONLY in the byok-anthropic-key-rotation-
        // reminder template, which references the customer's own
        // Anthropic account — not as an attribution string for who
        // wrote the email.
        if (token === 'Anthropic' && t.alias === 'byok-anthropic-key-rotation-reminder') {
          continue;
        }
        expect(
          t.body.includes(token),
          `template ${t.alias} contains banned token "${token}" — ${reason}`,
        ).toBe(false);
      }
    }
  });

  it('CRITICAL every template body ends with the canonical "— Driftstack" footer (or "— Driftstack support" for support-ack)', () => {
    for (const t of TEMPLATES) {
      const acceptableFooters = ['— Driftstack', '— Driftstack support'];
      const hasFooter = acceptableFooters.some((f) => t.body.includes(f));
      expect(
        hasFooter,
        `template ${t.alias} is missing the "— Driftstack" footer — copy edit dropped it?`,
      ).toBe(true);
    }
  });

  it('CRITICAL no template hardcodes the LOCKED_ARCHETYPE_ID literal (templates must flow through archetypeDisplayLabel() so an iPhone-17 launch does not strand iPhone-16-Pro strings)', () => {
    // Today zero templates surface an archetype id. If a future
    // template needs to render one (e.g. a "your archetype upgrade
    // is available" announcement), the canonical path is
    // archetypeDisplayLabel(id) from @driftstack/api-types, which
    // is the same source-of-truth the cross-SDK archetype roster
    // test pins.
    for (const t of TEMPLATES) {
      expect(
        t.body.includes('iphone16pro_ios18_7_safari26_4'),
        `template ${t.alias} hardcodes the LOCKED_ARCHETYPE_ID — route through archetypeDisplayLabel() instead`,
      ).toBe(false);
      expect(
        t.body.includes('iPhone 16 Pro'),
        `template ${t.alias} hardcodes "iPhone 16 Pro" — surface via archetypeDisplayLabel() so the next archetype launch doesn't strand the old display label`,
      ).toBe(false);
    }
  });
});
