// W781 — apps/docs guides/session-lifecycle.md content parity. One-
// hundred-seventh in the cross-SDK drift-guard series.
//
// /guides/session-lifecycle is the canonical state-diagram + direct-operation
// ownership + try/finally pattern reference. Drift to the state
// machine or the concurrent-cap-is-only-meter framing would mismatch
// W761 /api/sessions + W749 dashboard /sessions + ADR-004 pricing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/session-lifecycle.md');

describe('W781 docs /guides/session-lifecycle content parity', () => {
  it('guides/session-lifecycle.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Session lifecycle\n/,
    );
    expect(p).toMatch(
      // S31 2026-07-07 (fable-truth-audit) — no idle timeout exists; the boundary is the
      // free-tier duration cap.
      /description: The full lifecycle of a Driftstack session — create, drive, capture, destroy, and how concurrency and duration caps shape the boundaries\./,
    );
  });

  it("CRITICAL session-is-one-iPhone-Safari-browser framing pinned. The 'A session is one running iPhone Safari browser. Every session occupies one of your account\\'s concurrent slots from creation until destruction' wording matches W761 /api/sessions opening (2026-09-15 plain words: the WebKit-fork build detail is how we run it, not what the customer gets).", () => {
    const p = read(PAGE);

    expect(p).toMatch(/A \*\*session\*\* is one running iPhone Safari browser\./);
    expect(p).not.toMatch(/modified WebKit fork/);
    expect(p).toMatch(
      /Every session occupies one of your account's concurrent slots from creation until destruction;/,
    );
  });

  it('CRITICAL ASCII state-diagram pinned — creating→ready→busy→destroyed transitions matching the SessionStatus enum at packages/api-types/src/sessions.ts:15. The previous pin asserted a fictional `active` state — there is no `active` status in the wire-level SessionStatus enum (the values are creating/ready/busy/destroyed/errored). Customer code checking `session.status === "active"` would never match.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/create/);
    expect(p).toMatch(/│ creating │/);
    expect(p).toMatch(/│ ready │/);
    expect(p).toMatch(/│ busy │/);
    expect(p).toMatch(/│ destroyed │/);
    // S31 2026-07-07 (fable-truth-audit) — the diagram edge is the free-tier duration cap.
    expect(p).toMatch(/│ OR free-tier 20-min cap/);
    expect(p).not.toMatch(/idle ≥ idle_timeout/);
    expect(p).toMatch(/`errored` if the browser fails/);
    // 2026-09-15 plain words — the creating→ready edge label no longer leaks the
    // driver-allocation/handshake mechanics; the padded label must still align.
    expect(p).toMatch(/\(transient — the browser {12}┌───────┐/);
    expect(p).toMatch(/is being started\) {18}└───────┘/);
    expect(p).not.toMatch(/driver allocation \+ handshake/);
    // The fictional `active` state must NOT return in the diagram.
    expect(p).not.toMatch(/│ active │/);
  });

  it('create returns at ready while resource reads may observe creating; direct operations have one busy owner', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`sessions\.create\(\)` returns only once the session is `ready`, although a list or read made at the same time can still show it as `creating`\./,
    );
    expect(p).toMatch(
      /Each driving call \(navigate, interact, wait, capture\) moves the session from `ready` to `busy`; while it is `creating` or `busy`, any other call returns `409 Conflict`\./,
    );
    expect(p).toMatch(/When the call succeeds the session goes back to `ready`\./);
    expect(p).toMatch(
      /If the browser fails, the session becomes `errored`; if you destroy the session mid-call, it becomes `destroyed` and the interrupted call returns `410 Gone`\./,
    );
    // 2026-09-15 plain words — the execution internals must not return.
    expect(p).not.toMatch(/harness|driver dispatch|durable `creating` reservation|elects terminal/);
    expect(p).not.toMatch(/you don't observe `creating` separately/);
    // The previous fictional framing must NOT return.
    expect(p).not.toMatch(/once the session is `active` and ready/);
  });

  it("CRITICAL Retry-After + idle-boundary-worst-case framing pinned. The '429 Too Many Requests on sessions.create(), with a Retry-After header indicating when capacity will free up (worst case = soonest tracked session\\'s idle-timeout boundary)' wording matches W761 retry-after framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      // S31 2026-07-07 (fable-truth-audit) — no Retry-After on concurrency 429s (only
      // rate-limit 429s carry it) and no idle timeout exists.
      /Exceeding the cap returns `429 Too Many Requests` on `sessions\.create\(\)`, with `current_sessions` and `limit` in the problem body\./,
    );
  });

  it('CRITICAL 8-tier concurrency table pinned. Matches W761 /api/sessions + W769 /api/usage tier-cap tables.', () => {
    const p = read(PAGE);

    const tierCaps: Array<[string, string]> = [
      ['Free', '1'],
      ['Personal', '1'],
      ['Team', '3'],
      ['Agency', '8'],
      ['API Starter', '2'],
      ['API Builder', '8'],
      ['API Scale', '24'],
      ['Enterprise', '32'],
    ];
    for (const [tier, cap] of tierCaps) {
      expect(p, `${tier} → ${cap}`).toMatch(new RegExp(`\\| ${tier}\\s+\\|\\s+${cap}\\s+\\|`));
    }
  });

  it("CRITICAL concurrent-caps-are-only-metering framing pinned. The 'Concurrent caps are the only metering on paid tiers — there are no hour caps and no overage charges. Run sessions for as long as your workflow needs within your concurrent cap' wording matches ADR-004 + W754 /usage dashboard + W769 /api/usage.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Concurrent caps are the only metering on paid tiers — there are no hour caps and no overage charges\./,
    );
    expect(p).toMatch(
      /Run sessions for as long as your workflow needs within your concurrent cap\./,
    );
  });

  it('CRITICAL pricing-source-of-truth cross-reference pinned. driftstack.io/pricing is the canonical paywall location.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Pricing source of truth: \[driftstack\.io\/pricing\]\(https:\/\/driftstack\.io\/pricing\/\)\./,
    );
    expect(p).not.toMatch(/\]\(https:\/\/driftstack\.io\/pricing\)/);
  });

  it('CRITICAL 3-tier-error pinned on create — 429 concurrency-limit / 429 tier-limit / 403 forbidden. Matches W776 /sdk/error-handling 15-row error-class table.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\*\*Tier check:\*\* if you're at your concurrent cap, the call returns `429 concurrency-limit`\./,
    );
    expect(p).toMatch(
      /If your tier's profile cap is reached on a profile-binding flow, `429 tier-limit`\./,
    );
    expect(p).toMatch(/If your account is suspended, `403 forbidden`\./);
  });

  it('CRITICAL 3-wait_until-strategy enum pinned — load (default) / domcontentloaded / networkidle. Matches W761 /api/sessions wait_for enum (slightly renamed: docs guide uses wait_until, /api/sessions uses wait_for).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/wait_until: 'networkidle', \/\/ or 'load' \(default\), 'domcontentloaded'/);
    expect(p).toMatch(
      /`load` returns on the `load` event; `domcontentloaded` is faster but earlier; `networkidle` waits until network is quiet for a brief window — best for SPAs that load content after the initial render\./,
    );
  });

  it("CRITICAL interact framing pinned in plain words. The 'tap, scroll, type, or press keys on the page' wording names the four interact kinds (matches /api/sessions action.kind) without the behavioural-simulation-layer mechanics (2026-09-15 owner directive: human-like motion is a per-profile mode, not a promise on every interaction).", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\*\*`POST \/v1\/sessions\/:id\/interact`\*\* — tap, scroll, type, or press keys on the page\./,
    );
    expect(p).not.toMatch(/behavioural-simulation layer|iPhone Safari runtime/);
  });

  it('state shape, busy-while-capturing polling advice and team-admin secret boundary are pinned', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /live page introspection: current `url`, `title`, cookies \+ `local_storage`, and a `captured_at` timestamp\.[\s\S]+?poll it sparingly and only while the session is `ready`/,
    );
    expect(p).toMatch(
      /\(a call made while the session is `busy` returns `409`\); to check `creating` \/ `busy` without tying up the session, use `GET \/v1\/sessions\/:id` or the list endpoint instead\./,
    );
    expect(p).toMatch(
      /When acting as a team owner, state requires the `admin` role because it returns browser secrets such as cookies and local storage/,
    );
    expect(p).toMatch(
      /a `member` can still read list\/detail metadata but gets `403` for state, and the session is left untouched\./,
    );
    expect(p).toMatch(/Self-account `read:sessions` access is unchanged/);
    // 2026-09-15 plain words — driver-ownership vocabulary must not return.
    expect(p).not.toMatch(/claimed driver operation|driver owner|contacts the live driver/);
  });

  it("CRITICAL capture R2-EU-presigned-URL framing pinned. The 'Captures are stored on the EU-resident object-storage sub-processor (Cloudflare R2) and the response includes a signed URL that\\'s valid for a bounded window (~15 minutes). Persist the bytes if you need them long-term' wording matches W770 /api/account avatar EU-jurisdiction R2 + 1h-presigned + the GDPR data-residency framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      // S31 2026-07-07 (fable-truth-audit) — captures were NEVER stored server-side:
      // CaptureResponseSchema is inline {kind, data, encoding,
      // byte_size, duration_ms} (packages/api-types/src/sessions.ts).
      // The old pin locked a fictional R2 + signed-URL flow.
      /The response carries the capture inline — `data` is the content itself \(base64-encoded for screenshots and PDFs\) — and nothing is stored server-side\./,
    );
    expect(p).toMatch(/Persist the bytes yourself if you need them long-term\./);
  });

  it('CRITICAL destroy-is-idempotent + slot-released-immediately + profile-state-saved-on-clean-destroy framing pinned. The 3-claim contract matches W761 /api/sessions 4-claim destroy contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`destroy` is idempotent — calling it twice on the same `id` is a no-op the second time\. It releases the concurrent slot immediately\./,
    );
    expect(p).toMatch(
      /If the session was bound to a profile, the profile's storage state is captured and saved on a clean destroy\./,
    );
  });

  // S31 2026-07-07 (fable-truth-audit) — no idle timeout; slots are held until an explicit
  // destroy (free tier alone stops at its 20-min duration cap).
  it("CRITICAL 'Always destroy.' try/finally framing pinned — forgotten sessions hold their slot until destroyed.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\*\*Always destroy\.\*\* Forgotten sessions burn concurrent slots until you destroy them \(only free-tier sessions stop on their own, at the 20-minute cap\)\./,
    );
    expect(p).toMatch(/A `try \/ finally` around your session work is the safe pattern:/);
  });

  it('CRITICAL cross-SDK try/finally idiom framing pinned. The "Python and Go SDK examples follow the same pattern (with block in Python sync; defer in Go)" wording matches W779 cross-SDK quickstart triplet idioms.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Python and Go SDK examples follow the same pattern \(`with` block in Python sync; `defer` in Go\)\./,
    );
  });

  // S31 2026-07-07 (fable-truth-audit) — the old pin locked a FICTIONAL idle-cleanup
  // contract: no idle timeout exists on any tier (the only auto-stop is
  // the free-tier 20-minute duration sweep, session-duration-sweeper.ts),
  // and the webhook enum has no session.destroyed event at all
  // (packages/api-types/src/webhooks.ts).
  it('CRITICAL auto-destroy framing pinned: paid sessions never auto-destroyed; free tier stops at the 20-minute duration cap; no idle timeout on any tier.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Paid-tier sessions are never auto-destroyed — a forgotten session holds its concurrent slot until you destroy it/,
    );
    expect(p).toMatch(/On the free tier, a session is capped at 20 minutes of wall-clock time/);
    expect(p).toMatch(/There is no idle timeout on any tier\./);
    expect(p).not.toMatch(/session\.destroyed/);
    expect(p).not.toMatch(/idle_timeout/);
  });

  // S31 2026-07-07 (fable-truth-audit) — the keep-alive idiom was retired with the
  // fictional idle timeout: there is nothing to keep alive against, so
  // the page no longer teaches a heartbeat. Pin its absence.
  it('heartbeat idiom removed with the fictional idle timeout', () => {
    const p = read(PAGE);

    expect(p).not.toMatch(/cheapest heartbeat/);
  });

  it('error catalog distinguishes creating/busy 409 from destroyed/errored/close-winner 410', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`429 Too Many Requests` \(`https:\/\/errors\.driftstack\.dev\/rate-limited`\)/,
    );
    expect(p).toMatch(
      /`429 Too Many Requests` \(`https:\/\/errors\.driftstack\.dev\/concurrency-limit`\)/,
    );
    expect(p).toMatch(
      /`429 Too Many Requests` \(`https:\/\/errors\.driftstack\.dev\/tier-limit`\)/,
    );
    expect(p).toMatch(
      /`404 Not Found` — session ID doesn't exist \(or was destroyed and has since been cleaned up\)\./,
    );
    expect(p).toMatch(
      /`409 Conflict` — the session is still `creating`, or another operation is already running \(`busy`\); retry once it reports `ready`\./,
    );
    expect(p).toMatch(
      /`410 Gone` \(`https:\/\/errors\.driftstack\.dev\/session-destroyed`\) — the session is `destroyed` or `errored`, or this operation lost a race to destroy/,
    );
    expect(p).not.toMatch(/`navigate` after destroy/);
    expect(p).toMatch(
      /`502 Bad Gateway` \/ `503 Service Unavailable` — the browser session hit an error, or the requested feature is not available \(`driver-error` \/ `driver-not-integrated` \/ `feature-unavailable`\)\./,
    );
    // 2026-09-15 plain words — storage/driver internals must not return.
    expect(p).not.toMatch(/TTL-evicted|direct driver operation|driver-side error/);
  });

  it('a busy session left behind by a server crash is never automatically reset', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /A session left in `busy` after a server crash is not reset automatically: the operation that was running may already have changed the page, and repeating it could duplicate that work\. Destroy the session and create a fresh one\./,
    );
    expect(p).not.toMatch(/outcome-unknown owner|automatic reclaim/);
  });

  it("CRITICAL session.completed + session.failed webhook events pinned. The 2-terminal-event set + 'Intermediate state transitions (e.g. a hypothetical session.created) are not on the bus today' wording explains the no-intermediate-events contract.", () => {
    const p = read(PAGE);

    // S36 2026-07-07 (fable-truth-audit) — the idle-timeout clause was the retired
    // fiction; the real second path is the free-tier duration cap.
    // V-749 2026-08-08 — there is a THIRD path that audit did not reach:
    // destroyAllForAccount() emits session.completed when an account is suspended
    // and its live sessions are reclaimed. All three paths are now named, and the
    // automatic two are the ones that carry auto_destroyed + reason.
    expect(p).toMatch(
      /`session\.completed` — one per logical destroy of a non-terminal session: a customer-driven destroy, the free-tier duration cap, or an account suspension reclaiming its live sessions\./,
    );
    expect(p).toMatch(/`auto_destroyed: true` and a `reason`/);
    // The two-path wording must not return.
    expect(p).not.toMatch(
      /destroyed cleanly \(customer-driven destroy, or the free-tier duration cap\)/,
    );
    expect(p).toMatch(
      /`session\.failed` — the session ended because of an unrecoverable error \(for example, a timeout or a crash during a page action\)\. Create a new session to continue\./,
    );
    // 2026-09-15 plain words — the other session events name what the customer
    // gets, not the control plane / harness that produces them.
    expect(p).toMatch(
      /`session\.egress_capability_changed` — the session reported its proxy capabilities\./,
    );
    expect(p).toMatch(/`session\.challenge_detected` — the session detected a bot-check/);
    expect(p).not.toMatch(/control plane|harness|runtime \/ driver error/);
    expect(p).toMatch(
      /Intermediate state transitions \(e\.g\. a hypothetical `session\.created`\) are not on the bus today/,
    );
  });

  // S36 2026-07-07 (fable-truth-audit) — the idle-timeout reference + keep-alive advice were
  // the retired fiction; the not-resumable contract is what matters.
  it('CRITICAL sessions-not-resumable-after-destroy framing pinned (S36: idle-timeout wording retired).', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /A destroyed session requires a fresh `sessions\.create\(\)`; sessions are not resumable after destroy\./,
    );
    expect(p).toMatch(/Plan your workflow to recreate cleanly when a long pause is expected\./);
  });

  it("CRITICAL no-per-session-bandwidth-or-memory-limits framing pinned. The 'The limit that governs sessions is your tier's concurrent-session cap' wording matches W769 + ADR-004 pricing (2026-09-15 plain words: 'fleet-level enforcement' is how we run it and is gone).", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /There are no per-session bandwidth or memory limits for you to manage today\./,
    );
    expect(p).toMatch(
      /The limit that governs sessions is your tier's concurrent-session cap \(rate limits and profile caps are separate — see Error shapes above\)\./,
    );
    expect(p).not.toMatch(/Fleet-level enforcement/);
  });

  it('CRITICAL Next-steps 3-link set pinned — profile-management + webhooks/events + api/versioning.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*\[Profile management\]\(\/guides\/profile-management\/\)\*\*/);
    expect(p).toMatch(/\*\*\[Webhook events\]\(\/webhooks\/events\/\)\*\*/);
    expect(p).toMatch(/\*\*\[API versioning\]\(\/api\/versioning\/\)\*\*/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-guides-session-lifecycle-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
