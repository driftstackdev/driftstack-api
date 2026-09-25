// Security sweep E-26 (2026-09-24). .github/workflows/server-deploy.yml is the
// dormant tag-triggered production deploy (no server-v* tag exists; its legacy
// secrets are believed removed). If it ever fired it would:
//
//   • hand the production SSH key AND the whole production .env to
//     appleboy/ssh-action@v1 — a third-party action on a MUTABLE tag, so whoever
//     controls that tag controls what runs with both;
//   • write that .env with `echo "${{ secrets.DEPLOY_DOTENV_BASE64 }}" | base64 -d
//     > .env` — the secret spliced into script text, the file created under the
//     default umask (0644, world-readable);
//   • and only THEN run `docker compose pull`, which fails on today's host (it has
//     no docker), leaving that world-readable copy behind.
//
// The release policy (docs/operations/release-policy.md) says the tag workflow
// continues to exist, so it is hardened rather than deleted: no third-party code
// sees a secret, the env travels on stdin into a 0600 file renamed into place, and
// the host must prove it can run the deploy before anything is written to it.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const TEXT = readFileSync(resolve(REPO_ROOT, '.github/workflows/server-deploy.yml'), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

const workflow = parse(TEXT) as Workflow;
const steps: Step[] = Object.values(workflow.jobs).flatMap((j) => j.steps);

/** A secret other than the per-run GITHUB_TOKEN, anywhere in the step. */
const touchesSecret = (step: Step): boolean =>
  /secrets\.(?!GITHUB_TOKEN\b)[A-Z_]+/.test(JSON.stringify(step));

const firstParty = (uses: string): boolean => uses.startsWith('actions/');
const pinned = (uses: string): boolean => /@[0-9a-f]{40}$/.test(uses);

/** Script text a step runs: `run:` or a remote-exec action's `script:`. */
const scriptOf = (step: Step): string =>
  `${step.run ?? ''}${typeof step.with?.script === 'string' ? step.with.script : ''}`;

describe('the dormant tag deploy cannot leave the production env readable', () => {
  it('parses the workflow it guards', () => {
    expect(steps.length).toBeGreaterThan(4);
    expect(
      steps.some((s) => /base64 -d/.test(scriptOf(s))),
      'no step decodes the env',
    ).toBe(true);
  });

  it('CRITICAL no third-party action on a mutable tag receives a deploy secret', () => {
    const offenders = steps
      .filter((s) => s.uses !== undefined && touchesSecret(s))
      .filter((s) => !firstParty(s.uses!) && !pinned(s.uses!))
      .map((s) => `${s.name ?? '?'} -> ${s.uses}`);
    expect(offenders).toEqual([]);
  });

  it('CRITICAL no secret is spliced into script text; secrets reach scripts only through env', () => {
    const spliced = steps
      .filter((s) => /\$\{\{\s*secrets\./.test(scriptOf(s)))
      .map((s) => s.name ?? '?');
    expect(spliced).toEqual([]);
  });

  it('CRITICAL the env is written 0600 through a temp file renamed into place, never redirected straight to .env', () => {
    const writer = steps.find((s) => /base64 -d/.test(scriptOf(s)));
    const script = scriptOf(writer!);
    expect(script).toMatch(/umask 077/);
    expect(script).toMatch(/chmod 600/);
    expect(script).toMatch(/mv -f "\$tmp" \.env/);
    expect(script).not.toMatch(/base64 -d\s*>\s*\.env/);
  });

  it('CRITICAL the host must prove it can run the deploy before the env is written to it', () => {
    const writer = steps.find((s) => /base64 -d/.test(scriptOf(s)));
    const script = scriptOf(writer!);
    const preflight = script.indexOf('docker compose version');
    const write = script.indexOf('base64 -d');
    expect(preflight, 'no docker preflight in the step that writes the env').toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(write);
  });

  it('the image tag is validated before it reaches a remote command line', () => {
    const deploy = steps.find((s) => /docker compose up -d/.test(scriptOf(s)));
    expect(scriptOf(deploy!)).toMatch(/IMAGE_TAG" =~ \^/);
  });
});
