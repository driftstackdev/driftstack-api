# Driftstack — Acceptable Use Policy

**Version:** 1.0 · **Effective:** 2026-05-07

This Acceptable Use Policy ("**AUP**") governs Customer's use of the
Service. The AUP is incorporated into the [Terms of Service](terms-of-service.md) by reference. Capitalised terms are defined in
[`definitions.md`](definitions.md).

The AUP exists because the Service is general-purpose infrastructure
that can be misused. Customer is the party closest to the lawfulness
of any given Session: Customer chooses the target site, supplies the
authentication credentials, holds the relationship with the website
operator (or has reason to believe it has authorisation to interact),
and bears the legal responsibility for the resulting interaction
under Customer's own jurisdiction. Driftstack is the infrastructure
provider; Driftstack does not pre-screen target sites and does not
assess the legality of Customer's specific use under Customer's own
law.

That said, certain uses are categorically prohibited because the
infrastructure itself becomes complicit in serious harm regardless of
Customer's framing. Those prohibitions are listed below and are
enforceable against Customer's account.

## 1. Prohibited targets

Customer may not use the Service to interact with any website,
service, or system that is dedicated to or principally used for any
of the following:

1. **Child sexual abuse material (CSAM).** Including any site
   distributing, advertising, or facilitating the production of
   sexually exploitative imagery or content depicting persons under 18
   (or the higher age threshold of any covered jurisdiction). This
   prohibition is absolute and overrides any claim of investigative or
   research purpose; investigators with a legitimate basis under their
   own law route requests through the appropriate authorities, not
   commercial automation infrastructure.
2. **Terrorism or material support for terrorism.** Including any
   service used to coordinate, finance, recruit for, or distribute
   propaganda for entities designated as terrorist organisations under
   the EU consolidated terrorist list, the UN consolidated sanctions
   list, the US OFAC Specially Designated Nationals list, or
   equivalent designations of any covered jurisdiction.
3. **Sanctioned entities.** Any entity, person, or service designated
   under EU sanctions (Council Regulation), the UK sanctions list (UK
   Office of Financial Sanctions Implementation), the US OFAC SDN
   list, or any sanctions regime applicable to Customer's
   establishment.
4. **Critical infrastructure attack.** Including any system whose
   compromise would foreseeably impact public safety, public health,
   public utilities, defence, financial-system stability, or
   electoral integrity. The Service is not a tool for probing or
   exploiting infrastructure; Customer's authorised penetration
   testing of Customer's own infrastructure is permitted only when
   Customer holds written authorisation from the system owner and the
   testing falls within the scope of that authorisation.
5. **Distribution of malware, ransomware, or destructive payloads.**
   The Service may not be used to deliver, host, or trigger software
   designed to compromise, encrypt, or destroy third-party systems or
   data.

## 2. Prohibited techniques

Customer may not use the Service to carry out any of the following
techniques against any target, including targets not listed in
Section 1:

1. **Credential stuffing.** Using the Service to test credential
   pairs (username/password) obtained from a breach corpus or other
   third-party source against a target where Customer lacks the
   account-holder's authorisation. Customer's own authentication
   testing against Customer's own infrastructure with Customer's own
   credentials is permitted.
2. **Mass account creation in violation of target Terms of Service.**
   Where Customer lacks authorisation from the target operator and
   the target operator's published terms prohibit programmatic
   account creation, Customer may not use the Service to create
   accounts at scale. "At scale" means more than the rate a single
   ordinary human user could plausibly create through the target's
   intended interfaces.
3. **Distributed denial-of-service (DDoS) or volumetric attack.**
   Customer may not use the Service to generate request volumes
   intended to degrade or deny availability of the target. Driftstack
   reserves the right to apply per-target rate limiting on its own
   initiative when usage patterns suggest DDoS-like behaviour
   regardless of Customer's intent.
4. **Vulnerability exploitation without authorisation.** Customer may
   not use the Service to exploit a known vulnerability against a
   target that Customer is not authorised to test. Customer's bug
   bounty work falls within this carve-out only when the target
   operator's published bug bounty programme covers the technique,
   target scope, and authentication state Customer is using.
5. **Bypassing technical protection measures with intent to defeat
   commercial limits.** Customer may not use the Service to defeat
   per-user pricing tiers, rate limits, or geographic licensing
   restrictions that the target lawfully enforces under applicable
   law (including the EU Digital Markets Act exceptions and the
   InfoSoc Directive 2001/29/EC's permitted exceptions). This clause
   does not prohibit interoperability or research use that is itself
   lawful in Customer's jurisdiction.
6. **Personal data scraping outside Customer's lawful basis.**
   Customer may not use the Service to harvest Personal Data (as
   defined by the GDPR or any equivalent regime applicable to the
   data subject) where Customer lacks a lawful basis under Article 6
   GDPR or the equivalent local provision. Customer is solely
   responsible for determining its lawful basis for any Personal Data
   it processes through the Service; Driftstack does not pre-clear
   bases.
7. **Circumventing CAPTCHA or anti-automation in a manner that
   targets the rights of the target's other users.** Specifically:
   when Customer's automation degrades the target's ability to
   protect its other users (e.g. by overwhelming a fraud-detection
   pipeline or by impersonating non-Customer users), Customer's use
   crosses into prohibited territory regardless of Customer's
   commercial purpose.

## 3. Customer responsibility framing

The following framing is constitutive, not advisory:

1. **Customer holds the relationship with the target.** Customer is
   the party that has chosen the target site, has formed any
   applicable account or contractual relationship with the target,
   and is the party visible to the target's authentication and
   logging systems. Driftstack is invisible to the target as a
   commercial counterparty; from the target's perspective, the
   Customer (or the Customer's persona) is the actor.
2. **Customer holds the relationships with Customer-Connected
   Services.** Specifically: the proxy provider Customer uses, the
   captcha-solving service Customer uses, the email-verification
   service Customer uses, and the SMS-verification service Customer
   uses are Customer's contractual counterparties, not Driftstack's.
   Driftstack does not contract with these providers, does not
   receive service from them, and does not Process Personal Data on
   Driftstack's behalf through them.
3. **Customer is the lawful-basis decision-maker.** When Customer
   processes Personal Data through the Service, Customer is the
   Controller (in GDPR terms) and Driftstack is the Processor.
   Customer determines whether a given Session has a lawful basis
   under Article 6 GDPR (or local equivalent); Driftstack does not.
4. **The Service provides infrastructure, not legality.** Driftstack
   provides browsing infrastructure that closely matches the
   fingerprint of a real iPhone running iOS Safari. The fact that a
   target cannot detect the Customer's automation does not make the
   automation lawful. Whether a given Session is lawful is determined
   by Customer's own jurisdiction's law applied to Customer's
   conduct, not by the Service's technical capabilities.
5. **Customer's sessions can constitute Customer's instructions.**
   When the API receives a request from Customer, Driftstack acts on
   that request as Customer's documented instruction (within the
   meaning of Article 28(3)(a) GDPR). Customer's submission of a
   request implies Customer's representation that the request is
   lawful.

## 4. Reporting + abuse mechanism

Driftstack maintains an abuse-reporting channel at `abuse@driftstack.dev`.
Reports are triaged within five (5) business days. Driftstack accepts reports
from:

1. **Target operators** who believe Customer's use of the Service
   against the target violates Section 1 or Section 2 of this AUP, or
   violates the target's own published terms in a manner that the
   target asserts is not Customer-authorised.
2. **Data subjects** who believe a Customer is processing their
   Personal Data through the Service without a lawful basis. (Note:
   Driftstack as Processor cannot directly remediate Controller-side
   issues. Driftstack's response is to notify the Controller —
   Customer — and assist Customer's response to the data subject.)
3. **Law enforcement** acting under a valid legal process applicable
   to Driftstack as a Dutch BV.

A report received in good faith will not result in immediate
suspension of Customer's account. Driftstack's response is governed
by Section 5 (Enforcement progression) and Section 6 (Takedown
response) below.

## 5. Enforcement progression

Driftstack's enforcement of this AUP follows a graduated progression,
subject to the discretion in Section 5.4 below:

1. **Warning.** First instance of a non-severe violation — Driftstack
   notifies Customer in writing identifying the AUP clause believed
   violated, the specific Session(s) at issue, and a remediation
   window (typically 7 days). Customer's continued use during the
   warning window is not itself a further violation, but failure to
   remediate within the window escalates.
2. **Suspension.** A continued or repeated violation following a
   warning, OR a moderately severe first violation — Driftstack
   suspends Customer's account. Suspension means: (a) existing
   Sessions are destroyed, (b) the API rejects authenticated requests
   with HTTP 403 carrying a problem type
   `https://errors.driftstack.dev/forbidden`, (c) Customer-Provided Secrets are NOT
   deleted (Customer may need them to migrate workflows), and (d)
   billing pauses. Suspension typically lasts up to 30 days, during
   which Customer may dispute or remediate.

   The 403 carries the standard RFC 9457 fields only (`type`, `title`,
   `status`, `detail`) — there is no `reason` extension naming an AUP
   clause, and no clause identifier is recorded against an account, so
   a suspension 403 is not distinguishable by body shape from any other 403. The machine-readable signal for suspension is the webhook: the
   `session.completed` events emitted when suspension reclaims live
   Sessions carry `reason_code: "account_suspended"`. Customers who need
   to detect suspension programmatically should subscribe to that rather
   than parse the 403.

3. **Termination.** A severe violation under Section 1, OR a
   continuing violation that survives suspension, OR a Customer's
   refusal to dispute or remediate during the suspension window —
   Driftstack terminates the Subscription per Section 16 of the ToS.
   Termination triggers data deletion under the retention schedule in
   the Privacy Policy.

### 5.4 Discretion to skip steps

Driftstack reserves the right to skip directly to suspension or
termination, without warning, where:

1. The violation is described in Section 1 of this AUP (prohibited
   targets — CSAM, terrorism, sanctioned entities, critical
   infrastructure, malware distribution).
2. A valid legal process — court order, supervisory authority order,
   or law-enforcement demand — requires it.
3. Continued operation poses a credible imminent threat to a third
   party that immediate suspension can mitigate.
4. The violation is admitted by Customer or is supported by
   incontrovertible evidence (e.g. Customer's own statements in
   Customer's own published materials).

The progression in Section 5.1–5.3 is the default and applies in
the absence of these conditions.

## 6. Takedown response procedure

Driftstack responds to valid legal notices (court orders,
supervisory-authority orders, mutual legal assistance treaty
requests, properly-served subpoenas applicable to Driftstack as a
Dutch BV) on the timetable required by the issuing instrument.
Customer is notified of any such notice unless the notice itself or
applicable law prohibits notification.

Driftstack will not voluntarily disclose Customer Data to third
parties (including law enforcement) absent a valid legal process,
except (a) in good faith to investigate AUP violations, (b) to
prevent imminent harm consistent with the legal posture of a Dutch
BV, or (c) with Customer's prior written consent.

For copyright takedown notices addressed to Customer's content, the
applicable regime is the EU Digital Services Act (Regulation (EU)
2022/2065) where it applies to the Service as a hosting provider. The
DSA implementation is described separately in the Service's
hosting-provider terms (when published); the AUP does not pre-empt
that regime.

## 7. Driftstack's own AUP compliance

Driftstack is itself constrained by the AUP framework imposed on it
by its own Sub-processors:

1. **MacStadium's AUP** for the mac mini fleet hosting layer.
   Driftstack's continued operation depends on compliance, which
   means Driftstack's Customer base in aggregate must comply.
2. **Stripe's AUP / Restricted Businesses list** for the payment
   processing layer. Stripe restricts certain industries and
   activities; a Customer whose use of the Service falls into a
   Stripe-restricted category may render the Customer's account
   un-billable through Stripe even if the use otherwise satisfies
   Section 1 and Section 2 of this AUP. In that case, Driftstack
   may terminate the Subscription. If Driftstack subsequently
   engages an additional payment processor (e.g. a merchant-of-
   record alternative or a cryptocurrency processor), customers
   will be notified per the Sub-processor amendment mechanism in
   the DPA.

Customer is not bound by these third-party AUPs as a matter of
contract with Driftstack, but Customer's use that falls outside any
of them may render Driftstack unable to continue serving Customer.
Driftstack will notify Customer of any such issue and offer the
remediation options above.

## 8. Updates

This AUP is a Document under the [Terms of Service](terms-of-service.md). Material updates trigger the
re-acceptance flow described in [`definitions.md`](definitions.md)
under "Acceptance". Patch-level updates (typo, formatting,
clarification of an existing prohibition) do not.

## 9. Contact

- Abuse reports: `abuse@driftstack.dev`
- General AUP questions: `support@driftstack.dev`
- Postal correspondence: addressed to Driftstack B.V., Amsterdam, the Netherlands.

---

_End of AUP._
