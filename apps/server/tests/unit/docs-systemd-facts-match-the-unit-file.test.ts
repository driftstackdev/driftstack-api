// Operator docs must name the systemd unit and env file that actually exist.
//
// Two facts live in exactly one place — `infra/systemd/driftstack-api.service` — and both were
// wrong in the runbooks a human follows under pressure:
//
//   * `docs/runbooks/first-customer-day.md` Hour-0 told the operator to run
//     `journalctl -u driftstack-server -f`. There is no such unit. journalctl does NOT error on
//     an unknown unit — it blocks with zero output — so the first paying customer's first sixty
//     minutes were watched through a permanently blank window, and the V-494 plaintext-redaction
//     check assigned to that window could not be performed at all.
//   * `docs/deployment/dr-runbook.md` wrote the rotated `DATABASE_URL` / `REDIS_URL` to
//     `/opt/driftstack/.env`, but the unit reads `/opt/driftstack/api/.env`. The Redis step
//     `cat`s the wrong path, seds the (missing) content and scps the result back, then restarts.
//     The restart exits 0 and the service comes back on the OLD credential — a silent no-op in
//     the middle of a disaster-recovery rotation.
//
// The same doc also said `systemctl reload`, which is invalid under any name: the unit declares
// no `ExecReload=`, and the process only handles SIGTERM/SIGINT.
//
// DERIVED, not pinned: both facts are read out of the unit file, so renaming the unit or moving
// its EnvironmentFile fails here rather than silently invalidating every runbook.
//
// Deliberately narrow matching: `driftstack-server` is a legitimate SENTRY PROJECT SLUG
// (`scripts/sentry-create-per-service-projects.mjs`, and correctly pinned in
// docs/runbooks/observability.md). Only tokens following `journalctl -u` or `systemctl <verb>`
// are unit names, so the bare word is never matched.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SYSTEMD_DIR = resolve(REPO_ROOT, 'infra/systemd');

/** Operator-facing procedure docs. `docs/internal/` is historical record, not procedure. */
const DOC_DIRS = ['docs/runbooks', 'docs/deployment', 'docs/operations'] as const;

interface Unit {
  readonly name: string;
  readonly envFile: string | null;
  readonly hasReload: boolean;
}

function units(): Unit[] {
  if (!existsSync(SYSTEMD_DIR))
    throw new Error(
      `walk root is missing: ${SYSTEMD_DIR} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  return readdirSync(SYSTEMD_DIR)
    .filter((f) => f.endsWith('.service'))
    .map((f) => {
      const body = readFileSync(join(SYSTEMD_DIR, f), 'utf8');
      return {
        name: f.replace(/\.service$/, ''),
        envFile: /^EnvironmentFile=(.+)$/m.exec(body)?.[1]?.trim() ?? null,
        hasReload: /^ExecReload=/m.test(body),
      };
    });
}

function procedureDocs(): string[] {
  const out: string[] = [];
  for (const dir of DOC_DIRS) {
    const abs = resolve(REPO_ROOT, dir);
    if (!existsSync(abs))
      throw new Error(
        `walk root is missing: ${abs} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
      );
    for (const f of readdirSync(abs)) if (f.endsWith('.md')) out.push(join(abs, f));
  }
  return out;
}

describe('operator docs match the systemd unit that exists', () => {
  const found = units();
  const docs = procedureDocs();

  it('CRITICAL the unit file and the doc set were both read. Deriving from an empty unit list would make every check below vacuously true, which is how the wrong unit name survived in the first place.', () => {
    expect(found.length, '*.service files under infra/systemd').toBeGreaterThan(0);
    expect(found.map((u) => u.name)).toContain('driftstack-api');
    expect(docs.length, 'operator procedure docs scanned').toBeGreaterThan(10);
    const api = found.find((u) => u.name === 'driftstack-api');
    expect(api?.envFile, 'the unit must declare where it reads env from').toBe(
      '/opt/driftstack/api/.env',
    );
  });

  it('CRITICAL every `journalctl -u X` / `systemctl <verb> X` in an operator doc names a real unit — journalctl does not error on an unknown unit, it blocks with no output, so a wrong name is an invisible failure exactly when someone is watching for one', () => {
    const known = new Set(found.map((u) => u.name));
    // Third-party units an operator legitimately drives on the same box.
    const EXTERNAL = new Set(['nginx', 'postgresql', 'redis', 'redis-server', 'docker']);
    const bad: string[] = [];
    for (const doc of docs) {
      const rel = doc.slice(REPO_ROOT.length + 1);
      const body = readFileSync(doc, 'utf8');
      for (const m of body.matchAll(
        /(?:journalctl\s+-u|systemctl\s+(?:reload|restart|start|stop|status|enable|disable))\s+([a-z][a-z0-9-]*)/g,
      )) {
        const unit = m[1]!;
        if (known.has(unit) || EXTERNAL.has(unit)) continue;
        bad.push(`${rel}: "${m[0]}" — no infra/systemd/${unit}.service`);
      }
    }
    expect(bad.sort(), 'operator doc(s) naming a systemd unit that does not exist:').toEqual([]);
  });

  it('CRITICAL no operator doc tells the operator to `systemctl reload` a unit that declares no ExecReload — reload on such a unit fails, and the doc promised it as the way to pick up a rotated secret', () => {
    const byName = new Map(found.map((u) => [u.name, u]));
    const bad: string[] = [];
    for (const doc of docs) {
      const body = readFileSync(doc, 'utf8');
      for (const m of body.matchAll(/systemctl\s+reload\s+([a-z][a-z0-9-]*)/g)) {
        const unit = byName.get(m[1]!);
        if (unit === undefined) continue; // external unit; covered by the check above
        if (!unit.hasReload) {
          bad.push(`${doc.slice(REPO_ROOT.length + 1)}: reload ${unit.name} (no ExecReload=)`);
        }
      }
    }
    expect(bad.sort(), 'doc(s) prescribing an unsupported reload:').toEqual([]);
  });

  it('CRITICAL every env-file path in an operator doc is the one the unit actually reads — writing a rotated credential to the wrong path restarts clean and comes back on the old secret, which is the worst possible outcome mid-rotation', () => {
    const envFiles = new Set(found.map((u) => u.envFile).filter((p): p is string => p !== null));
    const bad: string[] = [];
    for (const doc of docs) {
      const rel = doc.slice(REPO_ROOT.length + 1);
      for (const m of readFileSync(doc, 'utf8').matchAll(
        /\/opt\/driftstack[A-Za-z0-9._/-]*\.env/g,
      )) {
        if (envFiles.has(m[0])) continue;
        bad.push(`${rel}: ${m[0]} — the unit reads ${[...envFiles].join(', ')}`);
      }
    }
    expect(bad.sort(), 'operator doc(s) citing an env path the unit never reads:').toEqual([]);
  });
});
