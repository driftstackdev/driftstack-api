// W872 — CaptureKind + wait_until cross-source invariant. One-
// hundred-ninety-eighth in the drift-guard series. Pins three
// session-driver enums:
//
//   CaptureKind (3): screenshot + dom_snapshot + pdf.
//   wait_until  (3): load + domcontentloaded + networkidle.
//   encoding    (2): base64 + utf8.
//
// stays in lockstep across:
//   - packages/api-types/src/sessions.ts (Zod canonical source).
//   - packages/sdk-go/types.go (Go SDK closed-enum consts for
//     CaptureKind).
//   - apps/docs/src/pages/* (customer-facing reference).
//
// Drift would silently break:
//   * Server driver dispatch (unrecognised capture kind).
//   * Go SDK consumers pattern-matching on CaptureKind consts.
//   * Doc examples drift from runtime behavior.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaptureKindSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const CAPTURE_KINDS = ['screenshot', 'dom_snapshot', 'pdf'] as const;
const WAIT_UNTIL_VALUES = ['load', 'domcontentloaded', 'networkidle'] as const;
const ENCODING_VALUES = ['base64', 'utf8'] as const;

describe('W872 CaptureKind cross-source invariant', () => {
  // ─── api-types canonical: CaptureKindSchema ──────────────────

  it("CRITICAL packages/api-types/src/sessions.ts CaptureKindSchema = z.enum(['screenshot', 'dom_snapshot', 'pdf']). The 3-value closed-roster is the contract every capture-flow driver dispatch pivots on.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /export const CaptureKindSchema = z\.enum\(\['screenshot', 'dom_snapshot', 'pdf'\]\);/,
    );
  });

  it('CRITICAL CaptureKind type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export type CaptureKind = z\.infer<typeof CaptureKindSchema>;/);
  });

  // ─── CaptureRequest + CaptureResponse use the enum ───────────

  it("CRITICAL CaptureRequestSchema + CaptureResponseSchema reference CaptureKindSchema for kind field. CaptureResponse also includes encoding: z.enum(['base64', 'utf8']) (binary captures use base64; DOM snapshots use utf8).", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/CaptureRequestSchema = z\.object\(\{[\s\S]+?kind: CaptureKindSchema/);
    expect(p).toMatch(/CaptureResponseSchema = z\.object\(\{[\s\S]+?kind: CaptureKindSchema/);
    expect(p).toMatch(/encoding: z\.enum\(\['base64', 'utf8'\]\)/);
  });

  // ─── Go SDK closed-enum consts ───────────────────────────────

  it("CRITICAL packages/sdk-go/types.go declares 3 CaptureKind consts — CaptureScreenshot + CaptureDOMSnapshot + CapturePDF. The 'enumerates the supported capture outputs' framing pins the closed-roster intent.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type CaptureKind string/);
    expect(p).toMatch(/CaptureScreenshot\s+CaptureKind = "screenshot"/);
    expect(p).toMatch(/CaptureDOMSnapshot CaptureKind = "dom_snapshot"/);
    expect(p).toMatch(/CapturePDF\s+CaptureKind = "pdf"/);
    expect(p).toMatch(/CaptureKind enumerates the supported capture outputs/);
  });

  // ─── TS SDK re-exports CaptureKind ───────────────────────────

  it('CRITICAL packages/sdk-typescript/src/index.ts re-exports CaptureKind from api-types. The re-export makes the type available without forcing customers to deep-import.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts'));
    expect(p).toMatch(/CaptureKind,/);
  });

  // ─── wait_until 3-value enum on Navigate ─────────────────────

  it("CRITICAL packages/api-types/src/sessions.ts NavigateRequestSchema wait_until field = z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'). The 3-value Playwright-style 'wait_until' is the contract for server-side WebKit navigation.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /wait_until: z\.enum\(\['load', 'domcontentloaded', 'networkidle'\]\)\.default\('load'\)/,
    );
  });

  // ─── Customer-facing docs reference the enums ────────────────

  it("CRITICAL apps/docs/src/pages/guides/session-lifecycle.md references 'wait_until: networkidle' + comment listing the other 2 values + 'best for SPAs' framing. The doc renders the 3-value contract for customers reading the guide.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/docs/src/pages/guides/session-lifecycle.md'));
    expect(p).toMatch(/wait_until: 'networkidle'/);
    expect(p).toMatch(/'load' \(default\), 'domcontentloaded'/);
    expect(p).toMatch(/best for SPAs/);
  });

  it("CRITICAL apps/docs/src/pages/quickstart.md uses kind: 'screenshot' in the capture example. Drift to a different value would silently let the customer hit the API with a value the schema rejects.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart.md'));
    expect(p).toMatch(/kind: 'screenshot'/);
  });

  // ─── 3+3+2 cardinality ───────────────────────────────────────

  it('CRITICAL CaptureKind = EXACTLY 3 values + wait_until = EXACTLY 3 values + encoding = EXACTLY 2 values. The 3/3/2 cardinality is what server driver-dispatch + client capture-response decode logic depend on.', () => {
    expect(CAPTURE_KINDS.length).toBe(3);
    expect(WAIT_UNTIL_VALUES.length).toBe(3);
    expect(ENCODING_VALUES.length).toBe(2);
  });

  // ─── No forbidden / Playwright-like values we don't support ──

  it("CRITICAL no source declares forbidden capture-kind names (jpeg / png / mhtml / video / har). These are common capture types the 3-value model intentionally excludes — Driftstack's WebKit driver only exposes screenshot + DOM snapshot + PDF.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    const m = p.match(/CaptureKindSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    const forbidden = ['jpeg', 'png', 'mhtml', 'video', 'har', 'mp4', 'webp'];
    for (const f of forbidden) {
      expect(body, `CaptureKind must NOT include forbidden '${f}'`).not.toMatch(
        new RegExp(`'${f}'`),
      );
    }
  });

  it('CRITICAL no source declares forbidden wait_until values (commit / firstcontentfulpaint / lcp). These are common signals the 3-value model intentionally excludes — Driftstack stays on the well-tested Playwright trio.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    const m = p.match(/wait_until: z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    const forbidden = ['commit', 'firstcontentfulpaint', 'lcp', 'idle', 'interactive'];
    for (const f of forbidden) {
      expect(body, `wait_until must NOT include forbidden '${f}'`).not.toMatch(
        new RegExp(`'${f}'`),
      );
    }
  });

  // ─── encoding matches capture-kind semantics ─────────────────

  it('CRITICAL encoding enum has EXACTLY 2 values (base64 + utf8). The 2-value model maps to binary (base64) vs text (utf8) capture outputs — binary kinds (screenshot/pdf) use base64; dom_snapshot uses utf8.', () => {
    expect(ENCODING_VALUES).toEqual(['base64', 'utf8']);
  });

  it('W602 doc coverage: every CaptureKind is documented in the customer api/sessions.md — source-derived from CaptureKindSchema.options so a future 4th kind can ship SDK-documented yet doc-stale no longer (the W564/W565/W600 doc-drift class)', () => {
    const doc = read(resolve(REPO_ROOT, 'apps/docs/src/pages/api/sessions.md'));
    for (const kind of CaptureKindSchema.options) {
      // doc quotes/backticks each kind, e.g. `'screenshot'`; bound on either
      // side so `pdf` can't false-match an unrelated substring.
      expect(doc, `sessions.md must document capture kind '${kind}'`).toMatch(
        new RegExp("[`']" + kind + "[`']"),
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/capture-kind-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
