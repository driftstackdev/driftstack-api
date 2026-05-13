// W529.B — drift guard for /tsconfig.base.json.
// Shared TypeScript base inherited by every workspace tsconfig. Drift
// here either weakens type safety (lowering strict-mode flags would
// silently widen the type holes) or breaks module-resolution (would
// shift behavior across every workspace simultaneously).
//
//   • ES2023 target + lib.
//   • NodeNext module + moduleResolution.
//   • esModuleInterop + forceConsistentCasingInFileNames + skipLibCheck
//     + resolveJsonModule.
//   • Full strict-mode suite: strict + noImplicitAny + strictNullChecks
//     + strictFunctionTypes + strictBindCallApply +
//     strictPropertyInitialization + noImplicitThis + alwaysStrict.
//   • Unused-var + return-coverage checks: noUnusedLocals +
//     noUnusedParameters + noImplicitReturns + noFallthroughCasesInSwitch.
//   • noUncheckedIndexedAccess (array/object access returns T | undefined).
//   • noImplicitOverride.
//   • isolatedModules + verbatimModuleSyntax (Node-ESM compatibility).
//   • declaration + declarationMap + sourceMap (consumer-package types
//     + debugger maps).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'tsconfig.base.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W529.B /tsconfig.base.json content parity', () => {
  const body = read(LIB);
  const json = JSON.parse(body) as {
    compilerOptions: Record<string, unknown>;
  };
  const co = json.compilerOptions;

  it("Target + module + lib framing pinned: 'target: ES2023' + 'lib: [ES2023]' + 'module: NodeNext' + 'moduleResolution: NodeNext' + 'esModuleInterop: true' + 'forceConsistentCasingInFileNames: true' + 'skipLibCheck: true' + 'resolveJsonModule: true' — pinned so the ES2023-target + NodeNext-module + esModuleInterop + cross-platform-casing-strict + skipLibCheck-fast-build + resolveJsonModule-JSON-imports commitment survives (drift to a lower target would silently drop modern features; drift to bundler-style moduleResolution would break Node-ESM consumers)", () => {
    expect(co.target).toBe('ES2023');
    expect(co.lib).toEqual(['ES2023']);
    expect(co.module).toBe('NodeNext');
    expect(co.moduleResolution).toBe('NodeNext');
    expect(co.esModuleInterop).toBe(true);
    expect(co.forceConsistentCasingInFileNames).toBe(true);
    expect(co.skipLibCheck).toBe(true);
    expect(co.resolveJsonModule).toBe(true);
  });

  it("Strict-mode 8-flag suite framing pinned: 'strict: true' + 'noImplicitAny: true' + 'strictNullChecks: true' + 'strictFunctionTypes: true' + 'strictBindCallApply: true' + 'strictPropertyInitialization: true' + 'noImplicitThis: true' + 'alwaysStrict: true' — pinned so the strict-mode-explicit-8-flag (every sub-flag explicitly true even though `strict:true` implies them — leaves no room for partial drift) commitment survives (drift to dropping any sub-flag would silently widen type holes even if `strict:true` remains)", () => {
    expect(co.strict).toBe(true);
    expect(co.noImplicitAny).toBe(true);
    expect(co.strictNullChecks).toBe(true);
    expect(co.strictFunctionTypes).toBe(true);
    expect(co.strictBindCallApply).toBe(true);
    expect(co.strictPropertyInitialization).toBe(true);
    expect(co.noImplicitThis).toBe(true);
    expect(co.alwaysStrict).toBe(true);
  });

  it("Lint-style + return + switch framing pinned: 'noUnusedLocals: true' + 'noUnusedParameters: true' + 'noImplicitReturns: true' + 'noFallthroughCasesInSwitch: true' + 'noUncheckedIndexedAccess: true' + 'noImplicitOverride: true' — pinned so the dead-code (unused-locals + unused-parameters) + control-flow safety (no-implicit-returns + no-fallthrough) + array/object-access safety (noUncheckedIndexedAccess → T | undefined) + override-explicit commitment survives (drift to dropping noUncheckedIndexedAccess would silently let arr[0] type as T instead of T|undefined, a common runtime-error source)", () => {
    expect(co.noUnusedLocals).toBe(true);
    expect(co.noUnusedParameters).toBe(true);
    expect(co.noImplicitReturns).toBe(true);
    expect(co.noFallthroughCasesInSwitch).toBe(true);
    expect(co.noUncheckedIndexedAccess).toBe(true);
    expect(co.noImplicitOverride).toBe(true);
  });

  it("isolatedModules + verbatimModuleSyntax + declaration + sourceMap framing pinned: 'isolatedModules: true' (every file must be standalone-transpilable) + 'verbatimModuleSyntax: true' (no implicit type-only erasure — explicit import type required) + 'declaration: true' + 'declarationMap: true' + 'sourceMap: true' — pinned so the Node-ESM-strict (isolatedModules + verbatimModuleSyntax) + consumer-package types (declaration + declarationMap) + debugger source-map commitment survives", () => {
    expect(co.isolatedModules).toBe(true);
    expect(co.verbatimModuleSyntax).toBe(true);
    expect(co.declaration).toBe(true);
    expect(co.declarationMap).toBe(true);
    expect(co.sourceMap).toBe(true);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
