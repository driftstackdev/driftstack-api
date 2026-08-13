// Every environment variable the server reads is documented somewhere an
// operator will look.
//
// Production `.env` is written from `DEPLOY_DOTENV_BASE64`, and four files
// describe what belongs in it: `.env.example`, the production and staging
// templates, and the prose reference `docs/deployment/env-vars.md`. A variable
// the code reads and none of them names is one an operator has no reason to set.
//
// That matters more here than in a codebase that fails fast, because
// `loadConfig` deliberately does not. Optional subsystems are all-or-nothing
// groups: the R2 comment says "four required to enable R2; if any is missing,
// R2 is disabled", and Postmark says "all three required to enable". Setting two
// of three Postmark variables does not raise — transactional email is simply off,
// in production, with nothing in the logs claiming a mistake was made. The
// undocumented variable and the silent-disable design compose into a failure
// nobody is told about.
//
// MEASURED: the server reads 94 variables; the four documents between them name
// 103; 40 are read and documented in none of them. Among those 40 are
// `PROFILE_MASTER_KEY`, `OAUTH_CLIENT_SIGNING_SECRET`, `NOWPAYMENTS_IPN_SECRET`,
// `METRICS_SCRAPE_TOKEN`, the three LiveKit variables and both OAuth client
// pairs — each of them the trigger for exactly the silent-disable above.
//
// This file does not fix that. It fixes the direction of travel: the 40 are
// enumerated by name, so a NEW undocumented variable fails immediately, and an
// entry that later gets documented, or stops being read, is reported as stale
// rather than sitting on a list describing work already done. Documenting them
// is a separate change needing a judgement per variable about whether it is
// operator-facing, has a safe default, or is a tuning knob — and
// `PLAYWRIGHT_HEADED` belongs in nobody's production environment at all.
//
// WHERE TO LOOK is itself the thing this file got wrong twice, so both mistakes
// are now assertions rather than lessons.
//
// The first was the READING side. `config.ts` does not touch `process.env`
// directly: `loadConfig(env: NodeJS.ProcessEnv = process.env)` takes the
// environment as a PARAMETER and reads `env.DATABASE_URL`. A scan for
// `process.env.X` alone found 22 variables and missed the entire central config,
// which is where most of them live. Both forms are read here and the total is
// floored, so a refactor moving reads behind a helper cannot quietly reduce this
// to checking nothing.
//
// The second was the DOCUMENTATION side, and it produced a real overstatement: a
// first version read only the three template files, reported 58 undocumented,
// and named `POSTMARK_API_TOKEN` among them. `docs/deployment/env-vars.md` — a
// 53KB reference that `config.ts` itself cites in a comment — documents that
// variable and seventeen others. The gap is 40, not 58. An audit is only as
// honest as its enumeration of where the answer could live, and the reference
// was found by reading the source comment rather than by the audit noticing its
// own blind spot.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
const ENV_DOCS = [
  resolve(REPO, '.env.example'),
  resolve(REPO, 'infra', 'env-templates', 'production.env.template'),
  resolve(REPO, 'infra', 'env-templates', 'staging.env.template'),
];

/**
 * The prose reference. Not a template, so a variable counts as documented when
 * its NAME appears anywhere — that is what a reader looking it up would find.
 */
const ENV_REFERENCE = resolve(REPO, 'docs', 'deployment', 'env-vars.md');

/**
 * Variables the server reads that no env document names.
 *
 * MEASURED at 40. Enumerated rather than counted so a new one fails loudly
 * instead of joining a number, and checked in both directions so an entry that
 * gets documented — or stops being read — is reported as stale.
 */
const UNDOCUMENTED_ENV = new Set([
  'AGENT_RELAY_MAX_ACCOUNT_INFLIGHT',
  'AGENT_TURN_MAX_ACCOUNT_INFLIGHT',
  'AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES',
  'AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_COUNT',
  'APP_VERSION',
  'BUNDLED_TURN_MAX_CONCURRENCY',
  'BYOK_ANTHROPIC_FALLBACK_KEY',
  'DB_STATEMENT_TIMEOUT_MS',
  'DRIFTSTACK_AGENT_DECOMPOSER_FORCE',
  'DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS',
  'DRIFTSTACK_AGENT_SESSION_PAGE_STATE_MAX_AGE_SECONDS',
  'DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY',
  'DRIFTSTACK_ANTHROPIC_MODEL',
  'DRIFTSTACK_FLEET_INTERNAL_TOKEN',
  'DRIFTSTACK_OWNER_EMAIL',
  'DRIFTSTACK_PROXY_PRELAUNCH_PROBE',
  'DRIFTSTACK_PROXY_PROBE_TARGET_URL',
  'DRIFTSTACK_PROXY_PROBE_TIMEOUT_MS',
  'DRIFTSTACK_WORKER_DISCONNECT_GRACE_SECONDS',
  'FLEET_CONTROL_PLANE_ENABLED',
  'FLEET_NODE_DISPLAY_NAME',
  'FLEET_NODE_HARDWARE_CLASS',
  'FLEET_NODE_REGION',
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_WS_URL',
  'METRICS_SCRAPE_TOKEN',
  'NOWPAYMENTS_API_KEY',
  'NOWPAYMENTS_IPN_SECRET',
  'OAUTH_CLIENT_CALLBACK_URL_BASE',
  'OAUTH_CLIENT_SIGNING_SECRET',
  'PERMISSIVE_CORS',
  'PLAYWRIGHT_HEADED',
  'PROFILE_MASTER_KEY',
  'PROFILE_MASTER_KEY_CMD',
  'R2_BUCKET_PUBLIC',
]);

/** Every environment variable name the server source reads, in either form. */
function readVariables(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      // Comments are NOT stripped, and that is deliberate after trying it. A
      // naive `/\*[\s\S]*?\*\//` strip swallowed fourteen real reads in
      // `bootstrap.ts` — a `/*` inside a string or regex literal opens a comment
      // the regex then closes somewhere far below — and the count fell from 94
      // to 80 while looking like a clean improvement. Correctly stripping
      // comments needs a tokeniser, and prose mentioning `env.SOMETHING` is a
      // much smaller problem than silently unseeing a whole file, so the prose
      // is written to avoid the pattern instead.
      const src = readFileSync(full, 'utf8');
      // `process.env.FOO` and the parameter form `env.FOO` that config.ts uses.
      for (const m of src.matchAll(/\bprocess\.env\.([A-Z_][A-Z0-9_]*)/g)) out.add(m[1]!);
      for (const m of src.matchAll(/\benv\.([A-Z_][A-Z0-9_]*)/g)) out.add(m[1]!);
      for (const m of src.matchAll(/\benv\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g)) out.add(m[1]!);
    }
  };
  walk(SERVER_SRC);
  return out;
}

/**
 * Everywhere a variable can be documented: `NAME=` lines an operator copies from
 * the templates, plus any mention by name in the deployment reference.
 */
function documentedVariables(): Set<string> {
  const out = new Set<string>();
  for (const file of ENV_DOCS) {
    for (const m of readFileSync(file, 'utf8').matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)) {
      out.add(m[1]!);
    }
  }
  const reference = readFileSync(ENV_REFERENCE, 'utf8');
  for (const m of reference.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) out.add(m[1]!);
  return out;
}

describe('every environment variable the server reads is documented', () => {
  it('CRITICAL both sides were read and are non-trivial. The comparison reports an absence, and an absence measured against an empty set is every variable — a reader that found nothing would either report the whole environment undocumented or, with the baseline absorbing it, report everything fine.', () => {
    // MEASURED: 94 read, 103 documented across the four sources.
    expect(readVariables().size, 'environment variables read by the server').toBeGreaterThanOrEqual(
      90,
    );
    expect(
      documentedVariables().size,
      'variables named in the env documents',
    ).toBeGreaterThanOrEqual(100);

    // The parameter form is the one a naive scan misses, checked on a variable
    // whose answer is not in doubt: config.ts reads `env.DATABASE_URL`, never
    // `process.env.DATABASE_URL`.
    expect(readVariables().has('DATABASE_URL'), 'the parameter form env.X is read').toBe(true);
    expect(readVariables().has('APP_VERSION'), 'and the direct process.env.X form').toBe(true);
  });

  it('CRITICAL no NEW variable is read without being documented or listed. Production .env is assembled from these documents, and loadConfig does not fail on a missing optional group — it disables the subsystem, so an undocumented variable becomes email that silently does not send rather than a deploy that refuses to start.', () => {
    const documented = documentedVariables();
    const undocumented = [...readVariables()]
      .filter((name) => !documented.has(name))
      .filter((name) => !UNDOCUMENTED_ENV.has(name))
      .sort();
    expect(
      undocumented,
      'variable(s) read by the server, documented nowhere, and not listed as known:',
    ).toEqual([]);
  });

  it('CRITICAL the known list is not stale. An entry that has since been documented, or that nothing reads any more, describes work already done — and a list read as outstanding while holding closed items is how the real entries stop being believed.', () => {
    const read = readVariables();
    const documented = documentedVariables();
    const stale: string[] = [];
    for (const name of UNDOCUMENTED_ENV) {
      if (documented.has(name))
        stale.push(`${name} is now documented — remove it from UNDOCUMENTED_ENV`);
      else if (!read.has(name))
        stale.push(`${name} is no longer read by the server — remove it from UNDOCUMENTED_ENV`);
    }
    expect(stale.sort(), 'stale entr(ies) in the known-undocumented list:').toEqual([]);
  });
});
