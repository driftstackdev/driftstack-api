// Standard profile icons (2026-06-15) — a curated emoji set the user can pick
// to distinguish profiles at a glance, instead of (or alongside) the monogram.
// Stored as ProfileMeta.icon (empty = use the monogram). Kept small + operator-
// oriented (shopping / finance / social / travel / work / regions …).

export interface ProfileIcon {
  emoji: string;
  label: string;
}

export const PROFILE_ICONS: ReadonlyArray<ProfileIcon> = [
  { emoji: '🛒', label: 'Shopping' },
  { emoji: '🏦', label: 'Banking' },
  { emoji: '📱', label: 'Social' },
  { emoji: '📣', label: 'Marketing' },
  { emoji: '🎮', label: 'Gaming' },
  { emoji: '✈️', label: 'Travel' },
  { emoji: '🎟️', label: 'Tickets' },
  { emoji: '👟', label: 'Sneakers' },
  { emoji: '💼', label: 'Work' },
  { emoji: '📰', label: 'News' },
  { emoji: '🎯', label: 'Ads/leads' },
  { emoji: '🛍️', label: 'Retail' },
  { emoji: '🧪', label: 'Testing' },
  { emoji: '🌐', label: 'General' },
  { emoji: '🔒', label: 'Secure' },
  { emoji: '⭐', label: 'Priority' },
];
