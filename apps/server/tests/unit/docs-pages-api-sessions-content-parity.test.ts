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
      /description: Create \+ drive iPhone Safari sessions — navigate, interact, wait, capture, extract, search, login, get-state, destroy\. Tier-gated concurrency\./,
    );
  });

  it('CRITICAL TIER_CONCURRENT_SESSION_LIMITS table pinned with all 8 tiers + caps. Matches W749 dashboard /sessions concurrent-meter shared constant.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`TIER_CONCURRENT_SESSION_LIMITS` constant in/);
    expect(p).toMatch(/`@driftstack\/api-types`/);

    const tierCaps: Array<[string, string]> = [
      ['free', '1'],
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
      // S31 2026-07-07 (fable-truth-audit) — ConcurrencyLimitError carries current_sessions/limit
      // extensions and NO retry_after_seconds, so no Retry-After header is
      // emitted (middleware/error-handler.ts only sets it for rate limits).
      /Hitting the cap on `POST \/v1\/sessions` returns `429 Too Many\s*\n?Requests` with `current_sessions` and `limit` in the problem body/,
    );
    expect(p).toMatch(/free-tier sessions stop at the 20-minute duration\s*\n?cap/);
    expect(p).not.toMatch(/tier-default idle timeout/);
  });

  it('CRITICAL 5-state STATUS enum pinned — creating/ready/busy/destroyed/errored. Matches W749 dashboard /sessions STATUS_BADGE_CLASS map.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`status` is one of `creating`, `ready`, `busy`, `destroyed`,\s*\n?`errored`/,
    );
  });

  it('create returns only at ready while concurrent resource reads can observe the durable creating reservation', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The SDK's `sessions\.create\(\)` call returns only after the\s*\n?new session reaches `ready`, but concurrent resource reads and lists can\s*\n?observe its durable `creating` reservation while the driver starts\./,
    );
    expect(p).toMatch(
      /session already `creating` or `busy` returns `409 Conflict` without a\s*\n?second driver dispatch/,
    );
    expect(p).not.toMatch(/creating` state isn't directly observable/);
  });

  it('direct operation owner and state timestamp truth are explicit', () => {
    const p = read(PAGE);
    expect(p).toMatch(/Every direct driver operation atomically claims `ready` → `busy`/);
    expect(p).toMatch(/Success settles `busy` → `ready`/);
    expect(p).toMatch(/driver failure\s*\n?elects `busy` → terminal `errored`/);
    expect(p).toMatch(/outcome-unknown\s*\n?`busy` owner is not automatically reclaimed/);
    expect(p).toMatch(/`last_state_at` is the most recent successful `getState` capture timestamp/);
    expect(p).not.toMatch(/most recent `getState` \/ `capture` \/\s*\n?`navigate`/);
  });

  it('documents login safe-refusal truth, strict branch fields and the explicit activation hold', () => {
    const p = read(PAGE);

    expect(p).toMatch(/The response is a strict two-branch result/);
    expect(p).toMatch(/"submitted": true,[\s\S]*?"credentials_truncated": false/);
    expect(p).toMatch(/"submitted": false,[\s\S]*?"credentials_truncated": true/);
    expect(p).toMatch(/does not type the password after a truncated username/);
    expect(p).toMatch(/does\s*\n?not expose a URL on this branch/);
    expect(p).toMatch(/`duration_ms` is capped at 600,000ms/);
    expect(p).toMatch(/separate 15,000ms for teardown and\s*\n?result delivery/);
    expect(p).toMatch(/does not extend successful login work/);
    expect(p).toMatch(/requires an explicitly real direct-driver login capability/);
    expect(p).toMatch(/currently\s*\n?shipped driver reports non-real capability/);
    expect(p).toMatch(/return\s*\n?the documented `503` before session lookup, operation claim/);
    expect(p).toMatch(/Do not send customer credentials/);
    expect(p).not.toMatch(
      /logged_in` is the post-submit assessment and\s*\n?is \*\*never a false positive\*\*/,
    );
  });

  it('CRITICAL the login section must not point customers at a recipe-execution surface. `execute_recipe` exists NOWHERE in the codebase — `/v1/recipes` is create/list/read/delete only (apps/docs/src/pages/api/index.astro: "it does not expose recipe execution"), so naming it as "the separate execute_recipe surface" advertised availability the product does not have. Unguarded prose drifted into this page once; this pins the corrected truth and bans the phantom surface.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /Recipes are capture-only today — `\/v1\/recipes` supports create, list,\s*\n?read and delete, and the API exposes no recipe-execution surface/,
    );
    expect(p).not.toMatch(/execute_recipe/);
  });

  it('documents search safe-refusal truth, the query bound and the real-capability 503 posture', () => {
    const p = read(PAGE);
    expect(p).toMatch(/`query` is required and capped at 10,000/);
    expect(p).toMatch(/"query_truncated": false/);
    expect(p).toMatch(/"query_truncated": true/);
    expect(p).toMatch(/refuses safely before\s*\n?Return, settle, or the results wait/);
    expect(p).toMatch(/refusal cannot carry\s*\n?`results_visible`/);
    expect(p).toMatch(/`duration_ms` is capped at 600,000ms/);
    expect(p).toMatch(/separate 15,000ms for teardown and result delivery/);
    expect(p).toMatch(/does not\s*\n?extend successful search work/);
    expect(p).toMatch(/requires an explicitly real\s*\n?direct-driver search capability/);
    expect(p).toMatch(/There\s*\n?is no public `fill_form`/);
  });

  it('CRITICAL LOCKED_ARCHETYPE_ID default + 3-purpose enum pinned. archetype defaults to iphone17_ios18_7_safari26_4; purpose defaults to production_customer with cumulative_rig_validation + test_domain_probe reserved internal.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`archetype` defaults to the locked iPhone 17 \/\s*\n?iOS 18\.7 \/ Safari 26\.4 archetype when omitted \(`LOCKED_ARCHETYPE_ID`\s*\n?= `iphone17_ios18_7_safari26_4`\)\./,
    );
    expect(p).toMatch(/`purpose` defaults to\s*\n?`production_customer`\./);
    expect(p).toMatch(
      /the other values\s*\n?\(`cumulative_rig_validation`, `test_domain_probe`\) are reserved\s*\n?for Driftstack-internal ops\./,
    );
  });

  it('direct archetype creates use the live selectable catalog while stored profile launches preserve compatibility', () => {
    const p = read(PAGE);

    expect(p).toContain('[`GET /v1/archetypes`](/api/archetypes/)');
    expect(p).toMatch(
      /Any id absent from that\s*\n?response returns `400 ValidationFailed` on the `archetype` field before the\s*\n?server creates a session row or asks the driver to allocate a browser\./,
    );
    expect(p).not.toMatch(/\bplanned ids?\b|reference-only/i);
    expect(p).toMatch(
      /Profile-backed launches inherit the already-stored profile archetype\.[\s\S]*?existing profile remains launchable if its pinned id is\s*\n?no longer offered for new direct creates\./,
    );
  });

  it('documents delay_ms as a public request bound without exposing driver implementation posture', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`delay_ms` \(requested inter-key delay, integer 0-500ms\)/);
    expect(p).not.toMatch(/mock driver|real driver/i);
  });

  it('CRITICAL label-max-120-char + metadata-arbitrary-JSON framing pinned. Drift to different field bounds would diverge from server validation.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`label` is a free-form short string \(max 120 chars\)/);
    expect(p).toMatch(
      /`metadata` is an arbitrary JSON object for the\s*\n?customer's own bookkeeping\./,
    );
  });

  it('states the fail-closed direct egress boundary without implying a raw proxy is consumed', () => {
    const p = read(PAGE);

    expect(p).toMatch(/does not accept a raw `proxy` field/);
    expect(p).toMatch(/never silently stripped or treated as an egress safeguard/);
    expect(p).toContain('`POST /v1/agent-sessions`');
    expect(p).toContain('`proxy_id`');
    expect(p).toMatch(/fail closed for every body/);
    expect(p).toMatch(/Setting the flag to `false` preserves\s*\n?proxy-free direct creation/);
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

  it('2026-06-05 — behavioral_profile (per-session persona) documented on POST /v1/sessions: in the request example + the casual/regular/power_user values + the regular default. Guards the API-reference doc from lagging the schema field (the gap this pin fixed).', () => {
    const p = read(PAGE);
    expect(p).toMatch(/"behavioral_profile": "regular"/);
    expect(p).toMatch(
      /`behavioral_profile` \(2026-06-05\) selects the per-session behavioural\s*\n?persona[\s\S]*?`casual`, `regular`, or `power_user`\. Defaults to `regular`/,
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

  it('navigation driver failures terminalize the session instead of advertising unsafe retry', () => {
    const p = read(PAGE);
    expect(p).toMatch(/failure winner becomes terminal `errored`, tears down its runtime/);
    expect(p).toMatch(/subsequent operations return\s*\n?`410 Gone`/);
    expect(p).not.toMatch(/session itself stays `ready` for a retry/);
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

    expect(p).toMatch(
      /GET endpoints require a bearer that satisfies the `read` scope; the team-role\s*\n?restrictions below also apply\./,
    );
    expect(p).toMatch(
      /Write endpoints \(POST navigate \/ interact \/ wait \/ capture \/ extract \/ search \/ login; DELETE\)\s*\n?require the `write:sessions` scope \(a broad `write` key also satisfies\s*\n?it\)\./,
    );
  });

  it('CRITICAL X-Driftstack-Account team-RBAC framing pinned. Cross-references W757 /team page + V-326e cycle.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Team RBAC: `X-Driftstack-Account` is honored —/);
    expect(p).toMatch(/`member` can list\s+and read the owner's persisted session metadata/);
    expect(p).toMatch(/live state and\s+writes require the `admin` role/);
    expect(p).toMatch(
      /A member's state or write request returns\s+403 before the driver is contacted/,
    );
  });

  it('CRITICAL team-scoped state is an admin-only secret-bearing live operation while self read:sessions is unchanged', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Despite its `GET` method, this is a live driver operation/);
    expect(p).toMatch(/With\s+`X-Driftstack-Account`, only a team `admin` may call it/);
    expect(p).toMatch(
      /a team `member`\s+receives `403` before the driver or session row is touched/,
    );
    expect(p).toMatch(
      /Members may still\s+use the sessions list and `GET \/v1\/sessions\/:id` for persisted metadata/,
    );
    expect(p).toMatch(/A\s+self-account caller with `read:sessions` is unchanged/);
  });

  it('CRITICAL 8-row common-errors table pinned — includes 409 operation ownership and terminal 410', () => {
    const p = read(PAGE);

    const errors: Array<[string, string]> = [
      ['401', 'unauthorized'],
      ['403', 'forbidden'],
      ['404', 'not-found'],
      ['409', 'conflict'],
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
    expect(p).toMatch(/\| 403\s+\| `forbidden`\s+\| Scope missing or team role is insufficient/);
    expect(p).toMatch(/Session is `creating` or another operation owns `busy`/);
    expect(p).toMatch(/Session is `destroyed`\/`errored`, or destroy won; recreate/);
  });

  it('CRITICAL 7-endpoint canonical action list pinned — POST /v1/sessions + GET /v1/sessions + GET /v1/sessions/:id (single resource) + GET /v1/sessions/:id/state + POST /v1/sessions/:id/{navigate,interact,wait,capture} + DELETE /v1/sessions/:id. 2026-06-24: "Get one" now documents the real single-resource GET /v1/sessions/:id (routes/sessions.ts:475, backs sessions.get()); the live-state GET /v1/sessions/:id/state stays the "Get state" endpoint. Drift would let SDK URL generation diverge.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/sessions`/);
    // The List route's PaginationQuerySchema parses only limit + cursor
    // (no `status` filter) — the example must not advertise &status=.
    expect(p).toMatch(/`GET \/v1\/sessions\?limit=50&cursor=<\.\.\.>`/);
    expect(p).not.toMatch(/`GET \/v1\/sessions\?[^`]*&status=/);
    // Single-resource detail endpoint (the "Get one" section).
    expect(p).toMatch(/`GET \/v1\/sessions\/:id` — fetch a single session resource\./);
    // Live-state endpoint stays under "Get state".
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
