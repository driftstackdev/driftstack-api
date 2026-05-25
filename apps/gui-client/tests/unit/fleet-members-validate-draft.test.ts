// Pure-function tests for validateDraft (fleet-members.ts) — governs the
// FleetView "add Mac node" form's Save-button enabled state. A regression
// here would either block legitimate fleet-member adds or let an invalid
// baseUrl through to the ping/dispatch layer. Companion to
// proxies-validate-draft; fleet-members.validateDraft had no direct test.

import { describe, expect, it } from 'vitest';
import { validateDraft, type FleetMemberDraft } from '../../src/lib/fleet-members';

function draft(over: Partial<FleetMemberDraft> = {}): FleetMemberDraft {
  return { label: 'mac-mini-01', baseUrl: 'https://mac-01.driftstack.dev', notes: null, ...over };
}

describe('validateDraft (gui-client/lib/fleet-members)', () => {
  it('accepts the canonical happy-path draft (https)', () => {
    const r = validateDraft(draft());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
  });

  it('accepts an http:// baseUrl', () => {
    expect(validateDraft(draft({ baseUrl: 'http://localhost:3000' })).ok).toBe(true);
  });

  it('flags an empty / whitespace-only label as Required', () => {
    expect(validateDraft(draft({ label: '' })).errors.label).toBe('Required.');
    expect(validateDraft(draft({ label: '   ' })).errors.label).toBe('Required.');
  });

  it('flags an empty baseUrl as Required', () => {
    const r = validateDraft(draft({ baseUrl: '' }));
    expect(r.ok).toBe(false);
    expect(r.errors.baseUrl).toBe('Required.');
  });

  it('flags an unparseable baseUrl as Invalid URL', () => {
    expect(validateDraft(draft({ baseUrl: 'not a url' })).errors.baseUrl).toBe('Invalid URL.');
  });

  it('flags a non-http(s) scheme (e.g. ftp://) explicitly', () => {
    expect(validateDraft(draft({ baseUrl: 'ftp://mac-01.driftstack.dev' })).errors.baseUrl).toBe(
      'Must be http:// or https:// URL.',
    );
  });

  it('notes is free-form and never blocks validity', () => {
    expect(validateDraft(draft({ notes: 'rack 3, behind the NAT' })).ok).toBe(true);
    expect(validateDraft(draft({ notes: null })).ok).toBe(true);
  });
});
