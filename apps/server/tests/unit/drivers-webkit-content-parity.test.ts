// W431.B — drift guard for apps/server/src/drivers/webkit.ts.
// Stub WebKit driver — every method throws DriverNotIntegratedError
// until the Driftstack WebKit fork closes Phase 2. Drift here means
// one method silently returns a value instead of throwing, which
// would break the "production fails loudly until WebKit is wired"
// invariant.
//
//   • Framing pinned: NOT YET INTEGRATED; stub returned when
//     DRIVER=webkit; replaced when WebKit fork Phase 2 closes.
//   • implements Driver — full surface, 8 methods.
//   • Every method: `await Promise.resolve()` followed by
//     `throw new DriverNotIntegratedError()`.
//   • No state, no fields, no constructor — pure stub.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/drivers/webkit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W431.B apps/server/src/drivers/webkit.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: Real WebKit driver — NOT YET INTEGRATED; stub returned by factory when DRIVER=webkit; replaced when WebKit fork Phase 2 closes', () => {
    expect(body).toMatch(/\/\/ Real WebKit driver — NOT YET INTEGRATED\./);
    expect(body).toMatch(
      /\/\/ This stub is what the driver factory returns when DRIVER=webkit is set\.\s*\/\/ Every method throws DriverNotIntegratedError\. The class exists so that the\s*\/\/ route layer can construct \+ use a Driver implementation; when the\s*\/\/ Driftstack WebKit fork closes its Phase 2, this file is replaced with the\s*\/\/ real adapter \(and the WebKit fork hands off the binding details\)\./,
    );
  });

  it('imports: DriverNotIntegratedError from lib/errors + full Driver type roster from ./types.js', () => {
    expect(body).toMatch(/import \{ DriverNotIntegratedError \} from '\.\.\/lib\/errors\.js';/);
    expect(body).toMatch(
      /import type \{\s*CaptureInput,\s*CaptureResult,\s*ExtractInput,\s*ExtractResult,\s*SearchInput,\s*SearchResult,\s*LoginInput,\s*LoginResult,\s*CreateSessionInput,\s*CreateSessionResult,\s*Driver,\s*DriverSessionId,\s*GUIInputInput,\s*GUIInputResult,\s*InteractInput,\s*InteractResult,\s*NavigateInput,\s*NavigateResult,\s*SessionStateResult,\s*WaitInput,\s*WaitResult,\s*\} from '\.\/types\.js';/,
    );
  });

  it('WebKitDriver implements Driver; 8 method signatures pinned', () => {
    expect(body).toMatch(/export class WebKitDriver implements Driver \{/);
    expect(body).toContain("readonly searchCapability = 'unavailable' as const;");
    expect(body).toContain("readonly loginCapability = 'unavailable' as const;");
    expect(body).toMatch(
      /async createSession\(_input: CreateSessionInput\): Promise<CreateSessionResult> \{/,
    );
    expect(body).toMatch(
      /async navigate\(_sessionId: DriverSessionId, _input: NavigateInput\): Promise<NavigateResult> \{/,
    );
    expect(body).toMatch(
      /async interact\(_sessionId: DriverSessionId, _input: InteractInput\): Promise<InteractResult> \{/,
    );
    expect(body).toMatch(
      /async guiInput\(_sessionId: DriverSessionId, _input: GUIInputInput\): Promise<GUIInputResult> \{/,
    );
    expect(body).toMatch(
      /async wait\(_sessionId: DriverSessionId, _input: WaitInput\): Promise<WaitResult> \{/,
    );
    expect(body).toMatch(
      /async getState\(_sessionId: DriverSessionId\): Promise<SessionStateResult> \{/,
    );
    expect(body).toMatch(
      /async capture\(_sessionId: DriverSessionId, _input: CaptureInput\): Promise<CaptureResult> \{/,
    );
    expect(body).toMatch(/async destroy\(_sessionId: DriverSessionId\): Promise<void> \{/);
  });

  it('Every method body: `await Promise.resolve()` then `throw new DriverNotIntegratedError()` — fail-loudly invariant', () => {
    const throwCount = body.match(/throw new DriverNotIntegratedError\(\);/g);
    expect(throwCount).not.toBeNull();
    expect((throwCount ?? []).length).toBe(11);
    const awaitResolveCount = body.match(/await Promise\.resolve\(\);/g);
    expect(awaitResolveCount).not.toBeNull();
    expect((awaitResolveCount ?? []).length).toBe(11);
  });

  it('No constructor or mutable/private state — only the fail-closed capability', () => {
    expect(body).not.toMatch(/constructor\(/);
    expect(body).not.toMatch(/private\s+\w/);
    expect(body.match(/readonly\s+\w+/g)).toEqual([
      'readonly searchCapability',
      'readonly loginCapability',
    ]);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
