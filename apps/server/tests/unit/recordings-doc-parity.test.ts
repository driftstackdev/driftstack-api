// W217.A — drift guard for /docs/recordings. The shipped desktop
// recorder is local-only; the API separately offers inline capture.
// This test prevents either surface from being presented as a
// fictional managed recording API.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'recordings.astro');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W217.A recordings doc parity', () => {
  const doc = read(DOC_PATH);

  it('documents the shipped desktop-local recording workflow', () => {
    expect(doc).toMatch(/<h1>Local session recordings<\/h1>/);
    expect(doc).toMatch(
      /record the streamed frames from a live,\s+hands-on session for local replay/,
    );
    expect(doc).toMatch(/recording stays in the app's local\s+data directory/);
    expect(doc).toMatch(/exported as a portable JSON envelope/);
  });

  it('pins the operator steps and lazy playback restoration', () => {
    expect(doc).toMatch(/Open a live session in the Simulator/);
    expect(doc).toMatch(/Choose <strong>Record<\/strong>/);
    expect(doc).toMatch(/Choose <strong>Stop<\/strong>/);
    expect(doc).toMatch(/Open <strong>Recordings<\/strong> to replay or export it/);
    expect(doc).toMatch(/frame data is loaded only when a\s+recording is opened for playback/);
  });

  it('does not claim a managed recording endpoint or webhook', () => {
    expect(doc).not.toMatch(/session\.recording_ready|playback_url|\/recording/);
    expect(doc).not.toMatch(/roadmap|no-op/i);
  });

  it('documents the live inline API capture endpoint', () => {
    expect(doc).toMatch(/POST \/v1\/sessions\/:id\/capture/);
    expect(doc).toMatch(/screenshot, DOM snapshot, and PDF captures/);
    expect(doc).toMatch(/returned inline in the response/);
    expect(doc).toMatch(/\/docs\/sessions/);
  });

  it('pins the storage boundary', () => {
    expect(doc).toMatch(/Desktop recordings are local to the operator's machine/);
    expect(doc).toMatch(/They are not uploaded by the recording workflow/);
    expect(doc).toMatch(/API captures are returned directly and are not retained/);
  });
});
