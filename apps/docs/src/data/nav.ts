// V-254 — central doc-site navigation. Single source of truth for the
// sidebar; pages reference this so adding a topic = one edit here.
//
// Categories order intentional: Quickstart at the top so a new
// customer's first click lands on a "I just got my key, what now"
// page; Reference + Architecture at the bottom for spec-level depth.
//
// V-256 expanded: Quickstart section + per-topic Guides entries.
//
// S22.2 (2026-07-06, Stoplight relayout) — FULL-TREE expansion: every
// one of the 50 routes under src/pages now has a nav entry (the prior
// 28-entry nav orphaned all 6 /reference/* pages, 4 /sdk/* pages and
// 12 /api/* pages — reachable only by URL, the single biggest cause of
// the "unclear" docs feedback). Section order for the three-pane tree:
// Overview → Get started → Guides → SDKs → API reference → Webhooks →
// Platform reference. Within API reference: the core resources you
// automate with come first (sessions/agent-sessions/recipes/profiles/
// profile-snapshots/proxies), then account + access control, then
// billing, then the remaining surfaces. Labels follow the plain-words
// rule; page slugs are FROZEN (labels live here, never page renames).

export interface DocNavItem {
  href: string;
  label: string;
  /** S22.4 (reserved) — HTTP method badge for per-endpoint anchor
   *  sub-nodes in the tree (GET/POST chips). UNUSED in S22.2. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
    label: 'Get started',
    items: [
      { href: '/quickstart/', label: 'Quickstart' },
      { href: '/license-activation/', label: 'License activation (GUI client)' },
    ],
  },
  {
    label: 'Guides',
    items: [
      { href: '/guides/', label: 'Guides overview' },
      { href: '/guides/profile-management/', label: 'Profile management' },
      { href: '/guides/session-lifecycle/', label: 'Session lifecycle' },
      { href: '/guides/team-rbac/', label: 'Teams & access control' },
      { href: '/guides/live-video/', label: 'Live video' },
    ],
  },
  {
    label: 'SDKs',
    items: [
      { href: '/sdk/', label: 'SDK overview' },
      { href: '/sdk/installation/', label: 'Installation' },
      { href: '/sdk/typescript-quickstart/', label: 'TypeScript quickstart' },
      { href: '/sdk/python-quickstart/', label: 'Python quickstart' },
      { href: '/sdk/go-quickstart/', label: 'Go quickstart' },
      { href: '/sdk/error-handling/', label: 'Error handling' },
      { href: '/sdk/versioning/', label: 'Versioning policy' },
    ],
  },
  {
    label: 'API reference',
    items: [
      { href: '/api/', label: 'API overview' },
      { href: '/api/versioning/', label: 'Versioning policy' },
      // Core automation resources.
      { href: '/api/sessions/', label: 'Sessions' },
      { href: '/api/agent-sessions/', label: 'Agent sessions' },
      { href: '/api/recipes/', label: 'Recipes' },
      { href: '/api/profiles/', label: 'Profiles' },
      { href: '/api/profile-snapshots/', label: 'Profile snapshots' },
      { href: '/api/proxies/', label: 'Account proxies' },
      // Account + access control.
      { href: '/api/account/', label: 'Account' },
      { href: '/api/auth/', label: 'Authentication' },
      { href: '/api/mfa/', label: 'Two-factor auth (MFA)' },
      { href: '/api/oauth/', label: 'OAuth (third-party clients)' },
      { href: '/api/api-keys/', label: 'API keys' },
      { href: '/api/team/', label: 'Teams & access control' },
      { href: '/api/usage/', label: 'Usage + quotas' },
      { href: '/api/audit-log/', label: 'Audit log' },
      // Billing + spend.
      { href: '/api/billing/', label: 'Billing' },
      { href: '/api/billing-crypto/', label: 'Crypto checkout' },
      { href: '/api/cost-monitoring/', label: 'Cost monitoring' },
      // Remaining surfaces.
      { href: '/api/bundled-llm/', label: 'Bundled LLM' },
      { href: '/api/byok-anthropic/', label: 'Bring your own Anthropic key' },
      { href: '/api/account-notifications/', label: 'Account notifications (SSE)' },
      { href: '/api/account-rate-limits/', label: 'Account rate limits' },
      { href: '/api/email-preferences/', label: 'Email preferences' },
      { href: '/api/status/', label: 'Status page API' },
      { href: '/api/legal/', label: 'Legal documents' },
    ],
  },
  {
    label: 'Webhooks',
    items: [
      { href: '/webhooks/endpoints/', label: 'Endpoints (CRUD + rotate + test)' },
      { href: '/webhooks/events/', label: 'Event catalog' },
      { href: '/webhooks/replay/', label: 'Replay deliveries' },
    ],
  },
  {
    label: 'Platform reference',
    items: [
      { href: '/reference/errors/', label: 'Errors' },
      { href: '/reference/rate-limits/', label: 'Rate limits' },
      { href: '/reference/pagination/', label: 'Pagination' },
      { href: '/reference/idempotency/', label: 'Idempotency keys' },
      { href: '/reference/scopes/', label: 'API key scopes' },
      { href: '/reference/metrics/', label: 'Prometheus metrics' },
    ],
  },
];
