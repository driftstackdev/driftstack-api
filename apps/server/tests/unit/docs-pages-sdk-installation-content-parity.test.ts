// W778 — apps/docs sdk/installation.md content parity. One-hundred-
// fourth in the cross-SDK drift-guard series.
//
// /sdk/installation is the canonical 3-SDK install + configuration
// reference. Drift to package names, status badges, or the cross-
// SDK capability matrix would mismatch W775 SDK landing-page + the
// SDK versioning policy.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/installation.md');

describe('W778 docs /sdk/installation content parity', () => {
  it('sdk/installation.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: SDK installation\n/,
    );
    expect(p).toMatch(
      /description: Installation and configuration for the Driftstack TypeScript, Python, and Go SDKs\./,
    );
  });

  it("CRITICAL OpenAPI 3.1 typed-surface framing pinned. The 'The Driftstack SDKs share a typed surface generated from the same OpenAPI 3.1 contract' wording matches W775 SDK index Zod-source-of-truth.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The Driftstack SDKs share a typed surface generated from the same OpenAPI 3\.1 contract\./,
    );
  });

  it('CRITICAL TS 3-installer set pinned — npm/pnpm/yarn. Drift would let SDK adopters miss their package manager.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/npm install @driftstack\/sdk/);
    expect(p).toMatch(/pnpm add @driftstack\/sdk/);
    expect(p).toMatch(/yarn add @driftstack\/sdk/);
  });

  it("CRITICAL TS Node-18+ + fetch+node:crypto requirements pinned. The 'Works in any modern runtime exposing fetch and node:crypto (Bun, Deno via npm specifier)' wording explains the runtime portability claim.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Node\.js ≥ 18 \(uses native `fetch`\)/);
    expect(p).toMatch(
      /Works in any modern runtime exposing `fetch` and `node:crypto` \(Bun, Deno via npm specifier\)\./,
    );
  });

  it('CRITICAL TS Driftstack({apiKey, baseUrl, timeoutMs, retry}) constructor shape pinned. Drift to a different option name would break SDK consumer configuration.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/apiKey: process\.env\.DRIFTSTACK_API_KEY!,/);
    expect(p).toMatch(/baseUrl: 'https:\/\/api\.driftstack\.dev'/);
    expect(p).toMatch(/timeoutMs: 30_000,/);
    expect(p).toMatch(/maxAttempts: 3,/);
    expect(p).toMatch(/initialDelayMs: 200,/);
    expect(p).toMatch(/maxDelayMs: 10_000,/);
  });

  // V-1131 — a SECOND hand-listed roster lived here, and V-1130 walked straight past
  // it while fixing the first one in this same file. Its title named a resource count
  // one higher than the list printed beneath it, and both fell short of what
  // `client.ts` actually ships: wrong about its own length and wrong about the SDK,
  // in a title that read as a deliberate figure. It asserted a strict subset of what
  // the derived TypeScript arm below now proves, matching `client.X.` identically, so
  // it is deleted rather than renumbered — correcting the figure would have preserved
  // the shape that produced a wrong one twice over.
  //
  // The figure was quoted verbatim in this note at first, which made the note itself
  // an offender the instant `resources` joined the detector's noun list in
  // `a-parity-pin-cannot-freeze-a-claim-that-expires`. A retraction paraphrases; only
  // a negative sentinel quotes.

  it('CRITICAL TS sessions 9-action catalog pinned — create/list/iterate/navigate/interact/wait/getState/capture/destroy. Matches W761 /api/sessions 6-action lifecycle + list+iterate convenience.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.sessions\.create\(body\?\);/);
    expect(p).toMatch(/client\.sessions\.list\(query\?\);/);
    expect(p).toMatch(/client\.sessions\.iterate\(opts\?\);/);
    expect(p).toMatch(/client\.sessions\.navigate\(id, body\);/);
    expect(p).toMatch(/client\.sessions\.interact\(id, body\);/);
    expect(p).toMatch(/client\.sessions\.wait\(id, body\);/);
    expect(p).toMatch(/client\.sessions\.getState\(id\);/);
    expect(p).toMatch(/client\.sessions\.capture\(id, body\);/);
    expect(p).toMatch(/client\.sessions\.destroy\(id\);/);
  });

  it('CRITICAL TS apiKeys 24h-grace + admin-scope framing pinned. Matches W762 /api/api-keys + W766 /api/team role-gating contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.apiKeys\.create\(body\); \/\/ requires account_owner scope/);
    expect(p).toMatch(/client\.apiKeys\.rotate\(id\); \/\/ 24-hour grace on prior key/);
    expect(p).toMatch(/client\.apiKeys\.revoke\(id\); \/\/ requires account_owner scope/);
  });

  it('CRITICAL TS webhooks rotateSecret 24h-grace-dual-sign framing pinned. Matches W753 dashboard /webhooks + W766 /api/team header-honoring + V-475 dual-sign contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.webhooks\.rotateSecret\(id\); \/\/ 24h grace dual-sign/);
    expect(p).toMatch(/client\.webhooks\.sendTest\(id\); \/\/ synthetic test\.ping/);
  });

  it('CRITICAL TS profileSnapshots 7-action catalog pinned. Matches W774 /api/profile-snapshots 5-endpoint set + iterate convenience.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.profileSnapshots\.capture\(profileId, body\?\);/);
    expect(p).toMatch(/client\.profileSnapshots\.listForProfile\(profileId, query\?\);/);
    expect(p).toMatch(/client\.profileSnapshots\.list\(query\?\);/);
    expect(p).toMatch(/client\.profileSnapshots\.iterate\(opts\?\);/);
    expect(p).toMatch(/client\.profileSnapshots\.get\(snapshotId\);/);
    expect(p).toMatch(/client\.profileSnapshots\.restore\(snapshotId, body\?\);/);
    expect(p).toMatch(/client\.profileSnapshots\.delete\(snapshotId\);/);
  });

  it('CRITICAL TS auth.cli-authorize 3-step pinned — initiate/bind/exchange. Matches W764 /api/auth CLI activation flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.auth\.cliAuthorizeInitiate\(body\); \/\/ CLI\/GUI activation/);
    expect(p).toMatch(/client\.auth\.cliAuthorizeBind\(body\);/);
    expect(p).toMatch(/client\.auth\.cliAuthorizeExchange\(body\);/);
    expect(p).toMatch(/client\.auth\.mfaChallenge\(body\); \/\/ login MFA exchange/);
    expect(p).toMatch(/client\.auth\.mfaStepUp\(body\); \/\/ step-up freshness/);
  });

  it("CRITICAL TS auditLog 3-action pinned — list/iterate/export. The 'GDPR Article 20 JSON' comment matches W768 audit-log export framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.auditLog\.list\(query\?\);/);
    expect(p).toMatch(/client\.auditLog\.iterate\(opts\?\);/);
    expect(p).toMatch(/client\.auditLog\.export\(\); \/\/ GDPR Article 20 JSON/);
  });

  it("CRITICAL DriftstackError + 4-subclass error-framing pinned. The 'every error extends DriftstackError. Catch the base for blanket handling, or specific subclasses (RateLimitError, ConcurrencyLimitError, ValidationError, AuthError) for granular logic' wording matches W776 /sdk/error-handling categorical-catch contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /every error extends `DriftstackError`\. Catch the base for blanket handling, or specific subclasses \(`RateLimitError`, `ConcurrencyLimitError`, `ValidationError`, `AuthError`\) for granular logic\./,
    );
  });

  it('CRITICAL Python PyPI pre-1.0 install, reproducibility, and distribution/import names pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The distribution name is `driftstack-sdk`; the import name is `driftstack`\./,
    );
    expect(p).toMatch(/\*\*Status:\*\* published on PyPI, pre-1\.0, and classified Alpha\./);
    expect(p).toMatch(/^pip install driftstack-sdk$/m);
    expect(p).toMatch(/Use requirements constraints or a lockfile for reproducible deployments/);
    expect(p).not.toMatch(/@<commit>#subdirectory=packages\/sdk-python|source commit/);
  });

  it('CRITICAL Python 3.10+ + sync+async dual-client framing pinned. Driftstack (sync) + AsyncDriftstack (async) with context-manager idiom matches the V-452 SDK idioms.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Python 3\.10\+\./);
    expect(p).toMatch(/from driftstack import Driftstack/);
    expect(p).toMatch(/from driftstack import AsyncDriftstack/);
    expect(p).toMatch(/with Driftstack\(api_key=os\.environ\["DRIFTSTACK_API_KEY"\]\) as client:/);
    expect(p).toMatch(
      /async with AsyncDriftstack\(api_key=os\.environ\["DRIFTSTACK_API_KEY"\]\) as client:/,
    );
  });

  // V-1130 — this hand-listed thirteen accessors against a page carrying
  // fifteen rows and an SDK shipping nineteen, so it was blind in both
  // directions at once: four shipped resources (archetypes, billing,
  // crypto_orders, egress) had no row on the canonical install page, and two
  // that did have rows (agent_sessions, recipes) were never checked. A
  // hand-written roster cannot report a member nobody added to it — the
  // self-cancelling shape this series keeps re-deriving. Derived from
  // client.py instead, so the next accessor added without a row fails here.
  it('CRITICAL every Python resource accessor the SDK ships has a row in the installation table, DERIVED from client.py rather than hand-listed. A hand-written roster is its own population and cannot notice a resource missing from it, which is how four shipped accessors reached customers absent from the canonical install page.', () => {
    const p = read(PAGE);
    const client = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/client.py'));

    const open = /^class Driftstack\b/m.exec(client);
    expect(open, 'the sync Driftstack class moved out of client.py').not.toBeNull();
    const after = client.slice((open as RegExpExecArray).index + 1);
    const next = /^class /m.exec(after);
    const body = next === null ? after : after.slice(0, next.index);

    const accessors = [...body.matchAll(/^\s+self\.([a-z_]+) *= *[A-Za-z]+Resource\(/gm)].map(
      (m) => m[1],
    );
    // Floor, not an equality pin: a new resource should fail on its missing
    // row below, not here. Zero would mean the parse broke and every row
    // "passes" — the vacuous-green this file was corrected for.
    expect(
      accessors.length,
      'no accessors parsed out of client.py — its shape moved',
    ).toBeGreaterThanOrEqual(19);

    const missing = accessors.filter((a) => !new RegExp(`\\| \`client\\.${a}\``).test(p));
    expect(
      missing.sort(),
      'Python resource accessors the SDK ships with no row in the installation page table:',
    ).toEqual([]);
  });

  // V-1130 — the TypeScript block had the same gap for the same reason: it
  // showed seventeen of the nineteen accessors client.ts ships, omitting
  // archetypes and egress. Nothing checked it at all, so the omission was
  // not even a stale pin — it was an unwatched surface.
  it('CRITICAL every TypeScript resource accessor the SDK ships appears in the page TS resources block, DERIVED from client.ts. The block is prose-shaped rather than a table, so a resource missing from it is invisible to any reader who does not already know it exists.', () => {
    const p = read(PAGE);
    const client = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/client.ts'));

    const accessors = [
      ...client.matchAll(
        /^\s+(?:public |readonly |public readonly )?([a-zA-Z]+)!?:\s*[A-Z][A-Za-z]*Resource/gm,
      ),
    ].map((m) => m[1]);
    expect(
      accessors.length,
      'no accessors parsed out of client.ts — its shape moved',
    ).toBeGreaterThanOrEqual(19);

    const missing = accessors.filter((a) => !new RegExp(`\\bclient\\.${a}\\.`).test(p));
    expect(
      missing.sort(),
      'TypeScript resource accessors the SDK ships that the installation page never shows:',
    ).toEqual([]);
  });

  it("CRITICAL Python pydantic-OR-dict input + typed-Pydantic-output framing pinned. The 'Inputs accept either a Pydantic model OR a plain dict. Outputs are typed Pydantic models' wording is the load-bearing Python idiom.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Inputs accept either a Pydantic model OR a plain `dict`\. Outputs are typed Pydantic models\./,
    );
  });

  it("CRITICAL Go 1.22+ + zero-non-stdlib-runtime-deps framing pinned. The 'The Go SDK is single-package, has zero non-stdlib runtime dependencies, and is context-aware throughout' wording matches Go-stdlib-only design constraint.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Go 1\.22\+ \(the toolchain floor declared in `go\.mod`\)/);
    expect(p).toMatch(
      /The Go SDK is single-package, has zero non-stdlib runtime dependencies, and is context-aware throughout\./,
    );
  });

  it('CRITICAL tagged Go install and go.mod/go.sum reproducibility are pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go@latest/);
    expect(p).toMatch(/\*\*Status:\*\* published as a tagged pre-1\.0 module\./);
    expect(p).toMatch(/Commit `go\.mod` and `go\.sum` for reproducible deployments/);
    expect(p).not.toMatch(/@<commit>|pseudo-version|first tag pending/i);
  });

  it('CRITICAL Go driftstack.New + defer client.Close() framing pinned. The constructor + cleanup idiom is the canonical Go-SDK resource-management.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client := driftstack\.New\(os\.Getenv\("DRIFTSTACK_API_KEY"\)\)/);
    expect(p).toMatch(/defer client\.Close\(\)/);
    expect(p).toMatch(/me, err := client\.Account\.Me\(ctx\)/);
  });

  it("CRITICAL versioning-independence framing pinned. The 'SDKs at any version stay compatible with the live API contract; SDK upgrades unlock newer fields and new resource methods, but won\\'t break older method calls' wording matches W777 SDK versioning policy.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /SDKs at any version stay compatible with the live API contract; SDK upgrades unlock newer fields and new resource methods, but won't break older method calls\./,
    );
  });

  it('CRITICAL 7-row What-ships capability-matrix pinned. Sessions/Profiles/API keys/Webhooks/Team RBAC/Usage/Account self — all 3 SDKs (TS/Python/Go) marked ✅. Drift would let customer expectations diverge from shipped capability.', () => {
    const p = read(PAGE);

    for (const cap of [
      'Sessions',
      'Profiles',
      'API keys',
      'Webhooks',
      'Team RBAC',
      'Usage',
      'Account self',
    ]) {
      expect(p, `capability row ${cap}`).toMatch(new RegExp(`\\| ${cap}\\s+\\| ✅`));
    }
  });

  it('CRITICAL search/login are presented as capability-gated, never as shipped availability. Every currently shipped driver reports non-real capability, so both routes return 503 before session lookup; a bare "Full CRUD + ... /search/login" claim here would market availability the deployment does not have.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\| Sessions\s+\| ✅\s+\| ✅\s+\| ✅\s+\| Full CRUD \+ navigate\/interact\/wait\/capture\/getState\/extract; search\/login are capability-gated/,
    );
    expect(p).toMatch(
      /`sessions\.search` and `sessions\.login` are typed in every SDK, but the routes\s*\n?themselves are capability-gated: they require a deployment advertising a real\s*\n?direct-driver search\/login capability and otherwise return `503` before the\s*\n?session is looked up or any browser work starts\./,
    );
    expect(p).toMatch(/\[Sessions\]\(\/api\/sessions\/\)/);
  });

  it('CRITICAL Next-steps 3-link set pinned — /quickstart/ + /guides/profile-management/ + /guides/session-lifecycle/. Drift to dropping any link would force new customers to hunt for follow-on content.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*\[Quickstart\]\(\/quickstart\/\)\*\*/);
    expect(p).toMatch(/\*\*\[Profile management\]\(\/guides\/profile-management\/\)\*\*/);
    expect(p).toMatch(/\*\*\[Session lifecycle\]\(\/guides\/session-lifecycle\/\)\*\*/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-sdk-installation-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
