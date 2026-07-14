import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const body = readFileSync(
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/recordings.astro'),
  'utf8',
);

describe('/docs/recordings current product contract', () => {
  it('documents the desktop-local record, stop, replay, and export flow', () => {
    expect(body).toContain('<h1>Local session recordings</h1>');
    expect(body).toContain('Choose <strong>Record</strong>');
    expect(body).toContain('Choose <strong>Stop</strong>');
    expect(body).toContain('Open <strong>Recordings</strong> to replay or export it');
    expect(body).toContain('portable JSON envelope');
  });

  it('pins local persistence and lazy frame hydration', () => {
    expect(body).toContain('Active recordings are finalised when their provider closes');
    expect(body).toMatch(/index is\s+restored when the app starts/);
    expect(body).toMatch(/frame data is loaded only when a\s+recording is opened/);
  });

  it('documents the separate API capture contract', () => {
    expect(body).toContain('POST /v1/sessions/:id/capture');
    expect(body).toContain('screenshot, DOM snapshot, and PDF');
    expect(body).toContain('returned inline in the response');
    expect(body).toContain('href="/docs/sessions/"');
  });

  it('pins the storage boundary', () => {
    expect(body).toContain("Desktop recordings are local to the operator's machine");
    expect(body).toContain('They are not uploaded by the recording workflow');
    expect(body).toContain('not retained by the capture endpoint');
  });

  it('contains no managed-recording promise or aspirational integration shape', () => {
    expect(body).not.toMatch(/roadmap|planned|recording_ready|record: true|WebM|retention sketch/i);
  });
});
