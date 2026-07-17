---
layout: ../../layouts/LegalLayout.astro
title: Data Processing Agreement
description: Article 28 GDPR processor terms for Customer Data, Session content, and Customer-Provided Secrets.
---

**Version:** 1.1 · **Effective:** 2026-07-17

This Data Processing Agreement ("**DPA**") forms part of the
[Terms of Service](/legal/terms/) between Driftstack B.V. (the
"**Processor**" or "**Driftstack**") and Customer (the "**Controller**"
or "**Customer**"). It governs the Processing of Personal Data by
Driftstack on Customer's behalf in the course of providing the
Service. Capitalised terms are defined in the [Terms of Service](/legal/terms/).

This DPA is structured to satisfy Article 28(3) GDPR. To the extent
applicable to a Customer's processing in another jurisdiction (UK
GDPR, Swiss FADP), this DPA's provisions read with the corresponding
provisions of those regimes.

## 1. Subject matter, duration, nature, and purpose

| Element                         | Specification                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subject matter**              | Processing of Personal Data by Driftstack as Processor on Customer's behalf in the course of providing the Service.                                                                                                                                                                                                                                   |
| **Duration**                    | The duration of Customer's Subscription, plus the retention periods specified in Section 11 of this DPA and Section 9 of the Privacy Policy.                                                                                                                                                                                                          |
| **Nature of Processing**        | Storage, transmission, transformation, retrieval, deletion, and execution of automated browsing instructions.                                                                                                                                                                                                                                         |
| **Purpose of Processing**       | To provide the Service to Customer: provision Sessions, execute Customer's intent-level instructions through the WebKit driver, return inline Capture artifacts, transmit ephemeral live-session media, hold Customer-Provided Secrets for the duration required for Session execution, and surface Session metadata for Customer's operational view. |
| **Categories of Data Subjects** | Customer's Authorized Users (where Customer's Account Data is processed) and the natural persons whose Personal Data Customer's automated browsing encounters at the Customer-selected target sites.                                                                                                                                                  |
| **Categories of Personal Data** | Set out in Annex 1.                                                                                                                                                                                                                                                                                                                                   |

## 2. Roles

2.1 **Customer is the Controller** of the Personal Data processed
under this DPA. Customer determines the purposes and means of
Processing, including the choice of target sites, the framing of
Customer Workflows, whether to request API Capture artifacts or view
ephemeral live-session media, and the supply of Customer-Provided
Secrets. Desktop-local recording files remain under Customer's
control and outside Driftstack's cloud processing.

2.2 **Driftstack is the Processor.** Driftstack Processes Personal
Data only on Customer's documented instructions, as set out in this
DPA, the Terms of Service, and through the Customer's API requests.

2.3 **Where Customer's Customer is itself a Data Subject's
Controller** (for example, where Customer is itself a B2B SaaS
serving its own customers), Customer represents that it has the
right to engage Driftstack as a Processor for that processing. The
chain of accountability beyond Customer is Customer's responsibility.

## 3. Driftstack's obligations as Processor

### 3.1 Process only on documented instructions

Driftstack Processes Personal Data only on Customer's documented
instructions, including with regard to international transfers,
unless required to do otherwise by Union or Member State law to
which Driftstack is subject. In the latter case, Driftstack informs
Customer of that legal requirement before Processing, unless that
law prohibits such information on important grounds of public
interest (Article 28(3)(a) GDPR).

Customer's "documented instructions" comprise:

1. The Terms of Service.
2. This DPA.
3. The Acceptable Use Policy.
4. The Customer's API requests (treated as instructions).
5. Configuration Customer sets in the GUI Client or via the API
   (Session, Capture, live-session, Sub-processor consent, etc.).
6. Any documented instruction Customer provides to Driftstack in
   writing referencing this DPA.

If Driftstack believes a Customer instruction infringes the GDPR,
the AVG, or other applicable data-protection law, Driftstack
informs Customer without delay (Article 28(3) final paragraph
GDPR).

### 3.2 Confidentiality

Driftstack ensures that personnel authorised to Process Personal
Data are bound by confidentiality obligations or are subject to a
statutory obligation of confidentiality (Article 28(3)(b) GDPR).

### 3.3 Security of Processing

Driftstack implements appropriate technical and organisational
measures to ensure a level of security appropriate to the risk
(Article 32 GDPR). The measures are set out in **Annex 2** of this
DPA.

### 3.4 Sub-processors

Driftstack may engage Sub-processors to fulfil specific Processing
activities. Driftstack:

1. Provides Customer with **general written authorisation** to
   engage the Sub-processors listed in **Annex 3** of this DPA.
2. Notifies Customer of any **intended addition or replacement** of
   Sub-processors at least **thirty (30) days** before that change
   takes effect, providing the new Sub-processor's identity, role,
   data category, and applicable transfer mechanism.
3. Permits Customer to **object** to the addition or replacement on
   reasonable grounds within the 30-day notice window. If Customer's
   objection cannot be resolved by Driftstack proposing a
   commercially reasonable alternative, Customer may terminate the
   affected portion of the Subscription without penalty by written
   notice given before the new Sub-processor is engaged. Customer's
   continued use of the Service after the 30-day window without
   objection constitutes consent to the new Sub-processor.
4. Imposes **contractual obligations on each Sub-processor** that
   are no less protective than those in this DPA, in particular as
   regards security obligations and assistance with Data Subject
   requests (Article 28(4) GDPR).
5. Remains **fully liable to Customer** for the performance of any
   Sub-processor's obligations (Article 28(4) GDPR).

### 3.5 Customer-Connected Services are NOT Sub-processors

Customer-Connected Services (HTTP/SOCKS5 proxies, captcha-solving
services, email services accessed by Customer's credentials, SMS
services accessed by Customer's credentials) operate under
**Customer's** account, **Customer's** credentials, and
**Customer's** contractual relationship with the third-party
provider. They are not Sub-processors of Driftstack within the
meaning of Article 28(2) and (4) GDPR.

The DPA's Sub-processor obligations (notice, objection, downstream
contractual obligations, downstream liability) do not apply to
Customer-Connected Services, because Driftstack does not engage
them as Sub-processors. Customer is responsible for the data
protection compliance of its relationships with these providers,
including any DPA Customer enters with them directly.

When Customer instructs Driftstack to forward a Customer-Provided
Secret to a Customer-Connected Service in the course of Session
execution, Driftstack acts on that instruction without itself
becoming a Controller of the data flowing to the Customer-Connected
Service.

### 3.6 Assistance with Data Subject requests

Taking into account the nature of the Processing, Driftstack
assists Customer by appropriate technical and organisational
measures, insofar as possible, in fulfilling Customer's obligation
to respond to requests from Data Subjects exercising their rights
under Articles 12–22 GDPR (Article 28(3)(e) GDPR).

Specifically, Driftstack:

1. Forwards to Customer, without undue delay, any Data Subject
   request received directly by Driftstack regarding data of which
   Customer is the Controller.
2. Provides Customer, on Customer's reasonable written request,
   with the technical means to access, export, rectify, restrict,
   or delete Personal Data Driftstack Processes on Customer's
   behalf.
3. Does not itself respond to a Data Subject's request regarding
   Customer's data without Customer's instruction, except where
   required to confirm Driftstack's role as Processor and identify
   Customer as the Controller.

### 3.7 Assistance with Controller's compliance

Taking into account the nature of the Processing and the
information available, Driftstack assists Customer in ensuring
compliance with Articles 32 to 36 GDPR (Article 28(3)(f) GDPR),
including:

1. Providing security documentation appropriate to Customer's risk
   assessment under Article 32.
2. Notifying Customer of Personal Data breaches per Section 7 of
   this DPA (Article 33).
3. Cooperating with Customer's data protection impact assessments
   (DPIAs) under Article 35 to the extent reasonably necessary.
4. Cooperating with Customer's prior consultation with the
   supervisory authority under Article 36 to the extent reasonably
   necessary.

### 3.8 Deletion or return at end of Processing

Upon termination of Customer's Subscription, Driftstack:

1. Deletes or returns (at Customer's choice, exercised within 30
   days of termination) all Personal Data Driftstack Processes on
   Customer's behalf, except where Union or Member State law
   requires retention (Article 28(3)(g) GDPR).
2. Deletes existing copies after the return or deletion is
   complete, except retained copies required by law (e.g. Dutch tax
   law's 7-year retention for billing records).
3. Provides Customer with a confirmation of deletion or return on
   Customer's written request.

The retention periods in Section 11 of this DPA and Section 9 of
the Privacy Policy implement this clause.

### 3.9 Audit cooperation

Driftstack makes available to Customer all information necessary to
demonstrate compliance with this DPA and Article 28 GDPR, and
allows for and contributes to audits, including inspections,
conducted by Customer or another auditor mandated by Customer
(Article 28(3)(h) GDPR), subject to:

1. **Frequency.** Once per twelve (12) months, except where (a)
   required by a supervisory authority, or (b) following a
   substantiated Personal Data breach affecting Customer.
2. **Notice.** At least thirty (30) days' written notice, except
   where the audit is requested following a breach.
3. **Auditor.** Customer's own personnel or an independent
   third-party auditor that is not a competitor of Driftstack and
   that has signed reasonable confidentiality obligations.
4. **Scope.** Limited to the systems, controls, and processes
   relevant to the Processing of Customer's Personal Data.
5. **Cost.** Borne by Customer except where the audit reveals a
   material breach by Driftstack of this DPA, in which case
   Driftstack reimburses reasonable audit costs.
6. **Standardised reports.** Driftstack may, in lieu of a
   Customer-conducted audit, satisfy this obligation by providing a
   current SOC 2 Type II report or equivalent third-party audit report
   if Driftstack holds one. Driftstack does not currently hold such a
   report; that fact does not limit Customer's audit rights above.

## 4. International transfers

Where Driftstack transfers Personal Data outside the EEA to a
country without an adequacy decision under Article 45 GDPR,
Driftstack relies on:

1. **The 2021 Standard Contractual Clauses** (Commission
   Implementing Decision (EU) 2021/914), the appropriate Module
   per the data flow, which are incorporated by reference into
   this DPA via **Annex 4**.
2. **The EU-US Data Privacy Framework**, where the recipient is
   self-certified at the time of transfer and the data category is
   within the recipient's certification scope.
3. **Supplementary measures** where required following the CJEU's
   _Schrems II_ judgment, including the technical measures in
   Annex 2 (encryption in transit and at rest, key management
   under Driftstack's control).

For the avoidance of doubt, where Driftstack and Customer act under
the SCCs, the SCCs prevail in case of conflict with this DPA on
matters of international transfer mechanism.

## 5. Customer-Provided Secrets — specific obligations

In addition to the obligations above, Driftstack handles
Customer-Provided Secrets (proxy credentials, captcha-service API
keys, email credentials, SMS-service API keys) under the following
specific terms:

1. **Storage.** Customer-Provided Secrets are stored encrypted at
   rest using application-level encryption with keys managed by
   Driftstack and rotated on a documented schedule.
2. **Use.** Customer-Provided Secrets are used solely to execute
   Customer's Session instructions. They are not used for any
   other purpose, are not aggregated across Customers, and are not
   exposed to any party other than the Customer-Connected Service
   that Customer has instructed Driftstack to forward them to.
3. **Logging.** Driftstack does not log Customer-Provided Secrets
   in plaintext. Audit logs reference secrets by an opaque
   identifier (e.g. `proxy_<uuid>`) only.
4. **Deletion.** Customer-Provided Secrets are deleted within 30
   days of Customer Account termination or earlier on Customer's
   documented request. Customer may rotate or revoke a secret at
   any time through the API.
5. **Compromise.** If Driftstack determines a Customer-Provided
   Secret has been compromised (whether through Driftstack's own
   systems or detected via abnormal access patterns), Driftstack
   notifies Customer without undue delay (target: within 24
   hours).

## 6. Personal Data breaches

### 6.1 Notification to Customer

Driftstack notifies Customer of any Personal Data breach affecting
Customer's data **without undue delay** after becoming aware
(target: within **48 hours**), and in any event within the
timetable required to enable Customer to fulfil its own Article 33
notification obligation to its supervisory authority (Article
33(2) GDPR).

The notification includes, to the extent then known:

1. The nature of the breach, including the categories and
   approximate number of Data Subjects and Personal Data records
   affected.
2. The likely consequences of the breach.
3. The measures taken or proposed to address the breach and
   mitigate its possible adverse effects.
4. The contact information of the Driftstack representative
   coordinating the response.

Where information is not available within 48 hours, Driftstack
provides it in subsequent communications without undue delay as it
becomes available.

### 6.2 Cooperation

Driftstack cooperates with Customer's response to the breach,
including by:

1. Providing additional information as Customer requests.
2. Implementing mitigation measures Customer reasonably requests
   that are within Driftstack's technical and operational control.
3. Assisting in Customer's preparation of supervisory-authority
   notifications and Data Subject communications.
4. Coordinating timing where Driftstack itself has a notification
   obligation as Controller of overlapping data (e.g. account
   data).

### 6.3 Documentation

Driftstack maintains records of all breaches affecting Customer
data, including the facts, effects, and remedial actions, and makes
the records available to Customer on request (Article 33(5) GDPR).

## 7. Records of Processing

Driftstack maintains records of Processing activities under
Article 30(2) GDPR and makes them available to Customer or to
supervisory authorities on request to the extent necessary to
demonstrate Driftstack's compliance.

## 8. Term

This DPA takes effect on the Effective Date and continues for as
long as Driftstack Processes Personal Data on Customer's behalf,
plus any post-termination retention periods.

## 9. Liability

Liability under this DPA is governed by the limitations and
carve-outs in Section 13 of the Terms of Service. The carve-out for
breach of confidentiality in ToS Section 13.3(3) extends to
material breach of this DPA's confidentiality and security
obligations.

## 10. Conflict

In case of conflict between this DPA and the Terms of Service or
any other Document on a matter of data protection, this DPA
prevails. In case of conflict between this DPA and the SCCs (where
incorporated under Annex 4), the SCCs prevail on matters of
international transfer.

## 11. Retention summary (cross-reference)

The retention periods applicable to data Processed under this DPA
are set out in Section 9 of the [Privacy Policy](/legal/privacy/#9-retention) and apply equally here. Notably:

- Desktop-local recordings: not uploaded to or retained by
  Driftstack; Customer controls retention and deletion on Customer's
  device.
- API Capture artifacts: returned inline; the Capture endpoint does
  not retain the response bytes.
- Live-session media: not stored; streamed through LiveKit and
  dropped on session end.
- Customer-Provided Secrets: deleted within 30 days of Account
  termination.
- Session metadata (non-content): 90 days operational; aggregated
  counters retained indefinitely.

---

## Annex 1 — Description of Processing

### Categories of Data Subjects

1. Customer's Authorized Users (employees, contractors, agents)
   whose Personal Data is contained in Account Data.
2. Natural persons whose Personal Data Customer's automated
   browsing encounters at Customer-selected target sites. The
   composition of this category depends entirely on Customer's
   choice of targets and Customer's Workflow configuration.

### Categories of Personal Data

1. **Account-related** (Authorized Users): name, email address,
   role, time zone, billing contact information.
2. **Session-related** (Data Subjects encountered through
   automation):
   - Identifiers visible to the automated browsing (account names,
     screen names, profile photos, public posts, public profile
     URLs).
   - Authentication-related (where Customer's automation
     authenticates to a target on the Customer's own behalf with
     Customer-Provided Secrets — this is Customer's own
     authentication, not third parties').
   - Content of pages browsed where transmitted through live-session
     media or returned inline as an API Capture artifact.
3. **Customer-Provided Secrets**: credentials Customer supplies
   (proxy auth, captcha API keys, email credentials, SMS API keys).
   These are technically credentials of natural persons or accounts
   Customer holds.

### Special categories

Driftstack does **not** intentionally Process Special Category Data
under Article 9 GDPR. Where Customer's automated browsing causes
such data to pass through live-session media or an API Capture
request, Customer is responsible for the underlying Article 9 lawful
basis. A desktop-local recording may contain the same data, but it
remains on Customer's device and is not uploaded to or retained by
Driftstack.

### Processing operations

Storage, retrieval, transmission, transformation, deletion,
transient forwarding of live-session media, inline return of API
Capture artifacts, forwarding to Customer-Connected Services on
Customer's instruction, and execution of Customer Workflow logic on
the Driftstack-hosted WebKit driver runtime.

---

## Annex 2 — Technical and Organisational Measures (TOMs)

These measures meet the requirement of Article 32 GDPR for a level
of security appropriate to the risk. Measures are layered.

### A. Confidentiality (Article 32(1)(b))

1. **Access control to systems.** Production systems are accessible
   only to authenticated personnel through identity-provider-
   integrated SSO with hardware-key-gated access where available.
   Access is provisioned per role with least-privilege defaults.
2. **Access control to data.** Application-level authentication via
   API Keys; per-Customer scoping; cross-Customer data access by
   Driftstack personnel requires explicit administrative action and
   is logged.
3. **API key handling.** API Keys are stored as scrypt hashes
   (memory-hard parameter set documented in `apps/server/src/lib`).
   Plaintext keys are shown to Customer once at issuance and not
   recoverable thereafter.
4. **Customer-Provided Secret handling.** Stored encrypted at rest
   with application-level encryption; never logged in plaintext;
   used only to execute Customer instructions.
5. **Personnel.** Driftstack personnel with production access are
   bound by written confidentiality obligations.

### B. Integrity (Article 32(1)(b))

1. **Encryption in transit.** TLS 1.2 minimum (TLS 1.3 preferred)
   for all API and Service traffic. HSTS configured.
2. **Encryption at rest.** Postgres disk-level encryption at the
   storage layer; application-level encryption for sensitive
   fields (API key hashes, Customer-Provided Secrets).
3. **Input validation.** Every API endpoint validates input through
   Zod schemas; the OpenAPI specification is generated from Zod, so
   validation is the single source of truth.
4. **Code-level protections.** TypeScript strict mode across the
   codebase; mandatory code review on changes affecting auth,
   billing, or data layer.

### C. Availability + resilience (Article 32(1)(b))

1. **Backup.** Postgres point-in-time recovery configured;
   default 30-day retention. Backups are encrypted.
2. **Redundancy.** Fleet capacity and redundancy are managed
   operationally. Any contractually binding availability or
   redundancy commitment is stated in Customer's applicable Order
   Form or published SLA.
3. **Health monitoring.** Structured Pino logs; alerting on error
   rates and latency anomalies; public status page at `status.driftstack.dev`.
4. **Incident response.** Documented runbook; on-call rotation
   capability scaled to Subscription tier.

### D. Restoration (Article 32(1)(c))

Backups are tested for restore at least quarterly. Restoration
drills are documented.

### E. Process for testing, assessing, evaluating effectiveness (Article 32(1)(d))

1. Periodic security reviews of changes affecting
   authentication, authorisation, or data handling.
2. Dependency vulnerability scanning on every CI run.
3. Coordinated vulnerability disclosure: a published mechanism for security researchers to report issues at `security@driftstack.dev`.
4. Review of TOMs at each annual revision of this DPA.

### F. Pseudonymisation (Article 32(1)(a))

Where pseudonymisation can be applied without defeating the
purpose of Processing, it is. Specifically: aggregated capacity
metrics use hashed customer identifiers; per-Customer telemetry is
not aggregated across Customers without anonymisation.

### G. Logical separation

Customer data is logically separated by tenant identifier
(account_id) at the database layer. Cross-tenant queries by
Driftstack personnel are restricted and audited.

---

## Annex 3 — Sub-processors

The same list as in [Privacy Policy Section 7](/legal/privacy/#7-sub-processors) applies, summarised here for convenience:

| Sub-processor                             | Role                                     | Location                                                     | Transfer mechanism                      |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| MacStadium, Inc.                          | Mac mini fleet hosting                   | US, California                                               | 2021 SCCs Module 2 + EU-US DPF (verify) |
| Stripe Payments Europe Ltd                | Payment processing (EEA/UK/CH Customers) | Ireland                                                      | EEA-internal                            |
| Stripe, Inc.                              | Payment processing (non-EEA Customers)   | US, Delaware                                                 | 2021 SCCs Module 2 + EU-US DPF (verify) |
| Anthropic, PBC (conditional, opt-in only) | Bundled-LLM AI agent                     | US, Delaware                                                 | 2021 SCCs Module 3 + EU-US DPF (verify) |
| Moneybird B.V.                            | Accounting + invoicing                   | Netherlands                                                  | EEA-internal                            |
| Hetzner Online GmbH                       | Control-plane hosting (VM)               | Germany                                                      | EEA-internal                            |
| Neon, Inc.                                | Managed Postgres                         | US (corp); EU Frankfurt (data)                               | 2021 SCCs Module 2 + EU-US DPF (verify) |
| Upstash, Inc.                             | Managed Redis                            | US (corp); EU Frankfurt (data)                               | 2021 SCCs Module 2 + EU-US DPF (verify) |
| Cloudflare, Inc.                          | DNS / CDN / edge / R2 / Pages            | US (corp); R2 default jurisdiction (data replicated EU + US) | 2021 SCCs Module 2 + EU-US DPF (verify) |
| Postmark (ActiveCampaign LLC)             | Transactional email                      | US                                                           | 2021 SCCs Module 2 + EU-US DPF (verify) |
| Sentry (Functional Software, Inc.)        | Error tracking                           | US (corp); EU region (data)                                  | 2021 SCCs Module 2 + EU-US DPF (verify) |
| NowPayments OÜ (conditional, opt-in only) | Cryptocurrency payment processing        | Estonia, EU                                                  | EEA-internal                            |
| LiveKit (conditional, opt-in only)        | WebRTC live-session signaling / media    | US (regional endpoints; EU preferred)                        | 2021 SCCs Module 2 + EU-US DPF (verify) |

The list as published in the Privacy Policy is the authoritative
list for the avoidance of doubt; this Annex is a convenience copy.

**Region preference vs. region routing.** Customer may state an
infrastructure region preference (one of `us` / `eu` / `apac`) via
the dashboard or API. The preference does not change current data
residency: Customer Data held in Driftstack's databases (account,
profile, session, and audit data) resides on the EU-resident
infrastructure listed above; file objects held in Cloudflare R2
(customer-uploaded avatars, encrypted profile blobs, public status
snapshots) use R2's default jurisdiction, which replicates storage
between the EU and the US under the transfer mechanism listed above.
Any change to a Sub-processor or processing location remains subject
to Section 3.4 notice and objection rights. The trust page at
[`/trust/sub-processors`](/trust/sub-processors/) carries the same
explanation in plain language.

---

## Annex 4 — Standard Contractual Clauses

Where international transfer to a non-Adequate Country requires
the SCCs, the **Commission Implementing Decision (EU) 2021/914**
Standard Contractual Clauses are incorporated into this DPA by
reference, with the following Module selections:

1. **Customer (EU Controller) → Driftstack (Dutch Processor).** No
   SCC needed for Driftstack itself (EEA-internal).
2. **Driftstack (Dutch Processor) → Sub-processor in non-Adequate
   Country.** Module 3 (processor-to-(sub)processor).
3. **Driftstack (Dutch Processor) → Sub-processor that itself acts
   as a Controller (e.g. payment processors in their independent
   Controller capacity).** Module 1 (controller-to-controller) for
   the data flowing in that capacity, and Module 3 for the
   Processor-side flow.

The selections are made per Sub-processor in the agreement
between Driftstack and that Sub-processor; this Annex describes the
position Driftstack takes towards Customer.

The SCCs are amended by Annex I (information about transfer),
Annex II (technical and organisational measures — refers to Annex
2 above), Annex III (sub-processors — refers to Annex 3 above) of
the SCCs, populated per the Sub-processor relationship.

---

## Annex 5 — UK / Swiss addenda

For UK Personal Data, the **UK International Data Transfer
Addendum** (issued under Section 119A Data Protection Act 2018,
mandatory from 21 March 2024 for new transfers) is incorporated
where applicable.

For Swiss Personal Data, the SCCs are amended per the Swiss FDPIC
guidance on EU SCCs as adopted in Switzerland: references to
"Member State" extend to Switzerland; the FADP Article 6 obligation
on cross-border transfers is satisfied; the FDPIC is the relevant
supervisory authority.

These addenda are included by reference; the operative text is
incorporated by the underlying SCCs and the issuing authority's
official addendum text.

---

## Contact

For all matters relating to this Data Processing Agreement:

- Privacy: `privacy@driftstack.dev`
- Legal: `legal@driftstack.dev`
- Postal correspondence: addressed to Driftstack B.V., Amsterdam, the Netherlands.

---

_End of DPA._
