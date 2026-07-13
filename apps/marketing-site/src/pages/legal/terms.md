---
layout: ../../layouts/LegalLayout.astro
title: Terms of Service
description: The master commercial agreement between Driftstack B.V. and Customer.
---

# Driftstack — Terms of Service

**Version:** 1.0 · **Effective:** 2026-05-07

These Terms of Service ("**ToS**") govern Customer's access to and
use of the Service offered by Driftstack. Capitalised terms are
defined in Section 2 (Defined terms) below. The
[Privacy Policy](/legal/privacy/), the
[Data Processing Agreement](/legal/dpa/), and the
[Acceptable Use Policy](/legal/aup/) are incorporated
by reference and form part of the agreement between the Parties.

The Service is provided to **business customers** only. The Service
is not intended for, and is not offered to, consumers within the
meaning of Article 7:5 of the Dutch Civil Code (_Burgerlijk Wetboek_)
or Article 2(1) of Directive 2011/83/EU. Customer represents that
its acceptance is on behalf of a legal entity acting in the course of
its trade, business, craft, or profession.

## 1. Acceptance + parties

By creating an Account, by recording an Acceptance through the API,
or by accessing the Service through an API Key issued to Customer,
Customer agrees to these ToS. The individual recording the
Acceptance represents that they are authorised to bind Customer.

The agreement is between Driftstack and Customer. The agreement
takes effect on the Effective Date of the most recent Acceptance.

## 2. Defined terms

Capitalised terms in this ToS have the meanings set out in this
Section 2. If a term is capitalised elsewhere in these Terms but
not defined in this Section, the term carries its plain English
meaning.

## 3. The Service

Driftstack provides an iPhone-archetype Safari automation platform.
Specifically, Driftstack provides:

1. An **API** (the `/v1/` endpoints) accepting Customer instructions
   and returning Session, Capture, and Recording artifacts.
2. **SDKs** (TypeScript, Python, Go) that wrap the API.
3. A **self-hosted GUI Client** for operating Sessions interactively.
4. **Mac mini fleet infrastructure** that hosts the WebKit driver
   processes underlying each Session.

The Service is delivered as a managed cloud offering (default) or
as a self-hosted deployment Customer runs against Customer's own
mac mini fleet (Enterprise tier). The applicable deployment model
is set out in Customer's Subscription configuration.

The Service is **intent-based**. Customer expresses intent through
the API (e.g. "tap the button matching this selector", "wait until
this URL pattern appears"); the Service's behavioural simulation
layer determines the mechanical execution (coordinates, motion,
timing). Customer does not have direct access to coordinate-level or
event-level primitives through the customer-facing SDKs. (See L-001
in `docs/locked-decisions.md` for the architectural reasoning, which
informs but is not part of this ToS.)

## 4. Account + authorised users

4.1 **Account.** Customer registers an Account with the legal entity
name, billing address, and (where applicable) VAT/BTW identification
number representing the entity acting on these ToS.

4.2 **Authorized Users.** Customer may grant access to its
Authorized Users through API Keys with appropriate scopes. Customer
is responsible for the actions of its Authorized Users, including any
acts or omissions that would constitute a violation of these ToS or
the AUP if performed by Customer.

4.3 **API Keys.** API Keys are confidential. Customer is responsible
for the confidentiality of its API Keys and for all use of the
Service under those keys. Customer notifies Driftstack without undue
delay of any suspected compromise; Driftstack provides a revocation
mechanism through the admin API.

4.4 **No multi-customer use.** A single Account may not be used to
provide the Service to third parties as a reseller or service bureau
absent an explicit reseller agreement separately negotiated.

## 5. Customer responsibilities

5.1 **Lawful use.** Customer is responsible for ensuring its use of
the Service complies with all law applicable to Customer's
jurisdiction and to the jurisdictions of the targets Customer
interacts with through the Service. The Service is general-purpose
infrastructure; Driftstack does not pre-clear specific use cases.

5.2 **AUP compliance.** Customer complies with the
[Acceptable Use Policy](/legal/aup/), which is part of
this agreement.

5.3 **Customer-Connected Services.** The Service relies on
Customer-Connected Services for production-grade automation: HTTP /
SOCKS5 proxies, captcha-solving services, email-verification services,
and SMS-verification services. Customer is responsible for procuring,
authenticating, and paying for these services. Customer holds the
relationship with the third-party provider; Driftstack does not
contract with these providers on Customer's behalf, does not
guarantee availability or quality of these services, and does not
warrant that any specific provider will work with the Service.

5.4 **Customer Workflows + Customer Data.** Customer is solely
responsible for the content of its Customer Workflows and the
processing of Customer Data through them. Customer represents that
its Customer Workflows do not violate the AUP and that Customer holds
the rights necessary to process the Customer Data it submits.

5.5 **Customer warranties.** Customer warrants that:

1. It is duly organised under the law of its jurisdiction and has
   authority to bind itself to these ToS.
2. Its use of the Service against any given target does not, to
   Customer's knowledge, violate the target's posted Terms of Use in
   a manner the target has not authorised.
3. It has a lawful basis under Article 6 GDPR (or applicable
   equivalent) for any Personal Data it processes through the
   Service.
4. It complies with applicable export control law (including EU Dual
   Use Regulation (EU) 2021/821 and equivalent regimes) and does not
   route the Service to or for the benefit of any sanctioned person
   or entity.

5.6 **Cooperation.** Customer cooperates in good faith with
Driftstack's response to AUP violations, abuse reports, and valid
legal process.

## 6. Intellectual property

6.1 **Driftstack IP.** As between the Parties, Driftstack owns all
right, title, and interest in and to the Service, including the
Platform software, the API, the SDKs, the GUI Client, the
behavioural simulation library, the Mac mini fleet infrastructure,
the Driftstack name and trademarks, and all derivative works
generated by Driftstack from Customer-supplied feedback or
configuration. The Service is licensed, not sold; nothing in this
ToS transfers ownership.

6.2 **Customer IP.** As between the Parties, Customer owns all right,
title, and interest in and to its Customer Workflows and Customer
Data, including any output Customer generates by running the Service
under those Workflows. Driftstack receives a limited, non-exclusive,
non-transferable, sub-licensable (only to Sub-processors) licence to
process the Customer Workflows and Customer Data solely as necessary
to provide the Service.

6.3 **Customer feedback.** If Customer provides Driftstack with
feedback, suggestions, or feature requests, Customer grants Driftstack
a perpetual, worldwide, royalty-free, non-exclusive licence to use
that feedback to improve the Service. The licence does not extend to
Customer's confidential information unless Customer separately
identifies the feedback as non-confidential.

6.4 **No reverse engineering.** Customer does not (and does not
permit any third party to) reverse engineer, decompile, or
disassemble the Service except to the extent permitted by mandatory
applicable law (including Article 6 of Directive 2009/24/EC on the
legal protection of computer programs, where Customer is established
in the EU).

6.5 **Open-source components.** The Service incorporates open-source
software components subject to their respective licences. A list is
maintained at the URL published in Driftstack's developer documentation.

## 7. Confidentiality

7.1 **Confidential Information.** "Confidential Information" means
any non-public information disclosed by one Party to the other in
connection with this agreement, marked or identified as confidential
or that a reasonable recipient would understand to be confidential
under the circumstances. Driftstack's Confidential Information
includes pricing not yet published, product roadmaps, and technical
internals. Customer's Confidential Information includes Customer
Workflows, Customer Data, Customer-Provided Secrets, and the
identity of Customer's specific targets to the extent not generally
known.

7.2 **Obligations.** Each Party uses Confidential Information only
to perform under this agreement, protects it with at least the
degree of care it uses for its own confidential information of like
importance (and no less than reasonable care), and discloses it only
to its personnel and contractors with a need to know who are bound
by confidentiality obligations no less protective than this clause.

7.3 **Exceptions.** Confidentiality obligations do not apply to
information that (a) is or becomes publicly available without breach
of this clause, (b) was lawfully in the recipient's possession before
disclosure, (c) is independently developed by the recipient without
use of the disclosing Party's Confidential Information, or (d) is
required to be disclosed by law or valid legal process. The
recipient subject to a disclosure requirement notifies the
disclosing Party where lawful.

7.4 **Survival.** Confidentiality obligations survive termination
for as long as the Confidential Information retains its confidential
character.

## 8. Fees + payment

8.1 **Fees.** Customer pays the Fees for the Subscription tier
selected at signup. Driftstack offers a perpetual Free tier, a
Manual ladder (Personal, Team, Agency), and an API ladder (API
Starter, API Builder, API Scale), with a custom-priced Enterprise
tier. The current tiers and prices are published at
<https://driftstack.dev/pricing>. Fees are exclusive of VAT unless
explicitly stated; VAT is added at the rate applicable to Customer's
location at invoice issuance.

8.2 **Billing cycles.** Subscriptions bill monthly in advance unless
the Customer's tier or contract explicitly states otherwise.
Enterprise tier bills annually in advance by default.

8.3 **Payment methods.** The Service accepts:

1. **Card payments** (Visa, Mastercard, American Express, regional
   cards where available) via Stripe.
2. **SEPA Direct Debit** for Customers with a EUR bank account in
   the SEPA zone, via Stripe.
3. **iDEAL** for Customers with a Dutch bank account, via Stripe.
4. **Bancontact** for Customers with a Belgian bank account, via
   Stripe.

8.4 **VAT / BTW.**

1. Customers established in the Netherlands are charged Dutch BTW at
   the prevailing rate (currently 21%).
2. Customers established in another EU Member State and providing a
   valid VAT identification number are subject to **Reverse-Charge
   VAT**: Driftstack invoices without BTW, and Customer accounts for
   VAT under its own member state's regime. Customer is responsible
   for verifying its own VAT identification number.
3. Customers established outside the EU are invoiced without BTW and
   are responsible for any applicable import VAT, GST, sales tax, or
   equivalent under their own jurisdiction.
4. Where the EU "place of supply" rules under Council Directive
   2006/112/EC, as amended, would shift Driftstack's VAT obligation,
   Driftstack reserves the right to register and remit accordingly
   and to update this clause on Major-version notice.

8.5 **Late payment.** Fees are due upon issuance of invoice (for
recurring billing, this is the Subscription renewal date). Past-due
amounts accrue interest at the statutory commercial rate under
Article 6:119a of the Dutch Civil Code (`wettelijke handelsrente`).
Driftstack may suspend or terminate the Subscription for non-payment
following at least seven (7) days' written notice and Customer's
failure to cure within that window.

8.6 **Disputes.** Customer may dispute an invoice in good faith by
written notice within 30 days of invoice issuance, identifying the
specific charge disputed and the basis. Undisputed amounts remain
due. Resolution of disputed amounts follows Section 22 (Dispute
Resolution).

8.7 **Refunds.** Subscriptions are non-refundable except where
mandated by law. Driftstack may, at its discretion, issue pro-rated
refunds for service failures attributable to Driftstack.

8.7.1 **Crypto payments are non-refundable.** Subscriptions paid via
crypto (NowPayments) are non-refundable in all cases, including but
not limited to buyer's remorse, accidental over-payment, and price
movement between order and any potential refund. Customer may cancel
the Subscription at any time — cancellation stops future billing
periods — but the current billing period is not refunded.
Driftstack's sole obligation under this clause is to honour the
service entitlement through the end of the current paid period.
Card refund mechanics (8.7, above) do not apply to crypto-paid
Subscriptions.

8.8 **Tier changes.** Customer may upgrade or downgrade tiers at any
time through the Service. Upgrades take effect immediately and are
pro-rated against the current billing cycle. Downgrades take effect
at the end of the current billing cycle.

## 9. Service levels

9.1 **No guaranteed SLA at lower tiers.** The Free, Manual-ladder
(Personal, Team, Agency), API Starter, and API Builder tiers are
provided **without** a contractually-binding service level
agreement. Driftstack uses commercially reasonable efforts to
maintain availability, but does not commit to a specific uptime
percentage at these tiers. Customer should plan its use accordingly.

9.2 **Commercial SLA at higher tiers.** The API Scale and Enterprise
tiers carry a contractual SLA published separately (currently: 99.9%
monthly availability; first-response SLA on Severity-1 incidents of
four (4) hours on API Scale and one (1) hour on Enterprise). The
contractual SLA, when in effect, governs in case of conflict with
this Section 9.

9.3 **Maintenance.** Driftstack performs scheduled maintenance during
windows announced at least 48 hours in advance through the Service's
status page at <https://status.driftstack.dev>. Customers may also
subscribe to email notifications via the form on the status page.
Emergency maintenance may be performed without notice when required
to address a security or integrity issue.

9.4 **Force majeure events** (Section 19) suspend service-level
obligations.

## 10. Data + privacy

10.1 **Privacy Policy.** Driftstack's processing of Personal Data as
**Controller** is governed by the [Privacy Policy](/legal/privacy/).

10.2 **DPA.** Driftstack's processing of Personal Data as
**Processor** on Customer's behalf is governed by the
[Data Processing Agreement](/legal/dpa/), which is incorporated by
reference.

10.3 **Customer-Provided Secrets.** Driftstack stores
Customer-Provided Secrets encrypted at rest and Processes them only
to execute Customer's instructions. The DPA's Annex 2 (Technical and
Organisational Measures) sets out the protective measures.

## 11. Warranties + disclaimer

11.1 **Driftstack warranties.** Driftstack warrants that:

1. It will provide the Service in a workmanlike manner consistent
   with industry practice for similar services.
2. It will not knowingly introduce malicious code into the Service.
3. It will maintain the Sub-processor list in the Privacy Policy
   in good faith and reflect material changes per the notification
   mechanism in Section 5 of the DPA.
4. It will respond to security vulnerability reports under a
   coordinated disclosure policy published separately.

   11.2 **Disclaimer.** Except as expressly stated in Section 11.1, the
   Service is provided **"as is"** and **"as available"**, and
   Driftstack disclaims all other warranties, express, implied, or
   statutory, including warranties of merchantability, fitness for a
   particular purpose, accuracy, completeness, and non-infringement, to
   the maximum extent permitted by applicable law.

   11.3 **Customer assumes risk on target compatibility.** Driftstack
   does not warrant that any specific target site will be reachable,
   will not change in ways that break Customer Workflows, or will not
   detect or block Customer's automation. The Service's fingerprint
   parity is a moving target; the
   [cumulative fingerprint rig](/trust/cumulative-rig) parity ledger
   documents the current state of known residuals.

## 12. Indemnification

12.1 **Driftstack indemnifies Customer** against third-party claims
that the Service, as provided by Driftstack and used by Customer in
accordance with this ToS, infringes the third party's intellectual
property rights enforceable in the European Union or in Customer's
jurisdiction. Driftstack's obligation under this Section 12.1 is
limited to (a) defence of the claim with counsel of Driftstack's
choosing, and (b) settlement or final-judgment damages directly
attributable to the infringement.

12.2 **Carve-outs from Driftstack's indemnification.** Driftstack's
obligation under Section 12.1 does not extend to claims arising from
(a) Customer Workflows or Customer Data; (b) Customer-Connected
Services; (c) Customer's use of the Service in a manner not
authorised by this ToS or the AUP; (d) Customer's modification of the
Service; or (e) combination of the Service with materials not
provided by Driftstack where the claim would not exist absent the
combination.

12.3 **Customer indemnifies Driftstack** against third-party claims
arising from (a) Customer's use of the Service against any target
(including target-operator claims for breach of target's posted
terms, where Customer lacked the authorisation it represented under
Section 5.5); (b) Customer's processing of Personal Data through the
Service in violation of applicable data-protection law; (c)
Customer's violation of the AUP; (d) Customer's combination of the
Service with Customer-Connected Services or other materials; and
(e) Customer's breach of Section 5.5 warranties.

12.4 **Indemnification procedure.** The indemnified Party (a)
notifies the indemnifying Party promptly of any claim subject to
indemnification, (b) gives the indemnifying Party sole control of
the defence and settlement (provided that no settlement that admits
liability or imposes non-monetary obligations on the indemnified
Party is made without the indemnified Party's consent), and (c)
provides reasonable cooperation in the defence at the indemnifying
Party's expense.

## 13. Limitation of liability

13.1 **Liability cap.** **TO THE MAXIMUM EXTENT PERMITTED BY
APPLICABLE LAW**, each Party's aggregate liability under or in
connection with this agreement is **limited to the total Fees paid
or payable by Customer to Driftstack under this agreement during the
twelve (12) months immediately preceding the event giving rise to
the claim**.

13.2 **Excluded damages.** **TO THE MAXIMUM EXTENT PERMITTED BY
APPLICABLE LAW**, neither Party is liable for any indirect,
incidental, special, consequential, or punitive damages, lost
profits, lost revenues, lost data, or business interruption,
regardless of the legal theory under which the claim arises and
regardless of whether the Party was advised of the possibility of
such damages.

13.3 **Carve-outs from the cap and excluded damages.** Sections 13.1
and 13.2 do **not** limit liability for:

1. Gross negligence or willful misconduct (_opzet of bewuste
   roekeloosheid_) by the liable Party or its officers or directors.
2. Indemnification obligations under Section 12.1 (Driftstack's IP
   infringement indemnification) or Section 12.3 (Customer's
   indemnifications), each capped only as stated in those sections
   if at all.
3. Breach of Section 7 (Confidentiality).
4. Customer's payment obligations under Section 8.
5. Liability for death or personal injury caused by the liable
   Party's negligence (where applicable law mandates).
6. Any other liability that may not be limited or excluded under
   applicable law (notably: certain consumer-protection liability,
   though this ToS is B2B-only, and certain product-liability
   regimes).

   13.4 **Allocation rationale.** The Parties acknowledge that the
   limitations and carve-outs in this Section 13 are an essential basis
   of the bargain, that the Fees reflect the allocation of risk, and
   that the limitations would apply even if a remedy fails of its
   essential purpose.

## 14. Term + termination + suspension

14.1 **Term.** The agreement begins on the Effective Date and
continues until terminated under this Section.

14.2 **Termination for convenience.** Either Party may terminate the
agreement for convenience on thirty (30) days' written notice,
effective at the end of the then-current billing cycle. Customer's
liability for Fees through the effective date is unchanged.

14.3 **Termination for cause.** Either Party may terminate the
agreement immediately on written notice if the other Party (a)
materially breaches this agreement and fails to cure within thirty
(30) days of written notice of the breach (no cure period for breach
incapable of cure), (b) becomes insolvent, files for bankruptcy or
has bankruptcy filed against it, or assigns its assets for the
benefit of creditors, or (c) ceases to do business.

14.4 **Suspension by Driftstack.** Driftstack may suspend Customer's
account immediately on written notice (which may be electronic) if
(a) Customer's use violates the AUP per Section 5 of the AUP, (b)
Customer's use poses an imminent threat to the Service's integrity
or to other customers, (c) Customer is more than thirty (30) days
past due on undisputed Fees, or (d) Driftstack is required by law
or valid legal process to suspend.

14.5 **Effect of termination or suspension.**

1. Customer's API Keys are revoked.
2. Active Sessions are destroyed.
3. Customer's right to access the Service ceases.
4. Driftstack retains Customer Data for the periods specified in the
   Privacy Policy (typically 30 days post-termination for content
   data, longer for billing and tax records as required by Dutch
   law) and then deletes per the retention schedule. Customer may
   request earlier deletion subject to Driftstack's continuing
   obligations under applicable law.
5. Sections that by their nature survive (Confidentiality, IP,
   Indemnification, Limitation of Liability, Governing Law, Dispute
   Resolution, Notices, and this clause) survive termination.

   14.6 **Suspension's reversibility.** Suspension is reversible.
   Customer may dispute or remediate during a suspension; if the
   underlying issue is resolved, Driftstack reinstates the account.

## 15. Modifications

15.1 **Modification procedure.** Driftstack may modify this ToS by
publishing a new version at the URL where this ToS is hosted (or by
notifying Customer through the API and recording the new version in
the legal-acceptance machinery).

15.2 **Material modifications.** Material modifications (those that
materially alter Customer's rights, obligations, or fees, or add or
remove a Sub-processor) take effect no earlier than thirty (30) days
after notification to Customer. Customer's continued use of the
Service after the new version's effective date constitutes
Acceptance.

15.3 **Customer's option on Material modification.** Customer may
terminate the Subscription on written notice given before the new
version's effective date, without penalty and with pro-rated refund
of pre-paid Fees attributable to periods after the termination
effective date.

15.4 **Non-material modifications.** Non-material modifications
(typo, formatting, clarification, additional examples that do not
change obligations) take effect immediately on publication and do
not require new Acceptance.

## 16. Governing law

16.1 This agreement is governed by the **laws of the Netherlands**,
excluding its conflict-of-law provisions and excluding the United
Nations Convention on Contracts for the International Sale of Goods.

16.2 The mandatory provisions of any consumer-protection law of
Customer's jurisdiction (where Customer's national law would so
mandate) are not waived by this Section 16. As noted in the
preamble, the Service is offered to business customers only and is
not intended to engage consumer-protection regimes.

## 17. Dispute resolution

17.1 **Good-faith negotiation.** The Parties first attempt to
resolve any dispute through good-faith negotiation between authorised
representatives within thirty (30) days of either Party's written
notice of the dispute.

17.2 **Jurisdiction.** Disputes not resolved through Section 17.1
are subject to the **exclusive jurisdiction** of the courts of
**Amsterdam, the Netherlands**, except that either Party may seek
interim or injunctive relief in any court of competent jurisdiction
to protect its intellectual property or Confidential Information.

17.3 **Class action waiver.** Each Party waives any right to
participate in a class action, collective action, or representative
proceeding against the other Party arising out of this agreement, to
the extent permitted by applicable law.

## 18. Export controls

Customer represents and warrants that it complies with all
applicable export-control law, including (without limitation)
Regulation (EU) 2021/821 on dual-use items, US Export
Administration Regulations (15 CFR §§ 730–774) where applicable, and
US OFAC sanctions where applicable. Customer does not export,
re-export, or route the Service to any sanctioned jurisdiction or
sanctioned person without all required authorisations.

## 19. Force majeure

Neither Party is liable for failure or delay in performance (other
than payment of Fees) caused by events beyond the Party's reasonable
control, including (without limitation) acts of war, terrorism,
civil disturbance, natural disaster, public-health emergency
declared by a competent authority, pandemic, internet or
telecommunications outage outside the Party's control, action of
government, or failure of a Sub-processor that is itself caused by a
force-majeure event. The affected Party notifies the other Party
without undue delay and uses commercially reasonable efforts to
mitigate.

## 20. Notices

20.1 Notices to Driftstack are addressed to `legal@driftstack.dev` and to the registered office of Driftstack B.V. as published on the Driftstack website.

20.2 Notices to Customer are addressed to the billing email
provided by Customer in its Account, to any other notice address
Customer has provided, or to the in-product notification mechanism
where applicable.

20.3 Notices are effective on receipt for postal mail and on
transmission for electronic delivery, in each case during the
recipient's normal business hours (or on the next business day if
sent outside business hours).

## 21. Severability + entire agreement + assignment

21.1 **Severability.** If any provision of this agreement is held
invalid, illegal, or unenforceable by a court of competent
jurisdiction, the remaining provisions remain in full force, and the
invalid provision is replaced by an enforceable provision that
approximates as closely as possible the Parties' intent.

21.2 **Entire agreement.** This ToS, together with the Privacy
Policy, the DPA, the AUP, the Definitions, and any commercial order
form or schedule signed by both Parties, constitutes the entire
agreement and supersedes all prior agreements between the Parties on
the Service.

21.3 **Assignment.** Customer may not assign this agreement without Driftstack's prior written consent (not to be unreasonably withheld), except that Customer may assign to an affiliate under common control or to a successor in connection with a merger, acquisition, or sale of substantially all of Customer's assets (with notice to Driftstack). Driftstack may assign this agreement, including in connection with a corporate reorganisation, with notice to Customer.

21.4 **No third-party beneficiaries.** No third party has rights
under this agreement.

21.5 **Independent contractors.** The Parties are independent
contractors. Nothing in this agreement creates a partnership, joint
venture, or agency relationship.

21.6 **Headings.** Section headings are for convenience and do not
affect interpretation.

## 22. Contact

For all matters relating to these Terms of Service:

- Legal: `legal@driftstack.dev`
- Privacy: `privacy@driftstack.dev`
- Postal correspondence: addressed to Driftstack B.V., Amsterdam, the Netherlands.

---

_End of ToS._
