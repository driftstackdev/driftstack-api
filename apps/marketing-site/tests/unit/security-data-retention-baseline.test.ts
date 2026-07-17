// W333.B — drift guard for /security session-content-handling pillar.
// Pins the load-bearing privacy framing:
//   • Live media is transport-encrypted, processed by LiveKit, and
//     dropped at session end
//   • Support access requires explicit customer authorization
//   • Capture artifacts are inline/non-retained; recordings stay local
//   • Self-hosted: even metadata stays inside the customer network

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/security.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W333.B /security session-content-handling pillar', () => {
  const body = read(PAGE);

  it('headline scopes non-retention to live media, not every session record', () => {
    expect(body).toMatch(/Live-session media is not retained by default/i);
    expect(body).toMatch(/Session\s+metadata and agent transcripts follow/i);
    expect(body).not.toMatch(/Session content is not retained by default/i);
    expect(body).not.toMatch(/Nobody at Driftstack can watch your sessions/i);
    expect(body).not.toMatch(/Driftstack staff cannot read your sessions/i);
  });

  it('names the exact live-media processing and retention boundary', () => {
    expect(body).toMatch(/[Cc]ontrol plane[\s\S]{0,80}metadata/);
    expect(body).toMatch(/processed through LiveKit/i);
    expect(body).toMatch(/dropped\s+when the session ends/i);
  });

  it('states the executable absence of an administrative staff join path', () => {
    expect(body).toMatch(/no administrative\s+path for Driftstack staff to join/i);
    expect(body).not.toMatch(/support can join/i);
  });

  it('states the exact Capture and desktop-recording boundaries', () => {
    expect(body).toMatch(/screenshots/i);
    expect(body).toMatch(/DOM\s+snapshots/i);
    expect(body).toMatch(/not retained by the Capture endpoint/i);
    expect(body).toMatch(/recordings stay on the customer's device/i);
    expect(body).not.toMatch(/none of it ever reaches our servers/i);
  });

  it('self-hosted: only license-validity heartbeats reach the control plane', () => {
    expect(body).toMatch(/license-validity heartbeats/i);
  });
});
