// A constant a release removed keeps its deprecation window.
//
// docs/architecture/sdk-versioning.md is explicit: a removal ships only AFTER
// at least one released MINOR that carried the deprecation notice, pre-1.0
// included. The never-tagged Go 0.2.0 removed six exported constants outright
// — the four `AccountTier` names of the single pricing ladder, and the two
// quota `WebhookEventType` names — so no released version ever warned about
// them. v0.3.0 restores all six as DEPRECATED constants: a v0.1.6 program
// compiles again, `go vet`/staticcheck report the use, and the removal can
// happen in a later MINOR with the window actually served.
//
// WHAT THIS GUARD PROTECTS, in the order it matters:
//
//   1. The six names exist. Deleting one again re-opens the break this
//      release closed.
//   2. Each carries a `Deprecated:` notice on the line(s) directly above it.
//      A restored constant with no notice is worse than a removal: it looks
//      current, so nobody migrates, and the removal lands unannounced.
//   3. Each notice says what to reach for instead. "Deprecated." alone tells
//      a reader to stop and nothing else.
//   4. None of them is in the LIVE roster const block. The quota events are
//      not sent and cannot be subscribed to; the old tiers are values the
//      server cannot return. Listing them beside the current values would
//      say the opposite of what the notice says.
//   5. The CHANGELOG states the window: they compile with a deprecation
//      warning now and go in a later MINOR. The doc comment is what a reader
//      hovering the symbol sees; the CHANGELOG is what someone planning an
//      upgrade reads. Both or neither.
//
// The arms that read the real file are paired with NEGATIVE CONTROLS over
// fixture text, because "every name has a notice above it" is exactly the
// shape of claim that also passes when the matcher is broken and finds
// nothing anywhere.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const GO_TYPES = resolve(REPO_ROOT, 'packages/sdk-go/types.go');
const GO_CHANGELOG = resolve(REPO_ROOT, 'packages/sdk-go/CHANGELOG.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/**
 * The constant declaration, together with the comment block that sits
 * immediately above it and nothing else. Returns null when the constant is
 * absent, which the arms below distinguish from "present without a notice".
 */
export function noticeAbove(source: string, name: string): string | null {
  const decl = new RegExp(`^\\s*${name}\\s+\\w+\\s*=\\s*"[^"]*"\\s*$`, 'm');
  const m = decl.exec(source);
  if (m === null) return null;
  const before = source.slice(0, m.index).split('\n');
  // The match starts at the beginning of the declaration's own line, so the
  // last element here is the empty string in front of it. Dropping it is what
  // makes the walk start on the comment line rather than stopping instantly —
  // without this the function returns "" for every constant, notice or not.
  if ((before[before.length - 1] ?? '').trim() === '') before.pop();
  const comment: string[] = [];
  for (let i = before.length - 1; i >= 0; i--) {
    const line = (before[i] ?? '').trim();
    if (line.startsWith('//')) comment.unshift(line);
    else break;
  }
  return comment.join('\n');
}

/** The const block a named constant is declared in, braces included. */
export function constBlockContaining(source: string, name: string): string | null {
  const blocks = source.match(/^const \(\n[\s\S]*?^\)$/gm) ?? [];
  return blocks.find((b) => new RegExp(`^\\s*${name}\\s`, 'm').test(b)) ?? null;
}

const RESTORED = [
  { name: 'TierStarter', value: 'starter', useInstead: 'TierAPIStarter' },
  { name: 'TierSolo', value: 'solo', useInstead: 'TierSoloManual' },
  { name: 'TierBuilder', value: 'builder', useInstead: 'TierAPIBuilder' },
  { name: 'TierScale', value: 'scale', useInstead: 'TierAPIScale' },
  {
    name: 'EventQuotaWarning80Pct',
    value: 'quota.warning_80pct',
    useInstead: 'Usage.CurrentPeriod',
  },
  { name: 'EventQuotaExceeded', value: 'quota.exceeded', useInstead: 'Usage.CurrentPeriod' },
] as const;

describe('a constant a release removed keeps its deprecation window', () => {
  const types = read(GO_TYPES);

  it('CRITICAL all six constants the never-tagged 0.2.0 removed are declared again, with the wire value they had in v0.1.6 — a program written against that tag compiles', () => {
    for (const { name, value } of RESTORED) {
      expect(types, `${name} must be declared`).toMatch(
        new RegExp(`^\\s*${name}\\s+\\w+ = "${value.replace(/\./g, '\\.')}"$`, 'm'),
      );
    }
  });

  it('CRITICAL each restored constant carries a `Deprecated:` notice directly above it, and the notice names what to use instead', () => {
    for (const { name, useInstead } of RESTORED) {
      const notice = noticeAbove(types, name);
      expect(notice, `${name} must be declared`).not.toBeNull();
      expect(notice, `${name} needs a Deprecated: notice`).toMatch(/\/\/ Deprecated:/);
      expect(notice, `${name}'s notice must name what to use instead`).toContain(useInstead);
    }
  });

  it('CRITICAL none of the six sits in the live roster: the deprecated names are declared in their own const block, away from the values the server actually uses', () => {
    const liveTiers = constBlockContaining(types, 'TierAPIStarter');
    const liveEvents = constBlockContaining(types, 'EventSessionCompleted');
    expect(liveTiers, 'the live AccountTier block must be present').not.toBeNull();
    expect(liveEvents, 'the live WebhookEventType block must be present').not.toBeNull();
    for (const { name } of RESTORED) {
      expect(liveTiers, `${name} must not be in the live tier block`).not.toMatch(
        new RegExp(`\\b${name}\\b`),
      );
      expect(liveEvents, `${name} must not be in the live event block`).not.toMatch(
        new RegExp(`\\b${name}\\b`),
      );
    }
  });

  it('CRITICAL the CHANGELOG states the window rather than leaving it to the doc comments: they compile with a deprecation warning now, and go in a later MINOR', () => {
    const changelog = read(GO_CHANGELOG);
    expect(changelog).toMatch(/deprecat/i);
    expect(changelog).toMatch(/removed in a later (?:MINOR|minor)/);
    for (const { name } of RESTORED) {
      expect(changelog, `${name} must be named in the migration notes`).toContain(name);
    }
  });

  it('NEGATIVE CONTROL the notice check fails on a constant without one, and on one whose notice says nothing about the replacement', () => {
    const withNotice = [
      'const (',
      '\t// Deprecated: use TierAPIStarter.',
      '\tTierX AccountTier = "x"',
      ')',
    ].join('\n');
    const bare = ['const (', '\tTierX AccountTier = "x"', ')'].join('\n');
    const vague = ['const (', '\t// Deprecated.', '\tTierX AccountTier = "x"', ')'].join('\n');

    expect(noticeAbove(withNotice, 'TierX')).toMatch(/\/\/ Deprecated:/);
    expect(noticeAbove(withNotice, 'TierX')).toContain('TierAPIStarter');
    expect(noticeAbove(bare, 'TierX')).toBe('');
    expect(noticeAbove(vague, 'TierX')).not.toMatch(/\/\/ Deprecated:/);
    // Absent, not merely un-noticed — the two must not read the same.
    expect(noticeAbove(bare, 'TierNotHere')).toBeNull();
  });

  it('NEGATIVE CONTROL the live-roster check fails when a deprecated name is moved back in beside the current values', () => {
    const mixed = [
      'const (',
      '\tEventSessionCompleted WebhookEventType = "session.completed"',
      '\tEventQuotaExceeded WebhookEventType = "quota.exceeded"',
      ')',
    ].join('\n');
    const block = constBlockContaining(mixed, 'EventSessionCompleted');
    expect(block).not.toBeNull();
    expect(block).toMatch(/\bEventQuotaExceeded\b/);
    // …and the real file is the other way round.
    expect(constBlockContaining(types, 'EventSessionCompleted')).not.toMatch(
      /\bEventQuotaExceeded\b/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(GO_TYPES)).toBe(true);
    expect(existsSync(GO_CHANGELOG)).toBe(true);
  });
});
