// W546.A — drift guard for /docs/CAPABILITIES.md.
// Fingerprint parity closure backlog. Per AGENTS.md "CAPABILITIES.md
// as truth source" framing — every documented capability must work
// end-to-end. Drift here either weakens the zero-detectable-delta
// bar (would re-introduce "observable-by-design" / "acceptable
// residual" deferral language), changes the namespace convention
// (would conflate main-repo V-IDs with control-plane V-IDs), or
// drops a category header (would orphan residual entries during
// table evolution).
//
//   • Status snapshot: 18 open residuals (as of 2026-05-03 V-149).
//   • Cumulative rig: 1252/1493 match, zero critical-surface diffs.
//   • Target: 100% match against iPhone 17 Pro / iOS 26 Safari.
//   • Bar framing: zero-detectable-delta, NO observable-by-design /
//     NO acceptable residual / NO edge case (all deferral language).
//   • Namespace note: bare V-NNN = main-repo log; V-NNN [control]
//     = control-plane log.
//   • Closure-only retirement rule: delete rows on rig-zero
//     confirmation.
//   • V-149 audit-footnote closure (Q8 snap on Simple-path).
//   • 8 categories (Canvas2D × 5 + Layout + JS-API-surface + Perf
//     Timing) + 6 no-residual categories.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/CAPABILITIES.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W546.A /docs/CAPABILITIES.md content parity', () => {
  const body = read(LIB);

  it("Header + status-snapshot + 18-open-residuals + cumulative-rig framing pinned: '# Driftstack — fingerprint parity closure backlog' + '**Status snapshot:** 18 open residuals (as of 2026-05-03, per main-repo V-149).' + 'Cumulative rig: **1252/1493 match**, zero critical-surface diffs.' + 'This document is the **closure backlog for fingerprint parity** — not marketing copy, not a status report.' + 'The bar is **100% match against genuine iPhone 17 Pro running iOS 26 Safari**, measured by the detection rig.' + 'Every non-zero residual listed here is an open item until the rig reads zero detectable delta. Entries retire only on rig-verified closure; closed entries are removed.' — pinned so the 18-open-residuals-as-of-V-149 + 1252/1493-match + zero-critical-surface-diffs + iPhone-17-Pro-iOS-26-Safari-bar + 100%-match-target + closure-only-retirement-rule commitment survives", () => {
    expect(body).toMatch(/^# Driftstack — fingerprint parity closure backlog$/m);
    expect(body).toMatch(
      /\*\*Status snapshot:\*\* 18 open residuals \(as of 2026-05-03, per main-repo V-149\)\./,
    );
    expect(body).toMatch(/Cumulative rig: \*\*1252\/1493 match\*\*, zero critical-surface diffs\./);
    expect(body).toMatch(
      /This document is the \*\*closure backlog for fingerprint parity\*\* — not/,
    );
    expect(body).toMatch(/marketing copy, not a status report\./);
    expect(body).toMatch(/The bar is \*\*100% match against\s*genuine iPhone 17 Pro/);
    expect(body).toMatch(/iOS 26 Safari\*\*, measured by the/);
    expect(body).toMatch(/detection rig\./);
    expect(body).toMatch(/Every non-zero residual listed here is an open item/);
    expect(body).toMatch(/until the rig reads zero detectable delta\. Entries retire only on/);
    expect(body).toMatch(/rig-verified closure; closed entries are removed\./);
  });

  it('No-deferral-language framing pinned: \'There is no "observable-by-design", no "acceptable residual", no "edge case." Those frames are deferral language. This doc is a parity ledger.\' — pinned so the NO-observable-by-design + NO-acceptable-residual + NO-edge-case + parity-ledger-framing commitment survives (drift to admitting any of those 3 deferral frames would weaken the zero-detectable-delta bar)', () => {
    expect(body).toMatch(/There is no "observable-by-design", no "acceptable residual", no/);
    expect(body).toMatch(/"edge case\." Those frames are deferral language\. This doc is a/);
    expect(body).toMatch(/parity ledger\./);
  });

  it("Entry-format 6-column table framing pinned: '## How to read this doc' + 'Every entry follows the same format:' + 'Surface | Exact API / wire / pixel / metric being measured.' + 'Current delta | Observed difference vs the iPhone 17 Pro / iOS 26 reference rig. Numerical when available (bytes, ULPs, pixels, ms).' + 'Target | Always **zero detectable delta**.' + 'Closure path | The patch ID, capture pass, or analysis approach planned. References to `wave-N-…` are WebKit-fork patches in `webkit-driftstack` (see `MODIFICATIONS.md` there).' + 'Status | `open` ... `in flight: <ref>` ... cross-references to V-IDs of the work.' + 'V-log | Citations to verification-log entries.' — pinned so the 6-column-table format (Surface + Current-delta + Target + Closure-path + Status + V-log) + wave-N-WebKit-fork-MODIFICATIONS.md anchor commitment survives", () => {
    expect(body).toMatch(/## How to read this doc/);
    expect(body).toMatch(/Every entry follows the same format:/);
    expect(body).toMatch(/Surface\s+\|\s+Exact API \/ wire \/ pixel \/ metric being measured\./);
    expect(body).toMatch(/Numerical when available \(bytes, ULPs, pixels, ms\)/);
    expect(body).toMatch(/Target\s+\|\s+Always \*\*zero detectable delta\*\*\./);
    expect(body).toMatch(/References to `wave-N-…` are WebKit-fork patches in `webkit-driftstack`/);
    expect(body).toMatch(/`open`/);
    expect(body).toMatch(/`in flight: <ref>`/);
    expect(body).toMatch(/V-log\s+\|\s+Citations to verification-log entries\./);
  });

  it("2-V-log-stream namespace-note framing pinned: '## Numbering namespace note' + 'There are two parallel verification-log streams that both start at V-031:' + '**Main repo** (`/operations/verification-log.md`) — fingerprint closure work (V-031–V-143+ as of this writing). All entries below cite this stream by default.' + '**Control-plane repo** (this repo, `docs/verification-log.md`) — API / SDK / GUI / contract work (V-031–V-039 as of this writing). No fingerprint residuals are tracked here.' + 'When CAPABILITIES.md cites a V-ID, default is main repo unless suffixed `[control]`.' — pinned so the 2-parallel-V-log-stream + main-repo-V-031-V-143+ + control-plane-V-031-V-039 + suffix-[control]-disambiguation commitment survives", () => {
    expect(body).toMatch(/## Numbering namespace note/);
    expect(body).toMatch(/There are two parallel verification-log streams that both start at/);
    expect(body).toMatch(/V-031:/);
    expect(body).toMatch(
      /- \*\*Main repo\*\* \(`\/operations\/verification-log\.md`\) — fingerprint/,
    );
    expect(body).toMatch(/closure work \(V-031–V-143\+ as of this writing\)\./);
    expect(body).toMatch(
      /- \*\*Control-plane repo\*\* \(this repo, `docs\/verification-log\.md`\) —/,
    );
    expect(body).toMatch(/API \/ SDK \/ GUI \/ contract work \(V-031–V-039 as of this writing\)\./);
    expect(body).toMatch(/No fingerprint residuals are tracked here\./);
    expect(body).toMatch(/When CAPABILITIES\.md cites a V-ID, default is main repo unless/);
    expect(body).toMatch(/suffixed `\[control\]`\./);
  });

  it("Total-open-count + 18-residual breakdown framing pinned: '## Total open count' + 'As of **2026-05-03 (V-149)**: **18 open residuals.**' + '8 in flight (patch / capture / analyzer in motion).' + '5 open with side-effect closure pending (root cause closes them).' + '5 open with no patch in flight (founder-deferred or blocked on investigation).' — pinned so the 18-open = 8-in-flight + 5-side-effect-pending + 5-no-patch-in-flight commitment survives", () => {
    expect(body).toMatch(/## Total open count/);
    expect(body).toMatch(/As of \*\*2026-05-03 \(V-149\)\*\*: \*\*18 open residuals\.\*\*/);
    expect(body).toMatch(/- 8 in flight \(patch \/ capture \/ analyzer in motion\)\./);
    expect(body).toMatch(/- 5 open with side-effect closure pending \(root cause closes them\)\./);
    expect(body).toMatch(
      /- 5 open with no patch in flight \(founder-deferred or blocked on investigation\)\./,
    );
  });

  it("8-category + 6-no-residual + trajectory-anchor framing pinned: '## Category: Canvas2D — Glyph Advance Width' + '## Category: Canvas2D — Pixel Rasterization' + '## Category: Canvas2D — Stage F (Complex Scripts & Transforms)' + '## Category: Canvas2D — Encoder MIME Types' + '## Category: Layout & Typography' + '## Category: JS API surface' + '## Category: Performance Timing' + '## Categories with no current open residuals' + 'Apple secure-context surfaces' + 'Audio — speech synthesis voice names (closed in V-112).' + 'JS DOM event surfaces' + 'WebGL / Metal / ANGLE' + 'Network / TLS / HTTP / WebRTC' + 'Permissions / Sensors / Storage / Service Workers' + '## Trajectory anchors (for context, not closure tracking)' + 'V-072 baseline' + 'V-119–V-120' + 'V-123' + 'V-143' + 'V-148-Complex' + 'V-149' — pinned so the 7-category-with-open-residuals + 6-no-residual-category + 6-trajectory-V-anchor commitment survives (drift to dropping or renaming a category would orphan residuals on table evolution)", () => {
    expect(body).toMatch(/## Category: Canvas2D — Glyph Advance Width/);
    expect(body).toMatch(/## Category: Canvas2D — Pixel Rasterization/);
    expect(body).toMatch(/## Category: Canvas2D — Stage F \(Complex Scripts & Transforms\)/);
    expect(body).toMatch(/## Category: Canvas2D — Encoder MIME Types/);
    expect(body).toMatch(/## Category: Layout & Typography/);
    expect(body).toMatch(/## Category: JS API surface/);
    expect(body).toMatch(/## Category: Performance Timing/);
    expect(body).toMatch(/## Categories with no current open residuals/);
    expect(body).toMatch(/- \*\*Apple secure-context surfaces\*\*/);
    expect(body).toMatch(/- \*\*Audio — speech synthesis voice names\*\* \(closed in V-112\)\./);
    expect(body).toMatch(/- \*\*JS DOM event surfaces\*\*/);
    expect(body).toMatch(/- \*\*WebGL \/ Metal \/ ANGLE\*\*/);
    expect(body).toMatch(/- \*\*Network \/ TLS \/ HTTP \/ WebRTC\*\*/);
    expect(body).toMatch(/- \*\*Permissions \/ Sensors \/ Storage \/ Service Workers\*\*/);
    expect(body).toMatch(/## Trajectory anchors \(for context, not closure tracking\)/);
    expect(body).toMatch(/V-072 baseline/);
    expect(body).toMatch(/V-119–V-120/);
    expect(body).toMatch(/V-148-Complex/);
    expect(body).toMatch(/V-149/);
  });

  it("V-149 closure + 1252/1493 trajectory framing pinned: 'Removed from the tables below per the rig-zero retirement rule:' + '`canvas.measureText.fonts.value['-apple-system'].width` — closed via **V-149** (2026-05-03).' + 'V-148-Complex (the ComplexTextController hook integration) landed at WebKit-fork commit `e522811f5a`' + 'V-148-PM established that V-148-Complex was the wrong place to look for the cumulative-rig 0.002 px residual (probe routes Simple, not Complex); V-149 closed via the Simple-path Q8 snap.' + 'V-149          | 2026-05-03 | 1252/1493' + 'Q8 snap on Simple-path V-138 over-correction. `-apple-system` width = `163.73046875` = iPhone EXACT. **Closes the −apple-system glyph-advance residual.**' + 'rig grew between V-143 and V-148 as additional probes were added; the +1 in the match count is the load-bearing closure number.' — pinned so the V-149-closure + e522811f5a-fork-commit + V-148-PM-Simple-not-Complex-finding + 163.73046875-iPhone-EXACT + rig-grew-from-1253-to-1493 commitment survives", () => {
    expect(body).toMatch(/Removed from the tables below per the rig-zero retirement rule:/);
    expect(body).toMatch(
      /`canvas\.measureText\.fonts\.value\['-apple-system'\]\.width`\*\* — closed/,
    );
    expect(body).toMatch(/via \*\*V-149\*\* \(2026-05-03\)\./);
    expect(body).toMatch(/V-148-Complex \(the ComplexTextController hook integration\) landed at/);
    expect(body).toMatch(/WebKit-fork commit `e522811f5a` and is correctly hooked; V-148-PM/);
    expect(body).toMatch(/established that V-148-Complex was the wrong place to look for the/);
    expect(body).toMatch(/cumulative-rig 0\.002 px residual \(probe routes Simple, not Complex\);/);
    expect(body).toMatch(/V-149 closed via the Simple-path Q8 snap\./);
    expect(body).toMatch(/V-149\s+\|\s+2026-05-03\s+\|\s+1252\/1493/);
    expect(body).toMatch(
      /Q8 snap on Simple-path V-138 over-correction\. `-apple-system` width = `163\.73046875` = iPhone EXACT\./,
    );
    expect(body).toMatch(/\*\*Closes the −apple-system glyph-advance residual\.\*\*/);
    expect(body).toMatch(/rig grew between V-143 and V-148/);
    expect(body).toMatch(/additional probes were added/);
    expect(body).toMatch(/\+1 in the match count/);
    expect(body).toMatch(/load-bearing closure number\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
