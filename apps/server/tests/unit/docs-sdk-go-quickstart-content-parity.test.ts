// Drift guard for apps/docs/src/pages/sdk/go-quickstart.md. Pins
// the Go 1.21+ contract, the alpha-pin-to-sha caveat, the
// driftstack.New + Close() lifecycle, and the WithBaseURL +
// WithHTTPClient option pattern.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/go-quickstart.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs sdk/go-quickstart content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Go quickstart/);
    expect(body).toMatch(/description: 5-minute getting-started for the driftstack-sdk Go client/);
  });

  it('Go version contract pinned: Go 1.22+ minimum (uses generics + slices package). 2026-06-24: packages/sdk-go/go.mod declares `go 1.22`, so the doc floor is 1.22+ (was a stale 1.21+). Drift to dropping/lowering the version floor would surprise customers running older Go', () => {
    expect(body).toMatch(/Go 1\.22\+ \(the SDK uses generic constraints \+ `slices` package\)/);
    expect(body).not.toMatch(/Go 1\.21\+/);
  });

  it('alpha-pin-to-sha caveat pinned: drift to claiming a stable v1 release would mislead customers about API-stability guarantees during alpha', () => {
    expect(body).toMatch(/The Go SDK is alpha until the first tagged release lands/);
    expect(body).toMatch(/Pin to a\s*\n?\s*>?\s*specific commit during the alpha by running/);
  });

  it("install command + canonical import path pinned: `go get github.com/driftstackdev/driftstack-api/packages/sdk-go` + the `driftstack` import alias. Drift would silently break customers' module imports", () => {
    expect(body).toMatch(/go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/);
    expect(body).toMatch(
      /driftstack "github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go"/,
    );
  });

  it('driftstack.New + Close() lifecycle pinned: defer client.Close() is the idiomatic-Go pattern. Drift to dropping Close() would normalize http.Transport leaks across long-running services', () => {
    expect(body).toMatch(/`driftstack\.New` returns `\*Client`/);
    expect(body).toMatch(/`Close\(\)` releases the underlying `http\.Transport` connection pool/);
    expect(body).toMatch(/idiomatic Go is `defer client\.Close\(\)`\s+in `main`/);
  });

  it('constructor options pinned: WithBaseURL (staging/self-hosted override) + WithHTTPClient (instrumented client for OTel/retries). Drift to dropping either would orphan customers from staging-vs-prod swaps and from instrumented-transport injection', () => {
    expect(body).toMatch(/driftstack\.WithBaseURL\("https:\/\/staging\.driftstack\.dev"\)/);
    expect(body).toMatch(/driftstack\.WithHTTPClient\(myInstrumentedHTTPClient\)/);
    expect(body).toMatch(/OpenTelemetry, retries, etc\./);
  });
});
