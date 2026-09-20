// The period backfill runs only when somebody asks for it.
//
// `runStripePeriodBackfill` pages a year of invoices out of a live Stripe account
// and writes to the billing tables. It is meant to be started by an operator,
// once, and watched. Nothing in the server may start it on its own: not
// bootstrap, not a scheduled job, not a route.
//
// That is a property of what IMPORTS the module, so this walks the server source
// for importers rather than trusting that nobody added one. The day an operator
// trigger lands, this list gains that one file, on purpose.
//
// An importer is any file whose CODE names the module's path — not only
// `import … from`. This server also loads modules with `await import('…')` (the
// browser driver, the TLS probe), and a job that loaded the backfill that way
// would start it just as well while a search for `from '…'` reported nothing.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/** Source files allowed to import the backfill. Empty: nothing starts it yet. */
const ALLOWED_IMPORTERS: readonly string[] = [];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** A string literal, in code, that is the path of `moduleName`: however it is loaded. */
function namesModule(moduleName: string): RegExp {
  return new RegExp(`['"\`][^'"\`\\n]*/${moduleName}(?:\\.js)?['"\`]`);
}

function importers(moduleName: string): string[] {
  const pattern = namesModule(moduleName);
  return sourceFiles(SRC)
    .filter((p) => pattern.test(codeOnly(readFileSync(p, 'utf8'))))
    .map((p) => relative(SRC, p))
    .sort();
}

describe('the period backfill runs only when somebody asks for it', () => {
  it('the walk finds importers at all: the webhook service next door is imported by the files known to use it', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(200);
    expect(importers('stripe-webhooks')).toEqual(
      expect.arrayContaining(['db/stripe-webhooks-repo.ts', 'lib/bootstrap.ts']),
    );
  });

  it('every way of loading a module is seen: a static import, a re-export, a bare import, and the dynamic import a lazy job would use — while the module’s own name in a log line is not one', () => {
    const names = namesModule('stripe-period-backfill');
    for (const line of [
      "import { runStripePeriodBackfill } from '../services/stripe-period-backfill.js';",
      "export * from './stripe-period-backfill.js';",
      "import '../services/stripe-period-backfill.js';",
      "const { runStripePeriodBackfill } = await import('../services/stripe-period-backfill.js');",
      'const mod = await import(`../services/stripe-period-backfill.js`);',
    ]) {
      expect(names.test(line), line).toBe(true);
    }
    for (const line of [
      "{ component: 'stripe-period-backfill', stripeInvoiceId }",
      "import { x } from '../services/stripe-period-backfill-report.js';",
    ]) {
      expect(names.test(line), line).toBe(false);
    }
  });

  it('CRITICAL no server source file imports the backfill, so nothing can start it: not bootstrap, not a job, not a route', () => {
    expect(importers('stripe-period-backfill')).toEqual([...ALLOWED_IMPORTERS]);
  });

  it('the module itself schedules nothing and registers nothing when it is loaded', () => {
    const code = codeOnly(
      readFileSync(resolve(SRC, 'services', 'stripe-period-backfill.ts'), 'utf8'),
    );
    expect(code).toContain('export async function runStripePeriodBackfill(');
    expect(code).not.toMatch(/setInterval|setTimeout|registerJob|scheduledJobs|app\.(get|post)\(/);
  });
});
