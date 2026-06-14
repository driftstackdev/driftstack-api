// F1 assistant-templates — the pure pieces: shipped defaults, custom-template
// validation, and the merge order the picker renders.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ASSISTANT_TEMPLATES,
  cleanCustomTemplate,
  mergeTemplates,
  type AssistantTemplate,
} from '../../src/lib/assistant-templates';

describe('DEFAULT_ASSISTANT_TEMPLATES', () => {
  it('are all builtin, uniquely ided, with non-empty prompts (incl. a warming preset)', () => {
    expect(DEFAULT_ASSISTANT_TEMPLATES.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const t of DEFAULT_ASSISTANT_TEMPLATES) {
      expect(t.builtin).toBe(true);
      expect(t.prompt.trim().length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
      ids.add(t.id);
    }
    expect(ids.size).toBe(DEFAULT_ASSISTANT_TEMPLATES.length);
    expect(ids.has('warm-browse')).toBe(true);
  });
});

describe('cleanCustomTemplate', () => {
  it('accepts a valid custom + forces builtin false', () => {
    const t = cleanCustomTemplate({
      id: 'c1',
      label: 'Mine',
      description: 'desc',
      prompt: 'do a thing',
      builtin: true, // should be forced to false
    });
    expect(t).toEqual({
      id: 'c1',
      label: 'Mine',
      description: 'desc',
      prompt: 'do a thing',
      builtin: false,
    });
  });

  it('rejects malformed entries (missing id / empty prompt / non-object)', () => {
    expect(cleanCustomTemplate(null)).toBeNull();
    expect(cleanCustomTemplate({ label: 'x', prompt: 'y' })).toBeNull(); // no id
    expect(cleanCustomTemplate({ id: 'c', label: 'x', prompt: '   ' })).toBeNull(); // empty prompt
  });

  it('defaults a missing description to empty + clamps lengths', () => {
    const t = cleanCustomTemplate({ id: 'c', label: 'a'.repeat(200), prompt: 'p' });
    expect(t?.description).toBe('');
    expect(t?.label.length).toBe(80);
  });
});

describe('mergeTemplates', () => {
  it('lists defaults first, then customs', () => {
    const custom: AssistantTemplate = {
      id: 'c1',
      label: 'Mine',
      description: '',
      prompt: 'p',
      builtin: false,
    };
    const merged = mergeTemplates([custom]);
    expect(merged.length).toBe(DEFAULT_ASSISTANT_TEMPLATES.length + 1);
    expect(merged[0]?.builtin).toBe(true);
    expect(merged[merged.length - 1]).toEqual(custom);
  });
});
