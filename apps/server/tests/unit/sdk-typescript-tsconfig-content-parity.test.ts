// W532.B — drift guard for packages/sdk-typescript/tsconfig.json.
// Typecheck-only tsconfig (build happens via tsup). Drift here either
// breaks the SDK-B Web-Crypto DOM-lib injection (would break type
// resolution for webhook-signature.ts SubtleCrypto usage) or drops the
// cross-package include that lets the SDK typecheck against server
// integration helpers + api-types source.
//
//   • extends: ../../tsconfig.base.json.
//   • rootDir: ../.. (monorepo root — needed because include reaches
//     into apps/server and ../api-types).
//   • outDir: dist (unused — noEmit:true).
//   • noEmit: true (this tsconfig is typecheck-only; tsup handles emit).
//   • composite: false, declaration: false, declarationMap: false,
//     sourceMap: false (no emit, no need for any of these).
//   • SDK-B framing: lib: ["ES2023", "DOM"] (DOM for SubtleCrypto).
//   • include: 7 globs — src + tests + examples + tsup.config.ts +
//     apps/server/tests/integration/_helpers + apps/server/src +
//     packages/api-types/src.
//
// NOTE: file is JSON-with-comments (TSConfig format), so we regex-
// match the source rather than JSON.parse.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/tsconfig.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W532.B packages/sdk-typescript/tsconfig.json content parity', () => {
  const body = read(LIB);

  it("extends + noEmit + composite-false framing pinned: 'extends: \"../../tsconfig.base.json\"' + 'rootDir: \"../..\"' (monorepo root — needed because include reaches into apps/server + ../api-types) + 'outDir: \"dist\"' + 'noEmit: true' (typecheck-only — tsup.config.ts handles actual emit) + 'composite: false' (NOT participating in project-references — tsup builds standalone) + 'declaration: false, declarationMap: false, sourceMap: false' (no emit, no need) — pinned so the typecheck-only + no-project-references commitment survives (drift to composite:true would conflict with tsup's standalone build; drift to noEmit:false would let tsc and tsup race to write dist/)", () => {
    expect(body).toMatch(/"extends": "\.\.\/\.\.\/tsconfig\.base\.json",/);
    expect(body).toMatch(/"rootDir": "\.\.\/\.\.",/);
    expect(body).toMatch(/"outDir": "dist",/);
    expect(body).toMatch(/"noEmit": true,/);
    expect(body).toMatch(/"composite": false,/);
    expect(body).toMatch(/"declaration": false,/);
    expect(body).toMatch(/"declarationMap": false,/);
    expect(body).toMatch(/"sourceMap": false,/);
  });

  it('SDK-B Web-Crypto DOM-lib injection framing pinned: \'SDK-B: webhook-signature.ts now uses Web Crypto API (SubtleCrypto) for browser-isomorphism. SubtleCrypto is in the DOM lib in older TS releases; pulling DOM in here so the type resolves on Node-only builds too. The runtime check inside the helper handles browsers without crypto.subtle.\' + \'lib: ["ES2023", "DOM"]\' — pinned so the SDK-B anchor + DOM-lib-for-SubtleCrypto + browser-isomorphism + runtime-check-inside-helper commitment survives', () => {
    expect(body).toMatch(
      /\/\/ SDK-B: webhook-signature\.ts now uses Web Crypto API \(SubtleCrypto\)\s*\/\/ for browser-isomorphism\. SubtleCrypto is in the DOM lib in older\s*\/\/ TS releases; pulling DOM in here so the type resolves on Node-only\s*\/\/ builds too\. The runtime check inside the helper handles browsers\s*\/\/ without crypto\.subtle\./,
    );
    expect(body).toMatch(/"lib": \["ES2023", "DOM"\]/);
  });

  it("Cross-package include framing pinned: 'src/**/*' + 'tests/**/*' + 'examples/**/*' + 'tsup.config.ts' + '../../apps/server/tests/integration/_helpers/**/*' + '../../apps/server/src/**/*' + '../api-types/src/**/*' — pinned so the cross-package typecheck reach (SDK can typecheck against server integration helpers + api-types source verbatim, not their compiled .d.ts) commitment survives (drift to dropping the apps/server reach would break SDK-uses-server-helpers integration test wiring)", () => {
    expect(body).toMatch(/"src\/\*\*\/\*",/);
    expect(body).toMatch(/"tests\/\*\*\/\*",/);
    expect(body).toMatch(/"examples\/\*\*\/\*",/);
    expect(body).toMatch(/"tsup\.config\.ts",/);
    expect(body).toMatch(/"\.\.\/\.\.\/apps\/server\/tests\/integration\/_helpers\/\*\*\/\*",/);
    expect(body).toMatch(/"\.\.\/\.\.\/apps\/server\/src\/\*\*\/\*",/);
    expect(body).toMatch(/"\.\.\/api-types\/src\/\*\*\/\*"/);
    expect(body).toMatch(/"exclude": \["dist", "node_modules"\]/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
