// V-534.M — TierBadge presentational component.
//
// Maps an account tier to a chip-style badge. Used by views that
// surface tier info (SettingsAccountCard, BillingCostView future
// header, etc.). Mapping lives here so a tier rename only touches
// one file.

export type AccountTier =
  | 'free'
  | 'solo_manual'
  | 'team_manual'
  | 'agency_manual'
  | 'api_starter'
  | 'api_builder'
  | 'api_scale'
  | 'enterprise';

export interface TierBadgeProps {
  /** Accepts any tier string for forward-compat with new tiers landed
   *  on the server before the client rebuilds. `AccountTier` is the
   *  documented happy-path set; unknown tiers render as-is. */
  tier: string;
  /** Optional override — defaults to the canonical human label. */
  label?: string;
  /** Size variant. Default `md` matches surrounding body text. */
  size?: 'sm' | 'md';
}

const TIER_LABEL: Record<string, string> = {
  free: 'Free',
  solo_manual: 'Personal',
  team_manual: 'Team',
  agency_manual: 'Agency',
  api_starter: 'API Starter',
  api_builder: 'API Builder',
  api_scale: 'API Scale',
  enterprise: 'Enterprise',
};

type Tone = 'neutral' | 'paid' | 'enterprise';

const TIER_TONE: Record<string, Tone> = {
  free: 'neutral',
  solo_manual: 'paid',
  team_manual: 'paid',
  agency_manual: 'paid',
  api_starter: 'paid',
  api_builder: 'paid',
  api_scale: 'paid',
  enterprise: 'enterprise',
};

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-surface-inset text-ink-secondary border-surface-divider',
  paid: 'bg-status-success/15 text-status-success border-status-success/30',
  enterprise: 'bg-accent/15 text-accent border-accent/30',
};

const SIZE_CLASSES: Record<NonNullable<TierBadgeProps['size']>, string> = {
  sm: 'px-1.5 py-0.5 text-xs',
  md: 'px-2 py-0.5 text-sm',
};

export function tierLabelFor(tier: string): string {
  return TIER_LABEL[tier] ?? tier;
}

export function tierToneFor(tier: string): Tone {
  return TIER_TONE[tier] ?? 'neutral';
}

export function TierBadge(props: TierBadgeProps): JSX.Element {
  const tone = tierToneFor(props.tier);
  const size = props.size ?? 'md';
  const label = props.label ?? tierLabelFor(props.tier);
  return (
    <span
      role="status"
      aria-label={`Tier: ${label}`}
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${TONE_CLASSES[tone]} ${SIZE_CLASSES[size]}`}
    >
      {label}
    </span>
  );
}
