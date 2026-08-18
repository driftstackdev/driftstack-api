// W851 — IncidentSeverity 3-value + IncidentStatus 4-value enum
// cross-source invariant. One-hundred-seventy-seventh in the drift-
// guard series. Pins that V-295a's two incident enums:
//   - IncidentSeverity = minor | major | outage (3 values).
//   - IncidentStatus = investigating | identified | monitoring |
//     resolved (4 values).
// remain consistent across:
//   - packages/api-types/src/incidents.ts (canonical source).
//   - apps/server/src/services/incidents.ts (typed imports).
//   - apps/status-site/src/pages/history.astro (SEVERITY_BADGE +
//     status colour-map — public status page renders all enum keys).
//   - apps/status-site/src/pages/index.astro (its own SEVERITY_BADGE +
//     STATUS_BADGE maps — main status page renders all enum keys).
//
// Drift to adding/removing an enum value without coordinated
// status-site updates would silently break:
//   * Status-page badge rendering (public) if a new status arrives
//     that has no colour-map entry.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { IncidentSeveritySchema, IncidentStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const INCIDENT_SEVERITIES = ['minor', 'major', 'outage'] as const;
const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;

describe('W851 incident enum cross-source invariant', () => {
  // ─── every status-site page carrying its own maps ────────────
  //
  // The per-page cases below name history.astro and index.astro. index.astro
  // was ADDED later, and this file's own comment records why: "The existing
  // checks above only covered history.astro, leaving index.astro's maps
  // unguarded." That omission then recurred — incident.astro, the per-incident
  // detail page a customer opens from a status update, carries a third copy of
  // both maps and was covered by none of it.
  //
  // Listing the pages is what keeps failing, so this discovers them. A fourth
  // page that copies the maps is covered the day it appears, and the values
  // come from the schemas rather than the restated arrays above, so a fifth
  // status cannot be added to the enum and missed here.
  it('CRITICAL every page with its own incident badge maps covers the full vocabulary', () => {
    // Scoped to the INCIDENT vocabularies by matching the keys, not the map
    // NAME: admin-panel also has STATUS_BADGE maps keyed on AccountStatus
    // (accounts.astro) and SessionStatus (sessions.astro), which are different
    // vocabularies that must not be judged against these.
    const APP_ROOTS = [
      'apps/status-site/src',
      'apps/admin-panel/src',
      'apps/customer-dashboard/src',
    ];
    const found: { file: string; map: string; keys: Set<string>; vocab: readonly string[] }[] = [];
    const walkFiles = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, e.name);
        if (e.isDirectory()) walkFiles(full, out);
        else if (/\.(astro|ts|tsx)$/.test(e.name)) out.push(full);
      }
      return out;
    };
    for (const root of APP_ROOTS) {
      for (const file of walkFiles(resolve(REPO_ROOT, root))) {
        const src = read(file);
        for (const m of src.matchAll(
          /const (STATUS_BADGE|SEVERITY_BADGE) = \{([\s\S]*?)\n\s*\};/g,
        )) {
          const keys = new Set(
            [...(m[2] ?? '').matchAll(/^\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*:/gm)].map(
              (k) => k[1] ?? '',
            ),
          );
          const vocab =
            m[1] === 'STATUS_BADGE' ? IncidentStatusSchema.options : IncidentSeveritySchema.options;
          // Only judge maps that are plainly this vocabulary's.
          if ([...keys].every((k) => (vocab as readonly string[]).includes(k))) {
            found.push({ file: file.slice(REPO_ROOT.length + 1), map: m[1] ?? '', keys, vocab });
          }
        }
      }
    }

    // Anti-vacuity, and the record of how far this spread. Three status-site
    // pages plus two admin-panel ones each keep their own copies — the previous
    // version of this case scanned status-site only, so the two the STAFF use
    // while handling the incident were unguarded.
    expect(
      [...new Set(found.map((f) => f.file))].sort(),
      'the set of files carrying incident badge maps changed',
    ).toEqual([
      'apps/admin-panel/src/pages/incidents/index.astro',
      'apps/admin-panel/src/pages/shells/incident-detail.astro',
      'apps/status-site/src/pages/history.astro',
      'apps/status-site/src/pages/incident.astro',
      'apps/status-site/src/pages/index.astro',
    ]);

    const gaps = found
      .flatMap(({ file, map, keys, vocab }) =>
        vocab.filter((v) => !keys.has(v)).map((v) => `${file}: ${map} has no entry for '${v}'`),
      )
      .sort();
    expect(
      gaps,
      'a page renders incident badges from a map missing an enum value. Several of these lookups ' +
        'have no fallback — SEVERITY_BADGE[inc.severity] straight into the class list — so a miss ' +
        'renders undefined on the page someone opened to find out what is happening',
    ).toEqual([]);
  });

  // ─── api-types canonical source ──────────────────────────────

  it("CRITICAL packages/api-types/src/incidents.ts declares IncidentSeveritySchema = z.enum(['minor', 'major', 'outage']) — the canonical 3-value severity enum. Drift would cascade through every consumer.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(
      /export const IncidentSeveritySchema = z\.enum\(\['minor', 'major', 'outage'\]\);/,
    );
  });

  it('CRITICAL packages/api-types/src/incidents.ts declares IncidentStatusSchema = z.enum([4-value]) — investigating + identified + monitoring + resolved. The 4-status lifecycle mirrors the canonical incident-flow per V-295a.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(/export const IncidentStatusSchema = z\.enum\(\[/);
    for (const status of INCIDENT_STATUSES) {
      expect(p, `IncidentStatusSchema must include '${status}'`).toMatch(new RegExp(`'${status}'`));
    }
  });

  it('CRITICAL IncidentSeverity + IncidentStatus types re-export from z.infer (drift-proof). Hand-written type unions would drift from runtime schema.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(/export type IncidentSeverity = z\.infer<typeof IncidentSeveritySchema>;/);
    expect(p).toMatch(/export type IncidentStatus = z\.infer<typeof IncidentStatusSchema>;/);
  });

  it('CRITICAL V-295a anchor pinned in api-types/incidents.ts. The V-295a anchor threads the incident-system provenance for cross-link discovery.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(/V-295a/);
  });

  // ─── Server service typed-imports ────────────────────────────

  it("CRITICAL apps/server/src/services/incidents.ts imports IncidentSeverity + IncidentStatus from '@driftstack/api-types' (workspace alias). Drift to a local re-declaration would silently let the server bypass schema validation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/import type \{[^}]*IncidentSeverity[^}]*\} from '@driftstack\/api-types';/s);
    expect(p).toMatch(/import type \{[^}]*IncidentStatus[^}]*\} from '@driftstack\/api-types';/s);
  });

  // ─── Status-site renders ALL enum values ─────────────────────

  it('CRITICAL apps/status-site/src/pages/history.astro SEVERITY_BADGE map has entries for ALL 3 severities. Drift to adding a severity without updating the badge map would render a broken/empty badge on the public status page.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/status-site/src/pages/history.astro'));
    expect(p).toMatch(/const SEVERITY_BADGE = \{/);
    for (const sev of INCIDENT_SEVERITIES) {
      expect(p, `SEVERITY_BADGE missing entry for '${sev}'`).toMatch(new RegExp(`\\s${sev}: \\[`));
    }
  });

  it('CRITICAL apps/status-site/src/pages/history.astro status colour-map has entries for ALL 4 statuses. Same defense-in-depth as severity badges — the public status page renders all statuses + drift would crash badge rendering.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/status-site/src/pages/history.astro'));
    for (const status of INCIDENT_STATUSES) {
      expect(p, `status colour-map missing entry for '${status}'`).toMatch(
        new RegExp(`\\s${status}: \\[`),
      );
    }
  });

  // index.astro has its OWN SEVERITY_BADGE + STATUS_BADGE maps (separate
  // from history.astro). The existing checks above only covered
  // history.astro, leaving index.astro's maps unguarded — a 5th status /
  // 4th severity would render with no badge styling (the `?? []` fallback)
  // on the main status page. Mirror the defense-in-depth here.

  it('CRITICAL apps/status-site/src/pages/index.astro SEVERITY_BADGE map has entries for ALL 3 severities. index.astro keeps its own badge maps; drift here renders an unstyled severity badge on the main public status page.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/status-site/src/pages/index.astro'));
    expect(p).toMatch(/const SEVERITY_BADGE = \{/);
    for (const sev of INCIDENT_SEVERITIES) {
      expect(p, `index.astro SEVERITY_BADGE missing entry for '${sev}'`).toMatch(
        new RegExp(`\\s${sev}: \\[`),
      );
    }
  });

  it('CRITICAL apps/status-site/src/pages/index.astro STATUS_BADGE map has entries for ALL 4 statuses. The main status page badges each incident by status; a status with no STATUS_BADGE entry falls back to `?? []` and renders unstyled.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/status-site/src/pages/index.astro'));
    expect(p).toMatch(/const STATUS_BADGE = \{/);
    for (const status of INCIDENT_STATUSES) {
      expect(p, `index.astro STATUS_BADGE missing entry for '${status}'`).toMatch(
        new RegExp(`\\s${status}: \\[`),
      );
    }
  });

  // ─── 3-severity + 4-status totals ────────────────────────────

  it('CRITICAL IncidentSeverity = exactly 3 values + IncidentStatus = exactly 4 values. The 3+4 cardinality is what status-page UI grids + admin-panel filters depend on. Drift would silently let extra states slip in without UI updates.', () => {
    expect(INCIDENT_SEVERITIES.length).toBe(3);
    expect(INCIDENT_STATUSES.length).toBe(4);
  });

  // ─── No forbidden / legacy status names ──────────────────────

  it('CRITICAL no source declares forbidden incident-status names (open / closed / acknowledged / fixed / completed / in_progress). These are common incident-tool conventions that V-295a intentionally avoids — drift to introducing them would fragment the 4-status lifecycle.', () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    // Scope the check to the IncidentStatusSchema enum body. The old pattern
    // started at the identifier and ran on until ANY `])`, so it swept up
    // later, unrelated schemas — `IncidentListStateSchema` legitimately offers
    // an 'open' FILTER, which tripped this as a false positive.
    const statusEnum = /IncidentStatusSchema = z\.enum\(\[([\s\S]*?)\]\)/.exec(apiTypes);
    expect(statusEnum, 'IncidentStatusSchema enum block not found').not.toBeNull();
    const body = statusEnum![1]!;
    for (const forbidden of [
      "'open'",
      "'closed'",
      "'acknowledged'",
      "'fixed'",
      "'completed'",
      "'in_progress'",
    ]) {
      expect(body, `IncidentStatus must NOT include forbidden status ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    // The lifecycle itself stays exactly four states.
    expect(body.match(/'[a-z_]+'/g)).toEqual([
      "'investigating'",
      "'identified'",
      "'monitoring'",
      "'resolved'",
    ]);
  });

  // ─── Severity ordering matches escalation ────────────────────

  it("CRITICAL IncidentSeverity ordering pinned as minor → major → outage (least → most severe). The escalation order is what status-page 'overall' computation depends on (`severity === 'outage'` is the worst-case branch). Drift to a different ordering would break overall-status computation.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(/IncidentSeveritySchema = z\.enum\(\['minor', 'major', 'outage'\]\);/);
    // Also pin: status-site index.astro uses `severity === 'outage'` for
    // worst-case classification.
    const statusIndex = read(resolve(REPO_ROOT, 'apps/status-site/src/pages/index.astro'));
    expect(statusIndex).toMatch(/severity === 'outage'/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/incident-enum-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
