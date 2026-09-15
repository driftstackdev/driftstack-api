// Drift guard for apps/docs/src/pages/guides/live-video.md. Pins the
// customer-facing live-video guide — per-Mac LiveKit server +
// per-session room + 2-option join-info pattern (auto-populated on
// create OR explicit mint) + livekit-client cross-platform support
// (browsers/Node/Electron/Tauri) + 24h-TTL re-mint requirement.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/live-video.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/pages/guides/live-video content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Live-video overview framing pinned: 'Live video is delivered through LiveKit, a WebRTC streaming service. When it is available on your deployment (see Pre-requisites), agent sessions publish their browser video stream into a per-session LiveKit room. Customer-side consumers (the customer dashboard, the desktop GUI client, a third-party automation tool) subscribe to the room and render the video — typically into an <video> element.' — pinned so the LiveKit-delivery + availability-conditional + per-session-room + 3-consumer-roster contract all stay documented (2026-09-15 plain words: the per-Mac fleet mechanics are gone)", () => {
    expect(body).toMatch(
      /Live video is delivered through LiveKit, a WebRTC streaming service\.\s*When it is available on your deployment \(see Pre-requisites\), agent\s*sessions publish their browser video stream into a per-session\s*LiveKit room\./,
    );
    expect(body).not.toMatch(/Driftstack fleet|Every Mac/);
    expect(body).toMatch(
      /Customer-side consumers \(the customer\s*dashboard, the desktop GUI client, a third-party automation\s*tool\) subscribe to the room and render the video — typically\s*into an `<video>` element\./,
    );
  });

  it("Pre-requisites 3-roster pinned: agent session + LiveKit-aware client (official livekit-client package works in browsers + Node + Electron + Tauri) + live video available on the deployment. + 'The livekit field on the session-create response tells you: if it is present, you can subscribe; if it is absent, you cannot.' — pinned so the 4-platform livekit-client + livekit-field-as-readiness-signal contract all stay documented (2026-09-15 plain words: Mac credential registration is how we run it)", () => {
    expect(body).toMatch(
      /The official `livekit-client` package\s*works in browsers \+ Node \+ Electron \+ Tauri:/,
    );
    expect(body).toMatch(
      /Live video must be available on your deployment\. The `livekit`\s*field on the session-create response tells you: if it is\s*present, you can subscribe; if it is absent, you cannot\./,
    );
    expect(body).not.toMatch(/registered\s*LiveKit credentials|LK-ready/);
  });

  it("Option A auto-populated framing pinned: 'The simplest path. When live video is available on your deployment, POST /v1/agent-sessions returns the join info inline' + 'session.livekit is undefined when live video is not yet available for the session. Clients that need a token in that state fall back to the explicit endpoint.' — pinned so the Option A on-create-inline + fall-back-to-explicit-mint contract all stay documented", () => {
    expect(body).toMatch(
      /The simplest path\. When live video is available on your deployment,\s*`POST \/v1\/agent-sessions` returns the join info inline:/,
    );
    expect(body).toMatch(
      /`session\.livekit` is `undefined` when live video is not yet\s*available for the session\. Clients that need a token in that\s*state fall back to the explicit endpoint\./,
    );
    expect(body).not.toMatch(/pre-LK deployments|no Mac has registered/);
  });

  it("Option B explicit-mint framing pinned: 'For pre-existing sessions, or to get a fresh token after the 24-hour token lifetime expires' — pinned so the pre-existing-session + 24-hour-lifetime use-case contract stays documented (drift on the 24h claim would mismatch the actual LIVEKIT_TOKEN_TTL_SECONDS constant)", () => {
    expect(body).toMatch(
      /For pre-existing sessions, or to get a fresh token after the\s*24-hour token lifetime expires:/,
    );
  });

  it("LiveKit join-info 5-field shape pinned: ws_url + room + token + participant_identity + expires_at. + 'Two ways to get the LiveKit join info' 2-option framing — pinned so the 5-field join-info shape stays documented", () => {
    expect(body).toMatch(
      /Two ways to get the LiveKit join info \(`ws_url`, `room`,\s*`token`, `participant_identity`, `expires_at`\):/,
    );
  });
});
