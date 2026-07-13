// W217.A — drift-guard for /docs/recordings. Recordings are a
// roadmap item (V-540): the endpoint, webhook event, and request
// body field documented before this pass do not exist. The page is
// now honest about that. This test fails if the page silently
// grows fictional claims back in.
//
// The test also stays green automatically once V-540 ships — at
// that point, the missing-endpoint / missing-event assertions will
// flip and force the doc to be unblocked, but the page must be
// updated alongside to clearly state recordings are now live.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'recordings.astro');
const ROUTES_DIR = join(REPO, 'apps', 'server', 'src', 'routes');
const SCHEMA_PATH = join(REPO, 'apps', 'server', 'src', 'db', 'schema.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function allRouteSources(): string {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(ROUTES_DIR, f), 'utf8'))
    .join('\n');
}

describe('W217.A recordings doc parity', () => {
  const doc = read(DOC_PATH);

  it('claims recordings are roadmap, not shipped — until the server registers the endpoint', () => {
    const routes = allRouteSources();
    const endpointShipped = /['"`]\/v1\/sessions\/[^'"]*\/recording['"`]/.test(routes);
    if (endpointShipped) {
      // Endpoint exists: doc must NOT still claim it's roadmap-only.
      expect(doc).not.toMatch(/Recordings are on the .* roadmap/i);
    } else {
      // Endpoint does NOT exist: doc must clearly call out
      // recordings as planned-not-live.
      expect(doc).toMatch(/roadmap/i);
      expect(doc, 'doc must call out the silent-strip footgun').toMatch(/no-op/i);
    }
  });

  it('session.recording_ready event is not claimed live unless it is in the enum', () => {
    const schema = read(SCHEMA_PATH);
    const enumBlock = schema.split("pgEnum('webhook_event_type', [")[1]?.split(']')[0] ?? '';
    const inEnum = enumBlock.includes("'session.recording_ready'");
    if (!inEnum) {
      // Doc must not write the event as a live, current-system event.
      // We tolerate the literal `session.recording_ready` string only
      // in the planned-feature section. So: assert the doc does not
      // demonstrate an actual subscribe + payload as if it were live
      // (the previous revision did exactly that).
      expect(doc).not.toMatch(/"events":\s*\[\s*"session\.recording_ready"\s*\]/);
      expect(doc).not.toMatch(/"type":\s*"session\.recording_ready"/);
    }
  });

  it('doc does not show a presigned playback_url example as if it were today', () => {
    // The previous doc demonstrated a real-looking 200 OK response
    // for a fictional endpoint, which an integrator would treat as
    // a contract.
    expect(doc).not.toMatch(/→ 200 OK[\s\S]{0,200}"playback_url":/);
  });

  it('doc cross-links Capture as the workable alternative today', () => {
    expect(doc).toMatch(/capture/i);
    expect(doc).toMatch(/\/docs\/sessions/);
  });

  it('doc separates the shipped desktop-local recorder from the unshipped managed API', () => {
    expect(doc).toMatch(/desktop app already offers a separate,\s+local recorder/);
    expect(doc).toMatch(/manual, local-only frame capture/);
    expect(doc).toMatch(
      /does not enable the\s+planned API field, webhook, WebM file, cloud upload, or retention\s+policy/,
    );
  });
});
