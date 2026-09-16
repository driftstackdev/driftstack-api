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
//
// 2026-09-16 READABILITY PASS (owner: "make things more 'noob'
// friendly ... most importantly website text"). The FAQ is what a
// hesitant buyer reads, so every answer now opens with the DIRECT
// answer in one short sentence, and the detail follows. Nothing
// factual moved: every tier gate, number, limit and disclosure is
// the same, and the strings the drift guards pin are kept verbatim.
// The shape to hold when editing:
//   sentence 1 = the answer a nervous reader needs ("No.", "Yes —
//                three ways.", "You keep everything.")
//   then       = the detail, in short sentences
//   last       = "(For developers: ...)" for the precise contract
// A term only appears once the same sentence has explained it in
// plain words (SDK = ready-made code libraries; concurrent = browser
// tabs open at once; canvas = the picture the browser draws).
//
// ⛔ 2026-09-16 VERIFIER FIX — the lead sentence is the DANGEROUS part of
// that shape. It is what a hesitant reader takes away, so a lead that
// generalises a gate, broadens a disclosure or omits the restriction the
// question was asked about is a FALSE ANSWER even when the body four
// sentences later is exactly right. Five landed in the pass above:
//
//   • "What is the bundled LLM?" opened "AI model access that comes with
//     your plan" — false for Team, Agency and API Starter, which are
//     byok_only in TIER_FEATURES. The lead is now gated to Builder /
//     Scale / Enterprise and names the BYOK tiers in the same breath.
//   • The concurrency answer attributed the $0.10 monthly budget to "the
//     optional AI assistant". The assistant runs on the BYOK-only tiers
//     too, where there is no Driftstack budget at all. Subject restored
//     to bundled model access.
//   • "Why Stripe?" widened the card disclosure — it swapped the pinned
//     noun (card NUMBER) for "card details", and the pinned verb
//     (never TOUCHES) for a "never reaches" form. Card metadata DOES
//     reach the server (Stripe's payment_method.attached webhook body is
//     delivered and handled; nothing card-related is persisted). The lead
//     now uses the narrow disclosure verbatim.
//   • "Is X allowed?" answered "Fraud and attacks, no" — naming neither
//     of the two cases in its own question. The lead now names the bot
//     and scraping boundaries, and the 59-word prohibition (the longest
//     sentence on the page) is four sentences.
//   • "Are these real iPhones?" had swapped the subject of the Mac↔iPhone
//     sentence from the ENGINE (what is actually checked) to the BROWSER
//     as a whole — a blanket behavioural-equivalence claim of the family
//     Rule 4 retires — while DROPPING one of the enumerated items it
//     rested on. Subject scoped back to "the engine runs the way it runs
//     on a phone".
//
// ⚠️ The retired phrasings are deliberately NOT quoted verbatim anywhere in
// this file, comments included. The honesty guards read the whole file as
// one string, so a comment that reproduces a forbidden phrase fails the
// negative pin that exists to keep that phrase out of the copy.
//
// These are pinned in faq-tier-cap-parity.test.ts (against TIER_FEATURES,
// not against text alone) and faq-page-content-parity.test.ts. And the two
// workspace honesty sweeps now WALK this file: they targeted only
// `src/pages` + `.astro|.md`, so every FAQ answer had been outside every
// overclaim sweep since the Fleet-v2 move out of faq.astro — which is how
// the three truth defects above landed with a green suite.

import { DEVICE_SUPPORT } from './capabilities.js';

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
        q: 'Why limit sessions at once, and not hours?',
        a: 'So you never have to watch a clock. Driftstack counts how many sessions you run at the same time, not how long each one stays open. Within that number, use them as much as you want — a session that sits open all day costs nothing extra. Most cloud-browser platforms bill by the hour instead, which quietly punishes you for leaving a session open. An account manager running 3 persistent profiles 8 hours a day generates about 720 browser-hours a month, and a surprise overage bill at the end of it. Here you upgrade when your team genuinely needs more sessions running side by side, not because a meter ran out.',
      },
      {
        q: "What's the difference between Manual and API?",
        a: 'Who does the driving — you, or your code. <strong>Manual</strong> means a person drives the session: you click around in our desktop app the way you would on a real phone. It is built for people working on their own, account managers, and agencies juggling many profiles. <strong>API</strong> means your code drives the session: your scripts start sessions themselves, using our ready-made code libraries (the SDK), so you can automate at scale. Underneath, both get the same browser and the same match to a real iPhone. What differs is who drives, and how many sessions can run at once. Each Driftstack account holds one subscription. If you need both — your team in the desktop app, your engineers automating — run two accounts. Most customers find one path is enough, and setting up the second account later is straightforward. See <a href="/pricing/#manual" class="text-tk-accent-text underline">Manual pricing</a> or <a href="/pricing/#api" class="text-tk-accent-text underline">API pricing</a>.',
      },
      {
        q: 'How is this different from Chrome-based "stealth" services?',
        a: "They dress Chrome up as something else. Driftstack dresses nothing up. Those services run Chromium — the open-source core of Chrome — and add 'stealth' plugins: a faked identity line, plus patched-over functions that intercept the checks a website runs on graphics, fonts, and the browser's own behaviour. The disguise holds while a website only looks at the painted-over surfaces. It fails the moment a detector looks underneath — at timing, at how errors are worded, at the graphics chip's raw output. Driftstack runs a build of Apple's own WebKit — the engine family behind iPhone Safari, the code that actually draws the page. There is no painted-over surface to look underneath: the answers a website reads come from the engine itself, checked against real iPhones check by check.",
      },
      {
        q: 'How many sessions can I run at once ("concurrent")?',
        a: 'As many as your plan allows to run at the same time. That is what <strong>concurrent</strong> means — think of it as the number of browser tabs you can have open at once. Per-tier caps: Personal = 1 concurrent / Team = 3 / Agency = 8 / API Starter = 2 / API Builder = 8 / API Scale = 24 / Enterprise = custom. Within your cap, run as many session-hours as you want: a 5-minute session and a 6-hour session count exactly the same. The cap only limits how many run side by side. There is no monthly browser-hour meter, no per-hour charge, and no browser-usage overage line on your bill. The optional bundled model access on API Builder and up has a separate monthly budget of its own (see <a href="/faq/#bundled-llm-byok" class="text-tk-accent-text underline">Bundled LLM + BYOK</a>). The free tier likewise has no usage charges — one concurrent session is its capacity limit.',
      },
      {
        q: 'What happens if I start one session too many?',
        a: 'The extra one simply fails with a clear error, and nothing already running is touched. Existing in-flight sessions are not interrupted. The cap is only checked when a session starts, never mid-session. (For developers: the request fails with HTTP 429 + a structured RFC 9457 problem-detail naming the cap and, where applicable, the next tier up.) To raise the cap, upgrade to a higher tier, or contact sales for Enterprise custom limits.',
      },
      {
        q: 'Are there setup fees on any tier?',
        a: 'No. No setup fees, no implementation fees, and no minimum-monthly-volume commitments on any subscription tier. The free tier is $0 forever. Subscriptions bill monthly or annually at the listed price, plus sales tax (VAT/BTW) where it applies.',
      },
      {
        q: 'How does annual billing work?',
        a: 'Annual contracts are billed up front for 12 months at 20% off the monthly equivalent. If you switch from monthly to annual or back, the difference is worked out automatically for the remaining days of your billing period (prorated). Annual contracts auto-renew unless cancelled at least 30 days before renewal.',
      },
    ],
  },
  {
    title: 'Free tier',
    entries: [
      {
        q: 'What do I get on the free tier?',
        a: "One persistent profile, one concurrent session, and sessions up to 20 minutes each, driven from our desktop app — $0 forever, no card required. The free tier is manual-only (no API/SDK access from code). It exists so you can try the real thing before you pay anything: you open real iPhone Safari sessions, built from Apple's own browser engine, and see in your own flows what a website can measure about them. Sessions reach the internet through an exit you supply, so a website sees that address instead of ours. The free tier runs the iPhone 13 and iPhone 13 mini device profiles, exits through your own SOCKS5 proxy (VPN files are a paid-plan feature), and does not include the AI agent.",
      },
      {
        q: 'Does the free tier expire?',
        a: 'No. The free tier is perpetual: there is no time window, no credit that runs out, and no auto-charge. Stay on it as long as you like.',
      },
      {
        q: 'Can I use the API or SDK on the free tier?',
        // S43 2026-07-07 (founder-approved) — claims fix: the old
        // answer claimed code access began only on the API ladder,
        // but TIER_FEATURES gives every paid tier (including the
        // Manual ladder) apiAccess: true with live keys. The free
        // tier's manual-only claim is true and stays.
        a: 'No — the free tier is manual-only and runs through our desktop app. Every paid tier, including the Manual tiers, includes programmatic API/SDK access with live keys, and paid tiers also drop the per-session time cap. The API plans (API Starter from $149/mo) are built and sized for code-first workloads, with higher limits on how many sessions run at once — up to 24 side by side on API Scale. The free tier is there so you can try the real thing by hand before you commit to automating anything.',
      },
      {
        q: 'Does the free tier count my usage against anything?',
        // 2026-09-15 refuter fix: the old answer named one concurrent session
        // as the sole limit — false: the free tier also caps a session at 20 minutes
        // (MAX_SESSION_MINUTES_PER_TIER.free in services/sessions.ts; pricing.ts
        // hoursLabel '20-minute sessions'). Both limits are named here.
        // 2026-09-16 plain words: the old metering/decrement/overage phrasing was
        // vendor vocabulary to a first-time reader — same three facts, said plainly.
        a: 'No. Nothing is counted by the hour, no credits tick down, and there is no overage bill. The only limits are one session at a time and 20 minutes per session: a session that reaches 20 minutes ends on its own, and you can start another straight away, as often as you like.',
      },
      {
        q: 'How do I move from the free tier to a paid tier?',
        // S43 2026-07-07 (founder-approved) — claims fix: programmatic
        // access is included on every paid tier (TIER_FEATURES
        // apiAccess: true across the paid ladder), not only the API
        // ladder; the old "(on the API ladder)" qualifier was false.
        a: 'Subscribe to any Manual or API tier through Stripe Checkout, from your dashboard. Your existing profile and account carry over. The higher session and profile limits, and API access (included on every paid tier), apply immediately on activation.',
      },
    ],
  },
  {
    title: 'Tiers + upgrades',
    entries: [
      {
        q: 'Can I upgrade or downgrade mid-month?',
        a: 'Yes. The price difference is worked out automatically for the remaining days of your billing period. New session and profile limits apply the next time you start a session or create a profile. Anything already running or saved is untouched at the changeover — only new sessions and profiles are checked against the new limits.',
      },
      {
        q: 'What if I cancel?',
        // S31 2026-07-07 (fable-truth-audit) — the old answer described a
        // suspended-state + 90-day-purge flow that does not exist:
        // Stripe cancellation downgrades the account to the perpetual
        // free tier (services/stripe-webhooks.ts), nothing is deleted,
        // and no 'subscription needs renewing' error exists.
        a: 'You keep everything. Service continues through the end of your current billing period. After that your account moves to the free tier automatically — nothing is deleted, your profiles and account data stay, and you can resubscribe any time. Free-tier limits then apply (1 profile, 1 concurrent session, manual-only); the <a href="/faq/#free-tier" class="text-tk-accent-text underline">Free tier</a> section has the full shape — 20-minute sessions, iPhone 13 / 13 mini device profiles, proxy only, no AI agent. Invoice history is retained for the legally-required period.',
      },
      {
        q: 'How does Enterprise pricing work?',
        a: 'Enterprise is custom — from $4,000/mo on annual contracts only. What you pay depends on how many sessions you run at once, how many profiles you keep, custom device profiles, whether the AI uses your own Anthropic key or model access Driftstack provides, and any compliance paperwork (custom data-protection agreement terms and add-ons). Email <a href="mailto:sales@driftstack.dev" class="text-tk-accent-text underline">sales@driftstack.dev</a> with a description of your workload and team.',
      },
    ],
  },
  {
    title: 'Billing + payments',
    entries: [
      {
        q: 'Why Stripe?',
        a: 'Stripe is our payment processor, so your card number never touches our servers. Card statements show "STRIPE *DRIFTSTACK". Receipts come from Stripe. Subscription management goes through the Stripe Customer Portal. Stripe handles PCI compliance (the card-security rules), fraud protection, payment disputes, and EU VAT/BTW reverse-charge (the EU tax rules for business buyers) — we rely on Stripe for all of that rather than rebuilding it ourselves.',
      },
      {
        q: 'Where do I update my payment method or download invoices?',
        a: 'In the Stripe Customer Portal. It is linked from your Driftstack dashboard and from every Stripe receipt email. Payment-method updates, invoice downloads, subscription cancellations, and tax-ID configuration all live there.',
      },
      {
        q: 'Do you store my card details?',
        a: 'No. Card details are stored by Stripe, never by Driftstack. We hold a Stripe customer ID and the facts about your subscription; the card number itself never touches our servers.',
      },
      {
        q: 'Can I pay in crypto?',
        a: 'Yes — via NowPayments on tiers where crypto checkout is enabled. Open the crypto checkout from the billing dashboard, then send the displayed amount in the displayed currency. The order moves through pending → confirming → paid as confirmations land on the blockchain, and the desktop app shows each order\'s event timeline and downloads its receipt as PDF or plain text. (For developers: as an order progresses, our system can notify yours automatically — those webhook events are documented in the <a href="https://docs.driftstack.io/webhooks/crypto-events/" class="text-tk-accent-text underline">crypto webhook events docs</a>.) <strong>Crypto payments are non-refundable</strong> — you can cancel any time, which stops future billing, but the current period is not refunded (see <a href="/legal/refunds/" class="text-tk-accent-text underline">refund policy</a>). Most customers use Stripe; crypto is a fallback for places where card payments are awkward.',
      },
      {
        q: "Where can I see what I've actually been billed?",
        a: 'In Stripe. Stripe\'s Customer Portal and Stripe-issued invoices are payment truth for card subscriptions; crypto customers use their NowPayments order receipt. The desktop app\'s Cost panel and GET <code class="font-mono">/v1/account/cost</code> show something different: an estimate of what it costs Driftstack to serve your account in a calendar month (UTC) — not your invoice. Today only the session-time part of that estimate is filled in; storage, network traffic, email, and AI show zero for now. See the <a href="/docs/cost-monitoring/" class="text-tk-accent-text underline">cost-monitoring docs</a>.',
      },
      {
        q: 'What if that cost estimate crosses a threshold?',
        a: 'Nothing happens to your account. The threshold is an internal signal for Driftstack, not a spending cap on your account. Crossing it can show an in-app notification, but it does not send you a billing email, add anything to your invoice, block a new session, or interrupt work already running. The only limit on your sessions is still how many can run at once on your plan.',
      },
      {
        q: 'Is that cost estimate live, or an old snapshot?',
        a: 'Live. It is recalculated every time you look at it, from how many minutes your sessions have run. It does not read your Stripe invoices or any billing record.',
      },
    ],
  },
  {
    title: 'Bundled LLM + BYOK',
    entries: [
      {
        q: 'What is the bundled LLM?',
        a: 'Model access Driftstack provides on API Builder, API Scale and Enterprise, so you don\'t have to open an account with an AI provider yourself. On Team, Agency and API Starter you bring your own key. Driftstack\'s optional AI agent (Team plans and up, and every API plan) drives a session with a large language model (LLM) — the kind of AI you talk to in plain English. Describe the task, watch it run step by step, and approve or deny a step that looks like a purchase, a payment, or an account deletion. Where the model comes from depends on your plan. Team, Agency, and API Starter use your own model key (BYOK). On Builder / Scale / Enterprise, you have two options: <strong>BYOK</strong> (bring your own API key — get one from your model provider, e.g. <a href="https://console.anthropic.com" class="text-tk-accent-text underline" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>; the AI usage is then billed to you by your provider, not Driftstack), or use Driftstack-provided model access. On Builder and Scale, each AI turn counts $0.10 against a monthly budget you control; it is not a separate line on today\'s invoice. Enterprise can use a contracted custom budget.',
      },
      {
        q: 'How do agent sessions work?',
        a: 'You type what you want in plain English, and the session does it while you watch. An <strong>agent session</strong> (Team plans and up, and every API plan) sits on top of a regular session and works like a chat: you type the goal (e.g. <span class="font-mono">"open https://example.com and capture a screenshot"</span>), the AI breaks it into concrete steps (<span class="font-mono">navigate</span>, <span class="font-mono">interact</span>, <span class="font-mono">wait</span>, <span class="font-mono">capture</span>), and the session carries them out. The steps come from a fixed set of actions — the AI cannot invent new ones — and a step that looks like a purchase, a payment, or an account deletion waits for your approval before it runs. Three modes: <strong>AI</strong> (the default — the AI plans every message), <strong>manual</strong> (your own app passes instructions straight through), and <strong>pair</strong> (the AI drives, but you can take over and hand back). You watch it live, with a written transcript as it runs and the screenshots it takes along the way. (For developers: the transcript streams over Server-Sent Events.) Full reference at <a href="https://docs.driftstack.io/api/agent-sessions/" class="text-tk-accent-text underline">docs.driftstack.io/api/agent-sessions</a>.',
      },
      {
        q: 'How is AI usage billed?',
        a: 'Two ways, depending on your plan: your own account with an AI provider, or a budget included with the plan. BYOK has no Driftstack markup — your Anthropic API key, your provider bill, your control. Set a stored key from the dashboard <span class="font-mono">/settings</span> page, <span class="font-mono">PUT /v1/account/me/byok-anthropic-key</span>, or per request with <span class="font-mono">x-byok-anthropic-api-key</span>. Team, Agency, and API Starter are BYOK-only; API Builder, API Scale, and Enterprise support bundled-LLM with consent. On API Builder and API Scale, each bundled LLM turn counts $0.10 against a monthly budget you control; the budget is enforced, but it is not a separate line on your invoice today. Enterprise can use a contracted custom budget. Enable bundled usage in the desktop app under <strong>Settings → AI &amp; billing</strong>, or with <span class="font-mono">PATCH /v1/account/me/bundled-llm-settings</span>.',
      },
      {
        q: 'Is my own AI key safe with you?',
        a: "Yes. In plain terms, the key is stored encrypted, the key that unlocks it is locked away separately, and it is readable only in memory, for the moment a session actually runs. Your Anthropic API key is encrypted at rest with envelope encryption, decrypted in-memory only at session execution time, and never logged. Our data-processing agreement (DPA) covers exactly how it's handled. Self-hosted customers can hold the outer (envelope) key in their own key-management system (KMS).",
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
        a: 'In the EU, with two exceptions we name here. Customer data in our databases — your account, profiles, audit logs, session metadata — is hosted in the EU: our servers and database are there. Uploaded files (your avatar, for example) use Cloudflare\'s R2 storage network, which can replicate outside the EU. Sessions may run outside the EU under standard contractual clauses (SCCs) and the EU-US Data Privacy Framework — the legal mechanisms EU law provides for data that leaves the EU. The complete list of the other companies we rely on to run the service (our sub-processors), with locations and contractual basis, is published at <a href="/trust/sub-processors/" class="text-tk-accent-text underline">/trust/sub-processors</a> and in the <a href="/legal/dpa/" class="text-tk-accent-text underline">Data Processing Agreement</a>.',
      },
      {
        q: 'Can I pick which region my data is stored in?',
        // S30 2026-07-07 (founder decision: soften) — scoped "data" to
        // "account data": R2-held files carry no EU-residency guarantee.
        a: 'No — and the setting that looks like it does is only a preference. You can state a region preference (US / EU / APAC) from <span class="font-mono">/settings → Region</span>; it is informational and does not change where your data is stored. Every customer\'s account data is stored on servers under EU jurisdiction. The <a href="/trust/sub-processors/" class="text-tk-accent-text underline">sub-processor page</a> lists the exact providers and locations, and the DPA\'s Article 28 process governs any material sub-processor change.',
      },
      {
        q: 'What does my team see when I add them to my account?',
        a: 'Your sessions, profiles and logs — never your billing, your password, or your two-factor recovery codes. Invite teammates by email from the desktop app\'s Team view (or the API), as <em>member</em> or <em>admin</em>, and remove them the same way. A <em>member</em> gets read-only views of your sessions, profiles, API keys, webhooks, audit log, and usage. An <em>admin</em> can also create, update, and delete those. When a member acts on your account, the audit log records both the action AND which member did it — so you can see who on your team did what without cross-referencing anything, and the whole audit log can be exported as CSV or JSON at any time. Sign-in and sign-out entries also record the IP address and browser used. That detail is visible to you and to any team member with read access on your account, so don\'t add team members you wouldn\'t share it with. Full reference: <a href="https://docs.driftstack.io/api/team/" class="text-tk-accent-text underline">docs.driftstack.io/api/team</a>.',
      },
      {
        q: 'Can I protect my dashboard sign-in with two-factor authentication?',
        a: 'Yes. The web dashboard supports time-based one-time passwords (TOTP — the six-digit codes from an authenticator app) plus single-use recovery codes. Once enrolled, dashboard sign-in asks for a code as well as your password. You can also see every active dashboard session and revoke any of them. Team members never see your recovery codes. Reference: <a href="https://docs.driftstack.io/api/mfa/" class="text-tk-accent-text underline">docs.driftstack.io/api/mfa</a>.',
      },
      {
        q: 'Are you GDPR-compliant?',
        a: 'Yes. The Privacy Policy, the data processing agreement (DPA) and the Acceptable Use Policy are linked in the footer of every page. The list of companies we rely on is in DPA Annex 3. Requests to have your data deleted (GDPR\'s "right to erasure") are honoured within 30 days. The legal documents are baseline drafts under counsel review; the first paying customer onboards only after counsel review completes.',
      },
      {
        q: 'Do you have a SOC 2 / ISO 27001 audit?',
        a: "No. Driftstack is not currently SOC 2 or ISO 27001 certified. The current compliance basis is GDPR, plus the EU's standard contractual clauses (SCCs) and the EU-US Data Privacy Framework (DPF) for data leaving the EU. If your policy requires certified infrastructure, self-hosting on hardware inside your audited environment is the available option.",
      },
      {
        q: 'Where do I read the Terms / Privacy / DPA / AUP?',
        a: "In the footer of every page — the four documents live at /legal/*. When you create an API key we record exactly which version of each document you accepted, down to its precise wording. When a document changes, you're asked to accept the new version, following the DPA's Article 28 amendment process.",
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
        a: 'Neither — and that is the point. A session is a real browser built from Apple\'s own source code, running on Apple hardware. Driftstack builds Apple\'s WebKit and Safari source code (the same C++ program code that runs on iOS) — the engine family behind iPhone Safari — and runs it on Apple\'s M-series Macs (macOS, Apple Silicon). Macs and iPhones share the same Apple chip family, so the engine runs the way it runs on a phone: the same JavaScript engine (JavaScriptCore), the same page-drawing engine (WebCore), and the same family of graphics chips. A website can measure a lot from inside a page: the picture the browser draws (canvas), its 3D graphics (WebGL), its audio, its fonts, its screen size, and the browser\'s own internal details. Every one of those is checked against real iPhones, check by check. Where Safari deliberately varies a value, Driftstack varies it the same way. Any difference we find is treated as a bug and fixed in the engine, never patched over. The <a href="/trust/cumulative-rig/" class="text-tk-accent-text underline">signal-by-signal table</a> lists what is checked and against which phone.',
      },
      {
        q: 'Does Driftstack work with Playwright / Selenium / Puppeteer?',
        a: 'Not by pointing those tools at a session — but your automation still works, once reshaped. Those tools speak Chrome\'s remote-control protocol (CDP / WebDriver), and Driftstack deliberately offers no CDP passthrough: no Chrome DevTools Protocol WebSocket, no WebDriver endpoint. <span class="font-mono">connectOverCDP()</span>, <span class="font-mono">puppeteer.connect()</span>, and Selenium/WebDriver clients cannot attach to a session. Instead you drive sessions through the typed Driftstack SDK over structured REST actions — <span class="font-mono">navigate</span>, <span class="font-mono">interact</span> (tap / type / scroll / press), <span class="font-mono">wait</span>, <span class="font-mono">capture</span>, <span class="font-mono">extract</span>, <span class="font-mono">state</span>, <span class="font-mono">search</span>, and <span class="font-mono">login</span>. If you have an existing Playwright or Puppeteer script, you reshape it into those discrete actions rather than pointing the same client at a new address. SDK quickstarts at <a href="https://docs.driftstack.io/sdk/typescript-quickstart/" class="text-tk-accent-text underline">/sdk/typescript-quickstart</a>, <a href="https://docs.driftstack.io/sdk/python-quickstart/" class="text-tk-accent-text underline">/sdk/python-quickstart</a>, <a href="https://docs.driftstack.io/sdk/go-quickstart/" class="text-tk-accent-text underline">/sdk/go-quickstart</a>.',
      },
      {
        q: 'Where do my sessions actually run?',
        // S26 2026-07-06 (#132) — accuracy fix (audit M5): this lists
        // session metadata rather than locally stored desktop recordings.
        // S30 2026-07-07 (founder decision: soften) — the listed
        // classes ARE DB-resident (EU-true), but "Everything ... EU"
        // was blanket; added the file-storage scope (R2 default
        // jurisdiction replicates EU + US).
        a: 'The browsers run in the US; your account data stays in the EU. The sessions themselves — the iPhone Safari browsers — run on Mac hardware hosted in the US (MacStadium), under the EU\'s Standard Contractual Clauses (SCCs) and the EU-US Data Privacy Framework. Customer data in our databases — accounts, profiles, audit logs, session metadata — stays in the EU. Uploaded files (avatars, for example) use Cloudflare\'s storage network, which can replicate outside the EU. The <a href="/trust/sub-processors/" class="text-tk-accent-text underline">list of companies we rely on</a> has the full breakdown with each provider\'s region. Our API runs in the EU, so from EU locations your commands typically reach it in under 30 milliseconds.',
      },
      {
        // 2026-09-15 refuter fix: the catalog names 19 specific models between
        // its endpoints (ARCHETYPE_REGISTRY carries no iPhone SE, 16e or Air row),
        // so this answer says "19 iPhone models, iPhone 13 → 17 Pro Max" and
        // states the gap — never the "every iPhone in that span" form.
        // The 19 is held to the registry by a cross-source invariant test.
        q: 'Which iPhones can I run?',
        a: `${DEVICE_SUPPORT.selectableCount} device profiles across 19 iPhone models, ${DEVICE_SUPPORT.deviceFamilies}, on iOS ${DEVICE_SUPPORT.iosVersions}, with Safari ${DEVICE_SUPPORT.safariVersions}. A device profile is one specific iPhone model, iOS version and Safari version together. Every profile you create is built on one, and the default is the iPhone 17 on iOS 18.7 / Safari 26.4. The free tier offers the iPhone 13 and iPhone 13 mini; every paid plan offers all of them. There are no iPad, Android, or desktop profiles. Not every iPhone in that span is included: there is no iPhone SE, 16e, or Air profile. (For developers: <span class="font-mono">GET /v1/archetypes</span> returns the current list, no sign-in needed.)`,
      },
      {
        q: 'Can I record or replay a session?',
        a: 'In the desktop app, yes. Start a recording on a session you are driving, stop it, and replay it from the Recordings view, or export it as a file. Recordings are saved on your own computer and never leave it — Driftstack keeps no server-side copy. Sessions driven from code take screenshots, page snapshots, or PDFs on request instead (<span class="font-mono">POST /v1/sessions/:id/capture</span>). Details on <a href="/docs/recordings/" class="text-tk-accent-text underline">/docs/recordings</a>.',
      },
      {
        q: 'What happens to a profile I delete?',
        a: 'It moves to a recycle bin: hidden from your list, restorable for 30 days, then purged for good. From the API you can also take a snapshot of a profile\'s settings and restore it into a new profile later (snapshots do not include cookies or logins), export a profile\'s settings as a file and import them again, and read a per-profile activity feed. Every profile change lands in your audit log, which you can export as CSV or JSON at any time. Details on <a href="/docs/profiles/" class="text-tk-accent-text underline">/docs/profiles</a>.',
      },
      {
        q: 'Can other tools sign in to my account on my behalf?',
        a: 'Yes — three ways, each with access you can limit and revoke. API keys are the usual path for your own code. Third-party apps can connect through OAuth 2.0 with PKCE, so they never see your password and you can revoke them one at a time — see <a href="/docs/oauth-apps/" class="text-tk-accent-text underline">/docs/oauth-apps</a>. Command-line tools use a device-code sign-in: the tool shows a short code, you approve it in the dashboard, and the tool receives its own credentials. Every sign-in and key action is recorded in your audit log.',
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
        a: 'Plan on reshaping your script, not swapping a URL. Scripts built for those platforms cannot connect to Driftstack directly — there is no CDP passthrough, the socket Chrome-automation tools plug into. Migration means reshaping your script into Driftstack\'s discrete REST actions (<span class="font-mono">navigate</span> / <span class="font-mono">interact</span> / <span class="font-mono">wait</span> / <span class="font-mono">capture</span> / <span class="font-mono">extract</span>) driven through the typed SDK. What your sessions look like to a website changes too, because you go from Chromium to real WebKit. Anything that depended on Chrome-specific behaviour needs adjusting: a specific user-agent string (the one-line introduction a browser sends with every request), Chrome-only DevTools commands, or CSS bugs specific to Blink, Chrome\'s rendering engine. The <a href="/comparison/" class="text-tk-accent-text underline">comparison page</a> covers feature-by-feature differences, and we publish step-by-step migration guides for the common Chrome-based vendors — <a href="https://docs.driftstack.io/guides/migrate-from-browserless/" class="text-tk-accent-text underline">migrating from Browserless</a> and <a href="https://docs.driftstack.io/guides/migrate-from-puppeteer/" class="text-tk-accent-text underline">migrating from Puppeteer</a>. Email <a href="mailto:support@driftstack.dev" class="text-tk-accent-text underline">support@driftstack.dev</a> if you want a hand reshaping your test suite before you cut over.',
      },
      {
        q: 'Can I run a side-by-side comparison before committing?',
        a: "Yes — that's exactly what the free tier is for. Run manual sessions through Driftstack alongside your current vendor and compare the results, at no cost. Many customers convert to a paid tier after watching how their own flows behave; some discover their detection problem isn't worth solving and stay on a Chrome-based service. Either outcome is fine — we'd rather you make the right call than the upsell.",
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
        a: "Legitimate automation, yes. Fraud, attacks, and bots against vendors that ban them, no — and scraping only within a site's own terms. The full Acceptable Use Policy is at <a href=\"/legal/aup/\" class=\"text-tk-accent-text underline\">/legal/aup</a> — read it before signing up if you're unsure. Driftstack is built for legitimate automation: QA, accessibility testing, market research, regulated-industry compliance testing, agency multi-client management, AI-agent-driven flows. We don't allow attacks on third-party systems, or fraud (ad fraud, fake-account creation, payment fraud). We don't allow CSAM (child sexual abuse material) or other illegal content. Large-scale scraping is out when it breaks a site's terms of service (ToS) — by getting around logins, or past a site's reasonable rate limits. So are sneaker bots / ticket bots run against vendors who have publicly prohibited bot purchasing. Suspected abuse triggers an account review under the Acceptable Use Policy's escalation process; persistent violations terminate the account.",
      },
      {
        q: 'What happens if Driftstack as a business goes away?',
        a: 'Two protections. (1) <strong>Data portability:</strong> profiles, audit logs and session metadata can be exported as CSV/JSON from the dashboard or via the API at any time, so customers can take their data with them on any timeline. (2) <strong>Self-hosted option:</strong> Enterprise + Self-hosted licensees receive source escrow — an independent third party holds a copy of our source code. If the cloud service is ever wound down, the escrow agreement releases the browser engine and the management software, so customers can keep running everything on their own hardware indefinitely. We carry no investors and no debt, so the most likely "Driftstack goes away" scenario is an orderly wind-down with months of notice, not a sudden shutoff. Self-hosted on day one is the answer for customers who cannot accept any cloud-vendor risk.',
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
        a: 'Email <a href="mailto:support@driftstack.dev" class="text-tk-accent-text underline">support@driftstack.dev</a>. Reply target is 48h business-time across every tier — an operational target we hold ourselves to, not a contractual SLA. (An SLA is a service-level promise written into the contract; where we have one, we say so.) Replies are written by a person, not template-blasted, so they take honest time. Slack Connect is available on request once a paid subscription is active. API Scale and Enterprise additionally carry a contractual first-response SLA on Severity-1 incidents (4 hours and 1 hour respectively) — see the <a href="/docs/sla-policy/" class="text-tk-accent-text underline">SLA policy</a>.',
      },
      {
        q: 'What if a session fails?',
        a: 'You get a clear error, you keep whatever you captured before it failed, and the session slot frees up. You can see everything a session did, start to finish, in the dashboard or from the SDK. A failed session returns a clear, machine-readable error (RFC 9457 problem-types, for developers). Any captures you took before the failure — screenshots, page snapshots, PDFs — are already in your hands, because capture results return to you the moment you take them. Sessions that fail on our side (a crash, or no machine available) do not count against how many sessions you can run at once: the slot frees up as soon as the failure is detected.',
      },
      {
        q: "What's the uptime target?",
        // S43 2026-07-07 (founder-approved) — aligned to the binding
        // ToS §9: the old answer ("no formal SLA with credits" on any
        // tier) contradicted §9.2, which grants API Scale + Enterprise
        // a contractual SLA (99.9% monthly availability) published at
        // /docs/sla-policy. The §9.1 tiers remain best-effort with no
        // contractual commitment — that part was true and stays.
        a: 'It depends on your tier — two answers, per the <a href="/legal/terms/" class="text-tk-accent-text underline">Terms</a> §9. On the Free, Manual (Personal / Team / Agency), API Starter, and API Builder tiers there is no contractually-binding SLA — we run best-effort (operationally we aim for 99.5%+) but do not commit to a specific uptime percentage, because a promise we could not stand behind would be theatre. API Scale and Enterprise carry a contractual SLA: 99.9% monthly availability with service credits, published in full at the <a href="/docs/sla-policy/" class="text-tk-accent-text underline">SLA policy</a>. Either way, the <a href="https://status.driftstack.io" class="text-tk-accent-text underline">status page</a> publishes incidents with timestamps and a written root-cause analysis (RCA) for each. If an incident hurts your workload meaningfully on any tier, email <a href="mailto:support@driftstack.dev" class="text-tk-accent-text underline">support@driftstack.dev</a> with concrete impact and we will work out a credit in good faith.',
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
