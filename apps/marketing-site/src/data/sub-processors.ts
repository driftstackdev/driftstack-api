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
    purpose: 'Managed Postgres for account, session, and audit data.',
    transferMechanism: 'EU-resident — no transfer required.',
  },
  {
    name: 'Upstash',
    region: 'Frankfurt (EU)',
    purpose: 'Managed Redis for auth-cache and rate-limit state.',
    transferMechanism: 'EU-resident — no transfer required.',
  },
  {
    name: 'Cloudflare R2',
    region: 'EU jurisdiction',
    purpose:
      'Object storage for session recordings and screenshots, public status-page snapshots, and customer-uploaded profile avatars.',
    transferMechanism: 'EU-jurisdiction storage — no transfer required.',
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
      'Payment processing, subscription management, BYOK metered billing, BTW reverse-charge handling via Stripe Tax.',
    transferMechanism: '2021 Standard Contractual Clauses + EU-US Data Privacy Framework.',
  },
  {
    name: 'Anthropic',
    region: 'United States',
    purpose:
      "Large language model for the optional AI agent feature. Engaged in two modes: (1) BYOK proxy — when the customer has supplied their own Anthropic API key, Driftstack forwards the request and the customer's Anthropic account is the contractual counter-party; Driftstack acts only as a transient proxy. (2) Bundled-LLM rail — opt-in only; Driftstack uses a deployment-managed key and bills the customer at a markup. Session data flows to Anthropic only when one of these two modes is engaged on a given turn.",
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
    transferMechanism: 'EEA-internal — no transfer mechanism required.',
  },
  {
    name: 'LiveKit',
    region: 'United States (regional endpoints; EU preferred)',
    purpose:
      'WebRTC live-session signaling and media SFU for the optional "live session" feature, where customer or Driftstack support views an in-progress browser session in real time. Disabled by default; engaged only when explicitly initiated.',
    transferMechanism: '2021 Standard Contractual Clauses + EU-US Data Privacy Framework.',
  },
];

export const SUB_PROCESSOR_REGISTER_LAST_UPDATED = '2026-05-10';

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
    date: '2026-05-10',
    kind: 'register_published',
    subject: '',
    summary:
      'Initial sub-processor register published as part of pre-launch ' +
      'transparency. The register reflects the production sub-processor ' +
      'list at /v1/status time of publication; future material changes ' +
      'land here per the Article 28(2) notice cadence.',
    effective_at: '2026-05-10',
  },
];
