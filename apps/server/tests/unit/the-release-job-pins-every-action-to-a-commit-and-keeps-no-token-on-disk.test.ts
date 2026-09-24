// Security sweep E-10 (2026-09-24) — the GUI release job holds the updater signing
// key and a contents:write token, and the GitHub release it writes IS the updater
// endpoint: a signed build plus write access there reaches every installed client.
// It ran third-party actions pinned to movable refs (a branch and two major tags),
// and its checkout left the token in .git/config for every later step, including
// dependency install scripts. A tag or branch can be moved by its owner; a commit
// SHA cannot. Every `uses:` in the release workflow is pinned to a full SHA, and the
// checkout does not persist credentials (every step that needs the token takes it
// from env).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, '..', '..', '..', '..', '.github', 'workflows', 'gui-release.yml');
const body = readFileSync(WORKFLOW, 'utf8');

describe('the release job pins every action to a commit and keeps no token on disk', () => {
  const uses = [...body.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]!);

  it('reads the workflow it guards — at least the five actions the job runs', () => {
    expect(uses.length).toBeGreaterThanOrEqual(5);
  });

  it('CRITICAL every action is pinned to a full 40-hex commit SHA, never a tag or branch', () => {
    const movable = uses.filter((u) => !u.startsWith('./') && !/@[0-9a-f]{40}$/.test(u));
    expect(movable).toEqual([]);
  });

  it('CRITICAL the checkout does not persist the token for later steps', () => {
    expect(body).toMatch(
      /uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+persist-credentials:\s*false/,
    );
  });
});
