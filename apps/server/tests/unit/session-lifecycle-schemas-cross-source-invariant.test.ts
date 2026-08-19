// W895 — Session lifecycle schemas cross-source invariant. Two-
// hundred-twenty-first in the drift-guard series (100th wave of
// the W796-W895 session). Pins the Session lifecycle:
//
//   ArchetypeSchema: regex /^[a-z0-9_]+$/ + 3-60 chars.
//   Session (12 fields): id + account_id + api_key_id + status +
//     archetype + purpose + label + metadata + created_at +
//     updated_at + last_state_at + destroyed_at.
//   CreateSessionRequest (6 optional fields).
//   CreateSessionResponse = SessionSchema (immediate-state).
//   NavigateRequest: url + timeout_ms (1s-2min) + wait_until.
//   NavigateResponse: url + HTTP status 100-599 + final_url +
//     duration_ms.
//
// stays in lockstep across api-types Zod canonical.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W895 Session lifecycle schemas cross-source invariant', () => {
  // ─── ArchetypeSchema ─────────────────────────────────────────

  it("CRITICAL packages/api-types/src/sessions.ts ArchetypeSchema = z.string().regex(/^[a-z0-9_]+$/, ...).min(3).max(60). The 3-60 char + lowercase-alphanumeric-underscore regex enforces archetype-slug shape (e.g. 'iphone16pro_ios18_7_safari26_4').", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /export const ArchetypeSchema = z\s*\n?\s*\.string\(\)\s*\n\s*\.regex\(\/\^\[a-z0-9_\]\+\$\/, \{ message: 'archetype slug is lowercase alphanumeric \+ underscores' \}\)\s*\n\s*\.min\(3\)\s*\n\s*\.max\(60\)/,
    );
  });

  // ─── Session 12-field shape ──────────────────────────────────

  it('CRITICAL SessionSchema has 14 fields, and this arm pins 12 of them — id + account_id + api_key_id + status + archetype + purpose + label + metadata + created_at + updated_at + last_state_at + destroyed_at. The two it does not pin are egress_capabilities and egress_capability_report, added after this arm was written. The shape is the full session-lifecycle audit-style read.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    const m = p.match(/SessionSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of [
      'id:',
      'account_id:',
      'api_key_id:',
      'status:',
      'archetype:',
      'purpose:',
      'label:',
      'metadata:',
      'created_at:',
      'updated_at:',
      'last_state_at:',
      'destroyed_at:',
    ]) {
      expect(body, `SessionSchema must have ${f}`).toMatch(new RegExp(f));
    }
  });

  it('CRITICAL Session.label + metadata + last_state_at + destroyed_at are nullable. label/metadata are optional decoration; last_state_at is null until first state capture; destroyed_at is null until destroyed.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/label: z\.string\(\)\.nullable\(\)/);
    // Bounded-blob fix — metadata is the size-capped SessionMetadataSchema.
    expect(p).toMatch(/metadata: SessionMetadataSchema\.nullable\(\)/);
    expect(p).toMatch(/last_state_at: Iso8601Schema\.nullable\(\)/);
    expect(p).toMatch(/destroyed_at: Iso8601Schema\.nullable\(\)/);
  });

  // ─── CreateSessionRequest 6 optional fields ──────────────────

  it('CRITICAL CreateSessionRequestSchema has 6 fields, ALL optional — selectable archetype + purpose + label + metadata + profile_id + behavioral_profile.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /CreateSessionRequestSchema = z\.object\(\{\s*\n\s*archetype: SelectableArchetypeIdSchema\.optional\(\)/,
    );
    expect(p).toMatch(/purpose: SessionPurposeSchema\.optional\(\)/);
    // 41f065b41 centralized the launch/create label bound so those two request
    // shapes cannot drift while still preserving optional create semantics.
    expect(p).toMatch(/SessionLabelSchema = z\.string\(\)\.max\(120\)/);
    expect(p).toMatch(/label: SessionLabelSchema\.optional\(\)/);
    // Bounded-blob fix — metadata is the size-capped SessionMetadataSchema.
    expect(p).toMatch(/metadata: SessionMetadataSchema\.optional\(\)/);
    expect(p).toMatch(/profile_id: z\.string\(\)\.optional\(\)/);
    expect(p).toMatch(/behavioral_profile: BehavioralProfileSchema\.optional\(\)/);
  });

  // ─── CreateSessionResponse = SessionSchema ───────────────────

  it("CRITICAL CreateSessionResponseSchema = SessionSchema (alias). The mutation endpoint returns the full Session shape so the SDK customer doesn't need an extra GET to inspect the new session.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export const CreateSessionResponseSchema = SessionSchema;/);
  });

  // ─── NavigateRequest ─────────────────────────────────────────

  it("CRITICAL NavigateRequestSchema 3 fields — url + timeout_ms (1s-2min) + wait_until (3-value enum, default 'load'). The timeout_ms bounds prevent both too-short false-negatives + too-long DoS.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    // W487 — url is http/https-only (z.string().url().refine(/^https?:/)).
    expect(p).toMatch(
      /NavigateRequestSchema = z\.object\(\{[\s\S]*?url: z[\s\S]*?\.string\(\)[\s\S]*?\.url\(\)/,
    );
    expect(p).toMatch(/\.refine\(\(u\) => \/\^https\?:\\\/\\\/\/i\.test\(u\)/);
    expect(p).toMatch(
      /timeout_ms: z\.number\(\)\.int\(\)\.min\(1000\)\.max\(120_000\)\.optional\(\)/,
    );
  });

  // ─── NavigateResponse status 100-599 ─────────────────────────

  it('CRITICAL NavigateResponseSchema 4 fields — url + status (HTTP 100-599) + final_url (post-redirect) + duration_ms. The 100-599 range matches HTTP-status valid range; final_url captures redirect destination so customers can detect redirect-chains.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /NavigateResponseSchema = z\.object\(\{\s*\n\s*url: z\.string\(\)\.url\(\),\s*\n\s*status: z\.number\(\)\.int\(\)\.min\(100\)\.max\(599\),/,
    );
    expect(p).toMatch(/final_url: z\.string\(\)\.url\(\)/);
    expect(p).toMatch(/duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\)/);
  });

  // ─── V-169 purpose default doc ───────────────────────────────

  it("CRITICAL Session.purpose comment pins V-169 anchor + 'defaults to production_customer' framing. The default-purpose contract matches the server-side purpose-when-omitted behavior.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/V-169 — harness purpose; defaults to `production_customer`/);
  });

  // ─── NavigateRequestInput export ─────────────────────────────

  it('CRITICAL NavigateRequestInput type uses z.input (NOT z.infer) — captures the CALLER shape where defaulted fields are optional. The z.input/z.infer distinction is what lets caller code skip defaulted fields.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export type NavigateRequestInput = z\.input<typeof NavigateRequestSchema>;/);
  });

  // ─── 14-field cardinality (Arc 5 EGRESS eg.1.c added egress_capability_report)

  it('CRITICAL Session = EXACTLY 14 fields. Migration 0045 added egress_capabilities (cross-agent contract 7d5992d9); migration 0054 + eg.1.c added egress_capability_report (raw harness payload). Drift to adding/removing without coordinated SDK + dashboard updates would break the session-lifecycle audit-style read contract.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    const m = p.match(/SessionSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1] ?? '';
    const fieldCount = (body.match(/^\s*[a-z_]+:/gm) || []).length;
    expect(fieldCount).toBe(14);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/session-lifecycle-schemas-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
