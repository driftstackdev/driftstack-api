// The AI credits mode is off unless it is spelt as a mode — and everything the
// mode switches on hangs off one value.
//
// `DRIFTSTACK_AI_CREDITS_MODE` is the master switch for a change that touches
// money, and it ships `off`. Two ways a switch like that goes wrong, both quiet:
//
//   · it reads a typo as `off`. Every boolean flag in this server once had its
//     own idea of "true", and the ones that disagreed failed silently: read, not
//     matched, nothing said. A mode that did the same would leave the ONE
//     deployment somebody meant to switch on running as off. So a value that is
//     not a mode refuses to boot, and a value that is one is read the way
//     `envFlag` reads: trimmed, any case.
//   · it is checked in five places and forgotten in the sixth. Here bootstrap
//     builds the grants service only when the mode says so, holds null
//     otherwise, and passes that ONE value to every caller and wraps every job
//     registration in it. The last arms hold bootstrap to that shape; what the
//     shape DOES is proved by booting it, in
//     with-ai-credits-off-nothing-new-is-registered-or-written.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AI_CREDITS_MODES, loadConfig, parseAiCreditsMode } from '../../src/lib/config.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = codeOnly(
  readFileSync(resolve(HERE, '..', '..', 'src', 'lib', 'bootstrap.ts'), 'utf8'),
);

/** The text of the `if (creditGrants !== null) { … }` block. */
function creditJobsBlock(): string {
  const open = BOOTSTRAP.indexOf('if (creditGrants !== null) {');
  if (open === -1) return '';
  let depth = 0;
  for (let i = BOOTSTRAP.indexOf('{', open); i < BOOTSTRAP.length; i += 1) {
    if (BOOTSTRAP[i] === '{') depth += 1;
    else if (BOOTSTRAP[i] === '}') {
      depth -= 1;
      if (depth === 0) return BOOTSTRAP.slice(open, i + 1);
    }
  }
  return '';
}

describe('the AI credits mode is off unless it is spelt as a mode', () => {
  it('there are three modes, and unset, empty and blank all mean off', () => {
    expect([...AI_CREDITS_MODES]).toEqual(['off', 'shadow', 'enforce']);
    for (const raw of [undefined, '', '   ', '\n']) expect(parseAiCreditsMode(raw)).toBe('off');
    expect(loadConfig({}).aiCreditsMode).toBe('off');
  });

  it('a mode is read trimmed and in any case, as a value pasted from a secret store arrives', () => {
    expect(parseAiCreditsMode('shadow')).toBe('shadow');
    expect(parseAiCreditsMode(' Enforce\n')).toBe('enforce');
    expect(parseAiCreditsMode('OFF')).toBe('off');
    expect(loadConfig({ DRIFTSTACK_AI_CREDITS_MODE: 'SHADOW ' }).aiCreditsMode).toBe('shadow');
  });

  it('CRITICAL anything else REFUSES TO BOOT, naming the variable and the three values — a typo must not run as off and say nothing', () => {
    for (const raw of ['enforced', 'on', 'true', '1', 'shadow,enforce', 'offf']) {
      expect(() => parseAiCreditsMode(raw), raw).toThrow(
        /Refusing to boot: DRIFTSTACK_AI_CREDITS_MODE must be one of off, shadow, enforce/,
      );
      expect(() => loadConfig({ DRIFTSTACK_AI_CREDITS_MODE: raw }), raw).toThrow(
        /Refusing to boot/,
      );
    }
  });

  it('CRITICAL bootstrap builds the grants service ONLY when the mode says so, and holds null otherwise', () => {
    expect(BOOTSTRAP).toMatch(
      /const creditGrants = creditGrantsRun\(config\.aiCreditsMode\)\s*\?\s*new CreditGrantsService\(\{[\s\S]*?\}\)\s*:\s*null;/,
    );
    expect(
      BOOTSTRAP.match(/new CreditGrantsService\(/g)?.length,
      'the grants service is constructed somewhere the mode does not gate',
    ).toBe(1);
  });

  it('CRITICAL every credits job is registered and seeded INSIDE the one block that value guards, and nowhere else in bootstrap', () => {
    const block = creditJobsBlock();
    expect(block, 'no `if (creditGrants !== null) { … }` block in bootstrap').not.toBe('');
    const inBlock = [...block.matchAll(/\b((?:register|enqueueNext)Credits\w+)\(/g)].map(
      (m) => m[1],
    );
    expect(inBlock.sort()).toEqual([
      'enqueueNextCreditsCoverageSweep',
      'enqueueNextCreditsExpirySweep',
      // Slice S9 — the daily invariant audit is registered and seeded under the
      // same switch as the three grant jobs, so with the mode off it has no
      // handler and no pending row either.
      'enqueueNextCreditsInvariantAudit',
      'registerCreditsCoverageSweepJob',
      'registerCreditsExpirySweepJob',
      'registerCreditsInvariantAuditJob',
      'registerCreditsWindowBoundaryJob',
    ]);
    const outside = BOOTSTRAP.replace(block, '');
    expect(
      [...outside.matchAll(/\b((?:register|enqueueNext)Credits\w+)\(/g)].map((m) => m[1]),
      'a credits job is registered or seeded outside the mode’s block',
    ).toEqual([]);
  });

  it('CRITICAL REVIEW B (S6) the plan-override WRITER is gated by the same mode, and built nowhere else — it is the second credits dependency bootstrap hands to a repo, and the arms above could not see it: with it wired while the mode is off, an admin tier change would start ending overrides and writing contract rows in a deployment that is meant to be dark', () => {
    expect(BOOTSTRAP).toMatch(
      /const creditPlanOverridesRepo = creditGrantsRun\(config\.aiCreditsMode\)\s*\?\s*new DrizzleCreditPlanOverridesRepo\(dbHandle\)\s*:\s*null;/,
    );
    expect(
      BOOTSTRAP.match(/new DrizzleCreditPlanOverridesRepo\(/g)?.length,
      'the plan-override writer is constructed somewhere the mode does not gate',
    ).toBe(1);
    expect(
      BOOTSTRAP,
      'the admin accounts repo is built with something other than the mode-gated writer',
    ).toMatch(/new DrizzleAccountsAdminRepo\(dbHandle, creditPlanOverridesRepo\)/);
  });

  it('CRITICAL the same value is what every billing caller is handed: the Stripe webhook service, every crypto activator, and the admin accounts service', () => {
    expect(BOOTSTRAP).toMatch(/creditsRefresher: creditGrants,/);
    const activators = BOOTSTRAP.match(/new CryptoTierActivationService\(/g)?.length ?? 0;
    expect(activators, 'crypto activators constructed in bootstrap').toBeGreaterThanOrEqual(3);
    expect(
      BOOTSTRAP.match(
        // S17 — the clawbacks service rides beside the grants service: null
        // whenever grants are, so a crypto refund takes nothing back while AI
        // credits are off, and takes it back everywhere they are on.
        /new CryptoTierActivationService\(\s*stripeWebhooksRepo,\s*logger,\s*accountLifecycleService,\s*authCache,\s*creditGrants,[^\n]*\n\s*creditClawbacks,[^\n]*\n\s*\)/g,
      )?.length,
      'a crypto activator is constructed without the grants service and the clawbacks service',
    ).toBe(activators);
    expect(BOOTSTRAP).toMatch(/new AccountsAdminService\([\s\S]*?creditGrants,\s*\);/);
  });
});
