// W781 — apps/docs guides/session-lifecycle.md content parity. One-
// hundred-seventh in the cross-SDK drift-guard series.
//
// /guides/session-lifecycle is the canonical state-diagram + 10-min
// idle-timeout + try/finally pattern reference. Drift to the state
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
      /description: The full lifecycle of a Driftstack session — create, drive, capture, destroy, and how concurrency and idle timeouts shape the boundaries\./,
    );
  });

  it("CRITICAL session-is-iPhone-Safari-on-WebKit-fork framing pinned. The 'A session is one running iPhone Safari instance on the modified WebKit fork. Every session occupies one of your account\\'s concurrent slots from creation until destruction' wording matches W761 /api/sessions opening.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /A \*\*session\*\* is one running iPhone Safari instance on the modified WebKit fork\./,
    );
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
    expect(p).toMatch(/│ OR idle ≥ idle_timeout/);
    expect(p).toMatch(/`errored` on driver failure/);
    // The fictional `active` state must NOT return in the diagram.
    expect(p).not.toMatch(/│ active │/);
  });

  it("CRITICAL creating-is-not-observed framing pinned (replaces the fictional 'session is active' framing — the SessionStatus enum has no `active` value). The 'In practice you don\\'t observe creating separately — the SDK\\'s sessions.create() blocks until the server-side transition reaches ready' wording explains the SDK-side state abstraction.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /In practice you don't observe `creating` separately — the SDK's `sessions\.create\(\)` blocks until the server-side transition reaches `ready`/,
    );
    // The previous fictional framing must NOT return.
    expect(p).not.toMatch(/once the session is `active` and ready/);
  });

  it("CRITICAL Retry-After + idle-boundary-worst-case framing pinned. The '429 Too Many Requests on sessions.create(), with a Retry-After header indicating when capacity will free up (worst case = soonest tracked session\\'s idle-timeout boundary)' wording matches W761 retry-after framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Exceeding the cap returns `429 Too Many Requests` on `sessions\.create\(\)`, with a `Retry-After` header indicating when capacity will free up \(worst case = soonest tracked session's idle-timeout boundary\)\./,
    );
  });

  it('CRITICAL 8-tier concurrency table pinned. Matches W761 /api/sessions + W769 /api/usage tier-cap tables.', () => {
    const p = read(PAGE);

    const tierCaps: Array<[string, string]> = [
      ['Free', '1'],
      ['Solo Manual', '1'],
      ['Team Manual', '3'],
      ['Agency Manual', '8'],
      ['API Starter', '2'],
      ['API Builder', '8'],
      ['API Scale', '24'],
      ['Enterprise', 'Custom'],
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

  it('CRITICAL pricing-source-of-truth cross-reference pinned. driftstack.dev/pricing is the canonical paywall location.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Pricing source of truth: \[driftstack\.dev\/pricing\]\(https:\/\/driftstack\.dev\/pricing\)\./,
    );
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

  it("CRITICAL realistic-input behavioural-simulation framing pinned. The 'Subject to the realistic-input behavioural-simulation layer that ships with every session' wording matches the V-NNN modified-WebKit input-emulation contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /synthesise touch \/ scroll \/ type input on the iPhone Safari runtime\. Subject to the realistic-input behavioural-simulation layer that ships with every session\./,
    );
  });

  it("CRITICAL state-read shape pinned — url + title + cookies + local_storage + captured_at (matches SessionStateSchema + the GET /state serializer; NOT ready_state/viewport, which the endpoint does not return). The 'Cheap; safe to poll at low frequency' framing is the canonical heartbeat-safety claim.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /read-only introspection: current `url`, `title`, persisted `cookies` \+ `local_storage`, and a `captured_at` timestamp\. Cheap; safe to poll at low frequency\./,
    );
  });

  it("CRITICAL capture R2-EU-presigned-URL framing pinned. The 'Captures are stored on the EU-resident object-storage sub-processor (Cloudflare R2) and the response includes a signed URL that\\'s valid for a bounded window (~15 minutes). Persist the bytes if you need them long-term' wording matches W770 /api/account avatar EU-jurisdiction R2 + 1h-presigned + the GDPR data-residency framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Captures are stored on the EU-resident object-storage sub-processor \(Cloudflare R2\) and the response includes a signed URL that's valid for a bounded window \(~15 minutes\)\./,
    );
    expect(p).toMatch(/Persist the bytes if you need them long-term\./);
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

  it("CRITICAL 'Always destroy.' try/finally framing pinned. The 'Forgotten sessions burn concurrent slots until their idle timeout fires. A try / finally around your session work is the safe pattern' wording explains the lifecycle-discipline.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\*\*Always destroy\.\*\* Forgotten sessions burn concurrent slots until their idle timeout fires\./,
    );
    expect(p).toMatch(/A `try \/ finally` around your session work is the safe pattern:/);
  });

  it('CRITICAL cross-SDK try/finally idiom framing pinned. The "Python and Go SDK examples follow the same pattern (with block in Python sync; defer in Go)" wording matches W779 cross-SDK quickstart triplet idioms.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Python and Go SDK examples follow the same pattern \(`with` block in Python sync; `defer` in Go\)\./,
    );
  });

  it("CRITICAL 10-minute default idle-timeout + session.destroyed reason:idle_timeout framing pinned. The 'Default idle window: 10 minutes. Higher tiers may extend (configured per-account by the control plane)' wording is the canonical idle-cleanup contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /If a session sees no API call for the per-tier idle window, the runtime auto-destroys it and emits a `session\.destroyed` webhook with `reason: "idle_timeout"`\./,
    );
    expect(p).toMatch(
      /Default idle window: 10 minutes\. Higher tiers may extend \(configured per-account by the control plane\)\./,
    );
  });

  it("CRITICAL getState-as-cheapest-heartbeat framing pinned. The 'To keep a session alive during a slow workflow, periodically call any method — sessions.getState() is the cheapest heartbeat' wording is the canonical keep-alive idiom.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /To keep a session alive during a slow workflow, periodically call any method — `sessions\.getState\(\)` is the cheapest heartbeat\./,
    );
  });

  it('CRITICAL 7-error-shape catalog pinned. 429-rate-limited + 429-concurrency-limit + 429-tier-limit + 404 + 409 + 410 session-destroyed + 502/503 driver. Matches W776 /sdk/error-handling problem-detail URL hierarchy.', () => {
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
      /`404 Not Found` — session ID doesn't exist \(or already destroyed and TTL-evicted\)\./,
    );
    expect(p).toMatch(
      /`409 Conflict` — operation invalid for the current state \(e\.g\. `navigate` after destroy\)\./,
    );
    expect(p).toMatch(/`410 Gone` \(`https:\/\/errors\.driftstack\.dev\/session-destroyed`\)/);
    expect(p).toMatch(/`502 Bad Gateway` \/ `503 Service Unavailable` — driver-side error/);
  });

  it("CRITICAL session.completed + session.failed webhook events pinned. The 2-terminal-event set + 'Intermediate state transitions (e.g. a hypothetical session.created) are not on the bus today' wording explains the no-intermediate-events contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`session\.completed` — session destroyed cleanly \(customer-driven destroy or clean idle-timeout shutdown\)\./,
    );
    expect(p).toMatch(/`session\.failed` — session terminated due to a runtime \/ driver error\./);
    expect(p).toMatch(
      /Intermediate state transitions \(e\.g\. a hypothetical `session\.created`\) are not on the bus today/,
    );
  });

  it("CRITICAL sessions-not-resumable-after-destroy framing pinned. The 'A session destroyed by idle-timeout requires a fresh sessions.create(); sessions are not resumable after destroy. Plan your workflow to either keep a session alive with periodic activity or to recreate cleanly when a long pause is expected' wording is the load-bearing customer-architecture guidance.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /A session destroyed by idle-timeout requires a fresh `sessions\.create\(\)`; sessions are not resumable after destroy\./,
    );
    expect(p).toMatch(
      /Plan your workflow to either keep a session alive with periodic activity or to recreate cleanly when a long pause is expected\./,
    );
  });

  it("CRITICAL session-level quotas-not-customer-facing framing pinned. The 'Fleet-level enforcement runs internally; tier concurrent caps are the only customer-visible meter' wording matches W769 + ADR-004 pricing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Session-level resource quotas \(per-session bandwidth, memory\) are not customer-facing today\./,
    );
    expect(p).toMatch(
      /Fleet-level enforcement runs internally; tier concurrent caps are the only customer-visible meter\./,
    );
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
