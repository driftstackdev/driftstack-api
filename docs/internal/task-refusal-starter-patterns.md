# Task-refusal starter patterns — DRAFT for founder / AUP review (W595)

**Status: DRAFT — NOT enabled.** This is a _suggested_ starting point for the
file-06 §Safety guardrail-#3 abuse-pattern list, provided so activation isn't a
blank page. **WHICH tasks Driftstack refuses is the founder/AUP's call (Tier-3);
the agent does not author binding compliance policy.** Review, edit, and adopt
(or discard) before turning anything on. Nothing here is live until you set the
env var (below) and restart.

## How it works (recap)

The gate (`apps/server/src/services/task-refusal.ts`, wired W589, activated
W592) screens each agent task BEFORE the LLM decompose. A match short-circuits
to a `refuse` outcome — no LLM call, no token charge. It is **bias-to-allow**: a
thin filter that false-positives on a legitimate customer is worse than a missed
obvious case (the AUP/account layer is the real backstop). So patterns are
**specific multi-word intent phrases**, never bare words — `steal someone's
password`, not `password` (which would block "update my password").

Patterns match the **normalized** task: lowercase, NFKC-folded,
dangerous-unicode-stripped, single-spaced. Author them in that form (lowercase,
no flags needed).

## Suggested starter set (review before adopting)

Conservative coverage of the file-06 examples (credential theft / fraud /
harassment) plus malware. Each is intentionally narrow.

```json
[
  {
    "id": "cred-theft-1",
    "category": "credential_theft",
    "pattern": "steal (?:someone'?s |a |the |their )?(?:password|credentials|login|api key)",
    "reason": "Tasks involving stealing another party's credentials are not permitted."
  },
  {
    "id": "phishing-1",
    "category": "credential_theft",
    "pattern": "(?:build|create|make|set up) (?:a )?phishing (?:page|site|form|kit)",
    "reason": "Building phishing pages is not permitted."
  },
  {
    "id": "fraud-cc-1",
    "category": "fraud",
    "pattern": "(?:credit card|payment card) (?:fraud|theft)|carding (?:site|shop)",
    "reason": "Payment-fraud tasks are not permitted."
  },
  {
    "id": "fraud-launder-1",
    "category": "fraud",
    "pattern": "launder (?:money|funds|cash)",
    "reason": "Money-laundering tasks are not permitted."
  },
  {
    "id": "harass-dox-1",
    "category": "harassment",
    "pattern": "(?:dox|stalk|harass) (?:a |this |the )?(?:person|user|someone|woman|man)|find (?:the )?home address of",
    "reason": "Harassment / doxxing tasks are not permitted."
  },
  {
    "id": "malware-1",
    "category": "malware",
    "pattern": "(?:write|build|create|deploy) (?:a |some )?(?:malware|ransomware|trojan|keylogger|computer virus)",
    "reason": "Creating malware is not permitted."
  }
]
```

## Activation (founder, when adopted)

1. Review/edit the JSON above (it is a regex source per the contract — test
   against your own legit-task corpus first; bias to allow).
2. Set it as the env var on each deployment (single line; escape as your
   secret-management requires):
   ```
   DRIFTSTACK_TASK_REFUSAL_PATTERNS=<the JSON array, minified>
   ```
3. Restart the API. Boot logs `task-refusal start-gate ACTIVE` with the
   active-pattern count. Production refuses to boot if the configured value is
   invalid JSON, is not a nonempty array, or contains any malformed,
   uncompilable, or ReDoS-rejected entry; fix the complete list instead of
   accepting partial protection. An absent/blank value intentionally leaves the
   gate off. Development/test skip and report malformed entries for authoring.

## Notes for the reviewer

- These are illustrative, not exhaustive — real AUP coverage is broader and
  belongs in the AUP doc; this gate only catches the _obvious_ cases cheaply
  before the LLM.
- Prefer adding categories over widening a single pattern (keeps each rule
  auditable; `patternId` is logged on every refusal).
- Re-test after any edit: a too-broad pattern silently blocks paying
  customers, which is worse than a missed abuse case here.

Contract: `driftstack/docs/internal/task-refusal-contract.md`.
Env var reference: `docs/deployment/env-vars.md`.
