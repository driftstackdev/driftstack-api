// Both "AI turns already running" refusals tell a program how long to wait, and
// they must tell it the SAME thing — they are indistinguishable to the program
// that receives them (same status, same problem type, same reason to wait), so
// two different waits would only teach it that the number means nothing.
//
// They used to say one second, for a condition that clears when a running turn
// finishes — tens of seconds of model calls and browser steps. A program obeying
// it resends about thirty times before there is any chance of a slot, spending a
// message-rate token each time, and refuses itself out of the bucket that would
// have let it through.
//
// This guard holds the one number in one place. The route's own constant is the
// source: the two refusal sites are read from the route source with comments
// stripped (a comment quoting a number is not the number the route sends), and
// every published surface that names the wait — the OpenAPI document, the
// guide's limits table, the agent-sessions reference, the included-AI page — is
// checked against the constant's VALUE, so changing the constant without saying
// so in the documents a customer reads fails here.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AI_TURNS_RUNNING_RETRY_AFTER_SECONDS } from '../../src/routes/agent-sessions.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

const ROUTE = codeOnly(read('apps/server/src/routes/agent-sessions.ts'));
const SPEC = read('apps/server/src/lib/openapi.ts');
const GUIDE = read('apps/docs/src/pages/guides/run-ai-tasks-from-code.md');
const REFERENCE = read('apps/docs/src/pages/api/agent-sessions.md');
const INCLUDED_AI = read('apps/docs/src/pages/api/bundled-llm.md');

const seconds = AI_TURNS_RUNNING_RETRY_AFTER_SECONDS;

describe('the wait after "AI turns already running" is one number, everywhere it is published', () => {
  it('is long enough to be worth obeying: a turn takes tens of seconds, so a one-second wait is a busy loop', () => {
    expect(seconds).toBeGreaterThanOrEqual(5);
    // And short enough that a program which waits is not simply stuck.
    expect(seconds).toBeLessThanOrEqual(60);
  });

  it('both refusals are constructed with the constant, and neither writes a wait of its own', () => {
    // The account's running-turns limit, and the included-AI ceiling.
    const refusals = ROUTE.match(/new RateLimitedError\(\s*AI_TURNS_RUNNING_RETRY_AFTER_SECONDS,/g);
    expect(refusals, 'both AI-turn refusals take the shared constant').toHaveLength(2);
    // Each one names the limit it is about, so the two really are the pair.
    expect(ROUTE).toMatch(/AI turns running on Driftstack/);
    expect(ROUTE).toMatch(/agent turns running \(limit/);
    // Nothing near an AI-turn refusal hands out a literal wait.
    expect(ROUTE).not.toMatch(/new RateLimitedError\(\s*\d+,\s*`Your account already has/);
  });

  it('the published spec tells a program the same wait, in the body and in the header', () => {
    expect(SPEC).toContain(`\`retry_after_seconds: ${String(seconds)}\``);
    expect(SPEC).toContain(`\`Retry-After: ${String(seconds)}\``);
    // And it says what the wait is — a guess at how long a turn takes — so a
    // program does not read it as a promise that one send will be enough.
    expect(SPEC).toMatch(/the wait is a guess at how long a running turn takes/);
  });

  it("the guide's limits table gives the same wait for both AI-turn rows", () => {
    const rows = GUIDE.split('\n').filter(
      (line) => line.includes('running at once, per account') && line.includes('rate-limited'),
    );
    expect(rows, 'the account row and the included-AI row').toHaveLength(2);
    for (const row of rows) {
      expect(row).toContain(`retry after ${String(seconds)} seconds`);
    }
  });

  it('the reference and the included-AI page give the same wait', () => {
    expect(REFERENCE).toContain(`\`retry_after_seconds: ${String(seconds)}\``);
    expect(REFERENCE).toMatch(
      new RegExp(`Retry-After\` header carrying the same ${String(seconds)}`),
    );
    expect(INCLUDED_AI).toContain(`\`retry_after_seconds: ${String(seconds)}\``);
  });

  it('no test writes the wait down as a number either — a second copy is what goes stale unseen', () => {
    // ⛔ THE ARM THAT WAS MISSING, AND IT COST A RED. The route and the pages
    // were moved to the constant; `bundled-turn-concurrency.test.ts` still
    // asserted `retry_after_seconds` was 1, in a file whose SUBJECT is the
    // concurrency cap rather than the wait, so nothing above looked at it. The
    // arms above read the route and the documents; a wait written down in a
    // THIRD place — another test — is invisible to all of them.
    //
    // The population is DERIVED: every server test that mentions one of the two
    // refusals, by the copy each one sends or by the limiter that produces it.
    const population: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(rel);
        } else if (/\.test\.ts$/.test(entry.name)) {
          const src = read(rel);
          if (
            /bundledTurnConcurrency|AI turns running|agent turns running|account-turn-limit/.test(
              src,
            )
          ) {
            population.push(rel);
          }
        }
      }
    };
    walk('apps/server/tests');
    // A derivation that finds nothing is a guard that passes by measuring
    // nothing — refuse instead.
    expect(
      population.length,
      'no test mentions either AI-turn refusal, so this arm is measuring nothing',
    ).toBeGreaterThanOrEqual(5);

    const literals: string[] = [];
    for (const rel of population) {
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          if (
            /(retry_after_seconds|retryAfterSeconds|\[['"]retry-after['"]\])[^\n]{0,40}\.toBe\(\s*['"]?\d/.test(
              line,
            )
          ) {
            literals.push(`${rel}:${String(i + 1)}`);
          }
        });
    }
    expect(
      literals,
      'take the wait from AI_TURNS_RUNNING_RETRY_AFTER_SECONDS, or assert it somewhere that is not about the AI-turn refusals',
    ).toEqual([]);
  });

  it('nothing customer-facing still names the old one-second wait for these refusals', () => {
    for (const [name, body] of [
      ['the guide', GUIDE],
      ['the reference', REFERENCE],
      ['the included-AI page', INCLUDED_AI],
      ['the spec', SPEC],
    ] as const) {
      expect(body, `${name} still says the wait is one second`).not.toMatch(
        /retry after 1 second|retry_after_seconds: 1`|Retry-After: 1`/,
      );
    }
  });
});
