// W384.B — drift guard for gui-client badge label/tone/class maps.
// Existing V-534.M / V-534.N / V-534.U tests render-check a handful
// of labels and tones. This guard pins the FULL mapping content
// (every key in every map) so that an accidental addition or
// removal of a tier / status / tone is caught at the source. The
// maps are the single source of truth — surfaces across the app
// (FleetView / LiveSessionView / SettingsAccountCard / BillingCost
// View etc.) render via these helpers.
//
//   • TierBadge: 9 AccountTier keys (free / trial_pack / 4 manual
//     tiers / 3 api tiers / enterprise) with full TIER_LABEL +
//     TIER_TONE maps. 4 Tone classes (neutral/trial/paid/
//     enterprise). 2 size variants (sm/md).
//   • SessionStatusBadge: 5 SessionStatus keys (creating / ready /
//     busy / destroyed / errored) with full STATUS_LABEL +
//     STATUS_TONE maps. 5 Tone classes.
//   • CryptoOrderStatusBadge: 5 CryptoOrderStatus keys (pending /
//     confirming / paid / failed / partial) with full STATUS_LABEL
//     + STATUS_TONE maps + isTerminalCryptoOrderStatus helper.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const TIER = resolve(REPO_ROOT, 'apps/gui-client/src/components/TierBadge.tsx');
const SESSION = resolve(REPO_ROOT, 'apps/gui-client/src/components/SessionStatusBadge.tsx');
const CRYPTO = resolve(REPO_ROOT, 'apps/gui-client/src/components/CryptoOrderStatusBadge.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W384.B gui-client TierBadge content parity', () => {
  const body = read(TIER);

  it('V-534.M framing pinned + AccountTier union: 8 literals (trial_pack removed 2026-05-27)', () => {
    expect(body).toMatch(/V-534\.M — TierBadge presentational component/);
    expect(body).toMatch(/export type AccountTier =/);
    for (const id of [
      'free',
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(body, `tier literal missing in AccountTier: ${id}`).toMatch(new RegExp(`'${id}'`));
    }
    expect(body).not.toMatch(/'trial_pack'/);
  });

  it('TIER_LABEL: 8 keys with canonical human labels (trial_pack removed 2026-05-27)', () => {
    expect(body).toMatch(/free: 'Free',/);
    expect(body).toMatch(/solo_manual: 'Personal',/);
    expect(body).toMatch(/team_manual: 'Team',/);
    expect(body).toMatch(/agency_manual: 'Agency',/);
    expect(body).toMatch(/api_starter: 'API Starter',/);
    expect(body).toMatch(/api_builder: 'API Builder',/);
    expect(body).toMatch(/api_scale: 'API Scale',/);
    expect(body).toMatch(/enterprise: 'Enterprise',/);
    expect(body).not.toMatch(/Trial Pack/);
  });

  it('Tone union: 3 literals (neutral/paid/enterprise) — trial tone removed 2026-05-27', () => {
    expect(body).toMatch(/type Tone = 'neutral' \| 'paid' \| 'enterprise';/);
  });

  it('TIER_TONE map: free=neutral / 6 paid / enterprise=enterprise (trial_pack removed 2026-05-27)', () => {
    expect(body).toMatch(/free: 'neutral',/);
    expect(body).toMatch(/solo_manual: 'paid',/);
    expect(body).toMatch(/team_manual: 'paid',/);
    expect(body).toMatch(/agency_manual: 'paid',/);
    expect(body).toMatch(/api_starter: 'paid',/);
    expect(body).toMatch(/api_builder: 'paid',/);
    expect(body).toMatch(/api_scale: 'paid',/);
    expect(body).toMatch(/enterprise: 'enterprise',/);
    expect(body).not.toMatch(/'trial'/);
  });

  it('TONE_CLASSES: 3 tone → tailwind class mappings (neutral/paid/enterprise) — trial removed 2026-05-27', () => {
    expect(body).toMatch(/neutral: 'bg-surface-inset text-ink-secondary border-surface-divider',/);
    expect(body).not.toMatch(/trial: 'bg-status-info/);
    expect(body).toMatch(
      /paid: 'bg-status-success\/15 text-status-success border-status-success\/30',/,
    );
    expect(body).toMatch(/enterprise: 'bg-accent\/15 text-accent border-accent\/30',/);
  });

  it('SIZE_CLASSES: sm + md variants with specific padding/text classes', () => {
    expect(body).toMatch(/sm: 'px-1\.5 py-0\.5 text-xs',/);
    expect(body).toMatch(/md: 'px-2 py-0\.5 text-sm',/);
  });

  it('helpers: tierLabelFor + tierToneFor exported (+ unknown-tier forward-compat falls back to raw id / neutral)', () => {
    expect(body).toMatch(/export function tierLabelFor\(tier: string\): string/);
    expect(body).toMatch(/return TIER_LABEL\[tier\] \?\? tier;/);
    expect(body).toMatch(/export function tierToneFor\(tier: string\): Tone/);
    expect(body).toMatch(/return TIER_TONE\[tier\] \?\? 'neutral';/);
  });

  it('TierBadge component: role="status" + aria-label="Tier: ${label}"', () => {
    expect(body).toMatch(/role="status"/);
    expect(body).toMatch(/aria-label=\{`Tier: \$\{label\}`\}/);
  });
});

describe('W384.B gui-client SessionStatusBadge content parity', () => {
  const body = read(SESSION);

  it('V-534.N framing pinned + SessionStatus union: 5 literals', () => {
    expect(body).toMatch(/V-534\.N — SessionStatusBadge presentational component/);
    expect(body).toMatch(
      /export type SessionStatus = 'creating' \| 'ready' \| 'busy' \| 'destroyed' \| 'errored';/,
    );
  });

  it('STATUS_LABEL: 5 keys with canonical labels', () => {
    expect(body).toMatch(/creating: 'Creating',/);
    expect(body).toMatch(/ready: 'Ready',/);
    expect(body).toMatch(/busy: 'Busy',/);
    expect(body).toMatch(/destroyed: 'Destroyed',/);
    expect(body).toMatch(/errored: 'Errored',/);
  });

  it('Tone union: 5 literals (neutral/success/busy/warning/error)', () => {
    expect(body).toMatch(/type Tone = 'neutral' \| 'success' \| 'busy' \| 'warning' \| 'error';/);
  });

  it('STATUS_TONE map: creating=neutral / ready=success / busy=busy / destroyed=warning / errored=error', () => {
    expect(body).toMatch(/creating: 'neutral',/);
    expect(body).toMatch(/ready: 'success',/);
    expect(body).toMatch(/busy: 'busy',/);
    expect(body).toMatch(/destroyed: 'warning',/);
    expect(body).toMatch(/errored: 'error',/);
  });

  it('busy tone dot uses animate-pulse (load-bearing UX: in-progress visual signal)', () => {
    expect(body).toMatch(/tone === 'busy'\s*\n?\s*\?\s*'bg-status-busy animate-pulse'/);
  });

  it('SessionStatusBadge component: role="status" + aria-label="Session status: ${label}"', () => {
    expect(body).toMatch(/role="status"/);
    expect(body).toMatch(/aria-label=\{`Session status: \$\{label\}`\}/);
  });

  it('helpers: sessionStatusLabelFor + sessionStatusToneFor exported with forward-compat fallback', () => {
    expect(body).toMatch(/export function sessionStatusLabelFor\(status: string\): string/);
    expect(body).toMatch(/return STATUS_LABEL\[status\] \?\? status;/);
    expect(body).toMatch(/return STATUS_TONE\[status\] \?\? 'neutral';/);
  });
});

describe('W384.B gui-client CryptoOrderStatusBadge content parity', () => {
  const body = read(CRYPTO);

  it('V-1056 V-534.U framing pinned + CryptoOrderStatus union: 6 literals, the set CryptoOrderStatusSchema declares. It was 5, omitting cancelled, while the maps in the same file carried it.', () => {
    expect(body).toMatch(/V-534\.U — CryptoOrderStatusBadge presentational component/);
    for (const value of ['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled']) {
      expect(body, `CryptoOrderStatus no longer includes '${value}'`).toMatch(
        new RegExp(`\\| '${value}'|= '${value}'`),
      );
    }
    expect(body, "the union dropped back to five values, excluding 'cancelled'").not.toMatch(
      /export type CryptoOrderStatus = 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial';/,
    );
  });

  it('STATUS_LABEL: 5 customer-facing labels pinned', () => {
    expect(body).toMatch(/pending: 'Awaiting payment',/);
    expect(body).toMatch(/confirming: 'Confirming on-chain',/);
    expect(body).toMatch(/paid: 'Paid',/);
    expect(body).toMatch(/failed: 'Failed',/);
    expect(body).toMatch(/partial: 'Partial — contact support',/);
  });

  it('STATUS_TONE map: pending=neutral / confirming=busy / paid=success / failed=error / partial=warning', () => {
    expect(body).toMatch(/pending: 'neutral',/);
    expect(body).toMatch(/confirming: 'busy',/);
    expect(body).toMatch(/paid: 'success',/);
    expect(body).toMatch(/failed: 'error',/);
    expect(body).toMatch(/partial: 'warning',/);
  });

  it('V-1056 isTerminalCryptoOrderStatus helper: true for paid, failed OR cancelled — matching isTerminalForward on the server', () => {
    expect(body).toMatch(
      /export function isTerminalCryptoOrderStatus\(status: string\): boolean \{\s*\n?\s*return status === 'paid' \|\| status === 'failed' \|\| status === 'cancelled';\s*\n?\s*\}/,
    );
    expect(
      body,
      'the two-value terminal set is back; a cancelled order would read as still moving',
    ).not.toMatch(/return status === 'paid' \|\| status === 'failed';/);
  });

  it('CryptoOrderStatusBadge component: role="status" + aria-label="Crypto order status: ${label}"', () => {
    expect(body).toMatch(/role="status"/);
    expect(body).toMatch(/aria-label=\{`Crypto order status: \$\{label\}`\}/);
  });
});

describe('W384.B all 3 badge component files exist', () => {
  it('TierBadge + SessionStatusBadge + CryptoOrderStatusBadge canonical paths', () => {
    expect(existsSync(TIER)).toBe(true);
    expect(existsSync(SESSION)).toBe(true);
    expect(existsSync(CRYPTO)).toBe(true);
  });
});
