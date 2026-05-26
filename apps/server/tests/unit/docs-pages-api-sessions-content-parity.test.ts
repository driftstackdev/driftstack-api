// W761 — apps/docs api/sessions.md content parity. Eighty-seventh in
// the cross-SDK drift-guard series.
//
// /api/sessions is the canonical reference for the 6-action session
// lifecycle (create/navigate/interact/wait/get-state/capture/destroy).
// Drift to the tier-concurrency table or the 8-state STATUS framing
// would let SDK consumers' expectations diverge from server enforcement.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/sessions.md');

describe('W761 docs /api/sessions content parity', () => {
  it('api/sessions.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Drift to a different description would mismatch the W760 /api index TOC framing ("create, navigate, interact, capture, wait, destroy").', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Sessions\n/);
    expect(p).toMatch(
      /description: Create \+ drive iPhone Safari sessions — navigate, interact, wait, capture, get-state, destroy\. Tier-gated concurrency\./,
    );
  });

  it('CRITICAL TIER_CONCURRENT_SESSION_LIMITS table pinned with all 8 tiers + caps. Matches W749 dashboard /sessions concurrent-meter shared constant.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`TIER_CONCURRENT_SESSION_LIMITS` constant in/);
    expect(p).toMatch(/`@driftstack\/api-types`/);

    const tierCaps: Array<[string, string]> = [
      ['trial_pack', '1'],
      ['solo_manual', '1'],
      ['team_manual', '3'],
      ['agency_manual', '8'],
      ['api_starter', '2'],
      ['api_builder', '8'],
      ['api_scale', '24'],
      ['enterprise', '32'],
    ];
    for (const [tier, cap] of tierCaps) {
      expect(p, `${tier} → ${cap}`).toMatch(new RegExp(`\\| \`${tier}\`\\s+\\|\\s+${cap} \\|`));
    }
  });

  it('CRITICAL cap-exceed 429 + Retry-After framing pinned. Drift would mismatch W760 rate-limit header contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Hitting the cap on `POST \/v1\/sessions` returns `429 Too Many\s*\n?Requests` with a `Retry-After` header\./,
    );
    expect(p).toMatch(/Sessions auto-destroy after\s*\n?their tier-default idle timeout/);
  });

  it('CRITICAL 5-state STATUS enum pinned — creating/ready/busy/destroyed/errored. Matches W749 dashboard /sessions STATUS_BADGE_CLASS map.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`status` is one of `creating`, `ready`, `busy`, `destroyed`,\s*\n?`errored`/,
    );
  });

  it("CRITICAL session-create-blocks-until-ready framing pinned. The 'SDK\\'s sessions.create() blocks until ready; any intermediate creating state isn\\'t directly observable' wording explains the SDK→server protocol.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The SDK's `sessions\.create\(\)` blocks until `ready`; any\s*\n?intermediate `creating` state isn't directly observable\./,
    );
  });

  it('CRITICAL LOCKED_ARCHETYPE_ID default + 3-purpose enum pinned. archetype defaults to iphone16pro_ios18_7_safari26_4; purpose defaults to production_customer with cumulative_rig_validation + test_domain_probe reserved internal.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`archetype` defaults to the locked iPhone-16\s*\n?Pro \/ iOS \/ Safari archetype when omitted \(LOCKED_ARCHETYPE_ID\)\./,
    );
    expect(p).toMatch(/`purpose` defaults to `production_customer`\./);
    expect(p).toMatch(
      /the other values\s*\n?\(`cumulative_rig_validation`, `test_domain_probe`\) are reserved\s*\n?for Driftstack-internal ops\./,
    );
  });

  it('CRITICAL label-max-120-char + metadata-arbitrary-JSON framing pinned. Drift to different field bounds would diverge from server validation.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`label` is a free-form short string \(max 120 chars\)/);
    expect(p).toMatch(
      /`metadata` is an arbitrary JSON object for the\s*\n?customer's own bookkeeping\./,
    );
  });

  it('2026-05-20 — profile-binding flipped planned→SHIPPED (fa8cb83a). Doc now pins the wired profile_id field on POST /v1/sessions, the metadata-stamp behaviour, cross-account 404 anti-enumeration, and the cross-link to profiles.launch().', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /When `profile_id` is supplied \(2026-05-20, commit `fa8cb83a`\) the\s*\n?server inherits the profile's `archetype` as the default, stamps\s*\n?`\{profile_id, profile_name\}` into the session's `metadata`/,
    );
    expect(p).toMatch(
      /Cross-account\s*\n?`profile_id` returns `404` \(anti-enumeration — indistinguishable\s*\n?from a missing one\)\./,
    );
    expect(p).toMatch(
      /See also `POST \/v1\/profiles\/:id\/launch` for\s*\n?the one-round-trip launch helper\./,
    );
  });

  it('CRITICAL 3-wait_until-strategy enum pinned — load/domcontentloaded/networkidle. The previous pin used `wait_for` which is fictional; the actual NavigateRequest schema at packages/api-types/src/sessions.ts:116 uses `wait_until`. Drift to dropping a strategy would silently break SDK consumers using it.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`wait_until`: `'load'` \(default\), `'domcontentloaded'`, or\s*\n?`'networkidle'`/,
    );
    // Fictional name must NOT return.
    expect(p).not.toMatch(/`wait_for`:/);
  });

  it('CRITICAL 4-interact-kind enum pinned — tap/type/scroll/press, with the correct discriminator name (kind) and request-body wrapper (action). The previous pin used "Supported types" + a flat top-level shape, but the schema in packages/api-types/src/sessions.ts:140 is a discriminatedUnion on `kind` wrapped inside `action`. The route accepts { action: { kind, ... }, timeout_ms? } per InteractRequestSchema at sessions.ts:166. Drift would force customers to copy the wrong shape and 4xx at the schema layer.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Supported discriminator values on `action\.kind`/);
    // All 4 kinds named.
    expect(p).toMatch(/- `tap`/);
    expect(p).toMatch(/- `type`/);
    expect(p).toMatch(/- `scroll`/);
    expect(p).toMatch(/- `press`/);
    // The action wrapper is the load-bearing shape detail.
    expect(p).toMatch(/"action":\s*\{/);
    expect(p).toMatch(/"kind":\s*"tap"/);
    // The previous (wrong) flat shape must NOT return.
    expect(p).not.toMatch(/^Supported types: `tap`/m);
  });

  it("CRITICAL 4-wait-kind enum pinned — selector/selector_hidden/url_matches/time. The previous pin (selector/navigation/duration) was fictional; WaitCondition at packages/api-types/src/sessions.ts:184 is a discriminatedUnion on `kind` with: selector, selector_hidden, url_matches, time. Body wraps the condition under `condition` key. The 'time form counts toward your minute-meter' clause is the load-bearing billing-meter framing.", () => {
    const p = read(PAGE);

    // The 4 real kinds.
    expect(p).toMatch(/- `selector`/);
    expect(p).toMatch(/- `selector_hidden`/);
    expect(p).toMatch(/- `url_matches`/);
    expect(p).toMatch(/- `time`/);
    // The `condition` wrapper is the load-bearing shape.
    expect(p).toMatch(/"condition":\s*\{/);
    // Billing-meter framing on `time` (not `duration`).
    expect(p).toMatch(/`time` form counts toward your minute-meter/);
    // Fictional kinds must NOT return.
    expect(p).not.toMatch(/`'navigation'`/);
    expect(p).not.toMatch(/`'duration'` \(just sleep\)/);
  });

  it('CRITICAL 3-capture-kind enum pinned — screenshot (PNG base64) + dom_snapshot (utf8) + pdf, with 4 MiB screenshot + 8 MiB PDF caps. The previous pin omitted dom_snapshot which is on the CaptureKindSchema enum at packages/api-types/src/sessions.ts:227. Drift to dropping the size cap would let API consumers DoS themselves.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`'screenshot'` \(PNG, base64-encoded in\s*\n?response\)/);
    expect(p).toMatch(/`'dom_snapshot'` \(the serialised DOM as raw text\)/);
    expect(p).toMatch(/`'pdf'`/);
    expect(p).toMatch(/Screenshots cap at 4 MiB; PDFs at 8 MiB\./);
    // Encoding hint.
    expect(p).toMatch(/`'base64'` for screenshot\+pdf, `'utf8'` for\s*\n?`dom_snapshot`/);
  });

  it('CRITICAL DELETE returns 204 + idempotent + frees-slot + webhook-fires framing pinned. The 4-claim contract is what tells SDK consumers about destroy semantics.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Cleanly tears down the session\. Returns `204 No Content`\./);
    expect(p).toMatch(
      /Idempotent\s*\n?on already-destroyed sessions\. Frees the concurrent slot\./,
    );
    expect(p).toMatch(
      /`session\.completed` webhook subscriptions fire after the row\s*\n?flips to `destroyed`\./,
    );
  });

  it('CRITICAL read-vs-write scope split pinned — GET=read, POST/DELETE=write. Drift to different scoping would mismatch server-side enforcement.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Read endpoints \(GET\) accept any valid bearer with `read` scope\./);
    expect(p).toMatch(
      /Write endpoints \(POST navigate \/ interact \/ wait \/ capture; DELETE\)\s*\n?require the `write:sessions` scope \(a broad `write` key also satisfies\s*\n?it\)\./,
    );
  });

  it('CRITICAL X-Driftstack-Account team-RBAC framing pinned. Cross-references W757 /team page + V-326e cycle.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Team RBAC: `X-Driftstack-Account` is honored —/);
    expect(p).toMatch(/`member` can read\s+the owner's sessions/);
    expect(p).toMatch(/writes require the\s+`admin`\s+role/);
    expect(p).toMatch(/a `member`\s+write returns 403/);
  });

  it('CRITICAL 7-row common-errors table pinned — 401/403/404/410/504/502/503. session-timeout is 504 (matches SessionTimeoutError + the errors reference), not 408. Drift to dropping a row would hide an error class from SDK consumers.', () => {
    const p = read(PAGE);

    const errors: Array<[string, string]> = [
      ['401', 'unauthorized'],
      ['403', 'forbidden'],
      ['404', 'not-found'],
      ['410', 'session-destroyed'],
      ['504', 'session-timeout'],
      ['502', 'driver-error'],
      ['503', 'driver-not-integrated'],
    ];
    for (const [status, errorType] of errors) {
      expect(p, `${status} ${errorType}`).toMatch(
        new RegExp(`\\| ${status}\\s+\\| \`${errorType}\``),
      );
    }
  });

  it('CRITICAL 6-endpoint canonical action list pinned — POST /v1/sessions + GET /v1/sessions + GET /v1/sessions/:id/state + POST /v1/sessions/:id/{navigate,interact,wait,capture} + DELETE /v1/sessions/:id. Drift would let SDK URL generation diverge.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/sessions`/);
    expect(p).toMatch(/`GET \/v1\/sessions\?limit=50&cursor=<\.\.\.>&status=<\.\.\.>`/);
    expect(p).toMatch(/`GET \/v1\/sessions\/:id\/state`/);
    expect(p).toMatch(/`POST \/v1\/sessions\/:id\/navigate`/);
    expect(p).toMatch(/`POST \/v1\/sessions\/:id\/interact`/);
    expect(p).toMatch(/`POST \/v1\/sessions\/:id\/wait`/);
    expect(p).toMatch(/`POST \/v1\/sessions\/:id\/capture`/);
    expect(p).toMatch(/`DELETE \/v1\/sessions\/:id`/);
  });

  it("CRITICAL session-lifecycle cross-reference pinned. The '/guides/session-lifecycle/' link is what drives SDK consumers from the reference to the state diagram.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\[Session lifecycle\]\(\/guides\/session-lifecycle\/\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-sessions-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
