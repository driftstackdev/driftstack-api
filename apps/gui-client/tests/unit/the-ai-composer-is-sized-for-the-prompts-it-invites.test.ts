import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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

/**
 * ⛔ REPOINTED 2026-09-19 (AI-view rebuild, stage 0). The composer moved out of
 * `views/AgentChatView.tsx` into `views/agent-chat/Composer.tsx`, which now owns
 * BOTH autogrow sites: the onChange handler, and `growComposerToFit` — the one
 * the view calls when a template fills the box. That is exactly the property
 * this file guards, so the pin follows the code and no assertion changed.
 */
const SRC = resolve(__dirname, '../../src/views/agent-chat/Composer.tsx');
const body = readFileSync(SRC, 'utf8');

/**
 * The `max-h-NN` scan below is a NEGATIVE, and a negative over one file is only
 * as good as that file's reach: a Tailwind `max-h-72` capping the composer from
 * a sibling in the same folder would read exactly like a clean run. So it scans
 * the WHOLE view — every file the AI view is built from — rather than the one
 * that happens to hold the textarea today.
 */
const AGENT_CHAT_DIR = resolve(__dirname, '../../src/views/agent-chat');
const VIEW_SOURCES = [
  resolve(__dirname, '../../src/views/AgentChatView.tsx'),
  ...readdirSync(AGENT_CHAT_DIR)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => resolve(AGENT_CHAT_DIR, f)),
];

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

  it('⛔ the CSS cap matches the JS cap — they are two caps, in two languages', () => {
    // The textarea carried `max-h-72` = 288px, the exact value this fix believed
    // it had raised. `max-height` beats an inline `style.height`, so the JS cap
    // was dead and the composer still stopped at the old size. An adversarial
    // check found it; the suite did not, because nothing compared the two.
    const cap = /const COMPOSER_MAX_HEIGHT_PX = (\d+);/.exec(body)?.[1];
    expect(cap).toBeDefined();
    expect(body, 'the Tailwind max-h must equal COMPOSER_MAX_HEIGHT_PX').toContain(
      `max-h-[${String(cap)}px]`,
    );
    // And no fixed-rem cap may return: a Tailwind max-h-<n> is 288px at n=72 and
    // reads as harmless. ⚠️ Comments stripped first — the prose above explaining
    // this trap contains the banned token, so a naive negative flags the fix as
    // the defect. Third time today a guard nearly accused its own explanation.
    // Swept over the WHOLE view, not just the file holding the textarea: a cap
    // reintroduced one file over would read exactly like a clean run.
    expect(VIEW_SOURCES.length, 'the view-source sweep derived nothing to scan').toBeGreaterThan(1);
    for (const file of VIEW_SOURCES) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line.trim()))
        .join('\n');
      expect(code, file).not.toMatch(/max-h-\d+\b/);
    }
  });

  it('the ceiling leaves room for a multi-step task', () => {
    const cap = /const COMPOSER_MAX_HEIGHT_PX = (\d+);/.exec(body)?.[1];
    expect(cap, 'COMPOSER_MAX_HEIGHT_PX must be declared').toBeDefined();
    // 288px was the reported-too-small value; anything at or below it is a regression.
    expect(Number(cap)).toBeGreaterThan(288);
  });
});
