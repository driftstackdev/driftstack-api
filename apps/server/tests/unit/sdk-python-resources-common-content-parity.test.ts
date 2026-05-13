// W587.C — drift guard for packages/sdk-python/src/driftstack/resources/_common.py.
// Shared resource-layer coercion helpers. Drift here either breaks
// the dict-vs-pydantic dual-input contract used everywhere in
// resources/, or accidentally starts emitting `null` for unset
// pydantic fields (polluting the wire payload).
//
//   • coerce_body: Pydantic BaseModel → model_dump(mode="json",
//     exclude_none=True); dict → passthrough; None → None.
//   • coerce_query: same posture for query params; dict path
//     additionally strips None values.
//   • Used by every resource for mutating + query-string methods.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/_common.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W587.C packages/sdk-python/src/driftstack/resources/_common.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + dual-input (pydantic OR dict) + same-JSON-on-wire + normaliser-before-httpx framing pinned', () => {
    expect(body).toMatch(/^"""Shared helpers for the resource layer\.\n/);
    expect(body).toMatch(/Customers can pass either a Pydantic model OR a dict to mutating/);
    expect(body).toMatch(/methods\. Both serialise to the same JSON shape on the wire — the/);
    expect(body).toMatch(/helper here normalises before hand-off to httpx\./);
    expect(body).toMatch(/^from pydantic import BaseModel$/m);
  });

  it('coerce_body: None round-trips as None + Pydantic via model_dump(mode="json", exclude_none=True) + dict passthrough; CreateSessionRequest() example pins the no-null-pollution invariant', () => {
    expect(body).toMatch(
      /^def coerce_body\(body: BaseModel \| dict\[str, Any\] \| None\) -> dict\[str, Any\] \| None:$/m,
    );
    expect(body).toMatch(
      /"""Convert a Pydantic model or dict to the dict that httpx will JSON-encode\./,
    );
    expect(body).toMatch(/``None`` round-trips as ``None`` so a route with no body works/);
    expect(body).toMatch(/without callers having to pass an empty dict\./);
    expect(body).toMatch(
      /Pydantic models go through ``model_dump\(mode="json", exclude_none=True\)``/,
    );
    expect(body).toMatch(/so optional unset fields don't pollute the wire payload \(e\.g\./);
    expect(body).toMatch(/``CreateSessionRequest\(\)`` shouldn't emit ``\{"label": null\}``\)\./);
    expect(body).toMatch(
      /if body is None:\s*\n\s*return None\s*\n\s*if isinstance\(body, BaseModel\):\s*\n\s*return body\.model_dump\(mode="json", exclude_none=True\)\s*\n\s*return body/,
    );
  });

  it('coerce_query: same body-coercion posture but dict path additionally strips None values via comprehension', () => {
    expect(body).toMatch(
      /^def coerce_query\(query: BaseModel \| dict\[str, Any\] \| None\) -> dict\[str, Any\] \| None:\s*\n\s*"""Same as :func:`coerce_body` but for query-string params\."""\s*\n\s*if query is None:\s*\n\s*return None\s*\n\s*if isinstance\(query, BaseModel\):\s*\n\s*return query\.model_dump\(mode="json", exclude_none=True\)\s*\n\s*return \{k: v for k, v in query\.items\(\) if v is not None\}/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
