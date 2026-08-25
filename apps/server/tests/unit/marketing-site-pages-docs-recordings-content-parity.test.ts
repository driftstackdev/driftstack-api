// W507.A — drift guard for the current recording and capture surfaces.
// Public docs must describe only the desktop-local recorder and API capture
// endpoint; speculative managed-recording endpoints and events stay absent.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/recordings.astro');

describe('W507.A apps/marketing-site/src/pages/docs/recordings.astro content parity', () => {
  const body = readFileSync(LIB, 'utf8');

  it('documents the live desktop-local recording workflow', () => {
    expect(body).toMatch(/<h1>Local session recordings<\/h1>/);
    expect(body).toMatch(/streamed frames from a live,\s*hands-on session for local replay/);
    expect(body).toMatch(/Choose <strong>Record<\/strong> while the stream is connected/);
    expect(body).toMatch(/Open <strong>Recordings<\/strong> to replay or export it/);
    expect(body).toMatch(/portable JSON envelope/);
  });

  it('documents the live API capture kinds and response ownership', () => {
    expect(body).toMatch(/<code>POST \/v1\/sessions\/:id\/capture<\/code>/);
    expect(body).toMatch(/screenshot, DOM snapshot, and PDF captures/);
    expect(body).toMatch(
      /Capture bytes are\s*returned inline in the response for your application to store/,
    );
  });

  it('pins the recording and capture storage boundary', () => {
    expect(body).toMatch(/Desktop recordings are local to the operator's machine/);
    expect(body).toMatch(/They are not uploaded by the recording workflow/);
    expect(body).toMatch(
      /API captures are returned directly and are not retained by the capture endpoint/,
    );
  });

  it('contains no speculative managed-recording contract', () => {
    expect(body).not.toMatch(/roadmap|work-in-progress|until the feature ships/i);
    expect(body).not.toMatch(/recording_ready|\/recording\b|"record"\s*:\s*true/);
  });

  it('routes support through the current support address', () => {
    expect(body).toMatch(/mailto:support@driftstack\.dev/);
  });

  it('exists at its canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
