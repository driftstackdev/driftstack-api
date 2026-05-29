// W477.A — drift guard for apps/gui-client/src/components/TierBadge.tsx.
// V-534.M TierBadge. Drift here either drops the 9-tier label
// map (an unknown tier falls through to the raw snake_case enum
// — UI shows 'api_starter' instead of 'API Starter') or breaks
// the enterprise-tone bg-accent class (Enterprise customers
// stop being visually differentiated from regular paid tiers —
// support drops the white-glove treatment because the chip
// looks identical).
//
//   • V-534.M framing pinned: 'TierBadge presentational
//     component.' + 'Maps an account tier to a chip-style badge.
//     Used by views that surface tier info (SettingsAccountCard,
//     BillingCostView future header, etc.). Mapping lives here
//     so a tier rename only touches one file.'
//   • AccountTier 9-value union (free | trial_pack | solo_manual
//     | team_manual | agency_manual | api_starter | api_builder
//     | api_scale | enterprise).
//   • TierBadgeProps: tier forward-compat string + label?
//     override + size? 'sm'|'md'.
//   • Tone 4-union (neutral | paid | enterprise | trial).
//   • TIER_LABEL 9-entry + TIER_TONE 9-entry + TONE_CLASSES
//     4-entry (enterprise→accent, paid→success, trial→info,
//     neutral→inset) + SIZE_CLASSES sm/md.
//   • tierLabelFor + tierToneFor ?? fallback for forward-compat.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/TierBadge.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W477.A apps/gui-client/src/components/TierBadge.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.M framing pinned: 'V-534.M — TierBadge presentational component.' + 'Maps an account tier to a chip-style badge. Used by views that surface tier info (SettingsAccountCard, BillingCostView future header, etc.). Mapping lives here so a tier rename only touches one file.'", () => {
    expect(body).toMatch(/\/\/ V-534\.M — TierBadge presentational component\./);
    expect(body).toMatch(
      /\/\/ Maps an account tier to a chip-style badge\. Used by views that\s*\n?\s*\/\/ surface tier info \(SettingsAccountCard, BillingCostView future\s*\n?\s*\/\/ header, etc\.\)\. Mapping lives here so a tier rename only touches\s*\n?\s*\/\/ one file\./,
    );
  });

  it("AccountTier 8-value union (free | solo_manual | team_manual | agency_manual | api_starter | api_builder | api_scale | enterprise) — pinned so a tier rename in the schema doesn't drop the typed surface here (trial_pack removed 2026-05-27)", () => {
    expect(body).toMatch(
      /export type AccountTier =\s*\n?\s*\| 'free'\s*\n?\s*\| 'solo_manual'\s*\n?\s*\| 'team_manual'\s*\n?\s*\| 'agency_manual'\s*\n?\s*\| 'api_starter'\s*\n?\s*\| 'api_builder'\s*\n?\s*\| 'api_scale'\s*\n?\s*\| 'enterprise';/,
    );
    expect(body).not.toMatch(/'trial_pack'/);
  });

  it("TierBadgeProps: tier 'Accepts any tier string for forward-compat with new tiers landed on the server before the client rebuilds. `AccountTier` is the documented happy-path set; unknown tiers render as-is.' + label? override + size? 'sm'|'md' 'Default `md` matches surrounding body text.'", () => {
    expect(body).toMatch(
      /export interface TierBadgeProps \{\s*\n?\s*\/\*\* Accepts any tier string for forward-compat with new tiers landed\s*\n?\s*\*\s+on the server before the client rebuilds\. `AccountTier` is the\s*\n?\s*\*\s+documented happy-path set; unknown tiers render as-is\. \*\/\s*\n?\s*tier: string;\s*\n?\s*\/\*\* Optional override — defaults to the canonical human label\. \*\/\s*\n?\s*label\?: string;\s*\n?\s*\/\*\* Size variant\. Default `md` matches surrounding body text\. \*\/\s*\n?\s*size\?: 'sm' \| 'md';\s*\n?\s*\}/,
    );
  });

  it("TIER_LABEL 8-entry: 'Free', 'Solo Manual', 'Team Manual', 'Agency Manual', 'API Starter', 'API Builder', 'API Scale', 'Enterprise' — Title Case + API uppercase preserved (trial_pack removed 2026-05-27)", () => {
    expect(body).toMatch(
      /const TIER_LABEL: Record<string, string> = \{\s*\n?\s*free: 'Free',\s*\n?\s*solo_manual: 'Solo Manual',\s*\n?\s*team_manual: 'Team Manual',\s*\n?\s*agency_manual: 'Agency Manual',\s*\n?\s*api_starter: 'API Starter',\s*\n?\s*api_builder: 'API Builder',\s*\n?\s*api_scale: 'API Scale',\s*\n?\s*enterprise: 'Enterprise',\s*\n?\s*\};/,
    );
    expect(body).not.toMatch(/'Trial Pack'/);
  });

  it('Tone 3-union (neutral | paid | enterprise) + TIER_TONE 8-entry: free→neutral, *_manual→paid, api_*→paid, enterprise→enterprise — pinned so enterprise customers stay visually differentiated from regular paid tiers (white-glove signal); trial tone removed 2026-05-27', () => {
    expect(body).toMatch(/type Tone = 'neutral' \| 'paid' \| 'enterprise';/);
    expect(body).toMatch(
      /const TIER_TONE: Record<string, Tone> = \{\s*\n?\s*free: 'neutral',\s*\n?\s*solo_manual: 'paid',\s*\n?\s*team_manual: 'paid',\s*\n?\s*agency_manual: 'paid',\s*\n?\s*api_starter: 'paid',\s*\n?\s*api_builder: 'paid',\s*\n?\s*api_scale: 'paid',\s*\n?\s*enterprise: 'enterprise',\s*\n?\s*\};/,
    );
    expect(body).not.toMatch(/'trial'/);
  });

  it("TONE_CLASSES 3-entry: neutral→bg-surface-inset, paid→bg-status-success/15, enterprise→bg-accent/15 (accent token, not a success-tier reuse — pinned so Enterprise isn't visually identical to paid tiers); SIZE_CLASSES sm (px-1.5 py-0.5 text-xs) + md (px-2 py-0.5 text-sm); trial tone removed 2026-05-27", () => {
    expect(body).toMatch(
      /const TONE_CLASSES: Record<Tone, string> = \{\s*\n?\s*neutral: 'bg-surface-inset text-ink-secondary border-surface-divider',\s*\n?\s*paid: 'bg-status-success\/15 text-status-success border-status-success\/30',\s*\n?\s*enterprise: 'bg-accent\/15 text-accent border-accent\/30',\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const SIZE_CLASSES: Record<NonNullable<TierBadgeProps\['size'\]>, string> = \{\s*\n?\s*sm: 'px-1\.5 py-0\.5 text-xs',\s*\n?\s*md: 'px-2 py-0\.5 text-sm',\s*\n?\s*\};/,
    );
  });

  it("Exported helpers tierLabelFor + tierToneFor with ?? fallback (label→raw tier, tone→'neutral') for forward-compat; Render: role='status' + aria-label `Tier: ${label}` + size default 'md' + label override default tierLabelFor(props.tier)", () => {
    expect(body).toMatch(
      /export function tierLabelFor\(tier: string\): string \{\s*\n?\s*return TIER_LABEL\[tier\] \?\? tier;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export function tierToneFor\(tier: string\): Tone \{\s*\n?\s*return TIER_TONE\[tier\] \?\? 'neutral';\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const tone = tierToneFor\(props\.tier\);\s*\n?\s*const size = props\.size \?\? 'md';\s*\n?\s*const label = props\.label \?\? tierLabelFor\(props\.tier\);\s*\n?\s*return \(\s*\n?\s*<span\s*\n?\s*role="status"\s*\n?\s*aria-label=\{`Tier: \$\{label\}`\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
