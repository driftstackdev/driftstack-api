// W383 — drift guard for the agent-session transcript SSE backpressure cap.
//
// The transcript stream (GET /v1/agent-sessions/:id/transcript/stream) hijacks
// the reply and writes live transcript events to the raw socket. Without a cap,
// a STALLED client (TCP window full) lets events buffer unboundedly in
// reply.raw.writableLength → server OOM. The guard closes the stream past a
// generous high-water mark; the client's EventSource auto-reconnects with
// Last-Event-ID and the replay loop resumes it (no transcript entry lost).
//
// The handler hijacks the reply (raw sockets) so it isn't unit-test-injectable;
// this content-parity guard pins the protection so it can't be silently removed.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W383 agent-session transcript SSE backpressure guard content parity', () => {
  const body = read(ROUTE);

  it('file exists at canonical path', () => {
    expect(existsSync(ROUTE)).toBe(true);
  });

  it('generous high-water mark constant pinned (4MB)', () => {
    expect(body).toMatch(/const MAX_SSE_BUFFER_BYTES = 4_000_000;/);
  });

  it('live-event write path closes the stream when the socket buffer exceeds the mark (backpressure)', () => {
    expect(body).toMatch(/if \(reply\.raw\.writableLength > MAX_SSE_BUFFER_BYTES\) cleanup\(\);/);
  });

  it('cleanup is idempotent (guard + close + error can all invoke it without double-end/unsubscribe)', () => {
    expect(body).toMatch(
      /let closed = false;\s*\n?\s*const cleanup = \(\): void => \{[\s\S]*?if \(closed\) return;\s*\n?\s*closed = true;\s*\n?\s*clearInterval\(heartbeat\);\s*\n?\s*unsubscribe\(\);\s*\n?\s*reply\.raw\.end\(\);/,
    );
  });

  it('requires the granular session-read scope after EventSource authentication', () => {
    expect(body).toMatch(
      /app\.requireAuthEventSource,\s*\n?\s*app\.requireScope\('read:sessions'\),\s*\n?\s*app\.rateLimit\('global'\)/,
    );
  });

  it('projects both replayed and live entries through the shared secret redactor', () => {
    expect(body).toMatch(/entry: publicTranscriptEntry\(entry\)/);
    expect(body).toMatch(/entry: publicTranscriptEntry\(event\.entry\)/);
  });

  it('projects both plan and nested result intents in the message response', () => {
    expect(body).toMatch(/intents: plan\.intents\.map\(publicAgentIntent\)/);
    expect(body).toMatch(/results: result\.executor\.results\.map\(publicIntentResult\)/);
  });
});
