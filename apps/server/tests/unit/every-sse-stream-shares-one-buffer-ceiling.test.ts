// Every SSE stream must bound its socket buffer, from one shared ceiling.
//
// An SSE response holds a socket open indefinitely. A viewer that stops reading
// — a paused debugger, a wedged proxy, a slept laptop — does not disconnect; it
// stops draining, and `reply.raw.writableLength` grows until the process is out
// of memory. So each stream drops its own viewer past a ceiling.
//
// The ceiling was declared THREE separate times: module scope in
// account-notifications.ts and status-stream.ts, function scope inside
// agent-sessions.ts. Each had its own content-parity test pinning its own copy
// as a source literal, so every copy was "covered" — and nothing said the three
// had to AGREE. Raising one for a larger payload and updating its pin would
// have left two streams on the old ceiling, silently.
//
// A fourth site, the agent-message heartbeat, used a bare inline `64 * 1024`
// with no constant at all.
//
// All four now read `lib/sse-backpressure.ts`. This checks the duplication
// cannot return: every writableLength comparison in the route layer must be
// against an imported ceiling, and the two ceilings must stay ordered — the
// heartbeat lane carries tens of bytes per beat, so its bound is deliberately
// far tighter, and a heartbeat bound at or above the payload bound would mean
// holding a dead socket open for weeks.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_SSE_BUFFER_BYTES,
  MAX_SSE_HEARTBEAT_BUFFER_BYTES,
} from '../../src/lib/sse-backpressure.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const ROUTES = execFileSync('git', ['ls-files', 'apps/server/src/routes'], {
  cwd: REPO,
  encoding: 'utf-8',
})
  .split('\n')
  .filter((f) => f.endsWith('.ts'))
  .map((file) => ({ file, body: readFileSync(resolve(REPO, file), 'utf-8') }));

/** Files that open an SSE response. */
const STREAMING = ROUTES.filter(({ body }) => body.includes('text/event-stream'));

describe('every SSE stream shares one buffer ceiling', () => {
  it('CRITICAL the scan found the streaming routes, so a clean result is a real one', () => {
    expect(
      STREAMING.length,
      'no SSE route matched — this scan would pass over an empty set',
    ).toBeGreaterThanOrEqual(3);
    const comparisons = STREAMING.reduce(
      (n, { body }) => n + [...body.matchAll(/writableLength\s*>/g)].length,
      0,
    );
    expect(
      comparisons,
      'no backpressure comparisons found in the streaming routes — either they lost their ' +
        'ceilings or this scan stopped matching them',
    ).toBeGreaterThanOrEqual(4);
  });

  it('CRITICAL every streaming route bounds its socket buffer', () => {
    const unbounded = STREAMING.filter(({ body }) => !body.includes('writableLength')).map(
      ({ file }) => file,
    );
    expect(
      unbounded,
      'this route opens an SSE stream and never checks writableLength — a viewer that stops ' +
        'reading grows the socket buffer until the process dies',
    ).toEqual([]);
  });

  it('CRITICAL no route compares against a redeclared or inline ceiling', () => {
    const offenders: string[] = [];
    for (const { file, body } of ROUTES) {
      // A local redeclaration is how the three copies existed in the first place.
      for (const [, name] of body.matchAll(/const (MAX_SSE[A-Z_]*) = /g))
        offenders.push(`${file}: redeclares ${name} instead of importing it`);
      // A bare number on the right of the comparison is the heartbeat's old shape.
      for (const [, operand] of body.matchAll(/writableLength\s*>\s*([^)]+)\)/g))
        if (!/^[A-Z][A-Z0-9_]*$/.test(operand!.trim()))
          offenders.push(`${file}: compares writableLength against \`${operand!.trim()}\``);
    }
    expect(
      offenders.sort(),
      'an SSE ceiling is declared or written inline rather than imported from ' +
        'lib/sse-backpressure.ts — that is exactly how three copies drifted apart',
    ).toEqual([]);
  });

  it('CRITICAL the heartbeat ceiling stays far below the payload ceiling', () => {
    expect(MAX_SSE_HEARTBEAT_BUFFER_BYTES).toBeLessThan(MAX_SSE_BUFFER_BYTES);
    // Heartbeats are tens of bytes; the payload bound is megabytes. If these
    // ever converge, someone has copied one onto the other.
    expect(
      MAX_SSE_BUFFER_BYTES / MAX_SSE_HEARTBEAT_BUFFER_BYTES,
      'the heartbeat lane writes tens of bytes per beat — a bound near the payload ceiling ' +
        'would hold a dead socket open for weeks',
    ).toBeGreaterThanOrEqual(8);
  });
});
