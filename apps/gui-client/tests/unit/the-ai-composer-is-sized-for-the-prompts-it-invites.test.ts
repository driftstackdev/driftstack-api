import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Owner 2026-08-31: "the text bar should be larger."
 *
 * The composer opened at 3 rows and capped its autogrow at 288px — cramped for
 * the thing it asks for. Its own placeholder is a two-clause task description,
 * and the task the owner actually typed ("go to X, create an account with this
 * email, tell me when a verification code is needed") does not fit in three
 * rows. A prompt box smaller than the prompts it invites reads as a search field.
 *
 * ⭐ The part worth guarding is not the numbers, it is that TWO sites grow this
 * textarea — the onChange handler and the restore-focus path — and they were
 * two independent literals. Two literals that must agree and are not named are
 * a drift waiting to happen: fix one, miss the other, and the box grows to a
 * different size depending on how the customer got there.
 */

const SRC = resolve(__dirname, '../../src/views/AgentChatView.tsx');
const body = readFileSync(SRC, 'utf8');

describe('the AI composer is sized for the prompts it invites', () => {
  it('grows through ONE named ceiling, not per-site literals', () => {
    const named = body.match(/Math\.min\([^)]*COMPOSER_MAX_HEIGHT_PX\)/g) ?? [];
    expect(named.length, 'every autogrow site must use the shared constant').toBeGreaterThanOrEqual(
      2,
    );
    // No autogrow site may reintroduce a bare pixel literal beside the constant.
    expect(body).not.toMatch(/style\.height = `\$\{Math\.min\([^)]*,\s*\d+\)\}px`/);
  });

  it('opens taller than a single-line search field', () => {
    const rows = /const COMPOSER_ROWS = (\d+);/.exec(body)?.[1];
    expect(rows, 'COMPOSER_ROWS must be declared').toBeDefined();
    expect(Number(rows)).toBeGreaterThanOrEqual(5);
    expect(body).toContain('rows={COMPOSER_ROWS}');
  });

  it('the ceiling leaves room for a multi-step task', () => {
    const cap = /const COMPOSER_MAX_HEIGHT_PX = (\d+);/.exec(body)?.[1];
    expect(cap, 'COMPOSER_MAX_HEIGHT_PX must be declared').toBeDefined();
    // 288px was the reported-too-small value; anything at or below it is a regression.
    expect(Number(cap)).toBeGreaterThan(288);
  });
});
