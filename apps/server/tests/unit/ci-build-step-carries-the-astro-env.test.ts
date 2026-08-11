// The CI step that runs `npm run build` must carry PUBLIC_API_BASE_URL.
//
// Both dashboards fail CLOSED without it — deliberately, so a missing deploy
// env can never silently ship an admin panel pointed at localhost:3000. While
// they shipped through the @astrojs/cloudflare adapter this never surfaced at
// build time: pages marked `prerender = false` resolved the base URL at REQUEST
// time. Dropping the adapter for plain static output moved that resolution to
// BUILD time, and `npm run build` — which is build:packages && build:apps, so
// all six Astro apps — started failing at `astro build` for admin-panel.
//
// CI did not notice, and could not: origin/main is a month behind and its last
// run predates the change. `npm run build` is the one CI step nobody executes
// locally, so the only signal available before a push is this file.
//
// The step gates `e2e` via `needs:`, so losing the env does not just fail the
// build — it silently skips the entire end-to-end suite.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CI = resolve(REPO_ROOT, '.github/workflows/ci.yml');

/** The env var both dashboards throw without. */
const REQUIRED_ENV = 'PUBLIC_API_BASE_URL';

interface Step {
  name: string;
  run: string;
  env: string;
}

/**
 * Steps in a workflow, as raw text blocks.
 *
 * Parsed by hand rather than with a YAML library because none is a dependency
 * of this workspace, and the property under test is textual: does the block
 * that runs the build also name the variable.
 */
function stepsOf(workflow: string): Step[] {
  const out: Step[] = [];
  const lines = workflow.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const isStepStart = /^\s{6}- name:/.test(lines[i] ?? '');
    if (!isStepStart) continue;
    if (start !== -1) out.push(toStep(lines.slice(start, i)));
    start = i;
  }
  if (start !== -1) out.push(toStep(lines.slice(start)));
  return out;
}

function toStep(block: string[]): Step {
  const text = block.join('\n');
  const name = /- name:\s*(.+)/.exec(text)?.[1]?.trim() ?? '';
  // Stop the block at the next step so a later step's env is not attributed here.
  const end = text.indexOf('\n      - name:');
  const body = end === -1 ? text : text.slice(0, end);
  const run = /\n\s*run:\s*([^\n]+)/.exec(body)?.[1]?.trim() ?? '';
  const envMatch = /\n\s*env:\s*\n((?:\s{10}\S[^\n]*\n?)+)/.exec(body);
  return { name, run, env: envMatch?.[1] ?? '' };
}

const workflow = existsSync(CI) ? readFileSync(CI, 'utf8') : '';
const steps = stepsOf(workflow);
const buildSteps = steps.filter((s) => s.run === 'npm run build');

describe('the CI build step carries the env both dashboards fail closed without', () => {
  it('CRITICAL the workflow was found and the build step located. The assertion below is about ONE step, so a parser that stopped finding steps would report the same clean result as a correctly configured job.', () => {
    expect(existsSync(CI), 'ci.yml at the canonical path').toBe(true);
    expect(steps.length, 'steps parsed out of ci.yml').toBeGreaterThan(15);
    // Not "exactly one": ci.yml has THREE. Asserting one is what this arm
    // caught — build-test, e2e and bench-regression each build the workspace,
    // and e2e's step was missing the env even after build-test was fixed.
    expect(buildSteps.length, 'steps running `npm run build` in ci.yml').toBeGreaterThanOrEqual(3);

    // The detector must distinguish a step that sets the env from one that
    // does not — otherwise the assertion below passes on anything.
    const withEnv = stepsOf(
      [
        '      - name: X',
        '        env:',
        `          ${REQUIRED_ENV}: https://example.test`,
        '        run: npm run build',
      ].join('\n'),
    );
    expect(withEnv[0]?.env, 'a step WITH the env is read as having it').toContain(REQUIRED_ENV);
    const withoutEnv = stepsOf(['      - name: X', '        run: npm run build'].join('\n'));
    expect(withoutEnv[0]?.env, 'a step WITHOUT it is read as lacking it').not.toContain(
      REQUIRED_ENV,
    );
  });

  it(`CRITICAL the build step sets ${REQUIRED_ENV}. Without it \`astro build\` fails closed for admin-panel and customer-dashboard, and because this step gates e2e via needs:, losing it also skips the entire end-to-end suite.`, () => {
    const missing = buildSteps.filter((s) => !s.env.includes(REQUIRED_ENV)).map((s) => s.name);
    expect(
      missing,
      `step(s) running \`npm run build\` without ${REQUIRED_ENV} — both dashboards throw without it, by design:`,
    ).toEqual([]);
  });
});
