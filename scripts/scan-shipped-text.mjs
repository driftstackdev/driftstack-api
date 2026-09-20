#!/usr/bin/env node
// Nothing internal ships in a published package.
//
// The owner's rule for customer-facing text is that it says WHAT the product
// does, never HOW it is built inside. Four artifacts carry that text to people
// who are not us — npm `@driftstack/sdk`, npm `@driftstack/api-types`, the PyPI
// wheel + sdist, and the Go module at its tag — and against published baselines
// of zero they currently carry internal ticket ids and internal infrastructure
// vocabulary. This scans what SHIPS and says where.
//
// WHY A SCRIPT AND NOT A GREP. "What ships" is not a glob. It is decided by
// `package.json` `files` plus npm's automatic set, by hatchling's include rules
// plus its force-includes, and by what git tracks under the Go module. Three
// different answers, none of them a directory listing. A grep over `packages/`
// scans tests and examples that never ship and misses the two things that do
// ship and are not source: the `.d.ts` a customer's editor shows on hover, and
// the TypeScript source text embedded in `dist/*.map` as `sourcesContent`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT SHIPS, PER PACKAGE, AND HOW THE LIST IS DERIVED
//
// npm (`@driftstack/sdk`, `@driftstack/api-types`)
//   Primary: `npm pack --dry-run --json` in the package directory. No network,
//   no credential — npm computes the tarball contents locally. Reproduced today
//   as 10 files for the SDK and 108 for api-types.
//   Fallback: `files` from package.json, directories expanded, plus npm's
//   automatic set (package.json, README, LICENSE). `--npm-method derived`
//   forces it. The two methods are cross-checked by the guard test: a hand
//   written expansion that silently narrows is the failure this whole file
//   exists to prevent, so it is measured rather than assumed.
//
// PyPI (`driftstack-sdk`)
//   Primary: `packages/sdk-python/.venv/bin/python -m build` into a temp dir,
//   when `build` is importable there. CI's venv installs `.[dev]`, which does
//   NOT include `build`, so CI takes the fallback.
//   Fallback: derived from `pyproject.toml`.
//     wheel  = every file under each `[tool.hatch.build.targets.wheel]
//              packages` entry, plus README.md — because the wheel's
//              `*.dist-info/METADATA` embeds the README verbatim as the long
//              description, which is what PyPI renders — plus LICENSE.
//     sdist  = the `[tool.hatch.build.targets.sdist] include` entries, plus
//              PKG-INFO (the README again), plus the `.gitignore` hatchling
//              FORCE-INCLUDES from the nearest VCS ignore file. That
//              force-include is not an edge case: it put the repository-root
//              `.gitignore` on PyPI verbatim, and
//              `the-python-sdist-carries-a-publishable-ignore-file.test.ts`
//              exists because of it.
//   The two methods produce the same finding counts; `--python-method both`
//   runs them together and reports each.
//
// Go (`packages/sdk-go`)
//   The module zip the proxy serves is the module directory at the tag, so the
//   list is what git has there: tracked files plus untracked-not-ignored ones,
//   because this release adds LICENSE and it is not committed yet.
//
//   EXAMPLES ARE INCLUDED. `packages/sdk-go/examples/*` carry no go.mod of
//   their own, so they are packages OF THIS MODULE: they travel in the zip and
//   pkg.go.dev gives each one its own page under Directories, doc comment and
//   all. Nothing excludes them, so they ship and they are scanned.
//
//   `_test.go` IS EXCLUDED, and this is the scanner's largest blind spot rather
//   than a claim that the files are private. They DO travel in the module zip —
//   `go mod download` writes them into the module cache — and pkg.go.dev renders
//   any `Example*` function from them inside the package documentation. They are
//   excluded because the release brief scopes this sweep to non-test files and
//   because the 32 of them are where the SDK keeps its deliberately-synthetic
//   credentials. `--go-tests` includes them; the number is reported separately
//   under the `go-tests` artifact so the decision stays visible instead of
//   being a silent zero.
//
// ─────────────────────────────────────────────────────────────────────────────
// BLIND SPOTS (see BLIND_SPOTS below — printed by every run, for the reason
// `a-gate-that-does-not-name-its-blind-spot-reads-as-total.test.ts` gives).
//
// ⚠️ THE NPM PACKAGES ARE READ FROM `dist/`, NOT FROM `src/`.
// `@driftstack/sdk` ships a bundle and `@driftstack/api-types` ships compiled
// modules; `packages/*/dist` is gitignored, so what this scans is whatever the
// last local build left there. Rewrite a doc comment in `src` and re-run without
// rebuilding and the numbers will not move — which reads as "the edit did not
// work". Rebuild first:
//
//   npm run build -w packages/api-types
//   npm run build -w packages/sdk-typescript
//
// (CI's build-test job builds both before the suite runs, so this is a local
// footgun only.) The Python and Go lists are read from source and need no build.
//
// Usage:
//   node scripts/scan-shipped-text.mjs                       all four packages
//   node scripts/scan-shipped-text.mjs --package sdk-typescript
//   node scripts/scan-shipped-text.mjs --package api-types --json
//   node scripts/scan-shipped-text.mjs --package sdk-python --python-method both
//   node scripts/scan-shipped-text.mjs --package sdk-go --go-tests
// Exit 1 when anything is found, 0 when clean, 2 on a usage or derivation error.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TICKET_ID = 'ticket-id';
export const INTERNAL_VOCABULARY = 'internal-vocabulary';

/**
 * The shapes to report. Every pattern below was derived by running this scanner
 * over today's artifacts and reading what it matched — not from memory of what
 * the repo's ticket ids look like. `seen` records the concrete strings that
 * justified the shape, so a later reader can tell a live rule from a guess.
 *
 * Patterns are global and are re-used across files; `scanText` resets
 * `lastIndex` before each use rather than trusting the caller.
 */
export const RULES = Object.freeze([
  // ── internal ticket / work-item ids ────────────────────────────────────────
  {
    id: 'verdict-id',
    class: TICKET_ID,
    // The sub-item suffixes are not decoration: `\bV-\d{2,4}\b` matches NEITHER
    // `V-352b` nor `V-295c3` (the trailing letter kills the word boundary), and
    // 350+ occurrences across the four artifacts wear one. A first version of
    // this rule missed every one of them and reported a smaller, confident,
    // wrong number. The slash tail matches a whole id LIST (`V-326c/V-326e`,
    // `V-353d/e`, `V-216 / V-449`) as one hit, so removing it from a sentence
    // does not leave an orphaned separator behind.
    pattern:
      /\bV-\d{2,4}(?:[a-z]\d?)?(?:\.[A-Z]{1,3})?(?:\s*\/\s*(?:V-\d{2,4}(?:[a-z]\d?)?|[a-z]\b))*/g,
    why: 'an internal verdict/ticket id',
    seen: [
      'V-026',
      'V-312',
      'V-666',
      'V-2011',
      'V-352b',
      'V-295c3',
      'V-666.BU',
      'V-326c/V-326e',
      'V-353d/e',
    ],
  },
  {
    id: 'workstream-id',
    class: TICKET_ID,
    pattern: /\bW-?\d{3,4}\b/g,
    why: 'an internal workstream id',
    seen: ['W140', 'W834', 'W1150', 'W2980'],
  },
  {
    id: 'decision-id',
    class: TICKET_ID,
    // Single-letter prefixes the repo uses for decision / ticket ledgers.
    pattern: /\b[DLNPT]-\d{1,3}\b/g,
    why: 'an internal decision or ledger id',
    seen: ['D-021', 'D-025', 'L-001', 'N-2', 'P-23', 'T-13'],
  },
  {
    id: 'sprint-id',
    class: TICKET_ID,
    pattern: /\bS\d{2}\b/g,
    why: 'an internal sprint id',
    seen: ['S44'],
  },
  {
    id: 'adr-id',
    class: TICKET_ID,
    pattern: /\bADR-\d{1,4}\b/g,
    why: 'an internal architecture-decision record',
    seen: ['ADR-004'],
  },
  {
    id: 'tech-debt-id',
    class: TICKET_ID,
    pattern: /\bTD-\d{1,4}\b/g,
    why: 'an internal tech-debt id',
    // Not in today's artifacts; named by the release review as a shape the repo
    // uses, so the rule carries a constructed example rather than an empty list
    // a positive control cannot exercise.
    seen: ['TD-002'],
  },
  {
    id: 'gui-item-id',
    class: TICKET_ID,
    pattern: /\bGUI-?\d{1,3}\b/g,
    why: 'an internal desktop-client work item',
    seen: ['GUI4'],
  },
  {
    id: 'sdk-item-id',
    class: TICKET_ID,
    pattern: /\bSDK-[A-Z]\b/g,
    why: 'an internal SDK work item',
    seen: ['SDK-B'],
  },
  {
    id: 'workstream-slice-id',
    class: TICKET_ID,
    pattern: /\bEG-(?:API|WK)-\d+(?:\.\d+)*\b/g,
    why: 'an internal workstream slice',
    seen: ['EG-API-1.3', 'EG-WK-1.9'],
  },
  {
    id: 'work-item-label',
    class: TICKET_ID,
    // Shapes the Go SDK's own doc guard already names
    // (packages/sdk-go/ai_docs_say_what_the_product_does_test.go).
    pattern:
      /\b(?:sub-)?slice\s+\d+\b|\bArc\s+\d+\b|\bWave\s+\d+\b|\bLK\.\d+\b|\bv2-#\d+\b|\bQ\.?\d?(?:\.\d+)*[a-z]?\s+verdict\b/gi,
    why: 'an internal work-item label',
    seen: ['LK.2', 'Q2 verdict', 'Arc 1 sub-slice 6.8', 'v2-#6'],
  },
  {
    id: 'planning-doc-ref',
    class: TICKET_ID,
    pattern: /\b(?:planning\s+)?(?:file|doc)[\s-]*\d{2,3}\b|\bplanning\s+\d{2,3}\b/gi,
    why: 'an internal planning document',
    seen: ['file 05', 'planning 133', 'planning file 133', 'doc-150', 'doc-132'],
  },
  {
    id: 'migration-number',
    class: TICKET_ID,
    pattern: /\bmigration\s+\d{3,4}\b/gi,
    why: 'an internal database migration number',
    seen: ['migration 0045', 'migration 0119'],
  },
  {
    id: 'commit-sha',
    class: TICKET_ID,
    // A short git sha or md5 prefix: 7-12 hex characters carrying at least one
    // letter AND at least one digit, not adjacent to another hex character or a
    // hyphen. The lookarounds are what keep UUID segments (`…-a1b2c3d4-…`),
    // 40- and 64-character digests, and decimal constants like 1000000 out.
    pattern:
      /(?<![0-9a-f-])(?=[0-9a-f]{7,12}(?![0-9a-f-]))(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}/g,
    why: 'an internal commit or digest reference',
    seen: ['7d5992d9', '8a03a3929', 'f204f294e', '4799420bc'],
  },

  // ── internal vocabulary ────────────────────────────────────────────────────
  {
    id: 'harness',
    class: INTERNAL_VOCABULARY,
    pattern: /\bharness(?:es|ed|ing)?\b/gi,
    why: 'the internal name for the device-side runner',
    seen: ['harness'],
  },
  {
    id: 'fleet',
    class: INTERNAL_VOCABULARY,
    pattern: /\bfleets?\b/gi,
    why: 'the internal name for the device estate',
    seen: ['fleet', 'fleet-vantage', 'Fleet-admin'],
  },
  {
    id: 'control-plane',
    class: INTERNAL_VOCABULARY,
    pattern: /\bcontrol[- ]planes?\b/gi,
    why: 'an internal architecture layer',
    seen: ['control plane', 'control-plane'],
  },
  {
    id: 'observer',
    class: INTERNAL_VOCABULARY,
    // `observer_off` and `observerEntryTypes` are identifiers on the public
    // wire and in the DOM: no word boundary follows `observer` in either, so
    // this cannot reach them. Only the prose sense is matched.
    pattern: /\bobservers?\b/gi,
    why: 'the internal name for the raw-socket egress probe',
    seen: ['the observer tunnel', 'raw-socket observer'],
  },
  {
    id: 'vantage',
    class: INTERNAL_VOCABULARY,
    pattern: /\bvantages?\b/gi,
    why: 'the internal name for where a measurement was taken from',
    seen: ['fleet-vantage', 'vantage flags'],
  },
  {
    id: 'mac-hardware',
    class: INTERNAL_VOCABULARY,
    // Case-sensitive on purpose: `macOS` is a customer-facing platform name and
    // has no word boundary after `Mac` anyway, but writing the rule
    // case-sensitively says so rather than relying on it.
    pattern: /\bMac[- ]?minis?\b|\bMacs?\b/g,
    why: 'the internal name for the hardware a session runs on',
    seen: ['Mac mini', 'per-Mac', 'the Mac harness'],
  },
  {
    id: 'the-box',
    class: INTERNAL_VOCABULARY,
    pattern: /\bbox(?:es)?\b/gi,
    why: 'the internal name for the machine a session runs on',
    seen: ['the box reports', 'GUI → box', 'on-box'],
  },
  {
    id: 'node-as-infrastructure',
    class: INTERNAL_VOCABULARY,
    // LOWER-CASE ONLY. Measured over today's artifacts: every capital-N `Node`
    // is the JavaScript runtime (Node.js, Node 18, Node's crypto, Node-only)
    // and every infrastructure sense is lower-case (`the fleet node`, `the
    // session node`, `mac-nodes`, `node-level control`). The lower-case runtime
    // senses that remain — `node:crypto`, `@types/node`, the engines key — are
    // in ALLOW_LIST with their reasons. This means `Node pool` would NOT be
    // reported; see BLIND_SPOTS.
    pattern: /\bnodes?\b/g,
    why: 'the internal name for a machine in the estate',
    seen: ['the fleet node', 'the session node', 'mac-nodes', 'node-level control'],
  },
  {
    id: 'agent-name',
    class: INTERNAL_VOCABULARY,
    pattern: /\bA[123]\b|\bAgent[- ]?[123]\b/g,
    why: 'an internal agent name',
    seen: ['A1', 'A2', 'A3', 'Agent-3'],
  },
  {
    id: 'founder',
    class: INTERNAL_VOCABULARY,
    pattern: /\bfounders?(?:['’]s)?\b/gi,
    why: 'a personal role, which customer-facing text never names',
    seen: ['founder verdict', "the founder's tier-3 boundary"],
  },
  {
    id: 'internal-decision',
    class: INTERNAL_VOCABULARY,
    pattern: /\bverdicts?\b|\btier-?3\b/gi,
    why: 'internal decision vocabulary — who decided it, not what it means',
    seen: ['founder verdict', 'Tier-3 verdict'],
  },
  {
    id: 'internal-repo-path',
    class: INTERNAL_VOCABULARY,
    pattern:
      /\bdocs\/(?:internal|planning)\b|\boperations\/[a-z][a-z0-9-]*\b|\bORCHESTRATOR[-\s]?STATE\b|\bagent[- ]bus\b|\bworktrees?\b/gi,
    why: 'a path or artefact that only exists inside the working repository',
    seen: ['docs/internal', 'docs/planning', 'operations/agent-bus', 'ORCHESTRATOR-STATE'],
  },
  {
    id: 'internal-host',
    class: INTERNAL_VOCABULARY,
    pattern: /\b[a-z0-9][a-z0-9-]*\.(?:internal|local|lan)\b|\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/g,
    why: 'an internal host name or a host:port a customer cannot reach',
    seen: ['mac-01.internal', '10.1.2.3:8443'],
  },
]);

/**
 * Legitimate text that a rule above would otherwise report, as DATA with a
 * reason each. An entry produces spans over the text; a match contained in one
 * of those spans is suppressed. Spans, not "is the phrase nearby", so allowing
 * `Node.js` cannot quietly allow a different `node` on the same line.
 *
 * `rules: '*'` applies to every rule; otherwise only to the ids listed.
 */
export const ALLOW_LIST = Object.freeze([
  {
    id: 'node-builtin-module',
    rules: ['node-as-infrastructure'],
    pattern: /\bnode:[a-z/]*/g,
    reason:
      "`node:crypto` / `node:fs/promises` is a Node built-in module specifier — the JavaScript runtime the SDK supports, not a machine. Also covers esbuild's `for ESM import in node:` interop banner.",
  },
  {
    id: 'node-types-package',
    rules: ['node-as-infrastructure'],
    pattern: /@types\/node\b/g,
    reason:
      'The `@types/node` package, named in devDependencies and in the paths inside `dist/.tsbuildinfo`.',
  },
  {
    id: 'node-engines-key',
    rules: ['node-as-infrastructure'],
    pattern: /"node"\s*:/g,
    reason: "package.json's `engines.node` key, which states the supported runtime floor.",
  },
  {
    id: 'node-run-a-script',
    rules: ['node-as-infrastructure'],
    pattern: /\bnode\s+[\w./@-]+\.[cm]?js\b/g,
    reason:
      '`node scripts/build-publish.mjs` in a package.json `scripts` entry invokes the JavaScript runtime on a file. It ships because package.json ships; it names the runtime, not a machine in the estate.',
  },
  {
    id: 'node-cjs-interop-banner',
    rules: ['node-as-infrastructure'],
    pattern: /\bnode compatibility\b/gi,
    reason:
      'Text tsup/esbuild emits into `dist/index.cjs` describing CommonJS interop. Build-tool output, not our prose.',
  },
  {
    id: 'nist-curve-name',
    rules: ['decision-id'],
    pattern: /\bP-(?:256|384|521)\b/g,
    reason: 'NIST elliptic-curve names (P-256 et al) collide with the `P-nnn` decision-id shape.',
  },
  {
    id: 'n-minus-one-release',
    rules: ['decision-id'],
    pattern: /\bN-[12]\b(?=\s+(?:version|release|releases))/gi,
    reason: '"N-1 release" / "N-2 version" is ordinary version-support language.',
  },
  {
    id: 'loopback-example-address',
    rules: ['internal-host'],
    pattern: /\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)(?::\d{2,5})?\b/g,
    reason:
      'Loopback and any-address are documentation-safe examples. The Go webhook-receiver example tells a customer to run their own listener on `http://localhost:4242/webhook`; that is their machine, not ours.',
  },
  {
    id: 'self-hosted-gateway-example',
    rules: ['internal-host'],
    pattern: /\bgw\.internal\b/g,
    reason:
      'Used in `sdk-typescript/src/http.ts` as an illustrative self-hosted base URL (`https://gw.internal/driftstack`) — a customer-side hostname in an example, not one of ours.',
  },
  {
    id: 'classic-mac-line-endings',
    rules: ['mac-hardware'],
    pattern: /\bclassic-Mac\b/g,
    reason:
      '"a classic-Mac-ended .ovpn" describes CR line endings in a customer-supplied file — a text-encoding fact, not our hardware.',
  },
  {
    id: 'proxy-test-vantage-wire-values',
    rules: ['fleet', 'vantage'],
    pattern: /"fleet"|`?\?vantage=fleet`?/g,
    reason:
      'The public proxy-test API spells these itself: `measured_from` comes back as `"control_plane"` or `"fleet"`, and the request takes `?vantage=fleet`. The server\'s own OpenAPI description documents both, so a customer reads and types them; an SDK that cannot name its own enum values documents nothing. Only the quoted value and the query parameter are allowed — a bare `fleet`, or `fleet-vantage`, is still reported.',
  },
  {
    id: 'css-box-terms',
    rules: ['the-box'],
    pattern: /\bbox model\b|\bbounding box\b/gi,
    reason:
      'Layout vocabulary. `\\bbox\\b` already cannot reach `checkbox` or `sandbox`; these two are the phrases where `box` stands alone in a non-infrastructure sense.',
  },
]);

/**
 * What this scanner does NOT see. Printed by every run and pinned by the guard
 * test, because a gate that does not name its blind spot reads as total.
 */
export const BLIND_SPOTS = Object.freeze([
  'Go `_test.go` files are excluded by default. They DO travel in the module zip, and pkg.go.dev renders `Example*` functions from them. Run with --go-tests to measure them.',
  '`node-as-infrastructure` matches lower-case `node` only, because every capital-N `Node` in the artifacts today is the JavaScript runtime. A future "Node pool" would not be reported.',
  'The vocabulary rules are `\\b`-anchored, so an internal word INSIDE an identifier is invisible: a snake_case field, a dotted event name or a CamelCase type name. Measured 2026-09-20 — `scanText` reports NOTHING for `mac_node.livekit_registered`, `mac_node_id`, `RegisterMacNodeRequest`, `single_host_vantage`, `web_port_vantage`, `observer_off`, `node_busy` or `measured_from`, while the bare prose `the device fleet`, `the Mac mini` and `the observer` all report. A package can therefore read ZERO on this class and still ship internal words to customers as part of the wire contract — @driftstack/api-types and the PyPI wheel both do today. Renaming them is a BREAKING API change, so they are a contract decision, not a text sweep.',
  'Only text is read. Images, fonts and other binary payloads in a package are listed but never opened.',
  'The rules are shapes, not understanding: a sentence can describe internal mechanism in plain words that match nothing here. This lowers the count of a known class; it does not certify the prose.',
  'The Python DERIVED list models hatchling, it does not run it. It reproduces the built artifact today and is cross-checked against a real build whenever `build` is importable, but a change to the hatch config that this parser does not model would go unseen.',
]);

/** Extensions that are read as text. Anything else is listed and not opened. */
const TEXT_EXTENSIONS = Object.freeze([
  '.cjs',
  '.cts',
  '.go',
  '.js',
  '.json',
  '.map',
  '.md',
  '.mjs',
  '.mod',
  '.mts',
  '.py',
  '.pyi',
  '.sum',
  '.toml',
  '.ts',
  '.tsbuildinfo',
  '.txt',
  '.typed',
  '.yaml',
  '.yml',
]);

/**
 * Files whose whole name is the extension, or which have none at all. These are
 * spelled out because `basename('.tsbuildinfo').lastIndexOf('.')` is 0, so the
 * extension test below cannot see them — and `dist/.tsbuildinfo` ships in
 * `@driftstack/api-types`, so missing it would be 45 KB of shipped text the
 * scan reported nothing about.
 */
const TEXT_BASENAMES = Object.freeze([
  '.gitignore',
  '.tsbuildinfo',
  'LICENSE',
  'METADATA',
  'PKG-INFO',
  'RECORD',
  'WHEEL',
  'py.typed',
]);

export function isTextPath(path) {
  const name = basename(path);
  if (TEXT_BASENAMES.includes(name)) return true;
  if (name.endsWith('.d.ts') || name.endsWith('.d.cts')) return true;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return TEXT_EXTENSIONS.includes(name.slice(dot));
}

/** Offsets at which each line starts, so a hit index becomes a 1-based line. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo] + 1 };
}

/**
 * Spans of `text` that an allow-list entry covers, with the rule ids each span
 * applies to. Exported so the guard test can assert an entry does what its
 * reason says.
 */
export function allowedRanges(text) {
  const ranges = [];
  for (const entry of ALLOW_LIST) {
    const re = new RegExp(entry.pattern.source, entry.pattern.flags);
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      if (m[0].length === 0) re.lastIndex += 1;
      else
        ranges.push({
          start: m.index,
          end: m.index + m[0].length,
          allow: entry.id,
          rules: entry.rules,
        });
      m = re.exec(text);
    }
  }
  return ranges;
}

function suppressedBy(ranges, ruleId, start, end) {
  for (const r of ranges) {
    if (r.start <= start && end <= r.end && (r.rules === '*' || r.rules.includes(ruleId)))
      return r.allow;
  }
  return null;
}

/**
 * Every rule match in `text`, minus what the allow-list covers.
 * `where` is carried through onto each finding so a caller can label a unit of
 * text that is not a file on disk (a `sourcesContent` entry, say).
 */
export function scanText(text, where = {}) {
  const ranges = allowedRanges(text);
  const starts = lineStarts(text);
  const findings = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        m = re.exec(text);
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (suppressedBy(ranges, rule.id, start, end) === null) {
        const { line, column } = lineOf(starts, start);
        findings.push({
          ...where,
          rule: rule.id,
          class: rule.class,
          why: rule.why,
          line,
          column,
          text: m[0],
          context: text
            .slice(Math.max(0, start - 48), end + 48)
            .replace(/\s+/g, ' ')
            .trim(),
        });
      }
      m = re.exec(text);
    }
  }
  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return findings;
}

/**
 * The source files a source map embeds. `sourcesContent` is the whole point:
 * both `dist/index.js.map` and `dist/index.cjs.map` carry the FULL TypeScript
 * source text, so every comment in `packages/sdk-typescript/src` ships inside
 * the npm tarball whether or not `src` is in the `files` allowlist.
 * Returns [] for a map with no `sourcesContent` (tsc emits these for api-types)
 * and for anything that is not parseable JSON.
 */
export function sourcesFromSourceMap(mapText) {
  let parsed;
  try {
    parsed = JSON.parse(mapText);
  } catch {
    return [];
  }
  const contents = Array.isArray(parsed?.sourcesContent) ? parsed.sourcesContent : [];
  const names = Array.isArray(parsed?.sources) ? parsed.sources : [];
  const out = [];
  for (let i = 0; i < contents.length; i += 1) {
    if (typeof contents[i] !== 'string') continue;
    out.push({
      source: typeof names[i] === 'string' ? names[i] : `sourcesContent[${i}]`,
      content: contents[i],
    });
  }
  return out;
}

/**
 * The units of text a shipped file contributes. A `.map` contributes its
 * embedded sources (and NOT the mappings blob, which is base64 noise that would
 * false-positive the commit-sha shape); everything else contributes itself.
 */
export function textUnitsForFile(shippedPath, body) {
  if (shippedPath.endsWith('.map')) {
    return sourcesFromSourceMap(body).map((s) => ({
      file: `${shippedPath}::${s.source}`,
      text: s.content,
    }));
  }
  return [{ file: shippedPath, text: body }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shipped-file lists

/**
 * Build-tool droppings that no packager ships. Hatchling excludes these by
 * default, so a derived list that walked them would report 106 files for a
 * wheel that really has 36 — a denominator inflated by `__pycache__`, which is
 * the exact shape of a scan that looks thorough and is measuring the wrong
 * population.
 */
const NEVER_PACKAGED = Object.freeze([
  '__pycache__',
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NEVER_PACKAGED.includes(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && !/\.(?:pyc|pyo)$/u.test(entry.name)) out.push(p);
  }
  return out;
}

/** npm's automatic set: always packed regardless of `files`. */
const NPM_ALWAYS = Object.freeze(['package.json', 'README.md', 'README', 'LICENSE', 'LICENCE']);

/** `npm pack --dry-run --json`. Local computation; no registry, no credential. */
export function npmShippedFilesViaPack(pkgDir) {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const entry = Array.isArray(parsed) ? parsed[0] : null;
  if (entry === null || !Array.isArray(entry.files)) return null;
  return entry.files.map((f) => f.path).sort();
}

/**
 * One `files` entry as a matcher over published paths.
 *
 * Only the wildcards npm's own matcher supports are modelled: `**` for any
 * number of path segments, `*` for anything inside one segment, and `?` for a
 * single character. Everything else is matched literally, and a trailing
 * separator is stripped so `dist/` and `dist` mean the same directory.
 *
 * A DIRECTORY entry also matches everything under it, which is why the regex
 * ends in `(?:/.*)?` — `!dist/ai-credits.*` has to remove the four emitted
 * files, and a bare `!docs` has to remove the whole tree.
 */
export function filesEntryMatcher(entry) {
  const rel = entry.replace(/^\.\//, '').replace(/\/+$/, '');
  const body = rel
    .split(/(\*\*|\*|\?)/u)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    })
    .join('');
  return new RegExp(`^${body}(?:/.*)?$`, 'u');
}

/**
 * `files` from package.json, directories expanded, plus npm's automatic set.
 *
 * ⛔ ORDER MATTERS AND NEGATIONS ARE REAL. npm honours `!`-prefixed entries in
 * `files`, and a later entry overrides an earlier one, so the list is applied
 * in sequence rather than collected. `@driftstack/api-types` relies on this to
 * keep `dist/.tsbuildinfo` and the unreleased pricing module out of the
 * tarball; a derivation that ignored the `!` would report files npm does not
 * pack, which is the direction that reads as a finding the artifact does not
 * have — and the `derived === npm pack --dry-run` arm of the shipped-text
 * guard is what proves this model right rather than plausible.
 */
export function npmShippedFilesDerived(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const listed = Array.isArray(manifest.files) ? manifest.files : [];
  const out = new Set();
  for (const name of NPM_ALWAYS) if (existsSync(join(pkgDir, name))) out.add(name);
  for (const raw of listed) {
    if (raw.startsWith('!')) {
      const negated = filesEntryMatcher(raw.slice(1));
      for (const held of [...out]) if (negated.test(held)) out.delete(held);
      continue;
    }
    const rel = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    const abs = join(pkgDir, rel);
    if (existsSync(abs)) {
      if (statSync(abs).isDirectory())
        for (const f of walk(abs)) out.add(relative(pkgDir, f).split('\\').join('/'));
      else out.add(rel);
      continue;
    }
    // Not a path on disk: npm treats the entry as a glob. Expand it against the
    // package the same way, so `dist/*.js` is not silently dropped.
    if (!/[*?]/u.test(rel)) continue;
    const matcher = filesEntryMatcher(rel);
    for (const f of walk(pkgDir)) {
      const shipped = relative(pkgDir, f).split('\\').join('/');
      if (shipped.startsWith('node_modules/')) continue;
      if (matcher.test(shipped)) out.add(shipped);
    }
  }
  return [...out].sort();
}

/**
 * `[tool.hatch.build.targets.<target>]` lists, read straight out of
 * pyproject.toml. Deliberately narrow: it reads the two keys this package
 * actually sets and nothing else, so a config shape it does not model is a
 * parse miss it can report rather than a silent partial answer.
 */
export function hatchListsFrom(pyprojectText) {
  const section = (name) => {
    const m = new RegExp(
      `\\[tool\\.hatch\\.build\\.targets\\.${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
      'u',
    ).exec(pyprojectText);
    return m === null ? null : m[1];
  };
  const arrayKey = (body, key) => {
    if (body === null) return null;
    const m = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'u').exec(body);
    if (m === null) return null;
    return [...m[1].matchAll(/["']([^"']+)["']/gu)].map((x) => x[1]);
  };
  return {
    wheelPackages: arrayKey(section('wheel'), 'packages'),
    sdistInclude: arrayKey(section('sdist'), 'include'),
  };
}

/**
 * Mirrors `hatchling/utils/fs.py::locate_file(root, '.gitignore', boundary='.git')`:
 * the CURRENT directory is checked before the boundary, so a package-local file
 * wins and the repository root's is what you get when there is none.
 */
export function nearestVcsIgnore(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.gitignore');
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Derived wheel + sdist file lists: [{ artifact, files: [{ shipped, source }] }]. */
export function pythonShippedFilesDerived(pkgDir) {
  const py = readFileSync(join(pkgDir, 'pyproject.toml'), 'utf8');
  const { wheelPackages, sdistInclude } = hatchListsFrom(py);
  if (wheelPackages === null || sdistInclude === null)
    throw new Error(
      'pyproject.toml: could not read [tool.hatch.build.targets.wheel].packages and [tool.hatch.build.targets.sdist].include — refusing to report a partial file list',
    );
  const version = (/^version\s*=\s*["']([^"']+)["']/mu.exec(py) ?? [null, '0.0.0'])[1];
  const name = (/^name\s*=\s*["']([^"']+)["']/mu.exec(py) ?? [null, 'package'])[1].replace(
    /-/g,
    '_',
  );
  const distInfo = `${name}-${version}.dist-info`;

  const wheel = [];
  for (const rel of wheelPackages) {
    const abs = join(pkgDir, rel);
    if (!existsSync(abs)) continue;
    const top = basename(rel);
    for (const f of walk(abs))
      wheel.push({ shipped: `${top}/${relative(abs, f).split('\\').join('/')}`, source: f });
  }
  // The wheel has no README.md of its own; its METADATA embeds the README as
  // the long description, which is the page PyPI renders. Same text, shipped.
  if (existsSync(join(pkgDir, 'README.md')))
    wheel.push({ shipped: `${distInfo}/METADATA`, source: join(pkgDir, 'README.md') });
  if (existsSync(join(pkgDir, 'LICENSE')))
    wheel.push({ shipped: `${distInfo}/licenses/LICENSE`, source: join(pkgDir, 'LICENSE') });

  const sdistRoot = `${name}-${version}`;
  const sdist = [];
  for (const rel of sdistInclude) {
    const clean = rel.replace(/^\//, '');
    const abs = join(pkgDir, clean);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory())
      for (const f of walk(abs))
        sdist.push({
          shipped: `${sdistRoot}/${clean}/${relative(abs, f).split('\\').join('/')}`,
          source: f,
        });
    else sdist.push({ shipped: `${sdistRoot}/${clean}`, source: abs });
  }
  if (existsSync(join(pkgDir, 'README.md')))
    sdist.push({ shipped: `${sdistRoot}/PKG-INFO`, source: join(pkgDir, 'README.md') });
  const ignore = nearestVcsIgnore(pkgDir);
  if (ignore !== null) sdist.push({ shipped: `${sdistRoot}/.gitignore`, source: ignore });

  return [
    { artifact: 'pypi:wheel', files: wheel.sort((a, b) => a.shipped.localeCompare(b.shipped)) },
    { artifact: 'pypi:sdist', files: sdist.sort((a, b) => a.shipped.localeCompare(b.shipped)) },
  ];
}

/** `python -m build` into a temp dir, unpacked. Returns null when unavailable. */
export function pythonShippedFilesViaBuild(pkgDir) {
  const python = join(pkgDir, '.venv', 'bin', 'python');
  if (!existsSync(python)) return null;
  const probe = spawnSync(python, ['-c', 'import build'], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  const out = mkdtempSync(join(tmpdir(), 'driftstack-pyship-'));
  try {
    const built = spawnSync(python, ['-m', 'build', '--outdir', out], {
      cwd: pkgDir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (built.status !== 0) return null;
    const dists = readdirSync(out);
    const whl = dists.find((f) => f.endsWith('.whl'));
    const tar = dists.find((f) => f.endsWith('.tar.gz'));
    if (whl === undefined || tar === undefined) return null;
    const unpackWheel = join(out, 'whl');
    const unpackSdist = join(out, 'sdist');
    if (spawnSync('unzip', ['-q', join(out, whl), '-d', unpackWheel]).status !== 0) return null;
    if (spawnSync('tar', ['xzf', join(out, tar), '-C', out], { cwd: out }).status !== 0)
      return null;
    const sdistDir = join(out, tar.replace(/\.tar\.gz$/, ''));
    const mk = (root, artifact) => ({
      artifact,
      files: walk(root)
        .map((f) => ({ shipped: relative(root, f).split('\\').join('/'), source: f }))
        .sort((a, b) => a.shipped.localeCompare(b.shipped)),
    });
    const result = [mk(unpackWheel, 'pypi:wheel'), mk(sdistDir, 'pypi:sdist')];
    // Read every body now: the temp tree is removed when this returns.
    for (const art of result)
      for (const f of art.files)
        f.body = isTextPath(f.shipped) ? readFileSync(f.source, 'utf8') : null;
    void unpackSdist;
    return result;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * What the Go module zip carries at the tag: what git has under the module
 * directory. Tracked files AND untracked-not-ignored ones, because a release
 * prepared in the working tree adds files (this one adds LICENSE) that are not
 * committed yet, and a list that omits them under-reports what will ship.
 */
export function goShippedFiles(repoRoot, { includeTests = false } = {}) {
  const r = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'packages/sdk-go'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0)
    throw new Error(`git ls-files failed under packages/sdk-go: ${String(r.stderr).trim()}`);
  const all = r.stdout.split('\n').filter((l) => l.length > 0);
  const isTest = (p) => p.endsWith('_test.go');
  const chosen = includeTests ? all : all.filter((p) => !isTest(p));
  return {
    files: chosen
      .map((p) => ({
        shipped: relative('packages/sdk-go', p).split('\\').join('/'),
        source: join(repoRoot, p),
      }))
      .sort((a, b) => a.shipped.localeCompare(b.shipped)),
    excludedTests: all.filter(isTest).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Package assembly

export const PACKAGES = Object.freeze(['sdk-typescript', 'api-types', 'sdk-python', 'sdk-go']);

/**
 * Run BOTH Python methods and say whether they agree.
 *
 * The derived method models hatchling; it does not run it. Two independent
 * derivations agreeing is evidence; one derivation agreeing with itself is not,
 * which is why this compares finding counts per artifact rather than asserting
 * the file lists are identical — they are not, and the difference is honest:
 * a real wheel also carries `RECORD` (file hashes) and `WHEEL` (build tags),
 * generated metadata with no prose in it. Returns null when `build` is not
 * importable in the package venv, which is CI's case.
 */
export function comparePythonMethods(repoRoot) {
  const dir = join(repoRoot, 'packages', 'sdk-python');
  const built = pythonShippedFilesViaBuild(dir);
  if (built === null) return null;
  const derived = pythonShippedFilesDerived(dir);
  const countsFor = (artifacts) =>
    Object.fromEntries(
      artifacts.map((a) => [a.artifact, countByClass(scanArtifact('sdk-python', a).findings)]),
    );
  const b = countsFor(built);
  const d = countsFor(derived);
  const disagreements = [];
  for (const artifact of Object.keys(b))
    for (const cls of [TICKET_ID, INTERNAL_VOCABULARY])
      if (b[artifact][cls] !== d[artifact]?.[cls])
        disagreements.push(
          `${artifact} ${cls}: built ${String(b[artifact][cls])} vs derived ${String(d[artifact]?.[cls])}`,
        );
  return { built: b, derived: d, agrees: disagreements.length === 0, disagreements };
}

/**
 * The artifacts of one package, each with its shipped file list.
 * Shapes: { package, artifacts: [{ artifact, method, files: [{shipped, source, body?}], note? }] }
 */
export function shippedArtifacts(
  repoRoot,
  pkg,
  { npmMethod = 'auto', pythonMethod = 'auto', goTests = false } = {},
) {
  if (pkg === 'sdk-typescript' || pkg === 'api-types') {
    const dir = join(repoRoot, 'packages', pkg);
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
    let method = 'npm pack --dry-run --json';
    let paths = npmMethod === 'derived' ? null : npmShippedFilesViaPack(dir);
    if (paths === null) {
      paths = npmShippedFilesDerived(dir);
      method = 'derived from package.json "files" + npm automatic set';
    }
    return {
      package: pkg,
      artifacts: [
        {
          artifact: `npm:${name}`,
          method,
          files: paths.map((p) => ({ shipped: p, source: join(dir, p) })),
        },
      ],
    };
  }
  if (pkg === 'sdk-python') {
    const dir = join(repoRoot, 'packages', 'sdk-python');
    const built = pythonMethod === 'derived' ? null : pythonShippedFilesViaBuild(dir);
    if (built !== null)
      return {
        package: pkg,
        artifacts: built.map((a) => ({
          ...a,
          method: 'python -m build (wheel + sdist), unpacked',
        })),
      };
    return {
      package: pkg,
      artifacts: pythonShippedFilesDerived(dir).map((a) => ({
        ...a,
        method: 'derived from pyproject.toml hatch include rules + the force-included VCS ignore',
      })),
    };
  }
  if (pkg === 'sdk-go') {
    const { files, excludedTests } = goShippedFiles(repoRoot, { includeTests: false });
    const artifacts = [
      {
        artifact: 'go:module',
        method:
          'git ls-files --cached --others --exclude-standard under packages/sdk-go, minus _test.go',
        files,
        note: `${String(excludedTests)} _test.go files excluded — see BLIND_SPOTS`,
      },
    ];
    if (goTests) {
      const withTests = goShippedFiles(repoRoot, { includeTests: true });
      const testOnly = withTests.files.filter((f) => f.shipped.endsWith('_test.go'));
      artifacts.push({
        artifact: 'go:tests',
        method:
          'the _test.go files the module zip also carries; pkg.go.dev renders Example* from them',
        files: testOnly,
      });
    }
    return { package: pkg, artifacts };
  }
  throw new Error(`unknown package: ${pkg}`);
}

/** Read every text unit of an artifact's file list and scan it. */
export function scanArtifact(pkg, artifact) {
  const findings = [];
  let textFiles = 0;
  for (const f of artifact.files) {
    if (!isTextPath(f.shipped)) continue;
    let body = f.body;
    if (body === undefined || body === null) {
      if (f.source === undefined || !existsSync(f.source)) continue;
      body = readFileSync(f.source, 'utf8');
    }
    textFiles += 1;
    for (const unit of textUnitsForFile(f.shipped, body))
      findings.push(
        ...scanText(unit.text, { package: pkg, artifact: artifact.artifact, file: unit.file }),
      );
  }
  return { findings, textFiles };
}

/** { [class]: count } for a findings array. */
export function countByClass(findings) {
  const counts = { [TICKET_ID]: 0, [INTERNAL_VOCABULARY]: 0 };
  for (const f of findings) counts[f.class] += 1;
  return counts;
}

/** { [artifact]: { [class]: count } } — the shape the ratchet file stores. */
export function countsByArtifact(results) {
  const out = {};
  for (const r of results) {
    out[r.package] ??= {};
    for (const a of r.artifacts) out[r.package][a.artifact] = countByClass(a.findings);
  }
  return out;
}

/** Everything, for one or more packages. */
export function scanPackages(repoRoot, packages = PACKAGES, options = {}) {
  return packages.map((pkg) => {
    const { artifacts } = shippedArtifacts(repoRoot, pkg, options);
    return {
      package: pkg,
      artifacts: artifacts.map((a) => {
        const { findings, textFiles } = scanArtifact(pkg, a);
        return {
          artifact: a.artifact,
          method: a.method,
          note: a.note,
          fileCount: a.files.length,
          textFileCount: textFiles,
          counts: countByClass(findings),
          findings,
        };
      }),
    };
  });
}

export function formatTable(results) {
  const lines = [];
  for (const r of results) {
    for (const a of r.artifacts) {
      lines.push('');
      lines.push(`── ${r.package} · ${a.artifact}`);
      lines.push(`   files ${String(a.fileCount)} (${String(a.textFileCount)} text) · ${a.method}`);
      if (a.note !== undefined && a.note !== null) lines.push(`   note: ${a.note}`);
      lines.push(
        `   ${TICKET_ID}: ${String(a.counts[TICKET_ID])}   ${INTERNAL_VOCABULARY}: ${String(a.counts[INTERNAL_VOCABULARY])}`,
      );
      const byFile = new Map();
      for (const f of a.findings) {
        if (!byFile.has(f.file)) byFile.set(f.file, []);
        byFile.get(f.file).push(f);
      }
      for (const [file, fs] of byFile) {
        lines.push(`   ${file}  (${String(fs.length)})`);
        for (const f of fs)
          lines.push(`      ${file}:${String(f.line)}  ${f.rule}  "${f.text}"  — ${f.why}`);
      }
    }
  }
  return lines.join('\n');
}

export function main(argv) {
  const args = [...argv];
  const valueOf = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i === -1 ? fallback : args[i + 1];
  };
  const asJson = args.includes('--json');
  const quiet = args.includes('--counts-only');
  const pkgArg = valueOf('--package', null);
  const packages = pkgArg === null ? [...PACKAGES] : pkgArg.split(',');
  for (const p of packages)
    if (!PACKAGES.includes(p)) {
      process.stderr.write(`unknown --package ${p}; known: ${PACKAGES.join(', ')}\n`);
      return 2;
    }
  const repoRoot = resolve(valueOf('--root', resolve(import.meta.dirname, '..')));
  const options = {
    npmMethod: valueOf('--npm-method', 'auto'),
    pythonMethod: valueOf('--python-method', 'auto'),
    goTests: args.includes('--go-tests'),
  };

  if (options.pythonMethod === 'both') {
    const cmp = comparePythonMethods(repoRoot);
    if (cmp === null)
      process.stdout.write(
        'python: `build` is not importable in packages/sdk-python/.venv — only the derived method can run here\n',
      );
    else {
      process.stdout.write(`python built vs derived: ${cmp.agrees ? 'AGREE' : 'DISAGREE'}\n`);
      for (const d of cmp.disagreements) process.stdout.write(`  ${d}\n`);
      for (const [artifact, counts] of Object.entries(cmp.built))
        process.stdout.write(
          `  built   ${artifact.padEnd(14)} ${TICKET_ID} ${String(counts[TICKET_ID]).padStart(5)}   ${INTERNAL_VOCABULARY} ${String(counts[INTERNAL_VOCABULARY]).padStart(5)}\n`,
        );
      for (const [artifact, counts] of Object.entries(cmp.derived))
        process.stdout.write(
          `  derived ${artifact.padEnd(14)} ${TICKET_ID} ${String(counts[TICKET_ID]).padStart(5)}   ${INTERNAL_VOCABULARY} ${String(counts[INTERNAL_VOCABULARY]).padStart(5)}\n`,
        );
    }
    options.pythonMethod = 'derived';
  }

  let results;
  try {
    results = scanPackages(repoRoot, packages, options);
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const total = results.reduce(
    (n, r) => n + r.artifacts.reduce((m, a) => m + a.findings.length, 0),
    0,
  );

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ counts: countsByArtifact(results), blindSpots: BLIND_SPOTS, results }, null, 2)}\n`,
    );
  } else {
    if (!quiet) process.stdout.write(`${formatTable(results)}\n`);
    process.stdout.write('\nCOUNTS (package · artifact · class)\n');
    for (const r of results)
      for (const a of r.artifacts)
        process.stdout.write(
          `  ${r.package.padEnd(15)} ${a.artifact.padEnd(26)} ${TICKET_ID} ${String(a.counts[TICKET_ID]).padStart(5)}   ${INTERNAL_VOCABULARY} ${String(a.counts[INTERNAL_VOCABULARY]).padStart(5)}\n`,
        );
    process.stdout.write('\nBLIND SPOTS\n');
    for (const b of BLIND_SPOTS) process.stdout.write(`  · ${b}\n`);
  }
  return total === 0 ? 0 : 1;
}

/* c8 ignore start — CLI wiring; the exported functions above are what the tests drive. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
/* c8 ignore stop */
