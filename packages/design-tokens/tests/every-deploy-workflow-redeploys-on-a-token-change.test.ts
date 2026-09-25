// A token change redeploys every surface that ships it.
//
// Each site deploys from its own workflow, and each workflow runs only when a
// path in its `on.push.paths` filter changes. Before this package every filter
// listed `apps/<site>/**` and the root manifests — and nothing under packages/ —
// so a shared token edit would have merged, passed CI and redeployed NOTHING: the
// sites would keep serving the old colours until some unrelated change touched
// them. Every deploy-*.yml, and the GUI render gates (which measure the app the
// tokens are taken from), must list this package.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const WORKFLOWS = join(REPO, '.github/workflows');
const FILTER = 'packages/design-tokens/**';

/** The push-trigger path filter of a workflow file's YAML, or null when it has none. */
function pushPaths(yamlText: string): string[] | null {
  const doc = parse(yamlText) as { on?: { push?: { paths?: unknown } } } | null;
  const paths = doc?.on?.push?.paths;
  return Array.isArray(paths) ? paths.map(String) : null;
}

const deployWorkflows = readdirSync(WORKFLOWS)
  .filter((f) => /^deploy-.+\.ya?ml$/.test(f))
  .sort();
const guarded = [...deployWorkflows, 'gui-gates.yml'];

describe('every deploy workflow redeploys on a design-token change', () => {
  it('the sweep found the six site deploys and the GUI gates', () => {
    // A filename change must not shrink this to nothing and pass.
    expect(deployWorkflows).toEqual([
      'deploy-admin-panel.yml',
      'deploy-customer-dashboard.yml',
      'deploy-docs.yml',
      'deploy-errors-site.yml',
      'deploy-marketing.yml',
      'deploy-status-site.yml',
    ]);
  });

  for (const file of guarded) {
    it(`${file} lists ${FILTER} in its push path filter`, () => {
      const paths = pushPaths(readFileSync(join(WORKFLOWS, file), 'utf8'));
      expect(paths, `${file} has no on.push.paths filter`).not.toBeNull();
      expect(paths).toContain(FILTER);
    });
  }

  it('POSITIVE CONTROL — the reader sees a filter without the package, and a workflow with no filter', () => {
    const without = "on:\n  push:\n    branches: [main]\n    paths:\n      - 'apps/docs/**'\n";
    expect(pushPaths(without)).toEqual(['apps/docs/**']);
    expect(pushPaths(without)).not.toContain(FILTER);
    expect(pushPaths('on:\n  workflow_dispatch:\n')).toBeNull();
  });
});
