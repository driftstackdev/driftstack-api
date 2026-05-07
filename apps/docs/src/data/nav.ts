// V-254 — central doc-site navigation. Single source of truth for the
// sidebar; pages reference this so adding a topic = one edit here.
//
// Categories order intentional: Quickstart at the top so a new
// customer's first click lands on a "I just got my key, what now"
// page; Reference + Architecture at the bottom for spec-level depth.

export interface DocNavItem {
  href: string;
  label: string;
}

export interface DocNavSection {
  label: string;
  items: DocNavItem[];
}

export const DOC_NAV: DocNavSection[] = [
  {
    label: 'Overview',
    items: [{ href: '/', label: 'Introduction' }],
  },
  {
    label: 'API reference',
    items: [
      { href: '/api/', label: 'API overview' },
      { href: '/api/versioning/', label: 'Versioning policy' },
    ],
  },
  {
    label: 'Webhooks',
    items: [{ href: '/webhooks/events/', label: 'Event catalog' }],
  },
  {
    label: 'SDKs',
    items: [
      { href: '/sdk/', label: 'SDK overview' },
      { href: '/sdk/versioning/', label: 'Versioning policy' },
    ],
  },
  {
    label: 'Guides',
    items: [{ href: '/guides/', label: 'Guides overview' }],
  },
];
