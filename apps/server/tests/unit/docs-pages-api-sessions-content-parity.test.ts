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

  it('CRITICAL profile-binding-planned-not-wired framing pinned. Sets the right expectation for SDK consumers reading the page today.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Profile binding is planned \(catalog\), not yet wired\.\*\*/);
    expect(p).toMatch(
      /Customers\s*\n?> using profiles via the SDK currently can't bind a session to a\s*\n?> profile programmatically\./,
    );
  });

  it('CRITICAL 3-wait_for-strategy enum pinned — load/domcontentloaded/networkidle. Drift to dropping a strategy would silently break SDK consumers using it.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`wait_for`: `'load'` \(default\), `'domcontentloaded'`, or\s*\n?`'networkidle'`/,
    );
  });

  it('CRITICAL 4-interact-type enum pinned — tap/type/scroll/press. Drift to dropping a type would silently break SDK interact() consumers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Supported types: `tap`, `type`, `scroll`, `press`/);
  });

  it("CRITICAL 3-wait-kind enum pinned — selector/navigation/duration. The 'duration form counts toward your minute-meter' clause is the load-bearing billing-meter framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`kind`: `'selector'` \(DOM appears\), `'navigation'` \(next nav\s*\n?completes\), or `'duration'` \(just sleep\)/,
    );
    expect(p).toMatch(/The `duration` form\s*\n?counts toward your minute-meter\./);
  });

  it('CRITICAL 2-capture-kind enum pinned — screenshot (PNG base64) + pdf, with 4 MiB screenshot + 8 MiB PDF caps. Drift to dropping the size cap would let API consumers DoS themselves.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`kind`: `'screenshot'` \(PNG, base64-encoded in response\) or\s*\n?`'pdf'`\. Screenshots cap at 4 MiB; PDFs at 8 MiB\./,
    );
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
      /Write endpoints \(POST navigate \/ interact \/ wait \/ capture; DELETE\)\s*\n?require `write`\./,
    );
  });

  it('CRITICAL X-Driftstack-Account team-RBAC framing pinned. Cross-references W757 /team page + V-326e cycle.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Team RBAC: `X-Driftstack-Account` is honored —/);
    expect(p).toMatch(/member roles can read \+ write on the owner's sessions\./);
  });

  it('CRITICAL 7-row common-errors table pinned — 401/403/404/410/408/502/503. Drift to dropping a row would hide an error class from SDK consumers.', () => {
    const p = read(PAGE);

    const errors: Array<[string, string]> = [
      ['401', 'unauthorized'],
      ['403', 'forbidden'],
      ['404', 'not-found'],
      ['410', 'session-destroyed'],
      ['408', 'session-timeout'],
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
