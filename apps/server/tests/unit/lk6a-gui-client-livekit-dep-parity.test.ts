// LK.6.a — gui-client gains the livekit-client dependency + a
// typed wrapper module. This drift guard verifies the wiring is
// in place via text reads (no actual livekit-client import — the
// dep installs at gui-client's own npm install time, not the
// server test suite's).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const GUI_PKG = resolve(REPO_ROOT, 'apps/gui-client/package.json');
const WRAPPER = resolve(REPO_ROOT, 'apps/gui-client/src/lib/livekit.ts');

describe('LK.6.a — gui-client livekit-client dep + wrapper', () => {
  it('apps/gui-client/package.json declares livekit-client in runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(GUI_PKG, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['livekit-client']).toBeDefined();
    // v2.x is the current major; pin to ^2 so minor + patch updates
    // flow without manual version bumps.
    expect(pkg.dependencies['livekit-client']).toMatch(/^\^2\./);
  });

  it('apps/gui-client/src/lib/livekit.ts exists', () => {
    expect(existsSync(WRAPPER)).toBe(true);
  });

  const body = readFileSync(WRAPPER, 'utf8');

  it('wrapper imports Room + RoomEvent from livekit-client', () => {
    expect(body).toMatch(/import \{ Room, RoomEvent \} from 'livekit-client'/);
  });

  it('wrapper imports LiveKitInfo type from the SDK (no duplicate definition)', () => {
    expect(body).toMatch(/import type \{ LiveKitInfo \} from '@driftstack\/sdk'/);
  });

  it('wrapper exports the InputEvent discriminated-union (Mac-side decoder contract)', () => {
    // The mouse/key/wheel/ping variants Agent 1's Swift InputEvent enum decodes
    // (the 5 touch variants — tap/touchStart/touchMove/touchEnd/swipe — are also
    // in the union; this check pins the original set's presence, not the count).
    expect(body).toMatch(/type: 'mouseMove'/);
    expect(body).toMatch(/type: 'mouseDown'/);
    expect(body).toMatch(/type: 'mouseUp'/);
    expect(body).toMatch(/type: 'keyDown'/);
    expect(body).toMatch(/type: 'keyUp'/);
    expect(body).toMatch(/type: 'wheel'/);
    expect(body).toMatch(/type: 'ping'/);
  });

  it('mouse buttons are bounded 0|1|2 (left/middle/right — matches Quartz CGEventCreateMouseEvent)', () => {
    expect(body).toMatch(/button:\s*0\s*\|\s*1\s*\|\s*2/);
  });

  it('wrapper exposes LivekitConnectionState discriminated union for UI', () => {
    // LK.6.c consumes this for the connecting/connected/etc. badge.
    expect(body).toMatch(/export type LivekitConnectionState/);
    expect(body).toMatch(/kind: 'idle'/);
    expect(body).toMatch(/kind: 'connecting'/);
    expect(body).toMatch(/kind: 'connected'/);
    expect(body).toMatch(/kind: 'reconnecting'/);
    expect(body).toMatch(/kind: 'disconnected'/);
    expect(body).toMatch(/kind: 'error'/);
  });

  it('wrapper exposes createLivekitRoom() tuned for the interactive simulator: adaptiveStream OFF (visibility/size gating adds latency to a single always-visible real-time track) + dynacast ON', () => {
    expect(body).toMatch(/export function createLivekitRoom/);
    expect(body).toMatch(/adaptiveStream:\s*false/);
    expect(body).toMatch(/dynacast:\s*true/);
  });

  it('wrapper exposes connectToAgentSession(room, info) consuming LiveKitInfo directly', () => {
    expect(body).toMatch(/export async function connectToAgentSession/);
    expect(body).toMatch(/room\.connect\(info\.ws_url, info\.token\)/);
  });

  it('wrapper exposes sendInputEvent(room, event) using DataChannel publish', () => {
    expect(body).toMatch(/export async function sendInputEvent/);
    expect(body).toMatch(/room\.localParticipant\.publishData/);
    // Default reliable=true (TCP-style; mouse/key events MUST arrive
    // in order; cursor-tracking opt-in to lossy=true).
    expect(body).toMatch(/const reliable = opts\.reliable \?\? true/);
  });
});
