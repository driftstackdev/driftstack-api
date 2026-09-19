// W778 — apps/docs sdk/installation.md content parity. One-hundred-
// fourth in the cross-SDK drift-guard series.
//
// /sdk/installation is the canonical 3-SDK install + configuration
// reference. Drift to package names, status badges, or the cross-
// SDK capability matrix would mismatch W775 SDK landing-page + the
// SDK versioning policy.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/installation.md');
const PY_RESOURCES = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources');

/**
 * The Python resource accessors at least one of whose public methods returns a
 * Pydantic model — derived from the SDK source, never listed here.
 *
 * A name counts as a model when the SDK declares it (directly or through one
 * more class) as a `BaseModel` subclass. `LiveKitInfo` is deliberately excluded
 * by that rule: the agent-sessions resource declares its own `TypedDict` of that
 * name, which is a plain dict at runtime.
 */
function pythonResourcesReturningPydanticModels(): string[] {
  const files = readdirSync(PY_RESOURCES).filter((f) => f.endsWith('.py') && !f.startsWith('_'));
  const generated = read(
    resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_generated/models.py'),
  );
  const sources = new Map(files.map((f) => [f.slice(0, -3), read(resolve(PY_RESOURCES, f))]));

  // Close over subclassing: `class RotateApiKeyResponse(CreateApiKeyResponse)`.
  const models = new Set<string>();
  const declarations = [...sources.values(), generated].flatMap((src) => [
    ...src.matchAll(/^class (\w+)\(([\w., ]+)\):/gm),
  ]);
  for (let pass = 0; pass < 5; pass += 1) {
    for (const d of declarations) {
      const bases = (d[2] ?? '').split(',').map((b) => b.trim());
      if (bases.some((b) => b === 'BaseModel' || models.has(b))) models.add(d[1] ?? '');
    }
  }
  expect(models.has('Session'), 'the model extractor found the generated models').toBe(true);

  const out: string[] = [];
  for (const [name, src] of sources) {
    // A module's own declaration wins over the generated one of the same name:
    // `agent_sessions` declares `class LiveKitInfo(TypedDict)`, which shadows the
    // generated `LiveKitInfo(BaseModel)` and is a plain dict at runtime.
    const shadowed = new Set(
      [...src.matchAll(/^class (\w+)\((?!BaseModel\b)[\w., ]*TypedDict[\w., ]*\):/gm)].map(
        (m) => m[1] ?? '',
      ),
    );
    const returns = [
      ...src.matchAll(/^ {4}(?:async )?def \w+\([\s\S]*?\)\s*->\s*([^:\n]+):/gm),
    ].map((m) => (m[1] ?? '').trim());
    const bare = returns.map((r) =>
      r
        .replace(/^Async(?:Iterator|Generator)\[/, '')
        .replace(/^Iterator\[/, '')
        .replace(/\].*$/, '')
        .replace(/\s*\|\s*None$/, '')
        .trim(),
    );
    if (bare.some((r) => models.has(r) && !shadowed.has(r))) out.push(name);
  }
  return out;
}

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

  it("CRITICAL same-surface-in-every-language framing pinned. The 'The Driftstack SDKs expose the same resources and methods in every language, with full type definitions' wording matches the SDK index promise; the OpenAPI-generation build mechanics were removed from the customer page and must not return.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The Driftstack SDKs expose the same resources and methods in every language, with full type definitions\. Pick the language that fits your stack\./,
    );
    expect(p).not.toMatch(/generated from the same OpenAPI/);
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

  // V-1132 — Go was the worst of the three and the last to be measured. The section
  // carried a single `client.Account.Me` example and no inventory at all, against the
  // nineteen accessors `client.go` ships, so eight resources — Archetypes, Billing,
  // CryptoOrders, Mfa, EmailPreferences, Legal, Egress and Recipes — appeared NOWHERE
  // in `apps/docs`, not on this page and not on any guide. A Go customer had no way to
  // learn they existed. Measured across every page before fixing, because the Go
  // surface IS documented elsewhere (go-quickstart, error-handling, several guides) and
  // "absent from this page" would have been the wrong claim.
  it('CRITICAL every Go resource accessor the SDK ships is named on the page, DERIVED from client.go. Go has no table and no per-method block, so an accessor omitted here is invisible across all of apps/docs rather than merely under-documented.', () => {
    const p = read(PAGE);
    const client = read(resolve(REPO_ROOT, 'packages/sdk-go/client.go'));

    const accessors = [...client.matchAll(/^\t([A-Z][A-Za-z]*)\s+\*[A-Za-z]+Resource$/gm)].map(
      (m) => m[1],
    );
    expect(
      accessors.length,
      'no accessors parsed out of client.go — its struct shape moved',
    ).toBeGreaterThanOrEqual(19);

    const missing = accessors.filter((a) => !new RegExp(`\\bclient\\.${a}\\b`).test(p));
    expect(
      missing.sort(),
      'Go resource accessors the SDK ships that the installation page never names:',
    ).toEqual([]);
  });

  it('the page names exactly the Python resources whose methods return Pydantic models, and says the rest return dicts', () => {
    const p = read(PAGE);

    // This page used to say "Outputs are typed Pydantic models" of EVERY resource,
    // and that sentence was pinned here as a quotation. Only six resources do;
    // `agent_sessions` — the one the AI guide teaches — returns plain dicts, which
    // the page's own Python examples read with result["field"]. So the claim is
    // DERIVED from the SDK source now instead of copied into this file.
    expect(p).toMatch(/Inputs accept either a Pydantic model OR a plain `dict`\./);
    expect(p).toMatch(/returns plain dicts that mirror the API's JSON/);
    expect(p, 'the old blanket claim must not come back').not.toMatch(
      /Outputs are typed Pydantic models\./,
    );

    const modelReturning = pythonResourcesReturningPydanticModels();
    // Vacuity: an extractor that found nothing would agree with any sentence.
    expect(modelReturning.length, 'Python resources with a Pydantic return').toBeGreaterThan(3);
    expect(modelReturning, 'sessions returns models').toContain('sessions');
    expect(modelReturning, 'agent_sessions returns dicts').not.toContain('agent_sessions');

    // The sentence names each model-returning resource in backticks, and no others.
    const sentence = /Inputs accept either a Pydantic model[^\n]*/.exec(p)?.[0] ?? '';
    expect(sentence, 'the Python output sentence was found').not.toBe('');
    const named = [
      ...new Set(
        [...sentence.matchAll(/`(\w+)`/g)]
          .map((m) => m[1] ?? '')
          .filter((n) => n !== 'dict' && n !== 'agent_sessions'),
      ),
    ].sort();
    expect(named, 'resources the page calls Pydantic-returning').toEqual(
      [...modelReturning].sort(),
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

  // V-1132 — the third hand-listed roster on this page. It checked seven rows of a
  // matrix that has fifteen, and its title described the matrix itself as having
  // seven. The eight rows it never named — Agent sessions, Recipes, Profile
  // snapshots, Audit log, MFA, Billing, Email preferences, Legal — could each have
  // lost a ✅ in silence. Derived from the matrix now, so every row is checked and a
  // new row is covered the moment it is added.
  //
  // What this deliberately CANNOT do is prove the matrix is complete. Unlike the
  // accessor arms above, which derive from client.py / client.ts / client.go, there
  // is no canonical capability list in source to check a roster against — so this
  // asserts every row present is honest, not that no row is missing. Archetypes,
  // CryptoOrders and Egress ship as accessors with no row here; the arms above are
  // what cover them, and saying so is better than a floor that pretends otherwise.
  it('CRITICAL every capability row in the What-ships matrix is ✅ across all three SDKs, DERIVED from the matrix rather than a hand-listed subset. A row that quietly loses a ✅ is a customer expectation diverging from shipped capability, and the seven-row subset this replaced was structurally unable to see the other eight.', () => {
    const p = read(PAGE);
    const section = p.slice(p.indexOf('## What ships'));
    const body = section.slice(0, section.indexOf('## Next steps'));

    const rows = [...body.matchAll(/^\| ([A-Za-z][^|]*?)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/gm)]
      .filter((m) => (m[1] ?? '').trim() !== 'Capability')
      .map((m) => ({
        cap: (m[1] ?? '').trim(),
        cols: [m[2], m[3], m[4]].map((c) => (c ?? '').trim()),
      }));

    // Anti-vacuity without freezing a row count: a parse that silently yields nothing
    // would report every row honest. Sessions is the one row that cannot leave.
    expect(
      rows.map((r) => r.cap),
      'no capability rows parsed — the matrix shape moved',
    ).toContain('Sessions');

    const notShipped = rows.filter((r) => r.cols.join('') !== '✅✅✅').map((r) => r.cap);
    expect(notShipped.sort(), 'capability rows not marked ✅ across TS/Python/Go:').toEqual([]);
  });

  it('CRITICAL search/login are presented as returning 503 where not enabled, never as shipped availability. Every currently shipped driver reports non-real capability, so both routes return 503 before session lookup; a bare "Full CRUD + ... /search/login" claim here would market availability the deployment does not have (2026-09-15 plain words: "capability-gated" / "direct-driver" are internal).', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\| Sessions\s+\| ✅\s+\| ✅\s+\| ✅\s+\| Full CRUD \+ navigate\/interact\/wait\/capture\/getState\/extract; search\/login return 503 where not enabled/,
    );
    expect(p).toMatch(
      /`sessions\.search` and `sessions\.login` are typed in every SDK, but they\s*\n?return `503` on deployments where search and login are not enabled\./,
    );
    expect(p).toMatch(/\[Sessions\]\(\/api\/sessions\/\)/);
    expect(p).not.toMatch(/capability-gated|direct-driver/);
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
