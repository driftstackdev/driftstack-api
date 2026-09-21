// DRIFTSTACK_PLANNING_READ — the experiment switch's BOOT-TIME half, read
// exactly the way `parseAiPace` reads DRIFTSTACK_AI_PACE (same file,
// `apps/server/src/lib/config.ts`): unset or blank is the default (here,
// `text` — today's planning read, unchanged); every other value that is not
// one of the three named modes REFUSES TO BOOT rather than silently reading
// as the default, because a misspelt experiment arm that silently ran the
// control would be reported as a null result.

import { describe, expect, it } from 'vitest';
import { parsePlanningReadMode } from '../../src/lib/config.js';
import { PLANNING_READ_MODES } from '../../src/services/agent-planning-read.js';

describe('DRIFTSTACK_PLANNING_READ — default off, and a typo cannot boot', () => {
  it('CRITICAL an unset or blank DRIFTSTACK_PLANNING_READ is `text` — the default deployment is today, unchanged', () => {
    expect(parsePlanningReadMode(undefined)).toBe('text');
    expect(parsePlanningReadMode('')).toBe('text');
    expect(parsePlanningReadMode('   ')).toBe('text');
  });

  it('every mode is accepted, trimmed and case-insensitively, because a value pasted out of a secret store carries whitespace', () => {
    for (const mode of PLANNING_READ_MODES) {
      expect(parsePlanningReadMode(mode)).toBe(mode);
      expect(parsePlanningReadMode(` ${mode.toUpperCase()}\n`)).toBe(mode);
    }
  });

  it('CRITICAL a value that is none of the three modes REFUSES TO BOOT rather than reading as `text`, and the message names all three', () => {
    for (const wrong of ['dom', 'both', 'element', 'elements-then-text', 'TEXTT']) {
      let thrown: unknown;
      try {
        parsePlanningReadMode(wrong);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `${wrong} was accepted`).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : '';
      expect(message).toMatch(/DRIFTSTACK_PLANNING_READ/);
      for (const mode of PLANNING_READ_MODES) {
        expect(message, `message does not name ${mode}`).toContain(mode);
      }
    }
  });
});
