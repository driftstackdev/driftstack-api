// Boolean environment variables all mean the same thing by the same rule.
//
// Eight flags were read with three different comparisons. Six used
// `env.X === 'true'`, so `FLEET_CONTROL_PLANE_ENABLED=TRUE` silently did
// nothing. `PERMISSIVE_CORS` lowercased first, so it alone accepted `True`. And
// `DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS` compared against `'1'`, so the
// value that works for every other flag in the system — `true` — left the
// rotation reminders running.
//
// None of those fail loudly. The variable is read, it does not match, the flag
// stays at its default, and nothing tells the operator that the value they set
// had no effect. That is the same silent-misconfiguration shape as the
// undocumented variables in the sibling guard, and it is worse in one respect:
// here the variable IS known and the value IS present, so a reader checking
// `.env` sees the setting they intended and no reason to doubt it.
//
// `envFlag` is now the single rule: `true`, `1`, `yes`, `on`, case-insensitive,
// whitespace-trimmed because a value pasted from a secret store often carries a
// trailing newline. Anything else, including unset, is false.
//
// ON WIDENING A SECURITY FLAG, because that is the part worth being explicit
// about. `PERMISSIVE_CORS` now accepts `1`/`yes`/`on` where it previously
// accepted only `true`. That flag caused a real production incident — the API
// echoed any Origin with credentials — and the fix was a fail-closed boot
// refusal when it is on in production. Widening it cannot reopen that hole,
// because `bootstrap` parses the value ONCE and hands the same boolean to both
// `assertCorsPosture` and the app: every value that switches permissive CORS on
// is the same value that refuses the boot. A parser used for the check and a
// different parser used for the effect would be the dangerous shape, and that is
// exactly what this file exists to prevent.
//
// TRUST_PROXY is deliberately not covered. `coerceTrustProxy` is tri-state —
// boolean, hop count, or an IP/CIDR list — so `'true'` there is one branch of a
// richer parse rather than a boolean convention.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envFlag } from '../../src/lib/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
/** Where the rule itself lives; its own comparison is the definition. */
const HELPER_FILE = resolve(SERVER_SRC, 'lib', 'config.ts');

/** Source lines that compare an env variable to a truthy literal directly. */
function bareComparisons(): string[] {
  const found: string[] = [];
  // V-1562 — this reports an ABSENCE, so the count is part of the answer.
  // Retargeting the walk at `src/db/migrations` (real directory, no `.ts`) left
  // all four arms GREEN while nothing was read. Measured at 340 files.
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      scanned += 1;
      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Comments describe the rule; they are not the rule.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (
          /\b(?:process\.)?env(?:\.[A-Z_][A-Z0-9_]*|\[['"][A-Z_][A-Z0-9_]*['"]\])\s*(?:\?\?[^)]*\)?\s*(?:\.toLowerCase\(\))?\s*)?(?:===|!==)\s*'(?:true|false|1|0|yes|no|on|off)'/.test(
            code,
          )
        ) {
          found.push(`${full.slice(SERVER_SRC.length + 1)}:${String(i + 1)}: ${code.trim()}`);
        }
      });
    }
  };
  walk(SERVER_SRC);
  if (scanned < 100) {
    throw new Error(
      `bareComparisons scanned only ${scanned.toString()} files under ${SERVER_SRC} — the walk is ` +
        'blind, so an empty result means nothing',
    );
  }
  return found.sort();
}

describe('boolean environment flags share one truthiness rule', () => {
  it('CRITICAL envFlag accepts the values an operator would reasonably write. Each was a real silent no-op under one of the three comparisons this replaced: TRUE under the case-sensitive form, and true under the numeric form that accepted only a literal one.', () => {
    for (const raw of ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', ' true ', 'true\n']) {
      expect(envFlag(raw), `${JSON.stringify(raw)} enables the flag`).toBe(true);
    }
  });

  it('CRITICAL envFlag rejects everything else, including the values that look like a deliberate OFF. A parser that accepted "false" would be catastrophic in the other direction — it is the value operators write to turn a flag off.', () => {
    for (const raw of ['false', 'FALSE', '0', 'no', 'off', '', '   ', 'truthy', 'enabled', '2']) {
      expect(envFlag(raw), `${JSON.stringify(raw)} leaves the flag off`).toBe(false);
    }
    expect(envFlag(undefined), 'an unset variable leaves the flag off').toBe(false);
  });

  it('CRITICAL no boolean env variable is compared directly any more. A second comparison is how the three conventions arose, and the risk is not only inconsistency: a value parsed one way for a security CHECK and another way for the EFFECT is how a fail-closed guard gets bypassed.', () => {
    expect(
      bareComparisons().filter((f) => !f.startsWith('lib/config.ts')),
      'source line(s) comparing an env variable to a truthy literal instead of using envFlag:',
    ).toEqual([]);
  });

  it('CRITICAL the scanner can still find a bare comparison. It reports an absence, so a regex that matched nothing would report the whole source clean — the failure this guard exists to prevent, wearing the pass as a disguise.', () => {
    // The helper's own definition is the one legitimate comparison in the tree,
    // and it is what proves the scanner is still looking.
    const helper = readFileSync(HELPER_FILE, 'utf8');
    expect(helper.includes("['true', '1', 'yes', 'on']"), 'the rule is where it is expected').toBe(
      true,
    );

    const probe = "  const x = env.SOME_FLAG === 'true';";
    const code = probe.replace(/\/\/.*$/, '');
    expect(
      /\b(?:process\.)?env(?:\.[A-Z_][A-Z0-9_]*|\[['"][A-Z_][A-Z0-9_]*['"]\])\s*(?:===|!==)\s*'(?:true|false|1|0|yes|no|on|off)'/.test(
        code,
      ),
      'the pattern this arm searches for still matches a bare comparison',
    ).toBe(true);
  });
});
