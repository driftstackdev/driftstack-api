---
layout: ../../layouts/LegalLayout.astro
title: Privacy Policy
description: How Driftstack processes personal data as a Controller — GDPR-aligned disclosures.
---

**Version:** 1.0 · **Effective:** 2026-05-07

This Privacy Policy describes how Driftstack Processes Personal Data
in connection with the Service. Capitalised terms are defined in the
[Terms of Service](/legal/terms/).

This Privacy Policy describes Driftstack's processing as a
**Controller** (account, billing, support correspondence, marketing
site analytics where applicable). Driftstack's processing as a
**Processor** on Customer's behalf (Customer Data, Session content,
Customer-Provided Secrets) is governed by the
[Data Processing Agreement (DPA)](/legal/dpa/), which is incorporated
into Customer's contract by reference.

## 1. Controller identity

The Controller of Personal Data described in this Privacy Policy is **Driftstack B.V.**, a private limited company organised under the laws of the Netherlands, established in Amsterdam.

For all matters relating to the Processing of Personal Data, including the exercise of Data Subject rights, contact:

- Privacy: `privacy@driftstack.dev`
- Legal: `legal@driftstack.dev`
- Postal correspondence: addressed to Driftstack B.V., the registered office of which is published on the Driftstack website.

Driftstack does not currently have a Data Protection Officer subject to mandatory appointment under Article 37(1)(b) GDPR; the Privacy Contact above is the primary point of contact for Data Subjects, supervisory authorities, and counterparties. Driftstack will appoint a DPO promptly if Driftstack's Processing activities cross any threshold that triggers a mandatory appointment under applicable law.

## 2. Scope of this Privacy Policy

This Privacy Policy applies to:

1. Personal Data of Customer's Authorized Users that Driftstack
   Processes to provision, bill for, and support the Service.
2. Personal Data of individual contacts (e.g. founders of B2B
   prospects) that Driftstack collects in pre-sales correspondence.
3. Personal Data collected through any public-facing Driftstack
   property (the marketing site at `driftstack.dev`, the API status
   page, the GitHub repository — to the extent any of these collect
   Personal Data).

This Privacy Policy does **not** apply to:

1. Personal Data Customer routes through the Service in the course
   of its own automated browsing — that data is governed by the
   [DPA](/legal/dpa/), where Customer is the Controller and Driftstack is
   the Processor.
2. Personal Data Processed by Sub-processors under their own
   privacy policies (linked in Section 7).
3. Personal Data Processed by Customer-Connected Services
   (proxies, captcha, email, SMS) under those services' own
   policies.

## 3. Data we collect (and why)

Driftstack collects the following categories of Personal Data, each
for the purposes and on the legal bases set out below.

### 3.1 Account data

**What:** legal entity name, billing address, VAT/BTW identification
number, primary contact name, primary contact email, billing email,
optional support contacts, time zone, optional profile avatar
(Customer-uploaded image, stored in the Cloudflare R2 sub-processor;
see §17 / DPA Annex 3), optional Customer-stated infrastructure
region preference (one of "us" / "eu" / "apac"; informational and
non-binding for v1, since all production data resides on
EU-jurisdiction infrastructure today — see §6 / §7 for the
authoritative routing).

**Why:** to administer the contractual relationship, generate
VAT-compliant invoices, send service notifications, provide
support, and render the dashboard / GUI Client identity row.

**Legal basis (GDPR Art 6):** Article 6(1)(b) — performance of the
contract with Customer (where the contact is Customer's principal or
authorised representative). Article 6(1)(f) — Driftstack's
legitimate interest in administering the relationship and complying
with its obligations (where the contact is a Customer employee whose
contact details are necessary for service operation).

**Source:** Customer provides directly at signup or via Account
configuration through the API or GUI.

### 3.2 Authentication data

**What:** API Keys (stored as scrypt-hashed values; the plaintext key
is shown to Customer once at issuance and is not recoverable
thereafter), session tokens for the GUI Client, key prefixes and
last-used-at timestamps. Optional second-factor authentication
state when Customer enrolls: a TOTP secret encrypted at rest with
AES-256-GCM (only the encrypted ciphertext is stored; the plaintext
exists only in memory during signature verification), 10 single-use
recovery codes stored as scrypt-hashed values (raw codes shown
once at enrollment), and a per-session "MFA-satisfied-at"
timestamp used to gate sensitive operations.

**Why:** to authenticate API requests, scope operations, detect
or remediate compromise, and enforce step-up reauthentication on
sensitive operations.

**Legal basis:** Article 6(1)(b) — performance of the contract.
Article 6(1)(c) — compliance with legal obligation under Article 32
GDPR (security of processing).

**Source:** Driftstack generates API Keys + MFA secrets at
Customer's request; Customer stores and manages them.

### 3.3 Session metadata

**What:** session id, account id, target URL, archetype identifier,
timestamps, duration, success/failure, aggregate operation counts.

**Why:** to operate the Service (route Sessions to Mac mini fleet
nodes, enforce rate limits, generate usage reports), to detect abuse,
and to maintain Service capacity planning.

**Legal basis:** Article 6(1)(b) — performance of the contract.
Article 6(1)(f) — legitimate interest in detecting abuse and
protecting the Service.

**Source:** generated by the Service in the course of executing
Customer's instructions.

### 3.4 Session recordings (optional)

**What:** sequenced PNG frames captured during Sessions where
Customer has explicitly enabled recording. Frame content can include
any Personal Data the Customer's automated browsing encounters
(e.g. account names, profile photos, message content visible in the
browser viewport).

**Why:** to provide Customer with a record of automated browsing for
debugging, audit, and replay. Recordings exist only when Customer
explicitly enables recording per Session.

**Legal basis:** Driftstack Processes Recordings as **Processor on
Customer's behalf** under the [DPA](/legal/dpa/), not as Controller. The
Customer is the Controller for Recording content. Customer's lawful
basis for the underlying browsing (and therefore for the
Recordings) is determined by Customer.

**Source:** Customer's enabled recording in the GUI Client or via
the API.

**Retention:** Customer-controlled. Default 30 days; Customer can
configure 1–365 days or disable entirely. Driftstack does not
retain Recordings beyond Customer's configured window.

### 3.5 Customer-Provided Secrets

**What:** authentication credentials Customer supplies for use in
Sessions, including (without limitation) HTTP/SOCKS5 proxy
credentials, captcha-service API keys, IMAP / Gmail OAuth tokens,
and SMS-service API keys.

**Why:** to forward to the appropriate Customer-Connected Service
on Customer's instruction during Session execution.

**Legal basis:** Driftstack Processes Customer-Provided Secrets as
**Processor on Customer's behalf** under the DPA, not as Controller.
Customer holds the underlying relationship with the third-party
provider; Driftstack is a transient holder of the credential for
the duration of the Session and for the storage retention specified
in Section 9.

**Storage:** encrypted at rest. Used only on Customer's instruction.
Not used for any purpose beyond executing Customer's Session.

### 3.6 Billing data

**What:** transaction identifiers, payment method type (card,
SEPA, iDEAL, Bancontact), last-four of payment
instruments where retained, invoice status, amount, currency, VAT
basis. Driftstack does **not** retain primary account numbers
(PANs); these are tokenised by Stripe under PCI-DSS scope.

**Why:** to process Subscription Fees, generate invoices, and
maintain accounting records.

**Legal basis:** Article 6(1)(b) — performance of the contract.
Article 6(1)(c) — compliance with Dutch tax law (Article 52 of the
Dutch _Algemene wet inzake rijksbelastingen_; 7-year retention).

**Source:** Stripe returns transaction metadata to Driftstack via
webhook. Customer provides billing details at signup or via the
customer portal.

**Renewal-reminder emails.** Approximately seven (7) days before each
recurring subscription invoice is generated, Stripe fires an
`invoice.upcoming` webhook to Driftstack. We use this signal to send
the billing email address one (1) `billing-renewal-reminder` email
per upcoming invoice, summarising the upcoming amount, currency, and
renewal date, and linking to the customer billing portal. Customers
may opt out of this email at any time via the dashboard's email
preferences page (the underlying contractual notification — actual
charge confirmation — is sent by Stripe and is not opt-outable).
The complete catalog of emails Driftstack sends — opt-outable vs
transactional — is on the public
[Emails reference page](https://docs.driftstack.dev/reference/emails/).

### 3.7 Support correspondence

**What:** email content, support ticket content, attachments, and
metadata associated with Customer's contact with Driftstack support.

**Why:** to provide support, document service issues, and improve
the Service.

**Legal basis:** Article 6(1)(b) — performance of the contract
(when support is contractually owed). Article 6(1)(f) — legitimate
interest in service improvement (when correspondence reveals
patterns of issue beyond the immediate Customer).

**Source:** Customer's outbound correspondence to Driftstack support
addresses.

### 3.8 Marketing-site data

**What:** access logs (IP address, user agent, referrer, request
timestamp) for visitors to `driftstack.dev` (the marketing site).
Driftstack does **not** currently set first-party analytics cookies
on the marketing site.

**Why:** infrastructure operation and abuse detection.

**Legal basis:** Article 6(1)(f) — legitimate interest in operating
the site. Where consent is required (e.g. for non-essential
analytics introduced in a future revision), Driftstack will collect
consent before processing and update this Section.

**Cookies:** Driftstack uses strictly-necessary cookies on the
marketing site (session-id for signup flow, CSRF token). Strictly-
necessary cookies do not require consent under Article 5(3) of
Directive 2002/58/EC (the ePrivacy Directive). If Driftstack adds
analytics or marketing cookies in a future revision, this Privacy
Policy will be updated and a cookie-consent mechanism deployed.

## 4. Special Category Data

Driftstack does **not** intentionally collect Special Category Data
(Article 9 GDPR — racial or ethnic origin, political opinions,
religious or philosophical beliefs, trade union membership, genetic
data, biometric data uniquely identifying a person, data concerning
health, or data concerning sex life or sexual orientation).

If Customer's automated browsing causes Special Category Data to be
captured in a Recording, that data is Processed by Driftstack only
as Processor on Customer's behalf under the DPA. Customer is
responsible for ensuring it has a lawful basis under Article 9(2)
GDPR for processing such data.

## 5. Data we do not collect

Driftstack does **not**:

1. Sell Personal Data to third parties.
2. Use Customer's Personal Data for behavioural advertising or
   profiling beyond what is necessary to operate the Service.
3. Combine Customer-Connected Service data with Driftstack-internal
   profiles or cross-Customer aggregates.
4. Use Customer Data (Sessions, Workflows, Recordings) to train
   machine-learning models, including the bundled-LLM AI agent
   feature, without Customer's separate explicit consent.

## 6. International transfers

Driftstack is established in the Netherlands. Several Sub-processors
are established outside the EEA, in particular in the United States.
Where Personal Data is transferred outside the EEA to a country
without an adequacy decision under Article 45 GDPR, Driftstack
relies on:

1. The **EU-US Data Privacy Framework (DPF)** for Sub-processors
   that are self-certified under the DPF and where the data
   category is within the scope of the recipient's certification.
   Counsel review confirms current self-certification status per
   Sub-processor at the EU-US DPF participants list (https://www.dataprivacyframework.gov/list).
2. The **2021 Standard Contractual Clauses** (Commission
   Implementing Decision (EU) 2021/914), in the appropriate Module
   per the Sub-processor's role, for Sub-processors not (or not
   currently) DPF-self-certified, or for transfer paths the DPF does
   not cover.
3. **Article 49 GDPR derogations** only in genuinely exceptional
   cases (e.g. one-time transfers in support of a legal claim).
   Driftstack does not rely on Article 49 derogations as a routine
   transfer mechanism.

The current applicable mechanism per Sub-processor is documented in
the Sub-processor list (Section 7).

## 7. Sub-processors

Driftstack engages the following Sub-processors to provide the
Service. Each Sub-processor is bound by a written agreement
imposing obligations consistent with Article 28 GDPR.

| Sub-processor                                                          | Purpose                                                                                                                                                                                                                    | Establishment                                                                | Transfer mechanism                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MacStadium, Inc.** (US, California)                                  | Mac mini fleet hosting infrastructure for the WebKit driver layer at launch.                                                                                                                                               | United States                                                                | 2021 SCCs (Module 2) supplemented by EU-US DPF where MacStadium is self-certified at the time of transfer; counsel verifies current status.                                                                               |
| **Stripe Payments Europe Limited** (Ireland)                           | Payment processing for Customers established in the EEA, UK, and Switzerland.                                                                                                                                              | Ireland                                                                      | EEA-internal; no transfer mechanism required for EEA Customer base.                                                                                                                                                       |
| **Stripe, Inc.** (US, Delaware)                                        | Payment processing for Customers established outside the EEA / UK / CH.                                                                                                                                                    | United States                                                                | 2021 SCCs (Module 2) and EU-US DPF (Stripe is DPF-self-certified at time of writing; counsel verifies current status).                                                                                                    |
| **Anthropic, PBC** (US, Delaware) — _conditional_                      | Bundled LLM for the AI agent feature. Engaged only when Customer opts into bundled-LLM billing. Customers using BYOK (own Anthropic credentials) do not establish this Sub-processor relationship through Driftstack.      | United States                                                                | 2021 SCCs (Module 3 — controller-to-processor where Driftstack acts as Customer's Processor and Anthropic acts as Sub-processor) and EU-US DPF where applicable; counsel verifies current Anthropic certification status. |
| **Moneybird B.V.** (Netherlands)                                       | Accounting platform for invoice generation and bookkeeping.                                                                                                                                                                | Netherlands                                                                  | EEA-internal; no transfer mechanism required.                                                                                                                                                                             |
| **Hetzner Online GmbH** (Germany)                                      | Control-plane hosting (VM running the API server, admin panel, and onboarding surface).                                                                                                                                    | Germany                                                                      | EEA-internal; no transfer mechanism required.                                                                                                                                                                             |
| **Neon, Inc.** (US, Delaware) — _data resident in EU Frankfurt_        | Managed Postgres for control-plane data.                                                                                                                                                                                   | United States (corporate); EU Frankfurt (data residency)                     | 2021 SCCs (Module 2) and EU-US DPF where applicable; counsel verifies current Neon certification status. Data-at-rest stays in the EU.                                                                                    |
| **Upstash, Inc.** (US, Delaware) — _data resident in EU Frankfurt_     | Managed Redis for caches, rate-limit buckets, and ephemeral session state.                                                                                                                                                 | United States (corporate); EU Frankfurt (data residency)                     | 2021 SCCs (Module 2) and EU-US DPF where applicable; counsel verifies current Upstash certification status. Data-at-rest stays in the EU.                                                                                 |
| **Cloudflare, Inc.** (US, Delaware)                                    | DNS, CDN, edge routing, R2 object storage for customer-uploaded avatars, encrypted profile blobs, and public status snapshots; Pages hosting for the marketing site.                                                       | United States (corporate); R2 default jurisdiction (data replicated EU + US) | 2021 SCCs (Module 2) and EU-US DPF where applicable; counsel verifies current Cloudflare certification status.                                                                                                            |
| **Postmark / ActiveCampaign LLC** (US, Delaware) — _EU sending region_ | Transactional email (signup verification, password reset, billing receipts, support correspondence).                                                                                                                       | United States                                                                | 2021 SCCs (Module 2) and EU-US DPF where applicable; counsel verifies current Postmark certification status.                                                                                                              |
| **Sentry / Functional Software, Inc.** (US, Delaware) — _EU region_    | Error tracking and performance monitoring for the API server, GUI client, and marketing site.                                                                                                                              | United States (corporate); EU region (data residency)                        | 2021 SCCs (Module 2) and EU-US DPF where applicable; counsel verifies current Sentry certification status. Sentry EU region selected.                                                                                     |
| **NowPayments OÜ** (Estonia, EU) — _conditional_                       | Cryptocurrency payment processing (BTC, LTC, USDT, USDC, ETH, XMR). Engaged only when a Customer opts to pay with cryptocurrency at checkout; bypassed entirely for Stripe-paying Customers.                               | Estonia, EU                                                                  | EEA-internal; no transfer mechanism required for EEA-resident Sub-processor.                                                                                                                                              |
| **LiveKit** (US, regional endpoints) — _conditional_                   | WebRTC signaling and media SFU for the optional live-session feature, where Customer or Driftstack support views an in-progress browser session in real time. Disabled by default; engaged only when explicitly initiated. | United States (regional endpoints; EU preferred)                             | 2021 SCCs (Module 2) and EU-US DPF where applicable; counsel verifies current LiveKit certification status.                                                                                                               |

The Sub-processor list is **subject to change** under the
notification mechanism in Section 5 of the DPA. The current list is
also published at the URL hosting this Privacy Policy when
Driftstack's marketing site goes live.

## 8. Customer-Connected Services (NOT Sub-processors)

The following third-party services are integrated with the Service
under **Customer's** account, **Customer's** credentials, and
**Customer's** contractual relationship. They are **not**
Sub-processors of Driftstack:

1. **HTTP / SOCKS5 proxy providers** (e.g. Bright Data, Smartproxy,
   Customer's own infrastructure).
2. **Captcha-solving services** (e.g. 2Captcha, CapSolver,
   AntiCaptcha).
3. **Email services** Customer accesses by IMAP, Gmail OAuth, or
   equivalent.
4. **SMS-verification services** (e.g. TextVerified, Twilio).

Driftstack does not contract with these providers, does not receive
service from them, and does not Process Personal Data on
Driftstack's behalf through them. The third-party Processes data on
**Customer's** instruction via **Customer's** credentials. Each
Customer-Connected Service operates under its own privacy policy
between Customer and that provider; Driftstack has no visibility
into that relationship beyond the credential Customer supplies and
the response observed during the Session.

## 9. Retention

| Category                                            | Retention period                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account data                                        | Duration of Subscription + 7 years post-termination (Article 52 _Algemene wet inzake rijksbelastingen_ — 7-year retention of administration).                                                                              |
| Authentication data (hashed API keys, key metadata) | Until revocation; revoked records retained 90 days for audit then deleted.                                                                                                                                                 |
| Session metadata                                    | 90 days operational; aggregated counters (no PII) retained indefinitely for capacity planning.                                                                                                                             |
| Session Recordings                                  | Customer-controlled (1–365 days, default 30); none retained beyond Customer's configured window.                                                                                                                           |
| Customer-Provided Secrets                           | Deleted within 30 days of Customer Account termination, or earlier on Customer's documented request.                                                                                                                       |
| Profile metadata + Profile Snapshots                | Customer-controlled. Profile rows persist until Customer deletes them; Profile Snapshots (immutable point-in-time copies) persist until Customer deletes them. All deleted within 30 days of Customer Account termination. |
| Billing data                                        | 7 years post-transaction (Dutch tax law, AWR Art 52).                                                                                                                                                                      |
| Support correspondence                              | 3 years post-resolution.                                                                                                                                                                                                   |
| Marketing-site access logs                          | 30 days.                                                                                                                                                                                                                   |

When the retention period for a category expires, Driftstack
deletes the Personal Data or anonymises it (rendering it no longer
attributable to a Data Subject). Anonymised aggregates may be
retained for capacity planning.

## 10. Data subject rights

Where Driftstack acts as Controller for Personal Data of a Data
Subject, the Data Subject has the rights set out in Articles 15–22
GDPR:

- **Right of access** (Article 15) — confirmation of whether
  Driftstack Processes the Data Subject's Personal Data, and a copy
  of that data.
- **Right to rectification** (Article 16) — correction of
  inaccurate or incomplete Personal Data.
- **Right to erasure** ("right to be forgotten" — Article 17) —
  deletion in the circumstances set out in Article 17(1), subject
  to the exceptions in Article 17(3) (notably: legal obligation,
  the establishment, exercise, or defence of legal claims).
- **Right to restriction of processing** (Article 18) — Processing
  on hold pending verification or pending the establishment of a
  legal claim.
- **Right to data portability** (Article 20) — Personal Data the
  Data Subject has provided, in a structured, commonly used,
  machine-readable format.
- **Right to object** (Article 21) — to processing based on
  Article 6(1)(f) (legitimate interest), where the Data Subject's
  interests prevail.
- **Rights related to automated individual decision-making,
  including profiling** (Article 22) — Driftstack does not engage
  in automated decision-making producing legal or similarly
  significant effects on Data Subjects.

To exercise any of these rights, contact `privacy@driftstack.dev`. Driftstack responds within one (1) month of receipt of the request, extendable by two (2) further months for complex or numerous requests with notice to the Data Subject (Article 12(3) GDPR).

Where Driftstack acts as **Processor** on Customer's behalf (e.g.
for Recordings), Data Subject requests should be directed to the
Customer (Controller). Driftstack assists Customer in responding,
per the DPA Section 6.

**Right to lodge a complaint with a supervisory authority**
(Article 77 GDPR): Data Subjects may lodge a complaint with the
**Autoriteit Persoonsgegevens** (Dutch DPA), Postbus 93374, 2509
AJ Den Haag, the Netherlands; or with the supervisory authority of
the Data Subject's habitual residence.

## 11. Data Protection Officer / Privacy Contact

Driftstack has assessed its DPO obligations under Article 37(1)(b)
GDPR and concluded that, at current scale, the threshold for
mandatory DPO appointment is not met. Driftstack has documented a
threshold-based policy: a DPO will be appointed when:

1. Total monthly active sessions across the Service exceed 1
   million; **or**
2. Any single Customer's monthly Sessions involve regular and
   systematic monitoring of more than 5,000 unique Data Subjects;
   **or**
3. The Autoriteit Persoonsgegevens issues guidance applying the
   Article 37(1)(b) threshold to similar services.

Until then, Driftstack designates a **Privacy Contact** responsible
for fielding privacy queries and coordinating Driftstack's response
to Data Subject requests:

- Privacy Contact: `privacy@driftstack.dev`
- Postal correspondence: addressed to Driftstack B.V., the registered office of which is published on the Driftstack website, attention: Privacy Contact.

The Privacy Contact monitors threshold conditions and triggers DPO appointment when applicable. The threshold policy is reassessed on each annual review of this Privacy Policy.

## 12. Security

Driftstack implements technical and organisational measures
appropriate to the risk under Article 32 GDPR. The measures are
documented in detail in the [DPA Annex 2](/legal/dpa/#annex-2--technical-and-organisational-measures-toms).
Summarised:

1. **Encryption in transit:** TLS 1.2+ for all API and Service
   traffic.
2. **Encryption at rest:** disk-level encryption on the Postgres
   primary; application-level encryption for Customer-Provided
   Secrets.
3. **Access control:** role-based access to production systems;
   principle of least privilege; production access logged.
4. **API authentication:** scrypt-hashed API Keys; revocable;
   scoped.
5. **Audit logging:** structured Pino-formatted JSON logs with
   request id correlation; admin actions audit-logged separately.
6. **Backup:** Postgres point-in-time recovery; default 30-day
   retention.
7. **Vulnerability management:** dependency security scanning;
   coordinated disclosure mechanism.
8. **Incident response:** documented runbook; on-call rotation
   capability scaled to Subscription tier.

## 13. Breach notification

Where Driftstack identifies a Personal Data breach within the
meaning of Article 4(12) GDPR:

1. **Notification to the supervisory authority.** Driftstack
   notifies the Autoriteit Persoonsgegevens (or the lead
   supervisory authority if different) within 72 hours of becoming
   aware of the breach, where the breach is likely to result in a
   risk to the rights and freedoms of natural persons. Where
   notification is not made within 72 hours, the notification is
   accompanied by reasons for the delay (Article 33(1) GDPR).
2. **Notification to Customer (where Driftstack is Processor).**
   Driftstack notifies Customer without undue delay (target: within
   48 hours of becoming aware), per the DPA Section 7.
3. **Notification to Data Subjects (where Driftstack is Controller
   and Article 34 applies).** Driftstack communicates the breach to
   affected Data Subjects without undue delay where the breach is
   likely to result in a high risk to their rights and freedoms,
   subject to the exceptions in Article 34(3).

## 14. Children

The Service is not directed to and is not intended for use by
children. Driftstack does not knowingly collect Personal Data of
children under 16 (or the equivalent threshold of the Data Subject's
jurisdiction). If Driftstack learns it has collected Personal Data
of a child, Driftstack deletes the data without undue delay.

## 15. Updates to this Privacy Policy

Driftstack may update this Privacy Policy from time to time.
Material updates take effect no earlier than 30 days after
notification (in-product banner or email to Customer's billing
contact). Customer's continued use of the Service after the
effective date constitutes acceptance. Non-material updates (typo,
formatting, clarification) take effect immediately on publication.

The current version is recorded in the document header and tracked
in the legal-acceptance machinery.

## 16. Contact

For all matters relating to this Privacy Policy:

- Privacy: `privacy@driftstack.dev`
- Legal: `legal@driftstack.dev`
- Postal correspondence: addressed to Driftstack B.V., Amsterdam, the Netherlands.

---

_End of Privacy Policy._
