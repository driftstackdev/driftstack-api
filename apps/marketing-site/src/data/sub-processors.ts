// Sub-processor register — public surface for /trust/sub-processors.
//
// Mirrors the DPA Annex 3 entries from `docs/legal/dpa.md` (this repo)
// plus the sub-processor lock from CLAUDE.md (V-052 revision). When
// the DPA Annex 3 changes, this file updates in the same commit; the
// /trust page is a customer-facing transparency artifact, not a
// separate canonical source.
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
    purpose: 'Object storage for session recordings and screenshots.',
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
      'Bundled large language model for the optional AI agent feature. Opt-in only; processes session data only when customers explicitly enable bundled-LLM billing.',
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
];

export const SUB_PROCESSOR_REGISTER_LAST_UPDATED = '2026-05-03';
