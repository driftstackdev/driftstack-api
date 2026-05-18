// LK.6.e — drift guard for the synthetic-ping RTT-measurement hook.
// Pins the protocol the harness-side RoomDataDispatcher +
// LatencyCollector echoes against (Agent 1 owns the harness side;
// this is the gui-client end).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HOOK = resolve(REPO_ROOT, 'apps/gui-client/src/lib/livekit-latency-ping.ts');

describe('LK.6.e — useLatencyPing hook', () => {
  it('hook file exists', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  const body = readFileSync(HOOK, 'utf8');

  it('exports useLatencyPing + LatencyState + formatRtt', () => {
    expect(body).toMatch(/export function useLatencyPing/);
    expect(body).toMatch(/export interface LatencyState/);
    expect(body).toMatch(/export function formatRtt/);
  });

  it('ping cadence is 2000 ms (LIVEKIT_PING_INTERVAL_MS)', () => {
    expect(body).toMatch(/LIVEKIT_PING_INTERVAL_MS = 2000/);
  });

  it('fresh-window discards samples older than 6000 ms', () => {
    expect(body).toMatch(/LIVEKIT_PING_FRESH_WINDOW_MS = 6000/);
  });

  it('reuses sendInputEvent + RoomEvent.DataReceived from the wrapper', () => {
    expect(body).toMatch(/sendInputEvent\(room, \{ type: 'ping', timestamp \}/);
    expect(body).toMatch(/RoomEvent\.DataReceived/);
  });

  it('ping itself sent lossy (reliable=false — packet loss preferable to congestion)', () => {
    expect(body).toMatch(/\{ type: 'ping', timestamp \}, \{ reliable: false \}/);
  });

  it('echo parsing tolerates non-JSON binary data events (ignored, not crash)', () => {
    expect(body).toMatch(/JSON\.parse\(new TextDecoder\(\)\.decode\(payload\)\)/);
    expect(body).toMatch(/return; \/\/ non-JSON data event/);
  });

  it('discriminates by type==="ping" + timestamp number (rejects stray data events)', () => {
    expect(body).toMatch(/\.type !== 'ping'/);
    expect(body).toMatch(/typeof \(parsed as \{ timestamp\?: unknown \}\)\.timestamp !== 'number'/);
  });

  it('matches echoes to outstanding pings by timestamp (out-of-order safe)', () => {
    expect(body).toMatch(/outstanding\.has\(ts\)/);
    expect(body).toMatch(/outstanding\.delete\(ts\)/);
  });

  it('garbage-collects outstanding pings older than the fresh window', () => {
    expect(body).toMatch(/timestamp - ts > LIVEKIT_PING_FRESH_WINDOW_MS/);
  });

  it('short-circuits when room===null OR enabled=false (no interval scheduled)', () => {
    expect(body).toMatch(/if \(room === null \|\| !enabled\) return/);
  });

  it('cleanup clears the interval + detaches the DataReceived listener', () => {
    expect(body).toMatch(/clearInterval\(handle\)/);
    expect(body).toMatch(/room as any\)\.off\?\.\(RoomEvent\.DataReceived, onData\)/);
  });

  it('formatRtt returns an em-dash when no fresh sample exists', () => {
    expect(body).toMatch(/state\.rttMs === null/);
    expect(body).toMatch(/return '— ms'/);
  });
});
