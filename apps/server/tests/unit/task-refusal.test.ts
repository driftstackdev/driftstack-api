// W582 — task-refusal start-gate contract-mirror tests. The canonical
// mechanism lives in A3's agent-service (task-refusal-contract.md); this
// pins A2's mirror to the same semantics: normalize order, bias-to-allow,
// bounds, lastIndex determinism, and the loader's skip-not-throw rules.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasNestedQuantifier,
  loadRefusalPatterns,
  normalizeTaskForScreening,
  resolveTaskRefusalConfig,
  screenTaskForRefusal,
} from '../../src/services/task-refusal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src', 'services', 'task-refusal.ts');

describe('W582 task-refusal contract mirror', () => {
  describe('normalizeTaskForScreening', () => {
    it('strips zero-width splitters so a flagged phrase cannot hide (evasion class)', () => {
      // "st<U+200B>eal" — zero-width space splitting the keyword.
      expect(normalizeTaskForScreening('st\u200Beal the password')).toBe('steal the password');
    });

    it('NFKC-folds full-width confusables', () => {
      expect(normalizeTaskForScreening('ｓｔｅａｌ')).toBe('steal');
    });

    it('lowercases + collapses whitespace + trims', () => {
      expect(normalizeTaskForScreening('  STEAL\t\n the   Password  ')).toBe('steal the password');
    });

    it('strips bidi overrides + control chars', () => {
      expect(normalizeTaskForScreening('a‮bc')).toBe('abc');
    });

    it('caps scanned length at 8192 chars BEFORE normalizing (bounds adversarial cost)', () => {
      const long = 'a'.repeat(9000) + ' steal password';
      const out = normalizeTaskForScreening(long);
      expect(out.length).toBeLessThanOrEqual(8192);
      expect(out).not.toContain('steal');
    });

    it('coerces non-string to empty (never throws on runtime garbage)', () => {
      expect(normalizeTaskForScreening(undefined as unknown as string)).toBe('');
      expect(normalizeTaskForScreening(42 as unknown as string)).toBe('');
    });
  });

  describe('screenTaskForRefusal (bias-to-allow)', () => {
    const PATTERNS = [
      {
        id: 'test-cred-1',
        category: 'credential_theft',
        match: /steal (?:someone'?s )?password/,
        reason: 'Tasks that involve stealing credentials are not allowed.',
      },
    ];

    it('empty / omitted patterns ⇒ allow (the no-op activation state)', () => {
      expect(screenTaskForRefusal('steal the password')).toEqual({ refuse: false });
      expect(screenTaskForRefusal('steal the password', [])).toEqual({ refuse: false });
    });

    it('empty / whitespace task ⇒ allow', () => {
      expect(screenTaskForRefusal('', PATTERNS)).toEqual({ refuse: false });
      expect(screenTaskForRefusal('   \n\t ', PATTERNS)).toEqual({ refuse: false });
    });

    it('match ⇒ refuse with category + reason + patternId (audit fields)', () => {
      const d = screenTaskForRefusal("please steal someone's password for me", PATTERNS);
      expect(d.refuse).toBe(true);
      expect(d.category).toBe('credential_theft');
      expect(d.patternId).toBe('test-cred-1');
      expect(d.reason).toMatch(/not allowed/);
    });

    it('matches the NORMALIZED form (zero-width evasion still refused)', () => {
      const d = screenTaskForRefusal('st\u200Beal pass\u200Bword'.replace('pass', ' pass'), [
        { id: 'p', category: 'c', match: /steal password/, reason: 'r' },
      ]);
      expect(d.refuse).toBe(true);
    });

    it('non-match ⇒ allow (thin gate; "update my password" passes a phrase pattern)', () => {
      expect(screenTaskForRefusal('update my password on example.com', PATTERNS).refuse).toBe(
        false,
      );
    });

    it('malformed pattern entries are skipped, never thrown (fail-safe)', () => {
      const d = screenTaskForRefusal('steal password', [
        null as unknown as (typeof PATTERNS)[0],
        { id: 'x', category: 'c', match: 'not-a-regexp' as unknown as RegExp, reason: 'r' },
        { id: 'p', category: 'c', match: /steal password/, reason: 'caught' },
      ]);
      expect(d.refuse).toBe(true);
      expect(d.patternId).toBe('p');
    });

    it('global-flag regex is deterministic across repeated calls (lastIndex reset)', () => {
      const p = [{ id: 'g', category: 'c', match: /steal password/g, reason: 'r' }];
      expect(screenTaskForRefusal('steal password', p).refuse).toBe(true);
      expect(screenTaskForRefusal('steal password', p).refuse).toBe(true);
      expect(screenTaskForRefusal('steal password', p).refuse).toBe(true);
    });

    it('first matching pattern wins', () => {
      const d = screenTaskForRefusal('steal password', [
        { id: 'first', category: 'a', match: /steal/, reason: 'r1' },
        { id: 'second', category: 'b', match: /password/, reason: 'r2' },
      ]);
      expect(d.patternId).toBe('first');
    });
  });

  describe('loadRefusalPatterns (pure-data path, skip-not-throw)', () => {
    it('compiles valid entries', () => {
      const { patterns, skipped } = loadRefusalPatterns([
        { id: 'a', category: 'c', pattern: 'steal password', reason: 'r' },
      ]);
      expect(patterns).toHaveLength(1);
      expect(skipped).toHaveLength(0);
      expect(patterns[0]!.match).toBeInstanceOf(RegExp);
    });

    it('skips (with reasons) instead of throwing: missing fields, bad regex, non-object', () => {
      const { patterns, skipped } = loadRefusalPatterns([
        'not-an-object',
        { category: 'c', pattern: 'x', reason: 'r' }, // missing id
        { id: 'b', category: 'c', pattern: '(unclosed', reason: 'r' }, // bad regex
        { id: 'ok', category: 'c', pattern: 'fine', reason: 'r' },
      ]);
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.id).toBe('ok');
      expect(skipped.map((s) => s.reason)).toEqual([
        'entry is not an object',
        'missing/empty id',
        'uncompilable regex (bad source or flags)',
      ]);
    });

    it('non-array data ⇒ empty (never throws)', () => {
      expect(loadRefusalPatterns(null).patterns).toEqual([]);
      expect(loadRefusalPatterns({ nope: true }).patterns).toEqual([]);
    });

    it('end-to-end: loaded data refuses through the screen', () => {
      const { patterns } = loadRefusalPatterns([
        {
          id: 'e2e',
          category: 'credential_theft',
          pattern: "steal (?:someone'?s )?password",
          reason: 'no',
        },
      ]);
      expect(screenTaskForRefusal("steal someone's password", patterns).refuse).toBe(true);
    });

    it('W2162/W2167: skips catastrophic-backtracking (ReDoS) patterns with redos_complexity', () => {
      const { patterns, skipped } = loadRefusalPatterns([
        { id: 'nested', category: 'c', pattern: '(a+)+', reason: 'r' },
        { id: 'star', category: 'c', pattern: '(a*)*', reason: 'r' },
        { id: 'dotstar', category: 'c', pattern: '(.*)+', reason: 'r' },
        { id: 'doublegrp', category: 'c', pattern: '((a+))+', reason: 'r' },
        { id: 'openbrace', category: 'c', pattern: '(\\d+){2,}', reason: 'r' },
        { id: 'alt', category: 'c', pattern: '(a|a)+', reason: 'r' },
        { id: 'altgrp', category: 'c', pattern: '((a|a))+', reason: 'r' },
        { id: 'ok', category: 'c', pattern: 'steal password', reason: 'r' },
      ]);
      // Only the benign literal compiles into the active set.
      expect(patterns.map((p) => p.id)).toEqual(['ok']);
      expect(skipped).toHaveLength(7);
      expect(skipped.every((s) => s.reason.startsWith('redos_complexity'))).toBe(true);
    });

    it('hasNestedQuantifier flags both ReDoS classes but not safe forms', () => {
      // Catastrophic (nested + overlapping-alternation).
      for (const bad of [
        '(a+)+',
        '(a*)*',
        '(.*)+',
        '((a+))+',
        '(\\d+){2,}',
        '(a|a)+',
        '((a|a))+',
      ]) {
        expect(hasNestedQuantifier(bad)).toBe(true);
      }
      // Safe: bounded quantifier on a group, escaped parens, char-class `+`,
      // root-level alternation (not a quantified unit), single quantifier.
      for (const ok of ['(a+){2}', '\\(a+\\)+', '[a+]+', 'a|b', 'a+', 'steal password']) {
        expect(hasNestedQuantifier(ok)).toBe(false);
      }
    });
  });

  describe('resolveTaskRefusalConfig (production activation integrity)', () => {
    const valid = JSON.stringify([
      { id: 'cred', category: 'credential_theft', pattern: 'steal password', reason: 'no' },
    ]);

    it.each([undefined, '', '   '])('leaves an unconfigured production gate off for %s', (raw) => {
      expect(resolveTaskRefusalConfig(raw, 'production')).toEqual({
        configured: false,
        patterns: [],
        skipped: [],
        issue: null,
      });
    });

    it('loads a complete valid production policy', () => {
      const resolved = resolveTaskRefusalConfig(valid, 'production');
      expect(resolved.configured).toBe(true);
      expect(resolved.issue).toBeNull();
      expect(resolved.skipped).toEqual([]);
      expect(resolved.patterns.map((pattern) => pattern.id)).toEqual(['cred']);
    });

    it.each([
      ['invalid_json', '{not-json'],
      ['not_an_array', JSON.stringify({ policy: [] })],
      ['empty_array', '[]'],
      [
        'skipped_entries',
        JSON.stringify([
          { id: 'valid', category: 'c', pattern: 'safe phrase', reason: 'no' },
          { id: 'bad', category: 'c', pattern: '(a+)+', reason: 'no' },
        ]),
      ],
      [
        'skipped_entries',
        JSON.stringify([
          { id: 'valid', category: 'c', pattern: 'safe phrase', reason: 'no' },
          { id: 'missing-reason', category: 'c', pattern: 'blocked phrase' },
        ]),
      ],
    ])('refuses production %s instead of serving a partial or empty policy', (issue, raw) => {
      expect(() => resolveTaskRefusalConfig(raw, 'production')).toThrow(
        new RegExp(`DRIFTSTACK_TASK_REFUSAL_PATTERNS is configured but ${issue}`),
      );
    });

    it.each(['development', 'test'] as const)(
      'retains skip-and-inspect behavior in %s',
      (nodeEnv) => {
        const resolved = resolveTaskRefusalConfig(
          JSON.stringify([
            { id: 'valid', category: 'c', pattern: 'safe phrase', reason: 'no' },
            { id: 'bad', category: 'c', pattern: '(a+)+', reason: 'no' },
          ]),
          nodeEnv,
        );
        expect(resolved.issue).toBe('skipped_entries');
        expect(resolved.patterns.map((pattern) => pattern.id)).toEqual(['valid']);
        expect(resolved.skipped).toHaveLength(1);
      },
    );

    it('does not echo the raw policy in a production diagnostic', () => {
      const raw = '{SUPERSECRET-POLICY-TEXT';
      let caught: unknown;
      try {
        resolveTaskRefusalConfig(raw, 'production');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain(raw);
      expect((caught as Error).message).not.toContain('SUPERSECRET');
    });
  });

  describe('contract drift-guards (source pins)', () => {
    const src = readFileSync(SRC, 'utf8');

    it('DANGEROUS_UNICODE source is byte-identical to the agent-service canonical class', () => {
      // CI has no cross-repo checkout, so pin the LITERAL source (copied from
      // driftstack/agent-service/src/page-representation.ts W1019/W1112). If
      // A3 widens their class, this pin forces a deliberate A2 update.
      expect(src).toContain(
        '/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]/g',
      );
      // And the file itself must contain no RAW dangerous chars (the W1030
      // binary-to-tooling bug class).
      const rawDangerous = new RegExp(
        // eslint-disable-next-line no-control-regex -- intentionally hunting raw control chars
        '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E]',
      );
      expect(rawDangerous.test(src)).toBe(false);
    });

    it('normalize order pinned: truncate → strip → NFKC → lowercase → ws-collapse', () => {
      expect(src).toMatch(
        /\.replace\(DANGEROUS_UNICODE, ''\)\s*\.normalize\('NFKC'\)\s*\.toLowerCase\(\)\s*\.replace\(\/\\s\+\/g, ' '\)\s*\.trim\(\)/,
      );
      expect(src).toMatch(/MAX_SCREEN_CHARS = 8192/);
    });
  });
});
