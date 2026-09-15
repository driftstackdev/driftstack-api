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
    // 2026-09-15 plain-language pass: "metadata ... follow their documented
    // retention periods" -> "records ... are kept for their documented
    // retention periods"; same scoping, customer words.
    expect(body).toMatch(
      /Session\s+records and agent transcripts are kept\s+for their documented retention/i,
    );
    expect(body).not.toMatch(/Session content is not retained by default/i);
    expect(body).not.toMatch(/Nobody at Driftstack can watch your sessions/i);
    expect(body).not.toMatch(/Driftstack staff cannot read your sessions/i);
  });

  it('names the exact live-media processing and retention boundary', () => {
    // 2026-09-15: "control plane" is banned on customer surfaces; the
    // same metadata-only boundary now reads "Driftstack keeps license
    // details, session records (id, status, timestamps)". The LiveKit
    // vendor name moved to the sub-processor register; the page keeps
    // the encrypted-in-transit + dropped-at-end boundary.
    expect(body).toMatch(
      /Driftstack keeps license details, session records \(id, status,\s+timestamps\)/,
    );
    expect(body).toMatch(/encrypted in transit, used to deliver the session to you/i);
    expect(body).toMatch(/dropped\s+when the session ends/i);
    expect(body).not.toMatch(/[Cc]ontrol plane/);
  });

  it('states the executable absence of an administrative staff join path', () => {
    expect(body).toMatch(
      /Driftstack staff have no\s+built-in way to join a customer's live session/i,
    );
    expect(body).not.toMatch(/support can join/i);
    expect(body).not.toMatch(/staff have no way to join/i); // "built-in" is the honest scope
  });

  it('states the exact Capture and desktop-recording boundaries', () => {
    expect(body).toMatch(/screenshots/i);
    expect(body).toMatch(/page\s+snapshots/i);
    expect(body).toMatch(/returned directly in\s+the API response and are not stored/i);
    expect(body).toMatch(/recordings stay\s+on your own computer and are not uploaded/i);
    expect(body).not.toMatch(/none of it ever reaches our servers/i);
  });

  it('self-hosted: only license-validity check-ins reach our servers', () => {
    expect(body).toMatch(/even session records stay inside your network/i);
    expect(body).toMatch(
      /only periodic "is this license still valid\?" check-ins reach\s+our servers/i,
    );
  });
});
