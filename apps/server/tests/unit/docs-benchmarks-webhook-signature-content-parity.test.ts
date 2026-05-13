// W571.B — drift guard for /docs/benchmarks/webhook-signature.md.
// V-124 perf-baseline snapshot 2026-05-04. Drift here either weakens
// the constant-time-compare claim, distorts the 3-shape hz ladder
// (small-body 54.8k/56.5k / large-body 36.8k ops/s), or removes the
// importKey caching optimization-opportunity note.
//
//   • V-124 baseline. NOT a CI gate.
//   • Apple M-class, Node v25, WebCrypto subtle HMAC-SHA256.
//   • 3 shapes: small-body valid / small-body invalid / large-body.
//   • importKey per-call (no caching) — optimization opportunity noted.
//   • Excluded: server-side signWebhookPayload Node createHmac path.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/benchmarks/webhook-signature.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W571.B /docs/benchmarks/webhook-signature.md content parity', () => {
  const body = read(LIB);

  it('Header + V-124-baseline + Node-v25 + WebCrypto-subtle + not-a-CI-gate framing pinned', () => {
    expect(body).toMatch(/^# Webhook signature verify benchmarks$/m);
    expect(body).toMatch(
      /Snapshot of `npm run bench` output for `packages\/sdk-typescript\/tests\/bench\/webhook-signature\.bench\.ts`\./,
    );
    expect(body).toMatch(/Re-run on demand; numbers vary by hardware\. \*\*Not a CI gate\.\*\*/);
    expect(body).toMatch(
      /`verifyWebhookSignature` runs once per inbound webhook delivery on customer infrastructure\./,
    );
    expect(body).toMatch(
      /Latency here is part of the customer's hot path, so it's worth a baseline\./,
    );
    expect(body).toMatch(/## Baseline \(V-124, 2026-05-04\)/);
    expect(body).toMatch(
      /Node: v25 local\. Uses Node's `globalThis\.crypto\.subtle` \(WebCrypto\) for HMAC-SHA256\./,
    );
  });

  it('3 shapes (small-valid / small-invalid / large-body) bench tables + constant-time framing pinned', () => {
    expect(body).toMatch(/### Small body \(~70 bytes JSON\), valid signature/);
    expect(body).toMatch(
      /The common-case shape: a `session\.completed` event payload, signature matches\./,
    );
    expect(body).toMatch(/\| hz\s+\| 54,859 ops\/s \|/);
    expect(body).toMatch(/\| mean\s+\| 18\.2µs\s+\|/);
    expect(body).toMatch(/\| p75\s+\| 18\.8µs\s+\|/);
    expect(body).toMatch(/\| p99\s+\| 25\.7µs\s+\|/);
    expect(body).toMatch(/\| p999\s+\| 173µs\s+\|/);
    expect(body).toMatch(/### Small body, invalid signature/);
    expect(body).toMatch(/Constant-time compare runs to completion regardless of valid\/invalid\./);
    expect(body).toMatch(/\| hz\s+\| 56,478 ops\/s \|/);
    expect(body).toMatch(/\| mean\s+\| 17\.7µs\s+\|/);
    expect(body).toMatch(/\| p99\s+\| 23\.6µs\s+\|/);
    expect(body).toMatch(
      /The two paths track within RME — there's no observable timing-side-channel between valid and invalid/,
    );
    expect(body).toMatch(
      /\(which is the entire point of using constant-time comparison via WebCrypto's HMAC-SHA256 verify\)\./,
    );
    expect(body).toMatch(/### Large body \(~10 KB JSON\), valid signature/);
    expect(body).toMatch(/A `session\.completed` event with a 10 KB payload extension\./);
    expect(body).toMatch(/\| hz\s+\| 36,796 ops\/s \|/);
    expect(body).toMatch(/\| mean\s+\| 27\.2µs\s+\|/);
    expect(body).toMatch(/\| p99\s+\| 112µs\s+\|/);
    expect(body).toMatch(/\| p999\s+\| 467µs\s+\|/);
  });

  it('Observations + intentionally-NOT-benched + How-to-re-run framing pinned', () => {
    expect(body).toMatch(/## Observations/);
    expect(body).toMatch(
      /- Verify is dominated by WebCrypto subtle's HMAC-SHA256 \+ the per-call `importKey` step/,
    );
    expect(body).toMatch(/\(the SDK doesn't cache imported keys — each call imports fresh\)\./);
    expect(body).toMatch(
      /- Large-body p99 \(112µs\) shows allocation \+ hash cost scaling roughly linearly with body size\./,
    );
    expect(body).toMatch(
      /10 KB is large for a webhook payload; typical Driftstack events are <1 KB\./,
    );
    expect(body).toMatch(
      /- Optimization opportunity: cache `subtle\.importKey` per \(secret\) value across calls\./,
    );
    expect(body).toMatch(
      /That would shave ~5-10µs off the mean and is invisible to the API contract\./,
    );
    expect(body).toMatch(
      /Not yet worth the complexity — file an issue if customer-side latency becomes a real complaint\./,
    );
    expect(body).toMatch(/## What's intentionally NOT benched here/);
    expect(body).toMatch(
      /- Server-side `signWebhookPayload` \(Node `createHmac`, no WebCrypto\) — different perf profile,/,
    );
    expect(body).toMatch(/runs once per delivery, not the constraint\./);
    expect(body).toMatch(
      /- Constant-time compare for partial signatures — WebCrypto returns boolean from `verify\(\)`;/,
    );
    expect(body).toMatch(/the timing of that comparison is implementation-defined\./);
    expect(body).toMatch(/## How to re-run/);
    expect(body).toMatch(
      /npx vitest bench --run packages\/sdk-typescript\/tests\/bench\/webhook-signature\.bench\.ts/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
