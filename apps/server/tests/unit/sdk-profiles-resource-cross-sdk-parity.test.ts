// W824 — cross-SDK ProfilesResource methods parity. One-hundred-
// fiftieth in the drift-guard series. Pins the ProfilesResource
// method set across all 3 SDKs. Profiles are the persistent-state
// resource (V-073) — drift would break customer profile-management
// code (V-313 clone + V-312 snapshot integrations).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/profiles.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/profiles.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/profiles.go');
const OPENAPI = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');
const SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts');

// 11 shared method names across all 3 SDKs ([TS, Python, Go] names;
// Python uses import_ since `import` is a keyword).
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['create', 'create', 'Create'],
  ['list', 'list', 'List'],
  ['get', 'get', 'Get'],
  ['update', 'update', 'Update'],
  ['delete', 'delete', 'Delete'],
  ['clone', 'clone', 'Clone'],
  ['iterate', 'iterate', 'Iterate'],
  ['export', 'export', 'Export'],
  ['import', 'import_', 'Import'],
  ['transfer', 'transfer', 'Transfer'],
  ['trim', 'trim', 'Trim'],
];

describe('W824 cross-SDK ProfilesResource methods parity', () => {
  it('all 3 ProfilesResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 11-required-method set ───────────────────────────────────

  it('CRITICAL all 11 ProfilesResource methods exist in all 3 SDKs — create + list + get + update + delete + clone + iterate + export + import + transfer + trim. Drift would break customer profile-management code (V-073 + V-313 clone + V-480 export/import + V-666 transfer + doc-150 §8 trim + W801 cross-SDK profile-management example).', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      expect(go, `Go missing 'func (r *ProfilesResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*ProfilesResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── Python untyped-dict return (untyped pending codegen) ─────

  it('CRITICAL Python ProfilesResource returns raw dict (untyped pending codegen pass). Matches W798 + W818 pagination duck-typing framing. Drift to typing the responses without a coordinated codegen update would break the duck-typing iterate() pattern.', () => {
    const p = read(PY);
    expect(p).toMatch(/def create\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(p).toMatch(/def get\(self, profile_id: str\) -> dict\[str, Any\]:/);
    expect(p).toMatch(
      /def update\(self, profile_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(p).toMatch(
      /def clone\(self, profile_id: str, body: dict\[str, Any\] \| None = None\) -> dict\[str, Any\]:/,
    );
  });

  it("CRITICAL Python ProfilesResource iterate() returns Iterator[dict[str, Any]] (sync) + AsyncIterator[dict[str, Any]] (async). The 'pending codegen' dict-shape lets iterate() work today across both untyped + future-typed customer code paths.", () => {
    const p = read(PY);
    expect(p).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[dict\[str, Any\]\]:/,
    );
    expect(p).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> AsyncIterator\[dict\[str, Any\]\]:/,
    );
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH ProfilesResource (sync) AND AsyncProfilesResource (async). Every method except iterate (generator) has an async counterpart.', () => {
    const p = read(PY);
    for (const [, pyName] of REQUIRED_METHODS) {
      if (pyName === 'iterate') continue;
      expect(p, `Python AsyncProfilesResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
  });

  // ─── Go Iterate uses callback pattern (no generators) ─────────

  it('CRITICAL Go Iterate uses callback pattern `Iterate(ctx, query, fn func(*Profile) (bool, error)) error` instead of TS/Python generators (Go pre-1.23 has no generators). The fn callback returns (continue bool, error) — drift to a different shape would break customer cursor-walking code.', () => {
    const p = read(GO);
    expect(p).toMatch(
      /func \(r \*ProfilesResource\) Iterate\(ctx context\.Context, query \*ListProfilesQuery, fn func\(\*Profile\) \(bool, error\)\) error/,
    );
  });

  // ─── TS strongly-typed Profile return ─────────────────────────

  it('CRITICAL TS + Go ProfilesResource return strongly-typed Profile objects (not dict/interface). Customer typeahead + compile-time checks rely on the typed return. TS: Promise<Profile>; Go: *Profile + error.', () => {
    expect(read(TS)).toMatch(/create\(body: CreateProfileRequest\): Promise<Profile>/);
    expect(read(TS)).toMatch(/get\(id: string\): Promise<Profile>/);
    expect(read(TS)).toMatch(
      /clone\(id: string, body: CloneProfileRequest = \{\}\): Promise<Profile>/,
    );
    expect(read(GO)).toMatch(
      /Create\(ctx context\.Context, body \*CreateProfileRequest\) \(\*Profile, error\)/,
    );
    expect(read(GO)).toMatch(/Get\(ctx context\.Context, profileID string\) \(\*Profile, error\)/);
  });

  // ─── V-313 clone() optional body ──────────────────────────────

  it("CRITICAL V-313 clone() accepts optional body cross-SDK — TS: CloneProfileRequest = {} default; Python: dict | None = None; Go: takes *CloneProfileRequest pointer (nil OK). Lets customers clone without specifying a name (server auto-derives '(copy)' per W801).", () => {
    expect(read(TS)).toMatch(
      /clone\(id: string, body: CloneProfileRequest = \{\}\): Promise<Profile>/,
    );
    expect(read(PY)).toMatch(
      /def clone\(self, profile_id: str, body: dict\[str, Any\] \| None = None\)/,
    );
    expect(read(GO)).toMatch(/func \(r \*ProfilesResource\) Clone\(/);
  });

  // ─── iterate(opts.limit) cross-SDK ────────────────────────────

  it('CRITICAL iterate() takes optional limit cross-SDK. TS: { limit?: number } = {}; Python: *, limit: int | None = None (kwarg-only); Go: query: *ListProfilesQuery (Limit field). The limit=50 convention matches W798 cross-SDK pagination example.', () => {
    expect(read(TS)).toMatch(
      /iterate\(opts: \{ limit\?: number \} = \{\}\): AsyncGenerator<Profile, void, void>/,
    );
    expect(read(PY)).toMatch(/def iterate\(self, \*, limit: int \| None = None\)/);
  });

  // ─── delete() returns void cross-SDK ──────────────────────────

  it('CRITICAL delete() returns void cross-SDK — TS Promise<void> / Python -> None / Go error-only. HTTP 204 per API.', () => {
    expect(read(TS)).toMatch(/delete\(id: string\): Promise<void>/);
    expect(read(PY)).toMatch(/def delete\(self, profile_id: str\) -> None:/);
    expect(read(GO)).toMatch(
      /func \(r \*ProfilesResource\) Delete\(ctx context\.Context, profileID string\) error/,
    );
  });

  // ─── Go ctx-first + (T, error) convention ─────────────────────

  it('CRITICAL Go ProfilesResource methods all take ctx context.Context as first arg + return (T, error) or error-only. Matches W822 + W823 cross-SDK Go convention.', () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      // Some methods (Clone) span multiple lines — `Func(\n\tctx context.Context,\n\t...)`.
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(`func \\(r \\*ProfilesResource\\) ${goName}\\(\\s*ctx context\\.Context`),
      );
    }
  });

  // ─── Python __init__ wiring ───────────────────────────────────

  it('CRITICAL Python ProfilesResource + AsyncProfilesResource constructors take http client. Matches W822 + W823 cross-SDK wiring pattern.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-profiles-resource-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });

  // ─── transfer: what the customer is told vs what the code does ─────
  //
  // V-1980. A transfer moves the profile RECORD and deliberately leaves the
  // stored browser state behind — the server cannot re-encrypt it, because each
  // profile's data key is bound to its owning account. Every customer-facing
  // surface used to say only "Mints a copy in the recipient's account", which a
  // reader can reasonably take to mean the cookies come too.

  it('CRITICAL every SDK and the published document warn that transfer leaves the stored state behind. Three SDK doc comments plus one OpenAPI description is four places a correction can be applied to three of', () => {
    for (const [label, path] of [
      ['TS', TS],
      ['Python', PY],
      ['Go', GO],
      ['OpenAPI', OPENAPI],
    ] as const) {
      const body = read(path);
      // A plain substring, NOT a regex. The first draft used
      // `does\\s*\\n?\\s*not move` to tolerate a line wrap, which is the exact
      // redundant-whitespace construct `a-parity-regex-may-not-be-ambiguous-
      // about-whitespace` forbids — it accepts precisely what `\\s*` accepts and
      // backtracks catastrophically when the match fails. That guard caught it.
      // The phrase is kept contiguous in all four sources instead, so no
      // whitespace tolerance is needed at all.
      expect(body, `${label} warns the stored state does not move`).toContain(
        'STORED BROWSER STATE does not move',
      );
      expect(body, `${label} points at export/import for the bytes`).toContain('export');
      expect(body, `${label} names import as the other half`).toMatch(/import_?\b/);
    }
    // The retired wording, which said the opposite by implication.
    for (const [label, path] of [
      ['TS', TS],
      ['Python', PY],
      ['Go', GO],
    ] as const) {
      expect(read(path), `${label} no longer claims a plain copy`).not.toContain('Mints a copy');
    }
  });

  it('CRITICAL and the service still behaves that way, so the warning above cannot outlive its truth. transferProfile mints a fresh identity for the recipient and never carries the source wrapped DEK, which is bound to the SOURCE account TMK', () => {
    const src = read(SERVICE);
    const start = src.indexOf('async transferProfile');
    expect(start, 'transferProfile still exists').toBeGreaterThan(-1);
    // Bound BOTH ends: an unbounded slice runs on into later members and would
    // report whatever they happen to contain.
    const rest = src.slice(start + 10);
    const end =
      /\n {2}(?:private |protected |public |static )?(?:async )?[A-Za-z_#]\w*\(|\n\}/.exec(rest);
    expect(end, 'a following member bounds the body').not.toBeNull();
    const body = rest.slice(0, end?.index ?? rest.length);
    expect(body.split('\n').length, 'the extracted body is non-trivial').toBeGreaterThan(40);

    expect(body, 'a fresh identity is minted for the RECIPIENT').toContain(
      'mintProfileIdentity(args.recipientAccountId)',
    );
    expect(body, 'the recipient row is inserted with the freshly minted key').toContain(
      'transferIdentity.wrappedDek',
    );
    expect(body, 'the SOURCE wrapped DEK is never carried across accounts').not.toContain(
      'source.wrappedDek',
    );
  });
});
