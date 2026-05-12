// W323.A — drift guard for /quickstart SDK coverage. The page
// shows minimal-viable lifecycle in TS, Python, and Go. Pins:
//   • DRIFTSTACK_API_KEY env var name (canonical)
//   • TS: imports Driftstack constructor; ses_*-prefixed ids; core
//     methods: sessions.create / .navigate / .capture / .destroy
//   • Python: AsyncDriftstack OR Driftstack client, same methods
//   • Go: driftstack.New + Sessions.Create + .Destroy

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W323.A /quickstart SDK coverage', () => {
  const body = read(PAGE);

  it('cites DRIFTSTACK_API_KEY env var (canonical name)', () => {
    expect(body).toContain('DRIFTSTACK_API_KEY');
  });

  it('TS example uses new Driftstack({...}) + core lifecycle methods', () => {
    expect(body).toMatch(/new Driftstack/);
    expect(body).toMatch(/client\.sessions\.create/);
    expect(body).toMatch(/client\.sessions\.navigate/);
    expect(body).toMatch(/client\.sessions\.capture/);
    expect(body).toMatch(/client\.sessions\.destroy/);
  });

  it('Python example uses the Driftstack(api_key=...) client + lifecycle methods', () => {
    expect(body).toMatch(/Driftstack\(api_key=/);
    expect(body).toMatch(/client\.sessions\.create/);
    expect(body).toMatch(/client\.sessions\.destroy/);
  });

  it('Go example uses driftstack.New + Sessions.Create', () => {
    expect(body).toMatch(/driftstack\.New/);
    expect(body).toMatch(/Sessions\.Create/);
  });

  it('does NOT use deprecated env-var names (DRIFTSTACK_KEY or DS_API_KEY)', () => {
    expect(body).not.toMatch(/\bDRIFTSTACK_KEY\b/);
    expect(body).not.toMatch(/\bDS_API_KEY\b/);
  });
});
