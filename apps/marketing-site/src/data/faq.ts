// /faq single source of truth — the page markup AND the FAQPage
// JSON-LD (schema.org Question/acceptedAnswer) both derive from
// FAQ_GROUPS below, so the schema can never diverge from the visible
// Q&A. Extracted from faq.astro 2026-07-03 (Fleet v2 redesign).
//
// Answer strings carry limited inline HTML (anchors / <strong> /
// <code> / <span class="font-mono">) rendered via set:html; the
// JSON-LD form is derived by faqPlainText() which strips tags and
// keeps every word. Accent-colored link text uses text-tk-accent-text
// (AA-safe on the dark bg) — never raw text-tk-accent.

export interface FaqEntry {
  /** Question — plain text; rendered as the visible heading AND as the schema.org Question name. */
  q: string;
  /** Answer — markdown-ish limited HTML (anchors only) — Astro renders raw via set:html. */
  a: string;
}

export interface FaqGroup {
  title: string;
  entries: FaqEntry[];
}

export const FAQ_GROUPS: FaqGroup[] = [
  {
    title: 'Pricing model',
    entries: [
      {
        q: 'Why concurrent caps and not hours?',
        a: 'Most cloud-browser platforms bill by the hour, which quietly punishes you for leaving a session open. An account manager running 3 persistent profiles 8 hours a day generates ~720 browser-hours a month — and a surprise overage bill. Driftstack only counts how many sessions you run at the same time. Within that cap, use them as much as you want: a session that sits open all day costs nothing extra. You upgrade when your team genuinely needs more sessions running side by side — not because a meter ran out, and never with the "did I use too many minutes this month" anxiety.',
      },
      {
        q: "What's the difference between Manual and API?",
        a: 'Manual means a person drives the session — you click around in our desktop app the way you would on a real phone. It\'s built for solo operators, account managers, and agencies juggling many profiles. API means your code drives the session — SDK access, programmatic session creation, scale-out automation. Underneath, both get the same engine, the same fingerprints, the same fidelity; what differs is how you drive it and the concurrent caps. Each Driftstack account holds one subscription. If you need both — say your team works in the GUI client AND your engineering team runs automation — run two accounts. Most customers find one path is enough; if you outgrow it, the second account is straightforward to provision. See <a href="/pricing#manual" class="text-tk-accent-text underline">Manual pricing</a> or <a href="/pricing#api" class="text-tk-accent-text underline">API pricing</a>.',
      },
      {
        q: 'How does this compare to Chromium-cloud stealth services?',
        a: "Chromium-cloud services run a Chromium fork with stealth plugins — user-agent strings, JavaScript Proxy traps over canvas / WebGL / navigator, monkeypatched Object.getOwnPropertyDescriptor calls. The fingerprint matches an iPhone if a detector only checks the spoofed surfaces; it doesn't match if the detector inspects what's underneath (timing, prototype chain, error stacks, GPU primitives). Driftstack runs WebKit's actual C++ source — there's no underneath. The fingerprint your code reads is the fingerprint a real iPhone reads. Same primitives, all the way down.",
      },
      {
        q: 'How does concurrent metering work?',
        a: "<strong>Concurrent</strong> means how many sessions you can run at the same time — think of it like the number of browser tabs you have open at once. That's the only thing we meter on paid tiers. Per-tier caps: Personal = 1 concurrent / Team = 3 / Agency = 8 / API Starter = 2 / API Builder = 8 / API Scale = 24 / Enterprise = custom. Within your cap, run as many session-hours as you want — a 5-minute session and a 6-hour session count exactly the same. The cap only limits how many run side by side; your monthly total is whatever your sessions produce running continuously. No monthly meter, no per-hour metering, no overage line items. The free tier has no metering at all — one concurrent session, no usage charges.",
      },
      {
        q: 'What happens when I hit my concurrent cap?',
        a: 'Session-creation requests fail with HTTP 429 + a structured RFC 9457 problem-detail pointing at the cap-reached state and (where applicable) the next-tier upgrade path. Existing in-flight sessions are not interrupted. The cap is enforced at session-creation time, not mid-session. To increase concurrent capacity, upgrade to a higher-cap tier or contact sales for Enterprise custom limits.',
      },
      {
        q: 'Are there setup fees on any tier?',
        a: 'No. No setup fees, no implementation fees, no minimum-monthly-volume commitments on any subscription tier. The free tier is $0 forever; subscriptions bill monthly or annually with the listed price + applicable BTW.',
      },
      {
        q: 'How does annual billing work?',
        a: 'Annual contracts are billed up front for 12 months at 20% off the monthly equivalent. Switching from monthly to annual or vice versa is prorated automatically by Stripe at the changeover date. Annual contracts auto-renew unless cancelled at least 30 days before renewal.',
      },
    ],
  },
  {
    title: 'Free tier',
    entries: [
      {
        q: 'What do I get on the free tier?',
        a: 'One persistent profile, one concurrent session, and sessions up to 20 minutes each, driven from the desktop GUI client — $0 forever, no card required. The free tier is manual-only (no programmatic API/SDK access); it exists so you can try the real thing before paying anything: open real iPhone Safari sessions on real WebKit and watch the fingerprint match in your own flows.',
      },
      {
        q: 'Does the free tier expire?',
        a: 'No. The free tier is perpetual — there is no time window, no credit that runs out, and no auto-charge. Stay on it as long as you like.',
      },
      {
        q: 'Can I use the API or SDK on the free tier?',
        a: 'No — the free tier is manual-only and runs through the desktop GUI client. Programmatic API/SDK access starts on the API ladder (API Starter from $149/mo), which is also where you get multiple concurrent sessions and no per-session time cap. The free tier lets you evaluate the real iPhone Safari fingerprint hands-on before committing to programmatic automation.',
      },
      {
        q: 'Is there any usage metering on the free tier?',
        a: 'None. No per-hour metering, no credit decrement, no overage. One concurrent session is the only limit, and within it you can run as many manual session-hours as you want.',
      },
      {
        q: 'How do I move from the free tier to a paid tier?',
        a: 'Subscribe to any Manual or API tier through Stripe Checkout from your dashboard. Your existing profile and account carry over; the higher concurrent + profile limits and (on the API ladder) programmatic access apply immediately on activation.',
      },
    ],
  },
  {
    title: 'Tiers + upgrades',
    entries: [
      {
        q: 'Can I upgrade or downgrade mid-month?',
        a: 'Yes. Stripe prorates the price change automatically at the changeover date. New concurrent + profile limits apply immediately on the next session-creation request and the next profile-creation request. Existing sessions and profiles are unaffected at the changeover; only new resources gate against the new tier limits.',
      },
      {
        q: 'What if I cancel?',
        a: 'Service continues through the end of your current billing period. After that, API keys 401 with a message pointing at billing-renewal. No data is deleted at cancellation; your account stays in a "suspended" state with a 30-day grace-period for recovery, then your account data (profiles, sessions, captures) is deleted per the DPA retention schedule. Operational session metadata is kept up to 90 days; invoice history is retained for the legally-required period.',
      },
      {
        q: 'How does Enterprise pricing work?',
        a: 'Enterprise is custom — from $4,000/mo on annual contracts only. Actual pricing depends on concurrent capacity, profile count, archetype customisation, BYOK + bundled-LLM mix, and any compliance requirements (custom DPA terms, data-handling addendums). Email <a href="mailto:sales@driftstack.dev" class="text-tk-accent-text underline">sales@driftstack.dev</a> with workload shape and team context.',
      },
    ],
  },
  {
    title: 'Billing + payments',
    entries: [
      {
        q: 'Why Stripe?',
        a: 'Stripe is our payment processor. Card statements show "STRIPE *DRIFTSTACK". Receipts come from Stripe. Subscription management goes through the Stripe Customer Portal. Stripe handles PCI compliance, fraud protection, dispute mechanisms, and EU VAT/BTW reverse-charge — all of which we inherit rather than reimplement.',
      },
      {
        q: 'Where do I update my payment method or download invoices?',
        a: 'Stripe Customer Portal. Linked from your Driftstack dashboard and from every Stripe receipt email. Payment-method updates, invoice downloads, subscription cancellations, and tax-ID configuration all live there.',
      },
      {
        q: 'Do you store my card details?',
        a: 'No. Card details are stored by Stripe, never by Driftstack. We hold a Stripe customer ID and subscription metadata; the card number itself never touches our servers.',
      },
      {
        q: 'Can I pay in crypto?',
        a: 'Yes — via NowPayments on tiers where crypto checkout is enabled. Open the crypto checkout from the billing dashboard, send the displayed amount in the displayed currency, and the order moves through pending → confirming → paid as on-chain confirmations land. The webhook contract is documented in our <a href="/docs/webhooks-crypto-events" class="text-tk-accent-text underline">crypto webhook events docs</a>. <strong>Crypto payments are non-refundable</strong> — you can cancel anytime, which stops future billing, but the current period is not refunded (see <a href="/legal/refunds" class="text-tk-accent-text underline">refund policy</a>). Most customers use Stripe; crypto is a fallback for jurisdictions where card payments are awkward.',
      },
      {
        q: "How can I tell how much I've spent this month?",
        a: 'GET <code class="font-mono">/v1/account/cost</code> returns a per-component breakdown (compute, storage, egress, email, LLM) plus the total in integer cents. The GUI client surfaces the same data as a Cost panel. There\'s a threshold-state field — under-soft / between / over-hard — that indicates whether your usage is on track or approaching the cap configured for your tier. See <a href="/docs/cost-monitoring" class="text-tk-accent-text underline">cost-monitoring docs</a>.',
      },
      {
        q: "What if I cross my tier's cap?",
        a: 'You get an email when the threshold transitions to "between-soft-and-hard" and another when it crosses "over-hard". Nothing is auto-blocked — running sessions stay running. The account team reaches out to discuss raising the cap or moving to a higher tier. We don\'t silently kill traffic to enforce a soft cap.',
      },
      {
        q: 'Are spend snapshots persisted or recomputed?',
        a: "Recomputed on every request today. When traffic justifies caching, we move to nightly snapshots. The endpoint contract stays the same — your integration won't notice.",
      },
    ],
  },
  {
    title: 'Bundled LLM + BYOK',
    entries: [
      {
        q: 'What is the bundled LLM?',
        a: 'Driftstack\'s optional AI agent feature drives sessions with a large language model — useful for natural-language test specifications, automated screenshot diffing, or LLM-driven flow exploration. On Builder / Scale / Enterprise, you have two options: <strong>BYOK</strong> (bring your own API key — get one from your model provider, e.g. <a href="https://console.anthropic.com" class="text-tk-accent-text underline" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>; your model spend goes to your provider account, not Driftstack), or use the bundled rate (Driftstack proxies the calls and bills you on one invoice at a markup over the published per-token price).',
      },
      {
        q: 'How do agent sessions work?',
        a: 'An <strong>agent session</strong> layers a chat-style decompose-and-execute loop on top of a regular driver session. You send a user message (e.g. <span class="font-mono">"open https://example.com and capture a screenshot"</span>); the decomposer translates it into structured intents (<span class="font-mono">navigate</span>, <span class="font-mono">interact</span>, <span class="font-mono">wait</span>, <span class="font-mono">capture</span>); the runtime executes them. Three modes: <strong>AI</strong> (default — every message goes through decompose), <strong>manual</strong> (pass-through for clients driving via their own UI), and <strong>pair</strong> (interactive takeover — AI drives by default, the customer can take over and hand back). Live transcript via Server-Sent Events. Full reference at <a href="https://docs.driftstack.dev/api/agent-sessions/" class="text-tk-accent-text underline">docs.driftstack.dev/api/agent-sessions</a>.',
      },
      {
        q: "What's the BYOK markup?",
        a: 'Per-token pricing for the bundled rate is announced at launch. BYOK incurs no Driftstack markup — your Anthropic API key, your bill, your control. Set a stored BYOK key via the dashboard <span class="font-mono">/settings</span> page, <span class="font-mono">PUT /v1/account/me/byok-anthropic-key</span>, or per-request via the <span class="font-mono">x-byok-anthropic-api-key</span> header. Bundled-LLM consent (<span class="font-mono">PATCH /v1/account/me/bundled-llm-settings</span>) is tier-gated: Team, Agency, and API Starter are BYOK-only; API Builder, API Scale, and Enterprise support bundled-LLM with consent. The bundled-LLM consent UI lands at v1.1 (use the PATCH endpoint directly until then); the read-only bundled-LLM status panel is already on <span class="font-mono">/agent-sessions</span>.',
      },
      {
        q: 'Is BYOK secret-handling secure?',
        a: 'Yes. Your Anthropic API key is encrypted at rest with envelope encryption, decrypted in-memory only at session execution time, and never logged. The DPA covers the handling shape. Self-hosted customers can use their own KMS for the envelope key.',
      },
    ],
  },
  {
    title: 'EU stack + compliance',
    entries: [
      {
        q: 'Where is my data stored?',
        a: 'Customer data is hosted in the EU. Compute, database, and object storage are all EU-resident. Session execution may run in supported regions outside the EU under standard contractual clauses (SCCs) and the EU-US Data Privacy Framework. Our complete sub-processor list, with locations and contractual basis, is published at <a href="/trust/sub-processors" class="text-tk-accent-text underline">/trust/sub-processors</a> and in the <a href="/legal/dpa" class="text-tk-accent-text underline">Data Processing Agreement</a>.',
      },
      {
        q: 'Can I pick which region my data is stored in?',
        a: 'You can state a region preference (US / EU / APAC) from <span class="font-mono">/settings → Region</span>; for v1 it\'s informational only. Every customer\'s data sits on EU-jurisdiction infrastructure today regardless of preference selected. The preference exists so we can route you to the matching region automatically once the multi-region rollout lands; we\'ll give you 30 days\' notice under the DPA Article 28 sub-processor amendment process before any of your data is migrated, with the right to keep your data in the EU or terminate the affected portion of the service. The trust page at <a href="/trust/sub-processors" class="text-tk-accent-text underline">/trust/sub-processors</a> covers this in the same plain language as the dashboard.',
      },
      {
        q: 'What does my team see when I add them to my account?',
        a: 'Team members with the <em>member</em> role see read-only views of your sessions, profiles, API keys, webhooks, audit log, and usage. Members with the <em>admin</em> role can also create/update/delete those resources. They never see your billing, your password, or your MFA recovery codes. When a member acts on your account, the audit log records both the action AND the calling member\'s account id (so you can see who on your team did what without correlating across separate identity systems). The audit log entry also captures IP/user-agent context for sign-in/sign-out events; that context is visible to both you and to any team member with read access on your account, so don\'t add team members you wouldn\'t share that level of detail with. Full reference: <a href="https://docs.driftstack.dev/api/team/" class="text-tk-accent-text underline">docs.driftstack.dev/api/team</a>.',
      },
      {
        q: 'Are you GDPR-compliant?',
        a: 'Yes. Privacy Policy + DPA + Acceptable Use Policy are linked in the footer. Sub-processor list is documented in the DPA Annex 3. Customer-controlled retention defaults to 30 days, settable 1–365 or disable. Right-to-erasure requests honoured within 30 days. The legal documents are baseline drafts under counsel review; first paying customer onboards only after counsel review completes.',
      },
      {
        q: 'Do you have a SOC 2 / ISO 27001 audit?',
        a: 'Not at v1. SOC 2 / ISO 27001 are roadmap items for post-first-paying-customer; the relevant compliance posture for v1 is GDPR + the standard EU SCCs + DPF transfers. Self-hosted is the immediate path for customers requiring host-level certification beyond what the cloud SKU provides.',
      },
      {
        q: 'Where do I read the Terms / Privacy / DPA / AUP?',
        a: 'Footer of every page links to the four documents at /legal/*. Customer acceptance is recorded at API key issuance time with a versioned content hash; document version bumps trigger re-acceptance per the DPA Art 28 sub-processor amendment mechanism.',
      },
    ],
  },
  {
    // V-500 — architecture + sessions group. Three buyer-recurring
    // questions buried in support threads pre-launch; pulling them
    // up so prospects answer themselves.
    title: 'Architecture + sessions',
    entries: [
      {
        q: 'Are these real iPhones or emulated?',
        a: "Neither — and that's the point. Driftstack runs the same browser code Apple ships on the iPhone: a fork of the WebKit + Safari source (the same C++ that ships on iOS), running on macOS Apple Silicon fleet hardware (M-series Macs). Macs and iPhones share the same Apple chip family, so the engine is identical to what runs on a physical iPhone — same JavaScriptCore, same WebCore, same fingerprint primitives, and crucially the same GPU silicon family. Every surface a detector can check from JavaScript (canvas, WebGL, audio, navigator, prototype chain, error stacks) matches a real iPhone bit-for-bit, because it's produced by the same code on the same chip family. The only surfaces that diverge are ones no website can read from JavaScript (kernel timings deep below the API), and detection methods that target those are vanishingly rare in practice.",
      },
      {
        q: 'Does Driftstack work with Playwright / Selenium / Puppeteer?',
        a: 'Not by connecting them directly — there is no CDP passthrough. Driftstack does not expose a Chrome DevTools Protocol WebSocket or a WebDriver endpoint, so <span class="font-mono">connectOverCDP()</span>, <span class="font-mono">puppeteer.connect()</span>, and Selenium/WebDriver clients cannot attach to a session. Instead you drive sessions through the typed Driftstack SDK over structured REST actions — <span class="font-mono">navigate</span>, <span class="font-mono">interact</span> (tap / type / scroll / press), <span class="font-mono">wait</span>, <span class="font-mono">capture</span>, <span class="font-mono">extract</span>, <span class="font-mono">state</span>, <span class="font-mono">search</span>, and <span class="font-mono">login</span>. If you have an existing Playwright/Puppeteer script, you reshape it into those discrete actions rather than pointing the same client at a new endpoint. SDK quickstarts at <a href="https://docs.driftstack.dev/sdk/typescript-quickstart" class="text-tk-accent-text underline">/sdk/typescript-quickstart</a>, <a href="https://docs.driftstack.dev/sdk/python-quickstart" class="text-tk-accent-text underline">/sdk/python-quickstart</a>, <a href="https://docs.driftstack.dev/sdk/go-quickstart" class="text-tk-accent-text underline">/sdk/go-quickstart</a>.',
      },
      {
        q: 'Where do my sessions actually run?',
        a: 'EU production runs single-region. Customer data — accounts, profiles, audit logs, session recordings — stays in the EU. The <a href="/trust/sub-processors" class="text-tk-accent-text underline">sub-processor list</a> has the full breakdown with each provider\'s region. Latency from EU customer locations is typically &lt;30ms to the API control plane and &lt;100ms session round-trip on the data plane. US/APAC customers see proportionally higher session round-trip from the EU origin.',
      },
    ],
  },
  {
    // V-500 — migrating-from group. The four named alternatives in
    // /comparison are the natural origin systems; explicit migration
    // steps reduce discovery friction.
    title: 'Migrating from another vendor',
    entries: [
      {
        q: 'Migrating from Browserless / Bright Data / ScrapingBee / Browserbase?',
        a: 'It is not a one-line endpoint swap — Driftstack has no CDP passthrough to point your existing Playwright/Puppeteer client at. Migration means reshaping your script into Driftstack\'s discrete REST actions (<span class="font-mono">navigate</span> / <span class="font-mono">interact</span> / <span class="font-mono">wait</span> / <span class="font-mono">capture</span> / <span class="font-mono">extract</span>) driven through the typed SDK. The fingerprint surface also changes (you go from Chromium to real WebKit), so any test or production flow that depended on Chrome-specific behaviours (a specific user-agent string, Chrome-only DevTools commands, Blink-specific CSS bugs) needs adjustment too. The <a href="/comparison" class="text-tk-accent-text underline">comparison page</a> covers feature-by-feature differences; we publish step-by-step migration guides for the common Chromium vendors — <a href="/docs/migration-from-browserless" class="text-tk-accent-text underline">migrating from Browserless</a> and <a href="/docs/migration-from-puppeteer" class="text-tk-accent-text underline">migrating from Puppeteer</a>. Email <a href="mailto:support@driftstack.dev" class="text-tk-accent-text underline">support@driftstack.dev</a> if you want a hand reshaping your test suite before you cut over.',
      },
      {
        q: 'Can I run a side-by-side comparison before committing?',
        a: "Yes — that's exactly what the free tier is for. Run manual sessions through Driftstack in parallel with your current vendor and compare outputs at no cost. Many customers convert to a paid tier after seeing real fingerprint match rates in their actual flows; some discover their detection-evasion problem isn't worth solving and stay on a Chromium service. Either outcome is fine — we'd rather you make the right call than the upsell.",
      },
    ],
  },
  {
    // V-500 — acceptable-use group. Pre-empts the "can I do shady
    // thing X" inquiries that pad support inboxes; the AUP link is
    // also explicit so prospects can read the boundary before
    // emailing.
    title: 'Acceptable use',
    entries: [
      {
        q: 'Is X allowed? (sneaker bots / scraping / ad fraud / etc.)',
        a: 'The full Acceptable Use Policy is at <a href="/legal/aup" class="text-tk-accent-text underline">/legal/aup</a> — read it before signing up if you\'re unsure. Short version: Driftstack is built for legitimate automation — QA, accessibility testing, market research, regulated-industry compliance testing, agency multi-client management, AI-agent-driven flows. We don\'t allow attacks on third-party systems, fraud (ad fraud, fake-account creation, payment fraud), CSAM or other illegal content, large-scale scraping that violates target ToS in a way that bypasses authentication or reasonable rate limits, or operating sneaker bots / ticket bots against vendors who have publicly prohibited bot purchasing. Suspected abuse triggers an account review under the AUP escalation flow; persistent violations terminate the account.',
      },
      {
        q: 'What happens if Driftstack as a business goes away?',
        a: 'Two protections. (1) <strong>Data portability:</strong> profiles + audit logs + session metadata can be exported as CSV/JSON from the dashboard or via the API at any time, so customers can take their data with them on any timeline. (2) <strong>Self-hosted SKU:</strong> Enterprise + Self-hosted licensees receive source escrow — if the cloud service is sunsetted, the source escrow agreement releases the WebKit fork + control-plane code so customers can continue running the stack on their own hardware indefinitely. We carry no investors and no debt, so the most likely "Driftstack goes away" scenario is a planned wind-down with months of notice, not a sudden shutoff. Self-hosted on day one is the answer for customers who can\'t accept any cloud-vendor risk.',
      },
    ],
  },
  {
    title: 'Support + reliability',
    entries: [
      {
        q: 'How do I contact support?',
        a: 'Email <a href="mailto:support@driftstack.dev" class="text-tk-accent-text underline">support@driftstack.dev</a>. Reply target is 48h business-time across every tier — replies are written, not template-blasted, so they take honest time. Slack Connect is available on request once a paid subscription is active.',
      },
      {
        q: 'What if a session fails?',
        a: 'Session lifecycle is observable end-to-end via the SDK and the dashboard. Failed sessions return structured error responses (RFC 9457 problem-types); recordings + state captures up to the failure point stay available. Sessions that fail in the orchestration layer (driver crashes, fleet unavailability, etc.) do not consume your concurrent slot — the slot frees immediately on failure detection.',
      },
      {
        q: "What's the uptime target?",
        a: 'Best-effort 99.5% across all tiers. There is no formal SLA with credits — Driftstack is a small operation and a tiered uptime ladder would be theatre rather than a real obligation we can stand behind. The <a href="https://status.driftstack.dev" class="text-tk-accent-text underline">status page</a> publishes incidents with timestamps + RCAs. If an incident hurts your workload meaningfully, email <a href="mailto:support@driftstack.dev" class="text-tk-accent-text underline">support@driftstack.dev</a> with concrete impact and we will work out a credit in good faith.',
      },
    ],
  },
];

// Group-title → slug for deep-linkable FAQ groups (e.g. /faq#acceptable-use,
// /faq#architecture-sessions). Lowercase, drop '+', map any non-alphanumeric
// run to a single '-', and trim leading/trailing '-'.
export function faqGroupSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/\+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Plain-string answer form for the FAQPage JSON-LD: strip the limited
// inline HTML, decode the few entities the answers use, and collapse
// whitespace. Every word of the rendered answer survives, so the
// schema declares exactly what the page shows.
export function faqPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
