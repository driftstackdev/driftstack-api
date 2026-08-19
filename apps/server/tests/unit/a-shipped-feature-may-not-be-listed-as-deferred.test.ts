// V-866 — the launch checklist and the feature catalog both listed the Tauri
// deep-link scheme as DEFERRED. It shipped in V-328.
//
// `tauri-plugin-deep-link = "2.0"` is a dependency, `tauri.conf.json` registers
// `"schemes": ["driftstack"]`, and `App.tsx` installs an always-on listener via
// `lib/app-deep-link-listener.ts`. The remaining work is a per-OS native-bundle
// run — a validation task, recorded in docs/founder-actions — not an unbuilt
// feature. "DEFERRED" tells someone triaging launch readiness that there is code
// to write, which is the same cost V-866 found in the GUI audit's stale P0.
//
// It rotted in FOUR places across two documents and none of them was pinned.
// That is why this guard derives the answer instead of freezing a sentence: a
// pin on any one of the four would have left the other three free to drift, and
// the drift is what happened.
//
// The rule it encodes is narrow on purpose. It does not require the docs to
// describe the feature in any particular way, only that they may not call it
// deferred while the plugin and the scheme are both registered. If the plugin is
// ever dropped, the liveness arm fails first and "deferred" becomes sayable
// again — so the guard cannot outlive the fact it depends on.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const CARGO = resolve(REPO_ROOT, 'apps/gui-client/src-tauri/Cargo.toml');
const TAURI_CONF = resolve(REPO_ROOT, 'apps/gui-client/src-tauri/tauri.conf.json');
const APP_TSX = resolve(REPO_ROOT, 'apps/gui-client/src/App.tsx');

/** Readiness documents whose deferred-lists a triager actually reads. */
const READINESS_DOCS = [
  'docs/launch/pre-launch-checklist.md',
  'docs/architecture/v294-feature-catalog.md',
] as const;

/** Lines naming the feature AND calling it deferred, across every readiness doc. */
function deferredMentions(): string[] {
  const out: string[] = [];
  for (const rel of READINESS_DOCS) {
    const body = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    body.split('\n').forEach((line, i) => {
      const namesFeature = /Tauri custom URL scheme|driftstack:\/\//i.test(line);
      // Struck-through corrections quote the old status on purpose; they are the
      // fix, not the defect. Without this the guard would fire on the very edit
      // that closed the finding — the shape V-794 documents at length.
      const isCorrection = /~~/.test(line);
      if (namesFeature && /\bDEFERRED\b/.test(line) && !isCorrection) {
        out.push(`${rel}:${String(i + 1)}`);
      }
    });
  }
  return out;
}

describe('V-866 a shipped feature may not be listed as deferred', () => {
  it('CRITICAL the readiness docs really parse and really mention this feature. The arm below reports an ABSENCE, so an empty read or a renamed feature would satisfy it having compared nothing — the false-green shape this sweep kept finding.', () => {
    const mentions = READINESS_DOCS.map(
      (rel) =>
        readFileSync(resolve(REPO_ROOT, rel), 'utf8')
          .split('\n')
          .filter((l) => /Tauri custom URL scheme|driftstack:\/\//i.test(l)).length,
    );
    for (const [i, n] of mentions.entries()) {
      expect(n, `${READINESS_DOCS[i] ?? ''} mentions the deep-link feature`).toBeGreaterThan(0);
    }
  });

  it('CRITICAL the deep-link scheme is actually registered, which is the fact the rule below depends on. Asserted first and separately: if the plugin is ever dropped, this fails before the docs arm does, and calling the feature deferred becomes correct again.', () => {
    expect(readFileSync(CARGO, 'utf8'), 'the plugin dependency').toMatch(
      /tauri-plugin-deep-link = "2\.0"/,
    );
    expect(readFileSync(TAURI_CONF, 'utf8'), 'the registered URL scheme').toMatch(
      /"schemes":\s*\[\s*"driftstack"\s*\]/,
    );
    expect(readFileSync(APP_TSX, 'utf8'), 'and a listener installed at app boot').toMatch(
      /installAppDeepLinkSources/,
    );
  });

  it('CRITICAL no readiness document calls this feature deferred while it is registered above. It said so in four places across two documents, none of them pinned, so fixing any one would have left the rest drifting. A struck-through correction is exempt: quoting the old status to retract it is the fix, not a repeat of the defect.', () => {
    expect(
      deferredMentions(),
      'these lines call a shipped feature deferred. The outstanding work is a per-OS bundle run (docs/founder-actions/v328-tauri-deep-link-test.md), which is validation, not implementation:',
    ).toEqual([]);
  });
});
