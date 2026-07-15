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
    expect(joined).toMatch(/deployment without a compatible harness returns/);
    expect(joined).toMatch(/bundled Anthropic access or provide a valid BYOK Anthropic key/);
    expect(joined).toMatch(/choose another supported proxy scheme/);
  });
});
