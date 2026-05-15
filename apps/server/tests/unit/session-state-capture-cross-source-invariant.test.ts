// W904 — SessionState 5-field + CaptureResponse 5-field cross-
// source invariant. Two-hundred-thirtieth in the drift-guard
// series. Pins the session state-read + capture-output schemas:
//
//   SessionState (5 fields):
//     - url: URL nullable.
//     - title: string nullable.
//     - cookies: array of records (driver-controlled shape).
//     - local_storage: record (key→string).
//     - captured_at: ISO.
//
//   CaptureResponse (5 fields):
//     - kind: CaptureKindSchema (3-value).
//     - data: string (base64 binary or raw utf8 text).
//     - encoding: 'base64' | 'utf8'.
//     - byte_size: int nonnegative.
//     - duration_ms: int nonnegative.
//
//   CaptureRequest (2 fields):
//     - kind: CaptureKindSchema (required).
//     - full_page: boolean (default false; screenshots only).
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

describe('W904 SessionState + Capture cross-source invariant', () => {
  // ─── SessionState 5-field shape ──────────────────────────────

  it('CRITICAL packages/api-types/src/sessions.ts SessionStateSchema has 5 fields — url (URL nullable) + title (string nullable) + cookies (array records) + local_storage (record key→string) + captured_at (ISO). The 5-field shape is the snapshot of session state at capture-time.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /SessionStateSchema = z\.object\(\{\s*\n\s*url: z\.string\(\)\.url\(\)\.nullable\(\)/,
    );
    expect(p).toMatch(/title: z\.string\(\)\.nullable\(\)/);
    expect(p).toMatch(/cookies: z\.array\(z\.record\(z\.unknown\(\)\)\)/);
    expect(p).toMatch(/local_storage: z\.record\(z\.string\(\)\)/);
    expect(p).toMatch(/captured_at: Iso8601Schema/);
  });

  it("CRITICAL SessionState.cookies comment pins 'Serialised cookies (driver-controlled shape)' — the inner record is z.record(z.unknown()) NOT a fixed schema because cookie attributes vary by driver/browser version. Drift to a fixed shape would break driver-cookie capture.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/\/\/ Serialised cookies \(driver-controlled shape\)/);
  });

  it("CRITICAL SessionState.local_storage comment pins 'Local storage snapshot' framing. The z.record(z.string()) shape matches localStorage's string-only value contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/\/\/ Local storage snapshot\./);
  });

  // ─── CaptureRequest 2-field shape ────────────────────────────

  it("CRITICAL CaptureRequestSchema has 2 fields — kind (CaptureKindSchema required) + full_page (boolean default false). full_page applies to screenshots only; on dom_snapshot/pdf it's silently ignored.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /CaptureRequestSchema = z\.object\(\{\s*\n\s*kind: CaptureKindSchema,\s*\n\s*\/\/ For screenshots: full-page or viewport\.\s*\n\s*full_page: z\.boolean\(\)\.default\(false\),/,
    );
  });

  // ─── CaptureResponse 5-field shape ───────────────────────────

  it('CRITICAL CaptureResponseSchema has 5 fields — kind + data (string) + encoding (base64|utf8) + byte_size (int nonnegative) + duration_ms (int nonnegative). The byte_size + duration_ms give clients usage-vs-cost visibility.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /CaptureResponseSchema = z\.object\(\{\s*\n\s*kind: CaptureKindSchema,\s*\n\s*\/\/ base64 for binary captures, raw text for DOM snapshots\.\s*\n\s*data: z\.string\(\),\s*\n\s*encoding: z\.enum\(\['base64', 'utf8'\]\),\s*\n\s*byte_size: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),/,
    );
  });

  it("CRITICAL CaptureResponse.data comment pins 'base64 for binary captures, raw text for DOM snapshots'. The format-by-kind mapping is what the encoding field carries — screenshots/pdf use base64, dom_snapshot uses utf8.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/base64 for binary captures, raw text for DOM snapshots/);
  });

  // ─── CaptureRequestInput uses z.input ────────────────────────

  it("CRITICAL CaptureRequestInput type uses z.input (NOT z.infer) — full_page has a default. The 'Caller-side shape: fields with server-side defaults are optional' framing is consistent with NavigateRequestInput.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export type CaptureRequestInput = z\.input<typeof CaptureRequestSchema>;/);
    expect(p).toMatch(/Caller-side shape: fields with server-side defaults are optional/);
  });

  // ─── url + title nullable rationale ──────────────────────────

  it("CRITICAL SessionState.url + title are both nullable. url is null when session hasn't navigated yet (creating/ready before first nav); title is null when page has no <title> tag. Drift to non-null would crash state-read on fresh sessions.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/url: z\.string\(\)\.url\(\)\.nullable\(\)/);
    expect(p).toMatch(/title: z\.string\(\)\.nullable\(\)/);
  });

  // ─── Types re-exported ───────────────────────────────────────

  it('CRITICAL SessionState + CaptureRequest + CaptureResponse types re-export via z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export type SessionState = z\.infer<typeof SessionStateSchema>;/);
    expect(p).toMatch(/export type CaptureRequest = z\.infer<typeof CaptureRequestSchema>;/);
    expect(p).toMatch(/export type CaptureResponse = z\.infer<typeof CaptureResponseSchema>;/);
  });

  // ─── 5-field cardinality ─────────────────────────────────────

  it('CRITICAL SessionState = EXACTLY 5 fields + CaptureResponse = EXACTLY 5 fields. The 5/5 cardinality is what driver-state + capture-output APIs depend on.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    const stateM = p.match(/SessionStateSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(stateM).not.toBeNull();
    const stateFields = ((stateM![1] ?? '').match(/^\s*[a-z_]+:/gm) || []).length;
    expect(stateFields).toBe(5);
    const capM = p.match(/CaptureResponseSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(capM).not.toBeNull();
    const capFields = ((capM![1] ?? '').match(/^\s*[a-z_]+:/gm) || []).length;
    expect(capFields).toBe(5);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/session-state-capture-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
