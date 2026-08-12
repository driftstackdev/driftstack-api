import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..');

const CURRENT_STATE_PATHS = [
  'apps/server/src/lib/openapi.ts',
  'packages/sdk-go/agent_sessions.go',
  'packages/sdk-go/examples/agent_chat/main.go',
  'packages/sdk-python/examples/agent_chat.py',
  'packages/sdk-python/examples/egress_flow.py',
  'packages/sdk-python/examples/egress_openvpn.py',
  'packages/sdk-python/openapi.json',
  'packages/sdk-python/src/driftstack/resources/agent_sessions.py',
  'packages/sdk-python/src/driftstack/client.py',
  'packages/sdk-typescript/examples/agent-chat.ts',
  'packages/sdk-typescript/examples/egress-flow.ts',
  'packages/sdk-typescript/examples/egress-openvpn.ts',
  'packages/sdk-typescript/src/resources/agent-sessions.ts',
] as const;

describe('SDK and OpenAPI current-state copy', () => {
  const joined = CURRENT_STATE_PATHS.map((path) => readFileSync(resolve(ROOT, path), 'utf8')).join(
    '\n',
  );

  it('does not promise that implemented runtime surfaces will arrive later', () => {
    expect(joined).not.toMatch(
      /not yet enabled on this deployment|not yet wired on this deployment|pre-harness \(today\)|Agent 1 roadmap|comes online when|harness ships|implementations land in PY2|accessors are placeholders/i,
    );
  });

  it('keeps deployment-dependent FeatureUnavailable guidance honest and actionable', () => {
    expect(joined).toMatch(/BYOK Anthropic key storage is unavailable on deployments without/);
    expect(joined).toMatch(/No compatible egress backend is available on this deployment/);
    // The input-event statement moved to its own PER-SDK check below. It was
    // /deployment without a compatible harness returns/ asserted against `joined`, which was
    // wrong twice over: the wording required the SDKs to frame input forwarding as
    // deployment-dependent when the route throws unconditionally, and a `joined` match is
    // satisfied by ANY ONE of the 13 files — so two of the three SDKs could drift back to
    // the false framing with this still green.
    expect(joined).toMatch(/bundled Anthropic access or provide a valid BYOK Anthropic key/);
    expect(joined).toMatch(/choose another supported proxy scheme/);
  });

  it("CRITICAL EVERY SDK says input forwarding is unavailable everywhere, not per-deployment. Checked per file rather than over the joined corpus: 'forwarded' is unreachable in all three SDKs for the same reason, so one of them carrying the sentence says nothing about the other two.", () => {
    // The route throws FeatureUnavailable unconditionally, and the one code path that
    // constructs { kind: 'forwarded' } sits behind the pair-mode `human-driving` state,
    // which only `takeover-grant` produces and nothing emits. So a customer branching on
    // `'forwarded'` is writing dead code, in every SDK, on every deployment.
    const SDK_SURFACES = [
      'packages/sdk-go/agent_sessions.go',
      'packages/sdk-python/src/driftstack/resources/agent_sessions.py',
      'packages/sdk-typescript/src/resources/agent-sessions.ts',
    ] as const;

    const silent = SDK_SURFACES.filter(
      (path) =>
        !/No deployment forwards input events/.test(readFileSync(resolve(ROOT, path), 'utf8')),
    );

    expect(
      silent,
      "SDK(s) not stating that input forwarding is unavailable on every deployment — do not reintroduce 'a deployment without a compatible harness', which implies another one forwards:",
    ).toEqual([]);
  });
});
