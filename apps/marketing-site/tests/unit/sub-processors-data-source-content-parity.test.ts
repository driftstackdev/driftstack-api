// W385.A — drift guard for marketing-site src/data/sub-processors.ts
// CANONICAL data source. Existing sub-processors-dpa-parity covers
// dpa.md row-derivation against this file; existing trust-sub-
// processors-page-binding covers the rendered table. This guard
// pins the source itself — DPA Annex 3 mirror + Article 28(2)
// posture + V-478 change-log schema.
//
//   • 12 SUB_PROCESSORS in canonical order: Hetzner Cloud / Neon /
//     Upstash / Cloudflare R2 / Postmark / Sentry / Stripe /
//     Anthropic / Moneybird / MacStadium / NowPayments / LiveKit.
//   • Each entry: 4 fields (name / region / purpose / transfer
//     mechanism).
//   • Article 28(2) 30-day notice posture pinned in module comment.
//   • SUB_PROCESSOR_REGISTER_LAST_UPDATED = '2026-05-10'.
//   • SubProcessorChangeLogEntry: 4 kinds (added / removed /
//     material_change / register_published).
//   • SUB_PROCESSOR_CHANGELOG: 1 initial register_published entry
//     pinned (2026-05-10 baseline).
//   • V-478 framing pinned.
//   • Anthropic opt-in framing + NowPayments opt-in framing +
//     LiveKit opt-in framing pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DATA = resolve(REPO_ROOT, 'apps/marketing-site/src/data/sub-processors.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W385.A marketing-site src/data/sub-processors.ts content parity', () => {
  const body = read(DATA);

  it('DPA Annex 3 mirror framing + V-052 revision pinned', () => {
    expect(body).toMatch(/Sub-processor register — public surface for \/trust\/sub-processors/);
    expect(body).toMatch(/Mirrors the DPA Annex 3 entries from `docs\/legal\/dpa\.md`/);
    expect(body).toMatch(/locked sub-processor list \(V-052 revision\)/);
  });

  it('Article 28(2) 30-day notice posture pinned in module comment', () => {
    expect(body).toMatch(
      /Changes to this list trigger Art 28\(2\) sub-processor amendment\s*\n?\s*\/\/\s*notice \(30-day notice to customers\) per the DPA/,
    );
    expect(body).toMatch(
      /Adding or removing\s*\n?\s*\/\/\s*an entry is a content change with compliance implications/,
    );
  });

  it('SubProcessor interface: 4 fields (name / region / purpose / transferMechanism)', () => {
    expect(body).toMatch(/export interface SubProcessor \{/);
    expect(body).toMatch(
      /\/\*\* Legal-entity name as it appears in the DPA Annex 3\. \*\/\s*\n?\s*name: string;/,
    );
    expect(body).toMatch(/region: string;/);
    expect(body).toMatch(/purpose: string;/);
    expect(body).toMatch(/transferMechanism: string;/);
  });

  it('12 SUB_PROCESSORS pinned in canonical order', () => {
    const block = body.match(/export const SUB_PROCESSORS: SubProcessor\[\] = \[([\s\S]+?)\];/);
    expect(block).not.toBeNull();
    const names = Array.from(block![1]!.matchAll(/name: '([^']+)',/g)).map((m) => m[1]);
    expect(names).toEqual([
      'Hetzner Cloud',
      'Neon',
      'Upstash',
      'Cloudflare R2',
      'Postmark',
      'Sentry',
      'Stripe',
      'Anthropic',
      'Moneybird',
      'MacStadium',
      'NowPayments',
      'LiveKit',
    ]);
  });

  it('EU-resident rows pinned: Hetzner Falkenstein / Neon Frankfurt / Upstash Frankfurt / Moneybird NL', () => {
    expect(body).toMatch(/region: 'Falkenstein, Germany \(EU\)',/);
    const frankfurt = body.match(/region: 'Frankfurt \(EU\)',/g);
    expect(frankfurt).not.toBeNull();
    expect(frankfurt!.length).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/region: 'Netherlands \(EU\)',/);
  });

  it('SCC + EU-US DPF transfer rows pinned (Postmark / Stripe / Anthropic / MacStadium / LiveKit)', () => {
    const sccMatches = body.match(
      /transferMechanism: '2021 Standard Contractual Clauses \+ EU-US Data Privacy Framework\.'/g,
    );
    expect(sccMatches).not.toBeNull();
    expect(sccMatches!.length).toBeGreaterThanOrEqual(5);
  });

  it('Anthropic two-mode framing pinned (BYOK proxy + Bundled-LLM opt-in rail)', () => {
    // The Anthropic entry now distinguishes two engagement modes
    // (BYOK proxy + Bundled-LLM rail) per the 2026-05-17 Q4=A
    // verdict (BYOK-always-wins over bundled-LLM). Pin both the
    // BYOK transient-proxy framing AND the bundled-LLM opt-in
    // framing so future drift can't quietly drop either mode's
    // disclosure.
    expect(body).toMatch(/BYOK proxy — when the customer has supplied their own Anthropic API key/);
    expect(body).toMatch(/Bundled-LLM rail — opt-in only/);
    expect(body).toMatch(
      /Session data flows to Anthropic only when one of these two modes is engaged/,
    );
  });

  it('NowPayments opt-in framing + Estonia (EEA-internal) transfer mechanism', () => {
    expect(body).toMatch(/NowPayments OÜ \(Estonia, EU\)/);
    expect(body).toMatch(
      /Cryptocurrency payment processing \(BTC, LTC, USDT, USDC, ETH, XMR\)\. Engaged only when a customer opts to pay with cryptocurrency at checkout; bypassed entirely for Stripe-paying customers/,
    );
    expect(body).toMatch(/EEA-internal — no transfer mechanism required\./);
  });

  it('LiveKit opt-in framing pinned (WebRTC live-session, disabled by default)', () => {
    expect(body).toMatch(
      /WebRTC live-session signaling and media SFU for the optional "live session" feature/,
    );
    expect(body).toMatch(/Disabled by default; engaged only when explicitly initiated\./);
  });

  it('Stripe row: BYOK metered billing + BTW reverse-charge via Stripe Tax', () => {
    expect(body).toMatch(
      /Payment processing, subscription management, BYOK metered billing, BTW reverse-charge handling via Stripe Tax/,
    );
    expect(body).toMatch(/Stripe Payments Europe Ltd \(Ireland\)/);
  });

  it('Cloudflare R2 row: 3 use cases (recordings/screenshots / status-page snapshots / profile avatars)', () => {
    expect(body).toMatch(
      /Object storage for session recordings and screenshots, public status-page snapshots, and customer-uploaded profile avatars/,
    );
  });

  it('Sentry row: EU ingest region (ingest.de.sentry.io)', () => {
    expect(body).toMatch(/EU region \(ingest\.de\.sentry\.io\)/);
    expect(body).toMatch(/EU ingest region — no transfer required for error data\./);
  });

  it('SUB_PROCESSOR_REGISTER_LAST_UPDATED = "2026-05-10"', () => {
    expect(body).toMatch(/export const SUB_PROCESSOR_REGISTER_LAST_UPDATED = '2026-05-10';/);
  });

  it('V-478 change-log surface framing pinned', () => {
    expect(body).toMatch(/V-478 — sub-processor change-log surface/);
    expect(body).toMatch(
      /Every material change to the SUB_PROCESSORS register lands here as\s+\*\s*an immutable entry/,
    );
  });

  it('SubProcessorChangeLogEntry: 4 kinds (added / removed / material_change / register_published) with semantics pinned', () => {
    expect(body).toMatch(
      /kind: 'added' \| 'removed' \| 'material_change' \| 'register_published';/,
    );
    expect(body).toMatch(/`added`: a new sub-processor entered the register/);
    expect(body).toMatch(
      /`removed`: an entry was withdrawn; the customer-facing change is\s+\*\s*only effective AFTER the notice window closes/,
    );
    expect(body).toMatch(
      /`material_change`: an existing entry's region \/ purpose \/ transfer\s+\*\s*mechanism changed/,
    );
    expect(body).toMatch(/`register_published`: pre-launch baseline marker/);
  });

  it('"Cosmetic edits (rewording, typo fixes) do NOT land here" honesty pinned', () => {
    expect(body).toMatch(/Cosmetic edits\s+\*\s*\(rewording, typo fixes\) do NOT land here/);
  });

  it('SUB_PROCESSOR_CHANGELOG: 1 initial register_published entry (2026-05-10 baseline)', () => {
    expect(body).toMatch(
      /export const SUB_PROCESSOR_CHANGELOG: SubProcessorChangeLogEntry\[\] = \[/,
    );
    expect(body).toMatch(/date: '2026-05-10',\s*\n?\s*kind: 'register_published',/);
    expect(body).toMatch(
      /Initial sub-processor register published as part of pre-launch ' \+\s*\n?\s*'transparency/,
    );
    expect(body).toMatch(/effective_at: '2026-05-10',/);
  });

  it('changelog effective_at field on schema (post-notice-window date semantics)', () => {
    expect(body).toMatch(
      /\/\*\* Date the change took effect \(post-notice-window if applicable\)\. \*\/\s*\n?\s*effective_at: string;/,
    );
  });

  it('data file exists at canonical path + dpa.md cross-reference exists', () => {
    expect(existsSync(DATA)).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/dpa.md'))).toBe(true);
  });
});
