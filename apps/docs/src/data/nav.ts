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
//
// S22.4 (2026-07-06, Stoplight reference furniture) — per-endpoint
// anchor SUB-NODES: every API-reference resource entry now carries
// `children` — one `{ href, label, method }` per documented endpoint,
// in PAGE order, extracted from the resource's .md h2 sections (an h2
// is an endpoint iff its direct content opens with a paragraph-start
// `METHOD /path` inline-code declaration, or the h2 itself embeds
// "… — METHOD /path" — a format retired from api/status in S27).
// Anchor slugs are github-slugger output (what
// rehype-slug renders) — the docs-nav-endpoint-children-integrity
// suite re-derives all of this from the .md sources, so a heading or
// endpoint edit fails the test until nav.ts is regenerated. Concept
// h2s (Resource shape / Concurrency / Errors / prose flow intros like
// oauth's "The flow") get NO sub-node; children render only for
// the ACTIVE resource page (Stoplight behavior) with a colored
// method chip (base.css .method-chip recipes, AA-verified).
//
// S27 (2026-07-07, docs reference hygiene) — md defect sweep +
// webhooks extension: api/status heading-embedded methods normalized
// to declaration lines; flow-step endpoints promoted to h2 sections
// (oauth authorize/complete/token, mfa enroll/verify, auth
// cli-authorize initiate/bind/exchange, agent-sessions
// takeover/handback/resume); profiles Export / Import split; the
// literal "Endpoint" h2s renamed (account-notifications, webhooks
// replay). Children extraction now ALSO covers the Webhooks section
// (endpoints + replay carry children; events is a catalog with none).
// Census: 122 API + 8 webhooks = 130 endpoint sub-nodes.
//
// S29 (2026-07-07, docs content-enrichment batch 1) — 5 NEW pages
// migrated from the legacy marketing /docs mirror (facts re-verified
// against server/SDK/api-types source before carry-over): Get started
// gains the curl-first quickstart (/quickstart-curl/); Guides gains
// concurrency & backpressure, the two migration guides (Puppeteer /
// Playwright, Browserless), and Sentry. Top-level route census
// 50 → 55. Endpoint children census unchanged (the new pages are
// guides, not API-reference resources — the children-integrity suite
// only extracts from the API reference + Webhooks sections).
//
// S33 2026-07-07 (fable-truth-audit) — 9 live-but-undocumented
// endpoints registered in openapi.ts + documented: agent-sessions
// gains the 7 live-session control sub-nodes (page-state / cookie
// read+import / history step / file upload / downloads list+fetch),
// profiles gains trim, auth gains resend-verification. Children
// census 130 → 139 (131 API + 8 webhooks); top-level routes
// unchanged at 55.
//
// S37 2026-07-07 (docs content-enrichment batch 2) — 5 NEW pages
// adapted from the legacy marketing /docs mirror (every claim
// re-verified against the crypto routes/service, the email-service
// send sites, and the post-S30 residency posture before carry-over):
// Guides gains /guides/paying-with-crypto/ and
// /guides/crypto-troubleshooting/; Webhooks gains
// /webhooks/crypto-events/ (a catalog page — no endpoint children);
// Platform reference gains /reference/emails/ and
// /reference/data-residency/. Top-level route census 55 → 60;
// children census unchanged at 139.

export interface DocNavItem {
  href: string;
  label: string;
  /** S22.4 — HTTP method chip (GET/POST/PUT/PATCH/DELETE). Reserved in
   *  S22.2, LIVE since S22.4 on endpoint sub-nodes (via DocNavChild;
   *  kept on the item shape for future single-endpoint pages). */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** S22.4 — per-endpoint anchor sub-nodes (href = parent href +
   *  '#' + rehype-slug anchor). Rendered indented under the parent,
   *  only while the parent is the ACTIVE page. Anchors, not pages:
   *  breadcrumbs + prev/next keep walking top-level items only. */
  children?: DocNavChild[];
}

export interface DocNavChild {
  href: string;
  label: string;
  method?: DocNavItem['method'];
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
      { href: '/quickstart-curl/', label: 'Quickstart (curl)' },
      { href: '/license-activation/', label: 'License activation (GUI client)' },
    ],
  },
  {
    label: 'Guides',
    items: [
      { href: '/guides/', label: 'Guides overview' },
      { href: '/guides/profile-management/', label: 'Profile management' },
      { href: '/guides/session-lifecycle/', label: 'Session lifecycle' },
      { href: '/guides/concurrency/', label: 'Concurrency & backpressure' },
      { href: '/guides/team-rbac/', label: 'Teams & access control' },
      { href: '/guides/live-video/', label: 'Live video' },
      { href: '/guides/migrate-from-puppeteer/', label: 'Migrating from Puppeteer / Playwright' },
      { href: '/guides/migrate-from-browserless/', label: 'Migrating from Browserless' },
      { href: '/guides/sentry/', label: 'Sentry integration' },
      { href: '/guides/paying-with-crypto/', label: 'Paying with crypto' },
      { href: '/guides/crypto-troubleshooting/', label: 'Crypto payment troubleshooting' },
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
      {
        href: '/api/sessions/',
        label: 'Sessions',
        children: [
          { href: '/api/sessions/#create', label: 'Create', method: 'POST' },
          { href: '/api/sessions/#list', label: 'List', method: 'GET' },
          { href: '/api/sessions/#get-one', label: 'Get one', method: 'GET' },
          { href: '/api/sessions/#navigate', label: 'Navigate', method: 'POST' },
          { href: '/api/sessions/#interact', label: 'Interact', method: 'POST' },
          { href: '/api/sessions/#wait', label: 'Wait', method: 'POST' },
          { href: '/api/sessions/#get-state', label: 'Get state', method: 'GET' },
          { href: '/api/sessions/#capture', label: 'Capture', method: 'POST' },
          { href: '/api/sessions/#extract', label: 'Extract', method: 'POST' },
          { href: '/api/sessions/#search', label: 'Search', method: 'POST' },
          { href: '/api/sessions/#login', label: 'Login', method: 'POST' },
          { href: '/api/sessions/#destroy', label: 'Destroy', method: 'DELETE' },
        ],
      },
      {
        href: '/api/agent-sessions/',
        label: 'Agent sessions',
        children: [
          { href: '/api/agent-sessions/#create', label: 'Create', method: 'POST' },
          { href: '/api/agent-sessions/#get', label: 'Get', method: 'GET' },
          { href: '/api/agent-sessions/#message', label: 'Message', method: 'POST' },
          { href: '/api/agent-sessions/#close', label: 'Close', method: 'DELETE' },
          {
            href: '/api/agent-sessions/#live-video-livekit',
            label: 'Live video (LiveKit)',
            method: 'POST',
          },
          {
            href: '/api/agent-sessions/#live-transcript-stream-sse',
            label: 'Live transcript stream (SSE)',
            method: 'GET',
          },
          { href: '/api/agent-sessions/#set-mode', label: 'Set mode', method: 'POST' },
          {
            href: '/api/agent-sessions/#live-input-event-manual--pair-mode',
            label: 'Live input event (manual / pair mode)',
            method: 'POST',
          },
          {
            href: '/api/agent-sessions/#request-takeover',
            label: 'Request takeover',
            method: 'POST',
          },
          {
            href: '/api/agent-sessions/#request-handback',
            label: 'Request handback',
            method: 'POST',
          },
          {
            href: '/api/agent-sessions/#resume-a-challenge-paused-session',
            label: 'Resume a challenge-paused session',
            method: 'POST',
          },
          { href: '/api/agent-sessions/#page-state', label: 'Page state', method: 'GET' },
          {
            href: '/api/agent-sessions/#read-the-cookie-jar',
            label: 'Read the cookie jar',
            method: 'GET',
          },
          { href: '/api/agent-sessions/#import-cookies', label: 'Import cookies', method: 'POST' },
          {
            href: '/api/agent-sessions/#step-browser-history',
            label: 'Step browser history',
            method: 'POST',
          },
          { href: '/api/agent-sessions/#upload-a-file', label: 'Upload a file', method: 'POST' },
          { href: '/api/agent-sessions/#list-downloads', label: 'List downloads', method: 'GET' },
          {
            href: '/api/agent-sessions/#fetch-a-download',
            label: 'Fetch a download',
            method: 'GET',
          },
        ],
      },
      {
        href: '/api/recipes/',
        label: 'Recipes',
        children: [
          { href: '/api/recipes/#create', label: 'Create', method: 'POST' },
          { href: '/api/recipes/#list', label: 'List', method: 'GET' },
          {
            href: '/api/recipes/#suggest-a-labeldescription',
            label: 'Suggest a label/description',
            method: 'GET',
          },
          { href: '/api/recipes/#get-one', label: 'Get one', method: 'GET' },
          { href: '/api/recipes/#delete', label: 'Delete', method: 'DELETE' },
        ],
      },
      {
        href: '/api/profiles/',
        label: 'Profiles',
        children: [
          { href: '/api/profiles/#create', label: 'Create', method: 'POST' },
          { href: '/api/profiles/#list', label: 'List', method: 'GET' },
          { href: '/api/profiles/#get-one', label: 'Get one', method: 'GET' },
          {
            href: '/api/profiles/#patch-rename--edit-description',
            label: 'Patch (rename + edit description)',
            method: 'PATCH',
          },
          { href: '/api/profiles/#launch', label: 'Launch', method: 'POST' },
          { href: '/api/profiles/#clone', label: 'Clone', method: 'POST' },
          { href: '/api/profiles/#transfer', label: 'Transfer', method: 'POST' },
          { href: '/api/profiles/#export', label: 'Export', method: 'GET' },
          { href: '/api/profiles/#import', label: 'Import', method: 'POST' },
          { href: '/api/profiles/#snapshots', label: 'Snapshots', method: 'POST' },
          {
            href: '/api/profiles/#delete-recycle-bin',
            label: 'Delete (recycle bin)',
            method: 'DELETE',
          },
          { href: '/api/profiles/#list-trash', label: 'List trash', method: 'GET' },
          { href: '/api/profiles/#restore', label: 'Restore', method: 'POST' },
          {
            href: '/api/profiles/#purge-permanent-delete',
            label: 'Purge (permanent delete)',
            method: 'DELETE',
          },
          {
            href: '/api/profiles/#trim-cached-site-data',
            label: 'Trim cached site data',
            method: 'POST',
          },
        ],
      },
      {
        href: '/api/profile-snapshots/',
        label: 'Profile snapshots',
        children: [
          {
            href: '/api/profile-snapshots/#capture-a-snapshot-of-a-profile',
            label: 'Capture a snapshot of a profile',
            method: 'POST',
          },
          {
            href: '/api/profile-snapshots/#list-snapshots-of-a-profile',
            label: 'List snapshots of a profile',
            method: 'GET',
          },
          {
            href: '/api/profile-snapshots/#list-all-snapshots-across-the-account',
            label: 'List all snapshots across the account',
            method: 'GET',
          },
          {
            href: '/api/profile-snapshots/#get-a-single-snapshot',
            label: 'Get a single snapshot',
            method: 'GET',
          },
          {
            href: '/api/profile-snapshots/#restore-a-snapshot-into-a-new-profile',
            label: 'Restore a snapshot into a new profile',
            method: 'POST',
          },
          {
            href: '/api/profile-snapshots/#delete-a-snapshot',
            label: 'Delete a snapshot',
            method: 'DELETE',
          },
        ],
      },
      {
        href: '/api/proxies/',
        label: 'Account proxies',
        children: [
          { href: '/api/proxies/#list', label: 'List', method: 'GET' },
          { href: '/api/proxies/#create', label: 'Create', method: 'POST' },
          { href: '/api/proxies/#update', label: 'Update', method: 'PUT' },
          { href: '/api/proxies/#delete', label: 'Delete', method: 'DELETE' },
          { href: '/api/proxies/#test-reachability', label: 'Test reachability', method: 'POST' },
        ],
      },
      // Account + access control.
      {
        href: '/api/account/',
        label: 'Account',
        children: [
          {
            href: '/api/account/#get-the-calling-account',
            label: 'Get the calling account',
            method: 'GET',
          },
          {
            href: '/api/account/#update-the-calling-account',
            label: 'Update the calling account',
            method: 'PATCH',
          },
          { href: '/api/account/#avatar-upload', label: 'Avatar upload', method: 'POST' },
        ],
      },
      {
        href: '/api/auth/',
        label: 'Authentication',
        children: [
          { href: '/api/auth/#sign-up', label: 'Sign up', method: 'POST' },
          { href: '/api/auth/#verify-email', label: 'Verify email', method: 'POST' },
          {
            href: '/api/auth/#resend-verification-email',
            label: 'Resend verification email',
            method: 'POST',
          },
          { href: '/api/auth/#log-in', label: 'Log in', method: 'POST' },
          { href: '/api/auth/#mfa-challenge', label: 'MFA challenge', method: 'POST' },
          { href: '/api/auth/#mfa-step-up', label: 'MFA step-up', method: 'POST' },
          { href: '/api/auth/#magic-link', label: 'Magic link', method: 'POST' },
          { href: '/api/auth/#password-reset', label: 'Password reset', method: 'POST' },
          { href: '/api/auth/#refresh', label: 'Refresh', method: 'POST' },
          { href: '/api/auth/#logout', label: 'Logout', method: 'POST' },
          { href: '/api/auth/#initiate-activation', label: 'Initiate activation', method: 'POST' },
          {
            href: '/api/auth/#bind-activation-dashboard',
            label: 'Bind activation (dashboard)',
            method: 'POST',
          },
          {
            href: '/api/auth/#exchange-for-the-api-key',
            label: 'Exchange for the API key',
            method: 'POST',
          },
        ],
      },
      {
        href: '/api/mfa/',
        label: 'Two-factor auth (MFA)',
        children: [
          { href: '/api/mfa/#start-enrollment', label: 'Start enrollment', method: 'POST' },
          {
            href: '/api/mfa/#confirm--receive-recovery-codes',
            label: 'Confirm + receive recovery codes',
            method: 'POST',
          },
          { href: '/api/mfa/#status', label: 'Status', method: 'GET' },
          { href: '/api/mfa/#login-challenge', label: 'Login challenge', method: 'POST' },
          { href: '/api/mfa/#step-up-reauth', label: 'Step-up reauth', method: 'POST' },
          { href: '/api/mfa/#disabling', label: 'Disabling', method: 'DELETE' },
          {
            href: '/api/mfa/#recovery-code-regeneration',
            label: 'Recovery code regeneration',
            method: 'POST',
          },
        ],
      },
      {
        href: '/api/oauth/',
        label: 'OAuth (third-party clients)',
        children: [
          {
            href: '/api/oauth/#1--stage-authorization',
            label: '1 — Stage authorization',
            method: 'GET',
          },
          {
            href: '/api/oauth/#2--customer-approves-dashboard-internal',
            label: '2 — Customer approves (dashboard-internal)',
            method: 'POST',
          },
          {
            href: '/api/oauth/#4--exchange-the-code-for-a-token',
            label: '4 — Exchange the code for a token',
            method: 'POST',
          },
          {
            href: '/api/oauth/#validating-tokens-introspection',
            label: 'Validating tokens (introspection)',
            method: 'POST',
          },
          { href: '/api/oauth/#revoking-tokens', label: 'Revoking tokens', method: 'POST' },
        ],
      },
      {
        href: '/api/api-keys/',
        label: 'API keys',
        children: [
          { href: '/api/api-keys/#create-a-key', label: 'Create a key', method: 'POST' },
          { href: '/api/api-keys/#list-keys', label: 'List keys', method: 'GET' },
          { href: '/api/api-keys/#rotate-a-key', label: 'Rotate a key', method: 'POST' },
          { href: '/api/api-keys/#revoke-a-key', label: 'Revoke a key', method: 'DELETE' },
        ],
      },
      {
        href: '/api/team/',
        label: 'Teams & access control',
        children: [
          {
            href: '/api/team/#inverse-view-the-teams-i-am-on',
            label: 'Inverse view: the teams I am ON',
            method: 'GET',
          },
          {
            href: '/api/team/#invite-a-team-member',
            label: 'Invite a team member',
            method: 'POST',
          },
          { href: '/api/team/#list-pending-invites', label: 'List pending invites', method: 'GET' },
          { href: '/api/team/#accept-an-invite', label: 'Accept an invite', method: 'POST' },
          { href: '/api/team/#list-members', label: 'List members', method: 'GET' },
          { href: '/api/team/#remove-a-member', label: 'Remove a member', method: 'DELETE' },
        ],
      },
      {
        href: '/api/usage/',
        label: 'Usage + quotas',
        children: [
          {
            href: '/api/usage/#current-period-summary',
            label: 'Current period summary',
            method: 'GET',
          },
          { href: '/api/usage/#daily-series', label: 'Daily series', method: 'GET' },
        ],
      },
      {
        href: '/api/audit-log/',
        label: 'Audit log',
        children: [
          { href: '/api/audit-log/#list', label: 'List', method: 'GET' },
          { href: '/api/audit-log/#export', label: 'Export', method: 'GET' },
        ],
      },
      // Billing + spend.
      {
        href: '/api/billing/',
        label: 'Billing',
        children: [
          { href: '/api/billing/#read-billing-state', label: 'Read billing state', method: 'GET' },
          {
            href: '/api/billing/#start-a-subscription',
            label: 'Start a subscription',
            method: 'POST',
          },
          {
            href: '/api/billing/#open-the-stripe-customer-portal',
            label: 'Open the Stripe Customer Portal',
            method: 'POST',
          },
        ],
      },
      {
        href: '/api/billing-crypto/',
        label: 'Crypto checkout',
        children: [
          {
            href: '/api/billing-crypto/#create-a-checkout-order',
            label: 'Create a checkout order',
            method: 'POST',
          },
          {
            href: '/api/billing-crypto/#list-customer-orders',
            label: 'List customer orders',
            method: 'GET',
          },
        ],
      },
      {
        href: '/api/cost-monitoring/',
        label: 'Cost monitoring',
        children: [
          { href: '/api/cost-monitoring/#read-your-cost', label: 'Read your cost', method: 'GET' },
        ],
      },
      // Remaining surfaces.
      {
        href: '/api/bundled-llm/',
        label: 'Bundled LLM',
        children: [
          {
            href: '/api/bundled-llm/#get-current-settings',
            label: 'Get current settings',
            method: 'GET',
          },
          {
            href: '/api/bundled-llm/#get-current-status-settings--spend',
            label: 'Get current status (settings + spend)',
            method: 'GET',
          },
          {
            href: '/api/bundled-llm/#update-settings-patch',
            label: 'Update settings (PATCH)',
            method: 'PATCH',
          },
        ],
      },
      {
        href: '/api/byok-anthropic/',
        label: 'Bring your own Anthropic key',
        children: [
          { href: '/api/byok-anthropic/#get-metadata', label: 'Get metadata', method: 'GET' },
          { href: '/api/byok-anthropic/#set-or-rotate', label: 'Set or rotate', method: 'PUT' },
          { href: '/api/byok-anthropic/#clear', label: 'Clear', method: 'DELETE' },
          {
            href: '/api/byok-anthropic/#test-connection',
            label: 'Test connection',
            method: 'POST',
          },
        ],
      },
      {
        href: '/api/account-notifications/',
        label: 'Account notifications (SSE)',
        children: [
          {
            href: '/api/account-notifications/#stream-notifications',
            label: 'Stream notifications',
            method: 'GET',
          },
        ],
      },
      {
        href: '/api/account-rate-limits/',
        label: 'Account rate limits',
        children: [
          {
            href: '/api/account-rate-limits/#get-effective-rate-limit-config',
            label: 'Get effective rate-limit config',
            method: 'GET',
          },
        ],
      },
      {
        href: '/api/email-preferences/',
        label: 'Email preferences',
        children: [
          {
            href: '/api/email-preferences/#list-current-preferences',
            label: 'List current preferences',
            method: 'GET',
          },
          {
            href: '/api/email-preferences/#set-one-preference',
            label: 'Set one preference',
            method: 'PUT',
          },
        ],
      },
      {
        href: '/api/status/',
        label: 'Status page API',
        children: [
          { href: '/api/status/#snapshot', label: 'Snapshot', method: 'GET' },
          { href: '/api/status/#incident-feed', label: 'Incident feed', method: 'GET' },
          { href: '/api/status/#incident-detail', label: 'Incident detail', method: 'GET' },
          { href: '/api/status/#live-stream', label: 'Live stream', method: 'GET' },
          { href: '/api/status/#sla-report', label: 'SLA report', method: 'GET' },
          { href: '/api/status/#start-subscription', label: 'Start subscription', method: 'POST' },
          {
            href: '/api/status/#confirm-subscription',
            label: 'Confirm subscription',
            method: 'GET',
          },
          { href: '/api/status/#unsubscribe', label: 'Unsubscribe', method: 'GET' },
        ],
      },
      {
        href: '/api/legal/',
        label: 'Legal documents',
        children: [
          { href: '/api/legal/#list-the-catalog', label: 'List the catalog', method: 'GET' },
          {
            href: '/api/legal/#see-what-needs-acceptance',
            label: 'See what needs acceptance',
            method: 'GET',
          },
          { href: '/api/legal/#record-acceptance', label: 'Record acceptance', method: 'POST' },
        ],
      },
    ],
  },
  {
    label: 'Webhooks',
    items: [
      {
        href: '/webhooks/endpoints/',
        label: 'Endpoints (CRUD + rotate + test)',
        children: [
          {
            href: '/webhooks/endpoints/#subscribe-create',
            label: 'Subscribe (create)',
            method: 'POST',
          },
          { href: '/webhooks/endpoints/#list--get', label: 'List + get', method: 'GET' },
          { href: '/webhooks/endpoints/#update', label: 'Update', method: 'PATCH' },
          { href: '/webhooks/endpoints/#delete', label: 'Delete', method: 'DELETE' },
          { href: '/webhooks/endpoints/#send-test', label: 'Send test', method: 'POST' },
          {
            href: '/webhooks/endpoints/#rotate-signing-secret',
            label: 'Rotate signing secret',
            method: 'POST',
          },
          {
            href: '/webhooks/endpoints/#delivery-introspection',
            label: 'Delivery introspection',
            method: 'GET',
          },
        ],
      },
      { href: '/webhooks/events/', label: 'Event catalog' },
      { href: '/webhooks/crypto-events/', label: 'Crypto order events' },
      {
        href: '/webhooks/replay/',
        label: 'Replay deliveries',
        children: [
          {
            href: '/webhooks/replay/#replay-a-delivery',
            label: 'Replay a delivery',
            method: 'POST',
          },
        ],
      },
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
      { href: '/reference/emails/', label: 'Emails Driftstack sends' },
      { href: '/reference/data-residency/', label: 'Data residency' },
    ],
  },
];
