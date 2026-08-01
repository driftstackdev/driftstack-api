// V-723 — cross-SDK drift guard for the agent-message stream backstop.
//
// One agent turn is a heartbeat-backed SSE stream: the server sends keep-alive
// comments every ~15s and the terminal `event: response` whenever the work
// finishes. Every SDK therefore needs an ABSOLUTE wall-clock ceiling, because
// the transport-level timeouts they each rely on are per-read IDLE deadlines —
// reset forever by exactly the heartbeat traffic that signals nothing is
// finishing. Without the ceiling a caller blocks indefinitely on a stream that
// is healthy and never terminal.
//
// The per-SDK files each pin their own constant. What no test pinned before
// this one is that all three AGREE — and that gap is precisely how the Python
// SDK ended up shipping with no backstop at all while TypeScript and Go both
// capped at 50 minutes. A per-file guard cannot catch a missing file.
//
// Drift in either direction is silent and harmful: a shorter ceiling aborts
// turns the server would still have completed, a longer one re-opens the hang.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** 50 minutes. Eight legal five-minute harness intents consume ~42 minutes;
 *  this leaves headroom for decomposition + optional read-back. */
const BACKSTOP_MINUTES = 50;

const SOURCES = {
  typescript: resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts'),
  go: resolve(REPO_ROOT, 'packages/sdk-go/client.go'),
  python: resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/http.py'),
} as const;

describe('V-723 agent-message stream backstop — cross-SDK parity', () => {
  // A missing SDK source must FAIL rather than vacuously pass: a guard that
  // disappears with its file is not a guard.
  it.each(Object.entries(SOURCES))('%s SDK source is present', (_sdk, path) => {
    expect(existsSync(path)).toBe(true);
  });

  it('TypeScript caps one agent turn at 50 minutes', () => {
    const body = readFileSync(SOURCES.typescript, 'utf8');
    expect(body).toMatch(
      new RegExp(
        `export const AGENT_MESSAGE_STREAM_TIMEOUT_MS = ${BACKSTOP_MINUTES.toString()} \\* 60_000;`,
      ),
    );
    // Applied as the DEFAULT for the message stream, not merely declared.
    expect(body).toMatch(/timeoutMs: opts\?\.timeoutMs \?\? AGENT_MESSAGE_STREAM_TIMEOUT_MS,/);
  });

  it('Go caps one agent turn at 50 minutes', () => {
    const body = readFileSync(SOURCES.go, 'utf8');
    expect(body).toMatch(
      new RegExp(
        `^const AgentMessageStreamTimeout = ${BACKSTOP_MINUTES.toString()} \\* time\\.Minute$`,
        'm',
      ),
    );
  });

  it('Python caps one agent turn at 50 minutes', () => {
    const body = readFileSync(SOURCES.python, 'utf8');
    expect(body).toMatch(
      new RegExp(
        `^AGENT_MESSAGE_STREAM_TIMEOUT_S = ${BACKSTOP_MINUTES.toString()} \\* 60\\.0$`,
        'm',
      ),
    );
  });

  it('Python ENFORCES the backstop rather than only declaring it', () => {
    // The constant alone is inert. The deadline has to reach the reader, and
    // the reader has to check it — the two halves that were missing.
    const body = readFileSync(SOURCES.python, 'utf8');
    expect(body).toMatch(/AGENT_MESSAGE_STREAM_TIMEOUT_S if stream_timeout_s is None/);
    expect(body).toMatch(/def _check_stream_deadline\(deadline: float \| None\) -> None:/);
    expect(body).toMatch(/if deadline is not None and time\.monotonic\(\) > deadline:/);
    // Arrival-granularity reads: a fixed 64 KiB chunk_size would buffer 15s
    // heartbeat comments for hours before the deadline was ever consulted.
    expect(body).toMatch(/_iter_chunks\(response, deadline\)/);
    expect(body).toMatch(/_aiter_chunks\(response, deadline\)/);
  });
});
