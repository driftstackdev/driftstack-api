// V-814 — the profile-cap error status, checked against the class instead of
// against the decision that was supposed to produce it.
//
// ADR-004 decided the profile cap would return `402 Payment Required` with a
// `profile-cap-reached` body and an upgrade link, and drew a deliberate contrast
// with the concurrency cap ("429 — payment-required is for trial-pack states
// only"). The implementation never drew that contrast. Both caps are 429:
// `TierLimitError` is `status: 429`, type `.../tier-limit`.
//
// The decision then propagated as fact. FIVE source and doc sites and EIGHT
// parity pins described the profile cap as a 402, and not one of them was wrong
// about anything a test could see, because every one of them was prose. A pin
// froze the ADR sentence; other pins froze the source comments that had copied
// it. The claim was self-consistent across the whole repo and false everywhere.
//
// A NOTE ON THE GUARD THIS WAS GOING TO BE. The first version scanned every
// file for an HTTP status quoted within 40 characters of any error-class name
// and compared against that class's real status. It found 40+ violations and
// almost all were false: `V-485` and `V-174` are entry numbers that look exactly
// like statuses, and any sentence enumerating several errors ("400 Validation,
// 401 InvalidKey, 403 Forbidden") cross-matches every pair inside the window. It
// could have been shipped with a 40-entry allowlist, which is the shape V-802's
// comment calls a blindfold: the allowlist would have grown faster than the
// signal. Proximity cannot separate "X returns 402" from "X, and separately,
// 402". So this guard is deliberately NARROW — it defends the claim that
// actually drifted, derives the status rather than restating it, and does not
// pretend to cover the class of defect in general.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ERRORS_TS = resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts');

/**
 * The surfaces that describe what a customer gets when the profile cap is hit.
 * Every one of these said 402 before V-814.
 */
const PROFILE_CAP_SURFACES = [
  'docs/adr/ADR-004-pricing-restructure-two-ladder.md',
  'apps/server/src/routes/profiles.ts',
  'apps/server/src/routes/account-me.ts',
  'apps/server/src/services/profile-snapshots.ts',
  'apps/server/tests/e2e/profile-limit.spec.ts',
] as const;

/** Roots that contain EMITTED code, as opposed to prose about it. */
const CODE_ROOTS = ['apps/server/src', 'packages'] as const;

/** `class XError extends ApiError { … status: NNN … }` → status. */
function statusByErrorClass(): Map<string, number> {
  const src = readFileSync(ERRORS_TS, 'utf8');
  const out = new Map<string, number>();
  for (const m of src.matchAll(/export class (\w+Error) extends ApiError \{/g)) {
    const start = m.index ?? 0;
    let depth = 0;
    let end = src.length;
    for (let k = start + m[0].length - 1; k < src.length; k += 1) {
      if (src[k] === '{') depth += 1;
      else if (src[k] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    const status = src.slice(start, end).match(/\bstatus:\s*(\d{3})\b/);
    if (status) out.set(m[1] as string, Number(status[1]));
  }
  return out;
}

function walkCode(dir: string, acc: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (
        [
          'node_modules',
          'dist',
          'migrations',
          'tests',
          '__pycache__',
          '.venv',
          'venv',
          '.tox',
        ].includes(e.name)
      )
        continue;
      walkCode(full, acc);
    } else if (/\.(ts|py|go)$/.test(e.name) && !/\.test\.ts$|_test\.go$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function codeFiles(): string[] {
  const acc: string[] = [];
  for (const r of CODE_ROOTS) {
    const full = resolve(REPO_ROOT, r);
    try {
      if (statSync(full).isDirectory()) walkCode(full, acc);
    } catch {
      /* absent in this checkout */
    }
  }
  return acc;
}

describe('V-814 the documented profile-cap status is derived from its class', () => {
  it('CRITICAL the class map is really parsed out of lib/errors.ts. Every arm below compares against it, so an empty map would make them agree with each other over nothing — the failure mode this family of guards keeps producing.', () => {
    const statuses = statusByErrorClass();
    expect(statuses.size, 'ApiError subclasses carrying a literal status').toBeGreaterThan(15);
    expect(statuses.get('TierLimitError'), 'the class the profile cap actually throws').toBe(429);
    expect(statuses.get('ConcurrencyLimitError'), 'the cap ADR-004 contrasted it with').toBe(429);
    // V-938 — raised from 100 to just under the measured 3134 (apps/server/src
    // plus every package). At 100 this walk could have lost 97% of its corpus
    // and still reported a green, which makes the arm's own non-vacuity claim
    // the least reliable thing in the file.
    // Floor set from the TRACKED population (~676 .ts/.py/.go under these roots at
    // HEAD), never an environment: a clean-box probe counted 2507 here, 1972 of
    // which were packages/sdk-python/.venv site-packages — library code inflating a
    // completeness floor. .venv/venv/.tox are skipped now, so this counts only
    // shipped code and holds on any checkout.
    expect(
      codeFiles().length,
      'emitted-code files scanned (tracked, .venv excluded)',
    ).toBeGreaterThan(500);
  });

  it('CRITICAL the two caps ADR-004 distinguished return the SAME status, so any prose drawing a status contrast between them is wrong by construction. The ADR reasoned that payment-required was right for the profile cap and rate-limit semantics right for the concurrency cap; both classes pass 429 to super, and have since before the ADR was written.', () => {
    const statuses = statusByErrorClass();
    expect(
      statuses.get('TierLimitError'),
      'if these ever genuinely diverge, ADR-004s original contrast becomes implementable and its note should be revisited',
    ).toBe(statuses.get('ConcurrencyLimitError'));
  });

  it('CRITICAL no surface describing the profile cap claims a payment-required status. This is the exact sentence that drifted: ADR-004 specified it, and five files and eight pins repeated it until the whole repo agreed on a status the server has never sent on this path. The expected value is READ from TierLimitError, so moving the class moves the guard.', () => {
    const real = statusByErrorClass().get('TierLimitError');
    expect(real, 'TierLimitError status resolved').toBeDefined();

    // The retired claim, and the premise that makes banning it correct. If
    // TierLimitError is ever genuinely moved to payment-required, THIS line
    // fails first and loudly — the guard invalidates itself rather than going
    // quietly wrong, which is the property the prose it polices lacked.
    const PAYMENT_REQUIRED = 402;
    expect(
      real,
      'TierLimitError has moved to payment-required — ADR-004s original decision is now implemented, so retire this guard and the note in the ADR',
    ).not.toBe(PAYMENT_REQUIRED);

    const offenders: string[] = [];
    for (const rel of PROFILE_CAP_SURFACES) {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (!new RegExp(`\\b${String(PAYMENT_REQUIRED)}\\b`).test(line)) return;
        // A markdown blockquote in an ADR is the correction record, not the
        // decision. The normative bullets are never blockquoted, so this is a
        // structural rule rather than another vocabulary rule: reintroducing
        // the claim as a bullet is still caught.
        if (/^\s*>/.test(line)) return;
        // A RETRACTION must carry its V-number ON THE SAME LINE as the retired
        // status. An earlier version of this rule excused any line whose
        // one-line neighbourhood mentioned the real status — and the mutation
        // proof caught it passing: reintroducing "profile cap → 402" as a
        // normative bullet was excused because the NEXT bullet legitimately says
        // 429. The exemption was widest exactly where the claim belongs, which
        // is the worst place for a guard to be generous. Same-line and explicit
        // costs one marker per correction and cannot be satisfied by accident.
        if (/\bV-814\b/.test(line)) return;
        offenders.push(`${rel}:${String(i + 1)} — ${line.trim().slice(0, 110)}`);
      });
    }
    expect(
      offenders,
      `the profile cap returns ${String(real)}, not ${String(PAYMENT_REQUIRED)}; these lines say otherwise:`,
    ).toEqual([]);
  });

  it('CRITICAL the `profile-cap-reached` body identifier is absent from emitted code. It is not a value that drifted — nothing ever emitted it. ADR-004 named it and five places repeated it, and a customer told to branch on it would wait for a body the server cannot produce. Asserted over CODE only: the prose retractions have to be free to name it, or the correction could not be written down.', () => {
    const hits: string[] = [];
    for (const file of codeFiles()) {
      const src = readFileSync(file, 'utf8');
      if (src.includes('profile-cap-reached')) hits.push(file.slice(REPO_ROOT.length + 1));
    }
    expect(
      hits,
      'the profile cap emits the tier-limit problem type; this identifier is fiction:',
    ).toEqual([]);
  });
});
