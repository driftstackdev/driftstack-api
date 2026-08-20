// V-1175 — a command in a fenced block is something a reader pastes into a terminal. It has
// to exist.
//
// `every-runbook-path-resolves` (V-1141/V-1145) established this for repo PATHS cited in
// documentation. Commands were never covered, and they fail worse: a broken path produces
// "no such file" against something the reader can go look for, while a broken npm script
// produces `npm error Missing script` — which reads, to a new developer, as their own
// environment being wrong.
//
// One was broken. `docs/onboarding-for-future-developers.md` told a new developer to run:
//
//     npm run dump-openapi --workspace apps/server > openapi.json
//
// `apps/server` has no `dump-openapi` script — its scripts are build, dev, start, pretest,
// test, test:e2e, typecheck, db:migrate, db:seed. Verified by running it: `npm error Missing
// script`. And the line was wrong a second time, independently: `dump-openapi.ts` takes an
// output PATH argument and writes the file itself with `writeFile`, printing where it put it.
// The `> openapi.json` redirect would have captured an empty file even if the script had
// existed — and the aside underneath ("Or wherever your shell wants the redirect") taught the
// misconception a second time. The corrected command was run before being written down: it
// produces a 2.0 MB OpenAPI 3.1.0 document with 196 paths.
//
// ── Scope, corrected in V-1178: fenced blocks were not the whole instruction surface ──
//
// This originally covered fenced blocks ONLY, reasoning that you cannot paste a sentence into
// a shell and that documentation legitimately DISCUSSES commands. The second half of that is
// right; the first half drew the line in the wrong place.
//
// `docs/runbooks/self-hosted-mac-local.md` carries a six-row TABLE of
// `| Surface | Command | URL |` — `npm run dev:dashboard` → `http://localhost:5173` — and that
// is an instruction by any reading. It is also invisible to a fenced-block scan. Measured:
// **42** backticked `npm run` citations sit outside fenced blocks against **28** inside, so
// the larger half of the population was the unguarded half.
//
// So inline backticked commands are checked too, against the ROOT scripts (prose carries no
// `cd` context to resolve against). Backticking is not by itself a claim of runnability, which
// is why the two genuinely descriptive cases are exempted BY NAME with their reasons rather
// than by widening the pattern until they pass. Both were verified at the citation site, and
// an arm below fails if either stops being descriptive — an allowlist nobody rechecks stops
// meaning "reviewed" and starts meaning "ignored".
//
// ── `cd` is tracked, because ignoring it manufactures findings ──────────────
//
// `npm run tauri build` is not a root script, and three blocks run it — each after
// `cd apps/gui-client`, which makes it correct. A first version of this scan reported all
// three as broken. A second still reported the Windows one, because that block says
// `cd apps\gui-client` with a backslash. Both were the scanner, not the docs. The working
// directory is now resolved from the last `cd` in the same block, separator-normalised, and
// the arm below asserts that `tauri` is a gui-client script and NOT a root one — so if the
// tracking is ever dropped, this fails on the reason rather than on the symptom.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

interface Manifest {
  name?: string;
  scripts?: Record<string, string>;
}

const scriptsOf = (rel: string): Set<string> =>
  new Set(Object.keys((JSON.parse(read(rel)) as Manifest).scripts ?? {}));

/** `npm --workspace` accepts EITHER the package name OR its directory, so both are keys. */
function workspaceScripts(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(resolve(REPO_ROOT, group))) {
      const dir = `${group}/${entry}`;
      const manifest = `${dir}/package.json`;
      if (!existsSync(resolve(REPO_ROOT, manifest))) continue;
      const scripts = scriptsOf(manifest);
      out.set(dir, scripts);
      const name = (JSON.parse(read(manifest)) as Manifest).name;
      if (name !== undefined) out.set(name, scripts);
    }
  }
  return out;
}

/**
 * Instruction surfaces. The verification log and dated session notes are HISTORY — a command
 * that was correct when written is not a defect now, the same rule V-1145 applied to paths.
 */
const HISTORY = /(?:^|\/)(?:verification-log\.md|MEMORY.*\.md)$|\/\d{4}-\d{2}-\d{2}-/;

function instructionPages(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(resolve(REPO_ROOT, rel))) {
      const child = `${rel}/${entry}`;
      if (statSync(resolve(REPO_ROOT, child)).isDirectory()) walk(child);
      else if (/\.mdx?$/.test(entry) && !HISTORY.test(child)) out.push(child);
    }
  };
  for (const root of ['docs', 'apps/docs/src/pages', 'apps/marketing-site/src/pages']) walk(root);
  return out;
}

const FENCE = /```\w*\n([\s\S]*?)```/g;
const WS_FLAG = String.raw`(?:-w|--workspace)(?:=|\s+)([@\w./-]+)`;
const NPM_RUN = new RegExp(
  String.raw`(?:npm|pnpm|yarn)\s+run\s+(?:${WS_FLAG}\s+)?([a-zA-Z0-9:_-]+)(?:\s+${WS_FLAG})?`,
  'g',
);
const SCRIPT_PATH =
  /\b(?:npx\s+tsx|tsx|node|bash|sh)\s+((?:apps|packages|scripts|operations)\/[\w./-]+\.(?:ts|mjs|js|sh))/g;
const CD = /^\s*cd\s+([\w./\\@-]+)/gm;

/** Backticked `npm run <script>` outside any fenced block — runbook tables, checklists. */
const INLINE = /`(?:npm|pnpm|yarn) run ([a-zA-Z0-9:_-]+)[^`]*`/g;
const FENCED_BLOCK = /```[\s\S]*?```/g;

/**
 * Inline citations that DESCRIBE a command rather than instruct you to run it. Each was read
 * at its citation site; the arm below re-checks that the reason still holds, because an
 * allowlist nobody rechecks stops meaning "reviewed" and starts meaning "ignored".
 */
const DESCRIPTIVE: ReadonlyMap<string, string> = new Map([
  [
    'docs/gui-client/audit-current-state.md::tauri:dev',
    "a status page for the gui-client listing that package's own scripts and what each opens",
  ],
  [
    'docs/proposals/td-002-drizzle-kit-reinstatement.md::drizzle:generate',
    'a proposal asking for this script to be CREATED — it is meant not to exist yet',
  ],
]);

interface Cited {
  page: string;
  command: string;
  script: string;
  workspace: string | undefined;
  cwd: string;
}

/** The working directory a command runs in: whatever the last `cd` above it in the block set. */
function cwdBefore(block: string, at: number): string {
  let cwd = '';
  for (const m of block.matchAll(CD)) {
    if (m.index < at) cwd = (m[1] ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }
  return cwd;
}

function citations(): { npm: Cited[]; paths: Cited[]; inline: Cited[] } {
  const npm: Cited[] = [];
  const paths: Cited[] = [];
  const inline: Cited[] = [];
  for (const page of instructionPages()) {
    // Inline citations are read from the page with fenced blocks stripped, so a command
    // never counts twice.
    for (const m of read(page).replace(FENCED_BLOCK, '').matchAll(INLINE)) {
      inline.push({
        page,
        command: m[0].replace(/`/g, '').trim(),
        script: m[1] ?? '',
        workspace: undefined,
        cwd: '',
      });
    }
    for (const block of read(page).matchAll(FENCE)) {
      const body = block[1] ?? '';
      for (const m of body.matchAll(NPM_RUN)) {
        npm.push({
          page,
          command: m[0].trim(),
          script: m[2] ?? '',
          workspace: m[1] ?? m[3],
          cwd: cwdBefore(body, m.index),
        });
      }
      for (const m of body.matchAll(SCRIPT_PATH)) {
        paths.push({
          page,
          command: m[0].trim(),
          script: m[1] ?? '',
          workspace: undefined,
          cwd: cwdBefore(body, m.index),
        });
      }
    }
  }
  return { npm, paths, inline };
}

describe('V-1175 every command the docs tell you to run exists', () => {
  it('CRITICAL the script inventories and the citation scan both come back non-empty, and `cd` is still being tracked. An empty inventory reports every command broken; a scan that matched nothing reports every command fine. The `tauri` assertion is the load-bearing one: three blocks run it only because they `cd apps/gui-client` first, so if directory tracking is dropped this fails on the reason rather than on the symptom.', () => {
    const root = scriptsOf('package.json');
    const ws = workspaceScripts();
    expect(root.size, 'no root scripts parsed').toBeGreaterThan(20);
    expect(ws.size, 'no workspace manifests parsed').toBeGreaterThan(10);

    // The exact shape that made a naive scan report three false findings.
    expect(
      ws.get('apps/gui-client')?.has('tauri'),
      '`tauri` is no longer a gui-client script',
    ).toBe(true);
    expect(
      root.has('tauri'),
      '`tauri` became a root script — the cd case no longer proves anything',
    ).toBe(false);

    const { npm, paths } = citations();
    expect(npm.length, 'no npm-run commands extracted from fenced blocks').toBeGreaterThan(15);
    expect(paths.length, 'no script-path invocations extracted').toBeGreaterThan(15);
    expect(
      npm.some((c) => c.script === 'tauri' && c.cwd === 'apps/gui-client'),
      'the cd-scoped `npm run tauri` case is no longer being resolved through its package',
    ).toBe(true);
  });

  it('CRITICAL every `npm run` in a fenced block names a script that exists where the block runs it. `npm error Missing script` reads to a new developer as their own environment being wrong, which is why an onboarding page is the worst possible place for one.', () => {
    const root = scriptsOf('package.json');
    const ws = workspaceScripts();
    const broken = citations()
      .npm.filter((c) => {
        if (c.workspace !== undefined) return !(ws.get(c.workspace)?.has(c.script) ?? false);
        if (c.cwd !== '' && ws.has(c.cwd)) return !(ws.get(c.cwd)?.has(c.script) ?? false);
        return !root.has(c.script);
      })
      .map((c) => `${c.page}: \`${c.command}\`${c.cwd === '' ? '' : ` (after cd ${c.cwd})`}`);
    expect(
      [...new Set(broken)].sort(),
      'documented commands naming a script that does not exist',
    ).toEqual([]);
  });

  it('CRITICAL every backticked `npm run` outside a fenced block names a real root script, or is one of two citations recorded as descriptive. A runbook table of `| Surface | Command | URL |` rows is an instruction, and it is invisible to a fenced-block scan — 42 of these sit outside fences against 28 inside, so this was the larger half of the population and the unguarded one.', () => {
    const root = scriptsOf('package.json');
    const { inline } = citations();
    expect(inline.length, 'no inline backticked commands extracted').toBeGreaterThan(25);
    // The row that made this arm necessary.
    expect(
      inline.some(
        (c) => c.page.endsWith('self-hosted-mac-local.md') && c.script === 'dev:dashboard',
      ),
      'the self-hosted runbook table is no longer being read',
    ).toBe(true);

    const broken = inline
      .filter((c) => !root.has(c.script) && !DESCRIPTIVE.has(`${c.page}::${c.script}`))
      .map((c) => `${c.page}: \`${c.command}\``);
    expect(
      [...new Set(broken)].sort(),
      'inline commands naming a script that does not exist',
    ).toEqual([]);
  });

  it('CRITICAL the descriptive-citation exemptions still describe rather than instruct. Each is exempt because the doc discusses a command instead of telling you to run it; if one becomes a real root script, or its citation disappears, the exemption has outlived its reason and should go rather than sit there granting silence.', () => {
    const root = scriptsOf('package.json');
    const { inline } = citations();
    const stale: string[] = [];
    for (const [key, why] of DESCRIPTIVE) {
      const [page, script] = key.split('::');
      if (!inline.some((c) => c.page === page && c.script === script)) {
        stale.push(`${key} — citation is gone; drop the exemption (${why})`);
      } else if (root.has(script ?? '')) {
        stale.push(`${key} — now a real root script; the exemption is obsolete`);
      }
    }
    expect(stale.sort(), 'descriptive-citation exemptions that no longer hold').toEqual([]);
    expect(DESCRIPTIVE.size, 'the descriptive allowlist grew without review').toBe(2);
  });

  it('CRITICAL every script file a fenced block invokes directly exists on disk. These are the commands that survive a script being renamed in package.json, so they are what documentation reaches for — and nothing was checking them outside the runbook tree.', () => {
    const broken = citations()
      .paths.filter((c) => {
        const candidates = [c.script, c.cwd === '' ? c.script : `${c.cwd}/${c.script}`];
        return !candidates.some((p) => existsSync(resolve(REPO_ROOT, p)));
      })
      .map((c) => `${c.page}: \`${c.command}\``);
    expect(
      [...new Set(broken)].sort(),
      'documented commands invoking a file that does not exist',
    ).toEqual([]);
  });
});
