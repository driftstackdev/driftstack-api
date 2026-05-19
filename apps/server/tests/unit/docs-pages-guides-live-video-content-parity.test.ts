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

  it("Live-video overview framing pinned: 'Every Mac in the Driftstack fleet runs its own LiveKit server. Agent sessions publish their browser video stream into a per-session LiveKit room. Customer-side consumers (the customer dashboard, the desktop GUI client, a third-party automation tool) subscribe to the room and render the video — typically into an <video> element.' — pinned so the per-Mac-LiveKit-server + per-session-room + 3-consumer-roster (dashboard / desktop GUI / third-party) contract all stay documented", () => {
    expect(body).toMatch(
      /Every Mac in the Driftstack fleet runs its own LiveKit server\.\s*\n?\s*Agent sessions publish their browser video stream into a\s*\n?\s*per-session LiveKit room\./,
    );
    expect(body).toMatch(
      /Customer-side consumers \(the customer\s*\n?\s*dashboard, the desktop GUI client, a third-party automation\s*\n?\s*tool\) subscribe to the room and render the video — typically\s*\n?\s*into an `<video>` element\./,
    );
  });

  it("Pre-requisites 3-roster pinned: agent session + LiveKit-aware client (official livekit-client package works in browsers + Node + Electron + Tauri) + deployment Mac with registered LiveKit credentials. + 'auto-populated livekit field on the session-create response tells you whether this is the case — if the field is absent, the deployment isn't LK-ready and you cannot subscribe.' — pinned so the 4-platform livekit-client + auto-populated-livekit-field-as-readiness-signal contract all stay documented", () => {
    expect(body).toMatch(
      /The official `livekit-client` package\s*\n?\s*works in browsers \+ Node \+ Electron \+ Tauri:/,
    );
    expect(body).toMatch(
      /The auto-populated `livekit` field on the\s*\n?\s*session-create response tells you whether this is the case —\s*\n?\s*if the field is absent, the deployment isn't LK-ready and you\s*\n?\s*cannot subscribe\./,
    );
  });

  it("Option A auto-populated framing pinned: 'The simplest path. When the deployment is LK-ready, POST /v1/agent-sessions returns the join info inline' + 'session.livekit is undefined on pre-LK deployments OR when no Mac has registered credentials yet. Clients that need a token in that state fall back to the explicit endpoint.' — pinned so the Option A on-create-inline + fall-back-to-explicit-mint contract all stay documented", () => {
    expect(body).toMatch(
      /The simplest path\. When the deployment is LK-ready, `POST\s*\n?\s*\/v1\/agent-sessions` returns the join info inline:/,
    );
    expect(body).toMatch(
      /`session\.livekit` is `undefined` on pre-LK deployments OR when\s*\n?\s*no Mac has registered credentials yet\. Clients that need a token\s*\n?\s*in that state fall back to the explicit endpoint\./,
    );
  });

  it("Option B explicit-mint framing pinned: 'For pre-existing sessions, or to re-mint after the 24-hour token TTL expires' — pinned so the pre-existing-session + 24-hour-TTL-re-mint use-case contract stays documented (drift on the 24h TTL claim would mismatch the actual LIVEKIT_TOKEN_TTL_SECONDS constant)", () => {
    expect(body).toMatch(
      /For pre-existing sessions, or to re-mint after the 24-hour token\s*\n?\s*TTL expires:/,
    );
  });

  it("LiveKit join-info 5-field shape pinned: ws_url + room + token + participant_identity + expires_at. + 'Two ways to get the LiveKit join info' 2-option framing — pinned so the 5-field join-info shape stays documented", () => {
    expect(body).toMatch(
      /Two ways to get the LiveKit join info \(`ws_url`, `room`,\s*\n?\s*`token`, `participant_identity`, `expires_at`\):/,
    );
  });
});
