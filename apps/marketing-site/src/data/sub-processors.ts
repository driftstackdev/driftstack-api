// Sub-processor register — public surface for /trust/sub-processors.
//
// Mirrors the DPA Annex 3 entries from `docs/legal/dpa.md` (this repo)
// plus the locked sub-processor list (V-052 revision). When the DPA
// Annex 3 changes, this file updates in the same commit; the /trust
// page is a customer-facing transparency artifact, not a separate
// canonical source.
//
// Changes to this list trigger Art 28(2) sub-processor amendment
// notice (30-day notice to customers) per the DPA. Adding or removing
// an entry is a content change with compliance implications.

export interface SubProcessor {
  /** Legal-entity name as it appears in the DPA Annex 3. */
  name: string;
  /** Region of operation; "EU" for EU-resident, country for specific. */
  region: string;
  /** What data flows through this sub-processor. */
  purpose: string;
  /** Transfer mechanism for any data outside the EU. */
  transferMechanism: string;
}

export const SUB_PROCESSORS: SubProcessor[] = [
  {
    name: 'Hetzner Cloud',
    region: 'Falkenstein, Germany (EU)',
    purpose: 'Compute infrastructure for the Driftstack control plane.',
    transferMechanism: 'EU-resident — no transfer required.',
  },
  {
    name: 'Neon',
    region: 'Frankfurt (EU)',
    purpose: 'Our managed database (Postgres) — stores account, session, and audit data.',
    transferMechanism: 'EU-resident — no transfer required.',
  },
  {
    name: 'Upstash',
    region: 'Frankfurt (EU)',
    purpose:
      'Fast temporary storage (managed Redis) — holds short-lived login-check (auth-cache) and rate-limit data.',
    transferMechanism: 'EU-resident — no transfer required.',
  },
  {
    // S43 2026-07-07 (founder-approved) — register correction. The
    // prior entry claimed "EU jurisdiction … no transfer required" and
    // listed "session recordings and screenshots"; ground truth
    // (dig + prod-box verified) is the R2 default jurisdiction with
    // EU + US replication (a transfer mechanism IS required), and the
    // objects actually stored are avatars, encrypted profile blobs,
    // and public status-page snapshots. Recordings are roadmap-only.
    name: 'Cloudflare R2',
    region: 'Default jurisdiction (data replicated EU + US)',
    purpose:
      'Object storage for customer-uploaded profile avatars, encrypted profile blobs, and public status-page snapshots.',
    transferMechanism: '2021 Standard Contractual Clauses + EU-US Data Privacy Framework.',
  },
  {
    name: 'Postmark',
    region: 'EU sending region',
    purpose:
      'Transactional email (signup verification, password reset, billing notifications, support correspondence).',
    transferMechanism: '2021 Standard Contractual Clauses + EU-US Data Privacy Framework.',
  },
  {
    name: 'Sentry',
    region: 'EU region (ingest.de.sentry.io)',
    purpose: 'Error monitoring and observability for the Driftstack control plane.',
    transferMechanism: 'EU ingest region — no transfer required for error data.',
  },
  {
    name: 'Stripe',
    region: 'Stripe Payments Europe Ltd (Ireland)',
    purpose:
      'Payment processing, subscription management, billing for Driftstack-bundled AI usage, and VAT (Dutch BTW) reverse-charge handling via Stripe Tax. BYOK AI usage is billed directly by the model provider, not Stripe through Driftstack.',
    transferMechanism: '2021 Standard Contractual Clauses + EU-US Data Privacy Framework.',
  },
  {
    name: 'Anthropic',
    region: 'United States',
    purpose:
      "Large language model (LLM) behind the optional AI agent feature. Engaged in two modes: (1) Bring your own key (BYOK) — the customer supplies their own Anthropic API key; the customer's contract is with Anthropic directly, and Driftstack only passes the request through without keeping it (a transient proxy). (2) Bundled — opt-in only; Driftstack uses its own deployment-managed key and bills standard Builder and Scale usage at $0.10 per agent turn, while Enterprise can use a contracted custom rate. Session data flows to Anthropic only when one of these two modes is actually used in a given AI step.",
    transferMechanism: '2021 Standard Contractual Clauses + EU-US Data Privacy Framework.',
  },
  {
    name: 'Moneybird',
    region: 'Netherlands (EU)',
    purpose: 'Accounting and invoicing operations for the Driftstack BV.',
    transferMechanism: 'EU-resident — no transfer required.',
  },
  {
    name: 'MacStadium',
    region: 'United States',
    purpose: 'Mac hardware hosting for the iPhone Safari session execution fleet.',
    transferMechanism: '2021 Standard Contractual Clauses + EU-US Data Privacy Framework.',
  },
  {
    name: 'NowPayments',
    region: 'NowPayments OÜ (Estonia, EU)',
    purpose:
      'Cryptocurrency payment processing (BTC, LTC, USDT, USDC, ETH, XMR). Engaged only when a customer opts to pay with cryptocurrency at checkout; bypassed entirely for Stripe-paying customers.',
    transferMechanism:
      'Inside the EEA (the EU plus Iceland, Liechtenstein, and Norway) — no transfer mechanism required.',
  },
  {
    name: 'LiveKit',
    region: 'United States (regional endpoints; EU preferred)',
    purpose:
      'Carries the live video stream (WebRTC; LiveKit provides the connection setup and video relay servers — signaling and media SFU) for the optional "live session" feature, where the customer or Driftstack support watches an in-progress browser session in real time. Disabled by default; engaged only when explicitly initiated.',
    transferMechanism: '2021 Standard Contractual Clauses + EU-US Data Privacy Framework.',
  },
];

export const SUB_PROCESSOR_REGISTER_LAST_UPDATED = '2026-07-07';

/**
 * V-478 — sub-processor change-log surface.
 *
 * Every material change to the SUB_PROCESSORS register lands here as
 * an immutable entry. Customers can scan the list to see when each
 * sub-processor was added or removed, and which Article 28(2) notice
 * window applied. Adding an entry is paired with the Art 28(2) 30-day
 * notice email per the DPA.
 *
 * `kind` semantics:
 *   - `added`: a new sub-processor entered the register.
 *   - `removed`: an entry was withdrawn; the customer-facing change is
 *     only effective AFTER the notice window closes.
 *   - `material_change`: an existing entry's region / purpose / transfer
 *     mechanism changed in a way that triggers Art 28(2). Cosmetic edits
 *     (rewording, typo fixes) do NOT land here.
 *   - `register_published`: pre-launch baseline marker. The register has
 *     been on-record from this date forward.
 */
export interface SubProcessorChangeLogEntry {
  date: string;
  kind: 'added' | 'removed' | 'material_change' | 'register_published';
  /** Sub-processor name, or empty for register-level entries. */
  subject: string;
  /** Customer-facing summary of what changed and why. */
  summary: string;
  /** Date the change took effect (post-notice-window if applicable). */
  effective_at: string;
}

export const SUB_PROCESSOR_CHANGELOG: SubProcessorChangeLogEntry[] = [
  {
    // S43 2026-07-07 (founder-approved) — correction entry, effective
    // immediately: the processing itself did not change, only the
    // register's description of it, so no 30-day Art 28(2) window
    // applies (nothing new is being engaged; the entry now discloses
    // the transfer that was already happening).
    date: '2026-07-07',
    kind: 'material_change',
    subject: 'Cloudflare R2',
    summary:
      'Correction: the Cloudflare R2 row previously described the ' +
      'storage as "EU jurisdiction — no transfer required" and listed ' +
      '"session recordings and screenshots". In fact the R2 buckets ' +
      'use the default jurisdiction, which replicates data between ' +
      'the EU and the US, so a transfer mechanism applies (2021 ' +
      'Standard Contractual Clauses + EU-US Data Privacy Framework), ' +
      'and the objects actually stored are customer-uploaded profile ' +
      'avatars, encrypted profile blobs, and public status-page ' +
      'snapshots (session recording is not a live feature). This is a ' +
      'correction of the register to describe existing processing ' +
      'accurately — the processing itself did not change.',
    effective_at: '2026-07-07',
  },
  {
    date: '2026-05-10',
    kind: 'register_published',
    subject: '',
    summary:
      'Initial sub-processor register published as part of pre-launch ' +
      'transparency. The register reflects the sub-processors in ' +
      'production at the time of publication; future material changes ' +
      'are recorded here, each with the 30-day notice GDPR ' +
      'Article 28(2) requires.',
    effective_at: '2026-05-10',
  },
];
