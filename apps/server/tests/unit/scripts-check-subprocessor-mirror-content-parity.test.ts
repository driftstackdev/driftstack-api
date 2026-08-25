// W535.B — drift guard for scripts/check-subprocessor-mirror.mjs.
// V-271 sub-processor mirror linter. Drift here either breaks the
// public/DPA lockstep enforcement (would let Article 28(2) GDPR
// compliance bugs ship — adding/removing a sub-processor triggers a
// customer re-acceptance flow) or weakens the substring-based match
// rationale (would surface false-positive drift on Stripe-split or
// Hetzner/Cloudflare entity-suffix variants).
//
//   • V-271 anchor.
//   • V-264 + V-255 cross-ref (both surfaces must move in lockstep —
//     Article 28(2) GDPR notice + re-acceptance flow).
//   • 2 paths: apps/marketing-site/src/data/sub-processors.ts (public)
//     + docs/legal/dpa.md (canonical DPA Annex 3).
//   • Substring-based (not strict 1:1) match rationale.
//   • Stripe split exception (Stripe Payments Europe Ltd + Stripe Inc
//     in DPA → single "Stripe" in public list).
//   • 20-token STOPWORDS list (entity suffixes + generic product
//     nouns).
//   • Article 28(2) error message + re-run instruction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'scripts/check-subprocessor-mirror.mjs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W535.B scripts/check-subprocessor-mirror.mjs content parity', () => {
  const body = read(LIB);

  it("V-271 + V-264 + V-255 cross-anchor + Article-28(2)-GDPR framing pinned: 'V-271 — Sub-processor mirror linter.' + 'Ensures the customer-facing sub-processor list in `apps/marketing-site/src/data/sub-processors.ts` stays in sync with the canonical DPA Annex 3 entries in `docs/legal/dpa.md`.' + 'V-264 + V-255 both noted that these two surfaces must move in lockstep — adding or removing a sub-processor triggers an Article 28(2) GDPR notice + a re-acceptance flow, so silent drift between the two is a compliance bug, not just a doc-rot annoyance.' — pinned so the 3-V-anchor + 2-surface-lockstep + Article-28(2)-compliance-not-doc-rot commitment survives", () => {
    expect(body).toMatch(/\/\/ V-271 — Sub-processor mirror linter\./);
    expect(body).toMatch(
      /\/\/ Ensures the customer-facing sub-processor list in\s*\/\/ `apps\/marketing-site\/src\/data\/sub-processors\.ts` stays in sync with\s*\/\/ the canonical DPA Annex 3 entries in `docs\/legal\/dpa\.md`\./,
    );
    expect(body).toMatch(
      /\/\/ V-264 \+ V-255 both noted that these two surfaces must move in\s*\/\/ lockstep — adding or removing a sub-processor triggers an Article\s*\/\/ 28\(2\) GDPR notice \+ a re-acceptance flow, so silent drift between\s*\/\/ the two is a compliance bug, not just a doc-rot annoyance\./,
    );
  });

  it("2-path canonical-source framing pinned: 'PUBLIC_LIST_PATH: apps/marketing-site/src/data/sub-processors.ts' + 'DPA_PATH: docs/legal/dpa.md' — pinned so the 2-canonical-source pointer commitment survives (drift to either path would silently route the lint at a stale file)", () => {
    expect(body).toMatch(
      /const PUBLIC_LIST_PATH = join\(REPO_ROOT, 'apps\/marketing-site\/src\/data\/sub-processors\.ts'\);/,
    );
    expect(body).toMatch(/const DPA_PATH = join\(REPO_ROOT, 'docs\/legal\/dpa\.md'\);/);
  });

  it("Substring-based match + Stripe-split exception framing pinned: 'Drift detection (substring-based, not strict 1:1):' + 'Each entry name in `data/sub-processors.ts` must match a row in the DPA Annex 3 table (case-insensitive substring of the row's \"Sub-processor\" column).' + 'Each row in DPA Annex 3 must have a corresponding entry in `data/sub-processors.ts` (substring match in either direction).' + 'The Stripe split (Stripe Payments Europe Ltd + Stripe, Inc. in the DPA → \"Stripe\" in the public list) is the documented exception; both DPA rows resolve to the single public \"Stripe\" entry.' — pinned so the substring-not-strict + bidirectional-substring + Stripe-split-as-documented-exception commitment survives", () => {
    expect(body).toMatch(/\/\/ Drift detection \(substring-based, not strict 1:1\):/);
    expect(body).toMatch(
      /\/\/\s+- The Stripe split \(Stripe Payments Europe Ltd \+ Stripe, Inc\. in\s*\/\/\s+the DPA → "Stripe" in the public list\) is the documented\s*\/\/\s+exception; both DPA rows resolve to the single public "Stripe"\s*\/\/\s+entry\./,
    );
  });

  it('STOPWORDS list framing pinned: \'Entity-suffix + generic-product-noun stop-list. These words don\'t uniquely identify a vendor; we strip them before token comparison so "Hetzner Cloud" matches "Hetzner Online GmbH" via the shared distinctive token "hetzner".\' + 21-token list (inc / ltd / limited / gmbh / bv / b.v. / pbc / llc / corp / corporation / co / company / cloud / online / r2 / commerce / payments / europe / the / and / a / an / of) — pinned so the entity-suffix stop-list (lets Hetzner + Cloudflare + Stripe variants match via distinctive-token-only) commitment survives', () => {
    expect(body).toMatch(
      /\/\/ Entity-suffix \+ generic-product-noun stop-list\. These words don't\s*\/\/ uniquely identify a vendor; we strip them before token comparison so\s*\/\/ "Hetzner Cloud" matches "Hetzner Online GmbH" via the shared\s*\/\/ distinctive token "hetzner"\./,
    );
    expect(body).toMatch(/'inc',/);
    expect(body).toMatch(/'ltd',/);
    expect(body).toMatch(/'limited',/);
    expect(body).toMatch(/'gmbh',/);
    expect(body).toMatch(/'bv',/);
    expect(body).toMatch(/'b\.v\.',/);
    expect(body).toMatch(/'pbc',/);
    expect(body).toMatch(/'llc',/);
    expect(body).toMatch(/'corp',/);
    expect(body).toMatch(/'cloud',/);
    expect(body).toMatch(/'r2',/);
    expect(body).toMatch(/'payments',/);
    expect(body).toMatch(/'europe',/);
  });

  it("Article-28(2) error-message framing pinned: 'Sub-processor changes are an Article 28(2) GDPR amendment + force a customer re-acceptance flow. Both surfaces MUST move in lockstep. Update the missing side to match, OR (if the change is intentional) update both. After fixing, re-run: node scripts/check-subprocessor-mirror.mjs' — pinned so the customer-facing error message (informs Article-28(2)-amendment + re-acceptance-flow + lockstep-update + re-run instruction) commitment survives (drift to dropping the Article 28(2) reminder from the error message would let devs treat this as a doc-rot fix instead of a compliance amendment)", () => {
    expect(body).toMatch(
      /`\\nSub-processor changes are an Article 28\(2\) GDPR amendment \+ force a customer\\n` \+\s*`re-acceptance flow\. Both surfaces MUST move in lockstep\. Update the missing side\\n` \+\s*`to match, OR \(if the change is intentional\) update both\. After fixing, re-run:\\n\\n` \+\s*` {4}node scripts\/check-subprocessor-mirror\.mjs\\n`/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
