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
        a: 'Manual means a person drives the session — you click around in our desktop app the way you would on a real phone. It\'s built for solo operators, account managers, and agencies juggling many profiles. API means your code drives the session — you get the SDK (our ready-made code library), your scripts start sessions themselves, and you can automate at scale. Underneath, both get the same engine, the same fingerprints, the same faithfulness to the real device; what differs is how you drive it and the concurrent caps. Each Driftstack account holds one subscription. If you need both — say your team works in the desktop app AND your engineering team runs automation — run two accounts. Most customers find one path is enough; if you outgrow it, the second account is straightforward to provision. See <a href="/pricing/#manual" class="text-tk-accent-text underline">Manual pricing</a> or <a href="/pricing/#api" class="text-tk-accent-text underline">API pricing</a>.',
      },
      {
        q: 'How does this compare to Chromium-cloud stealth services?',
        a: "Chromium-cloud services take Chrome and dress it up with 'stealth' plugins — a faked identity string plus patched-over JavaScript functions that intercept the checks websites run (on canvas, WebGL, and the navigator object — e.g. replacing built-ins like Object.getOwnPropertyDescriptor). The disguise holds if a website only checks the painted-over surfaces; it fails the moment a detector looks underneath — at timing, at how errors are worded, at the graphics chip's raw output. Driftstack runs Apple's actual WebKit browser code, so there is no underneath: the fingerprint your session shows is the one a real iPhone shows, produced by the same code all the way down.",
      },
      {
        q: 'How does concurrent metering work?',
        a: "<strong>Concurrent</strong> means how many sessions you can run at the same time — think of it like the number of browser tabs you have open at once. That's the only thing we meter on paid tiers. Per-tier caps: Personal = 1 concurrent / Team = 3 / Agency = 8 / API Starter = 2 / API Builder = 8 / API Scale = 24 / Enterprise = custom. Within your cap, run as many session-hours as you want — a 5-minute session and a 6-hour session count exactly the same. The cap only limits how many run side by side; your monthly total is whatever your sessions produce running continuously. No monthly meter, no per-hour metering, no overage line items. The free tier has no metering at all — one concurrent session, no usage charges.",
      },
      {
        q: 'What happens when I hit my concurrent cap?',
        a: 'Starting one session too many simply fails with a clear error — nothing already running is touched. Existing in-flight sessions are not interrupted. The cap is only checked when a session starts, never mid-session. (For developers: the request fails with HTTP 429 + a structured RFC 9457 problem-detail naming the cap and, where applicable, the next tier up.) To raise the cap, upgrade to a higher tier or contact sales for Enterprise custom limits.',
      },
      {
        q: 'Are there setup fees on any tier?',
        a: 'No. No setup fees, no implementation fees, no minimum-monthly-volume commitments on any subscription tier. The free tier is $0 forever; subscriptions bill monthly or annually at the listed price + sales tax (VAT/BTW) where it applies.',
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
        a: 'One persistent profile, one concurrent session, and sessions up to 20 minutes each, driven from our desktop app — $0 forever, no card required. The free tier is manual-only (no API/SDK access from code); it exists so you can try the real thing before paying anything: open real iPhone Safari sessions on real WebKit and watch the fingerprint match in your own flows.',
      },
      {
        q: 'Does the free tier expire?',
        a: 'No. The free tier is perpetual — there is no time window, no credit that runs out, and no auto-charge. Stay on it as long as you like.',
      },
      {
        q: 'Can I use the API or SDK on the free tier?',
        // S43 2026-07-07 (founder-approved) — claims fix: the old
        // answer claimed code access began only on the API ladder,
        // but TIER_FEATURES gives every paid tier (including the
        // Manual ladder) apiAccess: true with live keys. The free
        // tier's manual-only claim is true and stays.
        a: 'No — the free tier is manual-only and runs through our desktop app. Every paid tier, including the Manual tiers, includes programmatic API/SDK access with live keys; paid tiers also drop the per-session time cap. The API ladder (API Starter from $149/mo) is the path built and sized for code-first workloads, with concurrent caps that scale further (up to 24 sessions side by side on API Scale). The free tier lets you evaluate the real iPhone Safari fingerprint hands-on before committing to automation.',
      },
      {
        q: 'Is there any usage metering on the free tier?',
        a: 'None. No per-hour metering, no credit decrement, no overage. One concurrent session is the only limit, and within it you can run as many manual session-hours as you want.',
      },
      {
        q: 'How do I move from the free tier to a paid tier?',
        // S43 2026-07-07 (founder-approved) — claims fix: programmatic
        // access is included on every paid tier (TIER_FEATURES
        // apiAccess: true across the paid ladder), not only the API
        // ladder; the old "(on the API ladder)" qualifier was false.
        a: 'Subscribe to any Manual or API tier through Stripe Checkout from your dashboard. Your existing profile and account carry over; the higher concurrent + profile limits and programmatic API access (included on every paid tier) apply immediately on activation.',
      },
    ],
  },
  {
    title: 'Tiers + upgrades',
    entries: [
      {
        q: 'Can I upgrade or downgrade mid-month?',
        a: 'Yes. Stripe prorates the price change automatically at the changeover date. New concurrent + profile limits apply immediately on the next session-creation request and the next profile-creation request. Anything already running or saved is untouched at the changeover; only new sessions and profiles are checked against the new limits.',
      },
      {
        q: 'What if I cancel?',
        // S31 2026-07-07 (fable-truth-audit) — the old answer described a
        // suspended-state + 90-day-purge flow that does not exist:
        // Stripe cancellation downgrades the account to the perpetual
        // free tier (services/stripe-webhooks.ts), nothing is deleted,
        // and no 'subscription needs renewing' error exists.
        a: 'Service continues through the end of your current billing period. After that your account moves to the free tier automatically — nothing is deleted, your profiles and account data stay, and you can resubscribe any time. Free-tier limits then apply (1 profile, 1 concurrent session, manual-only). Invoice history is retained for the legally-required period.',
      },
      {
        q: 'How does Enterprise pricing work?',
        a: 'Enterprise is custom — from $4,000/mo on annual contracts only. Actual pricing depends on how many sessions you run at once, how many profiles, custom device types (archetypes), how you want AI usage billed (your own Anthropic key, or through us), and any compliance paperwork (custom data-protection agreement terms and add-ons). Email <a href="mailto:sales@driftstack.dev" class="text-tk-accent-text underline">sales@driftstack.dev</a> with a description of your workload and team.',
      },
    ],
  },
  {
    title: 'Billing + payments',
    entries: [
      {
        q: 'Why Stripe?',
        a: 'Stripe is our payment processor. Card statements show "STRIPE *DRIFTSTACK". Receipts come from Stripe. Subscription management goes through the Stripe Customer Portal. Stripe handles PCI compliance (the card-security rules), fraud protection, payment disputes, and EU VAT/BTW reverse-charge (the EU tax rules for business buyers) — we rely on Stripe for all of that rather than rebuilding it ourselves.',
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
        a: 'Yes — via NowPayments on tiers where crypto checkout is enabled. Open the crypto checkout from the billing dashboard, send the displayed amount in the displayed currency, and the order moves through pending → confirming → paid as on-chain confirmations land. (For developers: the webhook events — the automatic notifications our system sends yours as a payment progresses — are documented in the <a href="https://docs.driftstack.dev/webhooks/crypto-events/" class="text-tk-accent-text underline">crypto webhook events docs</a>.) <strong>Crypto payments are non-refundable</strong> — you can cancel anytime, which stops future billing, but the current period is not refunded (see <a href="/legal/refunds/" class="text-tk-accent-text underline">refund policy</a>). Most customers use Stripe; crypto is a fallback for jurisdictions where card payments are awkward.',
      },
      {
        q: "How can I tell how much I've spent this month?",
        a: 'The desktop app shows a Cost panel with this month\'s spend broken down by component: compute, storage, network traffic out (egress), email, and AI usage — plus whether you\'re on track for your tier\'s cap, approaching it, or over it. Developers can fetch the same numbers from GET <code class="font-mono">/v1/account/cost</code> (totals in whole cents; the on-track state is reported as under-soft / between / over-hard). See the <a href="/docs/cost-monitoring/" class="text-tk-accent-text underline">cost-monitoring docs</a>.',
      },
      {
        q: "What if I cross my tier's cap?",
        a: 'You get one email when your spending passes the early-warning level (the "soft cap") and another if it crosses the hard cap. Nothing is auto-blocked — running sessions stay running. The account team reaches out to discuss raising the cap or moving to a higher tier. We don\'t silently kill traffic to enforce a soft cap.',
      },
      {
        q: 'Are the spend numbers live or cached?',
        a: "Live — recalculated every time you look. If traffic grows we may switch to nightly pre-computed snapshots, but the API response shape won't change, so anything you've built on it keeps working.",
      },
    ],
  },
  {
    title: 'Bundled LLM + BYOK',
    entries: [
      {
        q: 'What is the bundled LLM?',
        a: 'Driftstack\'s optional AI agent feature drives sessions with a large language model (LLM) — useful for describing tests in plain English, automatically spotting what changed between screenshots, or letting the AI explore a flow on its own. On Builder / Scale / Enterprise, you have two options: <strong>BYOK</strong> (bring your own API key — get one from your model provider, e.g. <a href="https://console.anthropic.com" class="text-tk-accent-text underline" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>; the AI usage is then billed to you by your provider, not Driftstack), or use the bundled rate (Driftstack carries the AI calls for you and bills them on one invoice, at a markup over the provider\'s published price — AI usage is metered in "tokens", small chunks of text).',
      },
      {
        q: 'How do agent sessions work?',
        a: 'An <strong>agent session</strong> sits on top of a regular session and works like a chat: you type what you want (e.g. <span class="font-mono">"open https://example.com and capture a screenshot"</span>), the AI breaks it into concrete steps (<span class="font-mono">navigate</span>, <span class="font-mono">interact</span>, <span class="font-mono">wait</span>, <span class="font-mono">capture</span>), and the session carries them out. Three modes: <strong>AI</strong> (default — the AI plans every message), <strong>manual</strong> (your own app passes instructions straight through), and <strong>pair</strong> (the AI drives, but you can take over and hand back). You can watch a live transcript as it runs (streamed via Server-Sent Events, for developers). Full reference at <a href="https://docs.driftstack.dev/api/agent-sessions/" class="text-tk-accent-text underline">docs.driftstack.dev/api/agent-sessions</a>.',
      },
      {
        q: "What's the BYOK markup?",
        a: 'Per-token pricing for the bundled rate is announced at launch. BYOK incurs no Driftstack markup — your Anthropic API key, your bill, your control. Set a stored BYOK key via the dashboard <span class="font-mono">/settings</span> page, <span class="font-mono">PUT /v1/account/me/byok-anthropic-key</span>, or per-request via the <span class="font-mono">x-byok-anthropic-api-key</span> header. Which tiers may use which billing: Team, Agency, and API Starter are BYOK-only; API Builder, API Scale, and Enterprise support bundled-LLM with consent — an explicit opt-in (for developers: <span class="font-mono">PATCH /v1/account/me/bundled-llm-settings</span>). The dashboard switch for that opt-in arrives at v1.1 (until then, use the PATCH endpoint directly); a read-only bundled-LLM status panel is in the desktop app.',
      },
      {
        q: 'Is BYOK secret-handling secure?',
        a: "Yes. Your Anthropic API key is encrypted at rest with envelope encryption, decrypted in-memory only at session execution time, and never logged. In plain terms: the key is stored encrypted, the key that unlocks it is itself locked away separately, and it's only readable in memory for the moment a session runs. Our data-processing agreement (DPA) covers exactly how it's handled. Self-hosted customers can hold the outer (envelope) key in their own key-management system (KMS).",
      },
    ],
  },
  {
    title: 'EU stack + compliance',
    entries: [
      {
        q: 'Where is my data stored?',
        // S30 2026-07-07 (founder decision: soften) — "object storage
        // ... EU-resident" over-claimed: file objects (avatars,
        // uploads) live on Cloudflare R2 in the default jurisdiction
        // (EU + US replication), not the .eu-jurisdiction endpoint.
        // DB-resident data (accounts, profiles, audit logs, session
        // metadata) genuinely lives on EU Hetzner/Neon servers.
        a: 'Customer data in our databases — your account, profiles, audit logs, session metadata — is hosted in the EU: compute and database are EU-resident. Uploaded files (your avatar, for example) use Cloudflare\'s R2 storage network, which can replicate outside the EU. Session execution may run in supported regions outside the EU under standard contractual clauses (SCCs) and the EU-US Data Privacy Framework — the legal mechanisms EU law provides for data that leaves the EU. Our complete sub-processor list, with locations and contractual basis, is published at <a href="/trust/sub-processors/" class="text-tk-accent-text underline">/trust/sub-processors</a> and in the <a href="/legal/dpa/" class="text-tk-accent-text underline">Data Processing Agreement</a>.',
      },
      {
        q: 'Can I pick which region my data is stored in?',
        // S30 2026-07-07 (founder decision: soften) — scoped "data" to
        // "account data": R2-held files carry no EU-residency guarantee.
        a: 'You can state a region preference (US / EU / APAC) from <span class="font-mono">/settings → Region</span>; for v1 it\'s informational only. Every customer\'s account data sits on EU-jurisdiction infrastructure today regardless of preference selected. The preference exists so we can route you to the matching region automatically once the multi-region rollout lands; we\'ll give you 30 days\' notice before any of your data is moved — following the DPA\'s Article 28 process for changing sub-processors (the outside vendors that handle your data) — with the right to keep your data in the EU or terminate the affected portion of the service. The trust page at <a href="/trust/sub-processors/" class="text-tk-accent-text underline">/trust/sub-processors</a> covers this in the same plain language as the dashboard.',
      },
      {
        q: 'What does my team see when I add them to my account?',
        a: 'Team members with the <em>member</em> role see read-only views of your sessions, profiles, API keys, webhooks, audit log, and usage. Members with the <em>admin</em> role can also create/update/delete those resources. They never see your billing, your password, or your MFA recovery codes. When a member acts on your account, the audit log records both the action AND which member did it — so you can see who on your team did what without cross-referencing anything. Sign-in and sign-out entries also record the IP address and browser used; that detail is visible to both you and any team member with read access on your account, so don\'t add team members you wouldn\'t share that level of detail with. Full reference: <a href="https://docs.driftstack.dev/api/team/" class="text-tk-accent-text underline">docs.driftstack.dev/api/team</a>.',
      },
      {
        q: 'Are you GDPR-compliant?',
        a: 'Yes. Privacy Policy + DPA + Acceptable Use Policy are linked in the footer. Sub-processor list is documented in the DPA Annex 3. Requests to have your data deleted (GDPR\'s "right to erasure") are honoured within 30 days. The legal documents are baseline drafts under counsel review; first paying customer onboards only after counsel review completes.',
      },
      {
        q: 'Do you have a SOC 2 / ISO 27001 audit?',
        a: "Not at v1. SOC 2 / ISO 27001 are roadmap items for after our first paying customer. For v1 the compliance basis is GDPR plus the EU's standard contractual clauses (SCCs) and the EU-US Data Privacy Framework (DPF) for any data leaving the EU. If you need the machines themselves certified beyond that, self-hosting on your own audited hardware is the immediate path.",
      },
      {
        q: 'Where do I read the Terms / Privacy / DPA / AUP?',
        a: "Footer of every page links to the four documents at /legal/*. When you create an API key we record exactly which version of each document you accepted (identified by a fingerprint of its contents); when a document changes, you're asked to accept the new version, following the DPA's Article 28 amendment process.",
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
        a: "Neither — and that's the point. Driftstack runs the same browser code Apple ships on the iPhone: our own build of Apple's WebKit + Safari source code (the same C++ program code that runs on iOS), running on Apple's M-series Macs (macOS, Apple Silicon). Macs and iPhones share the same Apple chip family, so the engine is identical to a physical iPhone's — the same JavaScript engine (JavaScriptCore), the same page-rendering engine (WebCore), the same building blocks a fingerprint is made from, and, crucially, the same family of graphics chips. Everything a website can measure from inside a page — drawing output (canvas), 3D graphics (WebGL), audio, and the browser's own internals (navigator, prototype chain, error stacks) — matches a real iPhone bit for bit, because the same code produces it on the same chip family. The only differences sit so deep in the operating system that no website can read them from a page (kernel timings far below the web's reach), and detection that targets those is vanishingly rare in practice.",
      },
      {
        q: 'Does Driftstack work with Playwright / Selenium / Puppeteer?',
        a: 'Not by connecting them directly — those tools speak Chrome\'s remote-control protocol (CDP / WebDriver), and Driftstack deliberately offers no CDP passthrough: no Chrome DevTools Protocol WebSocket, no WebDriver endpoint. <span class="font-mono">connectOverCDP()</span>, <span class="font-mono">puppeteer.connect()</span>, and Selenium/WebDriver clients cannot attach to a session. Instead you drive sessions through the typed Driftstack SDK over structured REST actions — <span class="font-mono">navigate</span>, <span class="font-mono">interact</span> (tap / type / scroll / press), <span class="font-mono">wait</span>, <span class="font-mono">capture</span>, <span class="font-mono">extract</span>, <span class="font-mono">state</span>, <span class="font-mono">search</span>, and <span class="font-mono">login</span>. If you have an existing Playwright/Puppeteer script, you reshape it into those discrete actions rather than pointing the same client at a new endpoint. SDK quickstarts at <a href="https://docs.driftstack.dev/sdk/typescript-quickstart/" class="text-tk-accent-text underline">/sdk/typescript-quickstart</a>, <a href="https://docs.driftstack.dev/sdk/python-quickstart/" class="text-tk-accent-text underline">/sdk/python-quickstart</a>, <a href="https://docs.driftstack.dev/sdk/go-quickstart/" class="text-tk-accent-text underline">/sdk/go-quickstart</a>.',
      },
      {
        q: 'Where do my sessions actually run?',
        // S26 2026-07-06 (#132) — accuracy fix (audit M5): the data
        // list previously said "session recordings", but recordings
        // are roadmap-only (docs/recordings.astro: planned, not
        // live). "Session metadata" is what we actually store —
        // mirrors the truthful export list in the
        // business-continuity answer below.
        // S30 2026-07-07 (founder decision: soften) — the listed
        // classes ARE DB-resident (EU-true), but "Everything ... EU"
        // was blanket; added the file-storage scope (R2 default
        // jurisdiction replicates EU + US).
        a: 'Sessions run in one EU region. Customer data in our databases — accounts, profiles, audit logs, session metadata — stays in the EU; uploaded files (avatars, for example) use Cloudflare\'s storage network, which can replicate outside the EU. The <a href="/trust/sub-processors/" class="text-tk-accent-text underline">sub-processor list</a> has the full breakdown with each provider\'s region. From EU locations, your commands typically reach our API in under 30 milliseconds, and a full round trip — your click going in, the live picture coming back — takes under 100. US and Asia-Pacific customers see proportionally longer round trips, since the sessions stay in the EU.',
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
        a: 'It is not just changing one URL — scripts built for those platforms can\'t connect to Driftstack directly (there is no CDP passthrough, the socket Chrome-automation tools plug into). Migration means reshaping your script into Driftstack\'s discrete REST actions (<span class="font-mono">navigate</span> / <span class="font-mono">interact</span> / <span class="font-mono">wait</span> / <span class="font-mono">capture</span> / <span class="font-mono">extract</span>) driven through the typed SDK. The fingerprint your sessions present changes too (you go from Chromium to real WebKit), so any test or production flow that depended on Chrome-specific behaviours (a specific user-agent string, Chrome-only DevTools commands, CSS bugs specific to Blink — Chrome\'s rendering engine) needs adjustment too. The <a href="/comparison/" class="text-tk-accent-text underline">comparison page</a> covers feature-by-feature differences; we publish step-by-step migration guides for the common Chromium vendors — <a href="https://docs.driftstack.dev/guides/migrate-from-browserless/" class="text-tk-accent-text underline">migrating from Browserless</a> and <a href="https://docs.driftstack.dev/guides/migrate-from-puppeteer/" class="text-tk-accent-text underline">migrating from Puppeteer</a>. Email <a href="mailto:support@driftstack.dev" class="text-tk-accent-text underline">support@driftstack.dev</a> if you want a hand reshaping your test suite before you cut over.',
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
        a: "The full Acceptable Use Policy is at <a href=\"/legal/aup/\" class=\"text-tk-accent-text underline\">/legal/aup</a> — read it before signing up if you're unsure. Short version: Driftstack is built for legitimate automation — QA, accessibility testing, market research, regulated-industry compliance testing, agency multi-client management, AI-agent-driven flows. We don't allow attacks on third-party systems, fraud (ad fraud, fake-account creation, payment fraud), CSAM (child sexual abuse material) or other illegal content, large-scale scraping that breaks a site's terms of service (ToS) by getting around logins or past a site's reasonable rate limits, or operating sneaker bots / ticket bots against vendors who have publicly prohibited bot purchasing. Suspected abuse triggers an account review under the Acceptable Use Policy's escalation process; persistent violations terminate the account.",
      },
      {
        q: 'What happens if Driftstack as a business goes away?',
        a: 'Two protections. (1) <strong>Data portability:</strong> profiles + audit logs + session metadata can be exported as CSV/JSON from the dashboard or via the API at any time, so customers can take their data with them on any timeline. (2) <strong>Self-hosted option:</strong> Enterprise + Self-hosted licensees receive source escrow — an independent third party holds a copy of our source code. If the cloud service is ever wound down, the escrow agreement releases the browser engine (the WebKit fork) and the management software (the control-plane code) so customers can keep running everything on their own hardware indefinitely. We carry no investors and no debt, so the most likely "Driftstack goes away" scenario is a planned wind-down with months of notice, not a sudden shutoff. Self-hosted on day one is the answer for customers who can\'t accept any cloud-vendor risk.',
      },
    ],
  },
  {
    title: 'Support + reliability',
    entries: [
      {
        q: 'How do I contact support?',
        // S43 2026-07-07 (founder-approved) — the 48h figure stays as
        // the honest operational target, now explicitly framed as a
        // target rather than a contractual SLA, and reconciled with
        // the ToS §9.2 Severity-1 first-response grant on API Scale +
        // Enterprise.
        a: 'Email <a href="mailto:support@driftstack.dev" class="text-tk-accent-text underline">support@driftstack.dev</a>. Reply target is 48h business-time across every tier — an operational target we hold ourselves to, not a contractual SLA. Replies are written, not template-blasted, so they take honest time. Slack Connect is available on request once a paid subscription is active. API Scale and Enterprise additionally carry a contractual first-response SLA on Severity-1 incidents (4 hours and 1 hour respectively) — see the <a href="/docs/sla-policy/" class="text-tk-accent-text underline">SLA policy</a>.',
      },
      {
        q: 'What if a session fails?',
        // S26 2026-07-06 (#132) — accuracy fix (audit M5): the answer
        // previously said "recordings + state captures up to the
        // failure point stay available", presenting recordings as a
        // live feature. Recordings are roadmap-only
        // (docs/recordings.astro: `record: true` is a no-op today;
        // roadmap.astro lists "Workflow recording" under NEXT), and
        // captures return inline for you to keep — we don't retain
        // them server-side. Reworded to what exists today.
        a: 'You can see everything a session did, start to finish, in the dashboard or from the SDK. A failed session returns a clear, machine-readable error (RFC 9457 problem-types, for developers), and any captures you took before the failure — screenshots, page snapshots, PDFs — are already in your hands, because capture results return to you the moment you take them. (Session video recording is on the <a href="/roadmap/" class="text-tk-accent-text underline">roadmap</a>, not live yet.) Sessions that fail on our side (a crash, no machine available) do not consume your concurrent slot — the slot frees immediately on failure detection.',
      },
      {
        q: "What's the uptime target?",
        // S43 2026-07-07 (founder-approved) — aligned to the binding
        // ToS §9: the old answer ("no formal SLA with credits" on any
        // tier) contradicted §9.2, which grants API Scale + Enterprise
        // a contractual SLA (99.9% monthly availability) published at
        // /docs/sla-policy. The §9.1 tiers remain best-effort with no
        // contractual commitment — that part was true and stays.
        a: 'Two answers, per the <a href="/legal/terms/" class="text-tk-accent-text underline">Terms</a> §9. On the Free, Manual (Personal / Team / Agency), API Starter, and API Builder tiers there is no contractually-binding SLA — we run best-effort (operationally we aim for 99.5%+) but do not commit to a specific uptime percentage, because a promise we could not stand behind would be theatre. API Scale and Enterprise carry a contractual SLA: 99.9% monthly availability with service credits, published in full at the <a href="/docs/sla-policy/" class="text-tk-accent-text underline">SLA policy</a>. Either way, the <a href="https://status.driftstack.dev" class="text-tk-accent-text underline">status page</a> publishes incidents with timestamps + a written root-cause analysis (RCA) for each, and if an incident hurts your workload meaningfully on any tier, email <a href="mailto:support@driftstack.dev" class="text-tk-accent-text underline">support@driftstack.dev</a> with concrete impact and we will work out a credit in good faith.',
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
