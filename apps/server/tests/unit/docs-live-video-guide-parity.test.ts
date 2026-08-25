// Arc 6 docs.live-video — guides/live-video.md walks through the
// LiveKit subscriber integration end-to-end. This drift guard
// pins the canonical 4-step structure + the InputEvent schema +
// the dev-friendly reconnect / TTL notes so a refactor that drops
// any of them breaks CI.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/live-video.md');

describe('Arc 6 docs.live-video — guides/live-video.md parity', () => {
  it('page exists at the expected path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  const body = readFileSync(PAGE, 'utf8');

  it('frontmatter declares the layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: Live video for agent sessions/);
    expect(body).toMatch(/description: .*LiveKit/i);
  });

  it('lays out the 4-step integration structure', () => {
    expect(body).toMatch(/## 1\. Obtain the join info/);
    expect(body).toMatch(/## 2\. Connect to the room/);
    expect(body).toMatch(/## 3\. Send input back \(optional\)/);
    expect(body).toMatch(/## 4\. Disconnect on unmount/);
  });

  it('documents BOTH ways to get the join info (auto-populated + explicit)', () => {
    expect(body).toMatch(/Option A — auto-populated on session-create/);
    expect(body).toMatch(/Option B — explicit mint/);
  });

  it('documents the LK.3 endpoint path + the 3 error codes (404 / 403 / 503)', () => {
    expect(body).toMatch(/\/v1\/agent-sessions\/\$\{sessionId\}\/livekit-token/);
    expect(body).toMatch(/`404`/);
    expect(body).toMatch(/`403`/);
    expect(body).toMatch(/`503`/);
  });

  it('documents all 7 InputEvent variants', () => {
    expect(body).toMatch(/type: 'mouseMove'/);
    expect(body).toMatch(/type: 'mouseDown'/);
    expect(body).toMatch(/type: 'mouseUp'/);
    expect(body).toMatch(/type: 'keyDown'/);
    expect(body).toMatch(/type: 'keyUp'/);
    expect(body).toMatch(/type: 'wheel'/);
    expect(body).toMatch(/type: 'ping'/);
  });

  it('documents the reliable vs lossy split for InputEvent variants', () => {
    expect(body).toMatch(/`reliable: true`/);
    expect(body).toMatch(/`reliable: false`/);
    expect(body).toMatch(/head-of-line blocking/i);
  });

  it('Slice 6 — documents the canonical modifier vocabulary + the harness-drops-DOM-names warning + the 3-SDK constant export locations', () => {
    expect(body).toMatch(/### Modifier vocabulary/);
    expect(body).toMatch(/`'cmd' \| 'ctrl' \| 'shift' \| 'option'`/);
    // W3C key-action modifiers is the primary mapping (genuine WebKit key
    // events); Quartz CGEventFlags is the legacy fallback. Wrap-tolerant.
    expect(body).toMatch(/W3C key-action modifiers/);
    expect(body).toMatch(/Quartz\s*`CGEventFlags`/);
    expect(body).toMatch(
      /DOM-standard names \(`Shift \/ Control \/ Alt \/ Meta`\) round-trip\s*\n?through the schema unchanged but the harness decoder drops them\./,
    );
    expect(body).toMatch(/TS SDK re-exports `CANONICAL_MODIFIER_NAMES`/);
    expect(body).toMatch(
      /Python SDK exports\s*\n?`CANONICAL_MODIFIER_NAMES` from `driftstack\.resources\.agent_sessions`/,
    );
    expect(body).toMatch(/Go SDK exports `driftstack\.CanonicalModifierNames`/);
  });

  it('recommends adaptiveStream + dynacast in the Room constructor', () => {
    expect(body).toMatch(/adaptiveStream:\s*true/);
    expect(body).toMatch(/dynacast:\s*true/);
  });

  it('documents the 24-hour token TTL + how to handle expiry', () => {
    expect(body).toMatch(/24-hour HS256 JWTs/);
    expect(body).toMatch(/mint a fresh\s+token/);
  });

  it('links to the gui-client reference implementation paths', () => {
    expect(body).toMatch(/apps\/gui-client\/src\/lib\/livekit\.ts/);
    expect(body).toMatch(/apps\/gui-client\/src\/components\/AgentSessionPanel\.tsx/);
    expect(body).toMatch(/apps\/gui-client\/src\/components\/LivekitConnectionBadge\.tsx/);
    expect(body).toMatch(/apps\/gui-client\/src\/lib\/livekit-input-capture\.ts/);
    expect(body).toMatch(/apps\/gui-client\/src\/lib\/livekit-latency-ping\.ts/);
  });

  it('cross-links to /api/agent-sessions reference', () => {
    expect(body).toMatch(/\/api\/agent-sessions\//);
  });

  it('reachable from the docs landing via the DOC_NAV Guides section (S22.5 2026-07-06: the landing renders section cards derived from DOC_NAV instead of a hand-kept card grid, so the guide is reachable iff its tree entry exists — pinned here in nav.ts, in lockstep with docs-data-nav-content-parity)', () => {
    const idx = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/index.astro'), 'utf8');
    expect(idx).toMatch(/import \{ DOC_NAV \} from '\.\.\/data\/nav';/);
    expect(idx).toMatch(/const sections = DOC_NAV\.map\(/);
    const nav = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/data/nav.ts'), 'utf8');
    expect(nav).toMatch(/\{ href: '\/guides\/live-video\/', label: 'Live video' \}/);
  });
});
