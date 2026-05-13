// W542.B — drift guard for /.github/workflows/server-deploy.yml.
// V-278 tag-triggered production-only deploy. Sister workflow to
// deploy.yml. Drift here either drops the V-549.A pre-deploy smoke
// (would layer a new deploy on top of an already-broken production),
// drops the V-549.B auto-rollback to PREV_TAG (would leave broken
// containers running after a failed deploy), or widens the trigger
// past server-v* tags (would let arbitrary pushes trigger a prod
// release cut).
//
//   • V-278 anchor + sister-to-deploy.yml framing.
//   • Two trigger forms: push tags server-v* + workflow_dispatch
//     with `inputs.tag` (founder runbook override).
//   • Pre-deploy smoke V-549.A: /health + /openapi.json startsWith
//     "3.1" + 5s timeout.
//   • Post-deploy rollback V-549.B: capture PREV_TAG via docker
//     compose images --quiet + docker inspect RepoTags + re-export
//     IMAGE_TAG + docker compose up to roll back.
//   • Concurrency group server-deploy-${{ github.ref }} +
//     cancel-in-progress: false.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.github/workflows/server-deploy.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W542.B /.github/workflows/server-deploy.yml content parity', () => {
  const body = read(LIB);

  it("V-278 anchor + sister-to-deploy.yml framing pinned: '# V-278 — Tag-triggered production deploy for the API server.' + 'Sister workflow to .github/workflows/deploy.yml. Where deploy.yml auto-deploys to staging on every main merge + gates production on approval, this workflow gives the founder an explicit-release trigger via git tag — `git tag server-v0.2.1 && git push origin server-v0.2.1` cuts a production-only deploy with no main-merge coupling.' + '# Use either workflow:' + 'deploy.yml   — push-on-main; staging auto + manual-approval prod.' + 'Continuous-delivery shape; appropriate for the Q4-2026/Q1-2027 launch period when builds are vetted via the manual prod-approval gate.' + 'server-deploy.yml — tag-on-server-v*; production-only.' + 'Explicit-release shape; appropriate post-launch when production cuts should be deliberate cuts of a tagged release, not \"whatever's on main.\"' — pinned so the V-278 + sister-to-deploy.yml + Q4-2026/Q1-2027-launch-period-CD-shape + post-launch-tag-explicit-release-shape + git-tag-server-v0.2.1-example commitment survives", () => {
    expect(body).toMatch(/# V-278 — Tag-triggered production deploy for the API server\./);
    expect(body).toMatch(/# Sister workflow to \.github\/workflows\/deploy\.yml\./);
    expect(body).toMatch(
      /Where deploy\.yml\s*\n#\s*auto-deploys to staging on every main merge \+ gates production on/,
    );
    expect(body).toMatch(/# approval, this workflow gives the founder an explicit-release/);
    expect(body).toMatch(/# trigger via git tag — `git tag server-v0\.2\.1 && git push origin/);
    expect(body).toMatch(/# server-v0\.2\.1` cuts a production-only deploy with no main-merge/);
    expect(body).toMatch(/# coupling\./);
    expect(body).toMatch(/# Use either workflow:/);
    expect(body).toMatch(
      /#\s+- deploy\.yml\s+— push-on-main; staging auto \+ manual-approval prod\./,
    );
    expect(body).toMatch(/#\s+Continuous-delivery shape; appropriate for the/);
    expect(body).toMatch(/#\s+Q4-2026\/Q1-2027 launch period when builds are/);
    expect(body).toMatch(/#\s+vetted via the manual prod-approval gate\./);
    expect(body).toMatch(/#\s+- server-deploy\.yml — tag-on-server-v\*; production-only\./);
    expect(body).toMatch(/#\s+Explicit-release shape; appropriate post-launch/);
    expect(body).toMatch(/#\s+when production cuts should be deliberate cuts/);
    expect(body).toMatch(/#\s+of a tagged release, not "whatever's on main\."/);
  });

  it("Trigger + concurrency framing pinned: 'name: Server release deploy (tag)' + 'on: push: tags: - server-v*' + 'workflow_dispatch: inputs: tag: description: \"Tag to deploy (e.g. server-v0.2.1). Must already exist.\" + required: true + type: string' + 'concurrency: group: server-deploy-${{ github.ref }} + cancel-in-progress: false' — pinned so the server-v* tag-trigger + workflow_dispatch-with-required-tag-input + cancel-in-progress: FALSE (let in-flight deploys finish) commitment survives (drift to widening tag pattern past 'server-v*' would let arbitrary tags trigger production)", () => {
    expect(body).toMatch(/^name: Server release deploy \(tag\)$/m);
    expect(body).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*- 'server-v\*'/);
    expect(body).toMatch(
      /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*tag:\s*\n\s*description: 'Tag to deploy \(e\.g\. server-v0\.2\.1\)\. Must already exist\.'\s*\n\s*required: true\s*\n\s*type: string/,
    );
    expect(body).toMatch(
      /concurrency:\s*\n\s*group: server-deploy-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/,
    );
  });

  it("build-image + checkout-tag + GHCR-tag-only framing pinned: 'Checkout (tag) + uses: actions/checkout@v6 + with: ref: ${{ github.event.inputs.tag || github.ref }}' + 'REF=${GITHUB_REF##*/} + INPUT_TAG=${{ github.event.inputs.tag }} + TAG_NAME=${INPUT_TAG:-$REF}' + 'IMAGE=ghcr.io/${{ github.repository_owner }}/driftstack-api:${TAG_NAME}' + 'docker/build-push-action@v6 + tags: image-tag (only — no :latest)' — pinned so the checkout-the-tag-not-HEAD + tag-or-input-fallback + GHCR-with-exact-tag-no-latest-push commitment survives (drift to also pushing :latest on tag deploy would clobber the latest-from-main pointer with a possibly-older tagged build)", () => {
    expect(body).toMatch(/name: Checkout \(tag\)/);
    expect(body).toMatch(/uses: actions\/checkout@v6/);
    expect(body).toMatch(/ref: \$\{\{ github\.event\.inputs\.tag \|\| github\.ref \}\}/);
    expect(body).toMatch(/REF="\$\{GITHUB_REF##\*\/\}"/);
    expect(body).toMatch(/INPUT_TAG="\$\{\{ github\.event\.inputs\.tag \}\}"/);
    expect(body).toMatch(/TAG_NAME="\$\{INPUT_TAG:-\$REF\}"/);
    expect(body).toMatch(
      /IMAGE="ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/driftstack-api:\$\{TAG_NAME\}"/,
    );
    expect(body).toMatch(/uses: docker\/build-push-action@v6/);
  });

  it("V-549.A pre-deploy smoke framing pinned: '# V-549.A / V-660 — pre-deploy smoke against the live target.' + '# If production is already broken, abort instead of layering a new deploy on top. Sub-second cost.' + 'name: Pre-deploy production smoke (V-549.A)' + 'curl --fail --silent --show-error --max-time 5 https://api.driftstack.dev/health' + 'curl --fail --silent --show-error --max-time 5 https://api.driftstack.dev/openapi.json | jq -e \\'.openapi | startswith(\"3.1\")\\' > /dev/null' + 'echo \"Pre-deploy smoke OK; proceeding with deploy.\"' — pinned so the V-549.A / V-660 pre-deploy-smoke + abort-if-prod-broken + sub-second-cost + /health-200 + /openapi.json-must-startWith-3.1 + 5s-max-time commitment survives (drift to skipping the openapi.json check would let a broken OpenAPI build pass the smoke)", () => {
    expect(body).toMatch(/# V-549\.A \/ V-660 — pre-deploy smoke against the live target\./);
    expect(body).toMatch(/# If production is already broken, abort instead of layering a/);
    expect(body).toMatch(/# new deploy on top\. Sub-second cost\./);
    expect(body).toMatch(/name: Pre-deploy production smoke \(V-549\.A\)/);
    expect(body).toMatch(
      /curl --fail --silent --show-error --max-time 5 \\\s*\n\s*https:\/\/api\.driftstack\.dev\/health > \/dev\/null/,
    );
    expect(body).toMatch(
      /curl --fail --silent --show-error --max-time 5 \\\s*\n\s*https:\/\/api\.driftstack\.dev\/openapi\.json \\\s*\n\s*\| jq -e '\.openapi \| startswith\("3\.1"\)' > \/dev\/null/,
    );
    expect(body).toMatch(/echo "Pre-deploy smoke OK; proceeding with deploy\."/);
  });

  it('V-549.B auto-rollback framing pinned: \'Deploy via SSH with auto-rollback (V-549.B)\' + \'# V-549.B — capture the currently-running image tag so we can roll back to it if the post-deploy health-check fails.\' + \'PREV_TAG=$(docker compose images --quiet driftstack-api 2>/dev/null | xargs -r docker inspect --format \\\'{{(index .RepoTags 0)}}\\\' 2>/dev/null | head -n1 || true)\' + \'if [ -n "$PREV_TAG" ]; then echo "Previous image tag (for rollback): $PREV_TAG"; else echo "No previous image tag detected — first deploy or scratch state."; fi\' + \'10-attempt /health loop with HEALTHY=1 flag\' + \'if [ "$HEALTHY" -ne 1 ]; then echo "Post-deploy /health failed. Initiating V-549.B rollback."; if [ -n "$PREV_TAG" ]; then export IMAGE_TAG="$PREV_TAG"; docker compose up -d --remove-orphans; echo "Rolled back to $PREV_TAG. Manual verification required."; else echo "No previous tag to roll back to. Manual intervention required."; fi; exit 1; fi\' — pinned so the V-549.B PREV_TAG-capture + first-deploy-graceful-fallback + HEALTHY-flag-not-early-exit + roll-back-to-PREV_TAG + Manual-verification-required + exit-1-on-rollback commitment survives', () => {
    expect(body).toMatch(/name: Deploy via SSH with auto-rollback \(V-549\.B\)/);
    expect(body).toMatch(/# V-549\.B — capture the currently-running image tag so we can/);
    expect(body).toMatch(/# roll back to it if the post-deploy health-check fails\./);
    expect(body).toMatch(
      /PREV_TAG=\$\(docker compose images --quiet driftstack-api 2>\/dev\/null \\/,
    );
    expect(body).toMatch(
      /\| xargs -r docker inspect --format '\{\{\(index \.RepoTags 0\)\}\}' 2>\/dev\/null \\/,
    );
    expect(body).toMatch(/\| head -n1 \|\| true\)/);
    expect(body).toMatch(/if \[ -n "\$PREV_TAG" \]; then/);
    expect(body).toMatch(/echo "Previous image tag \(for rollback\): \$PREV_TAG"/);
    expect(body).toMatch(/echo "No previous image tag detected — first deploy or scratch state\."/);
    expect(body).toMatch(/HEALTHY=0/);
    expect(body).toMatch(/HEALTHY=1/);
    expect(body).toMatch(/if \[ "\$HEALTHY" -ne 1 \]; then/);
    expect(body).toMatch(/echo "Post-deploy \/health failed\. Initiating V-549\.B rollback\."/);
    expect(body).toMatch(/export IMAGE_TAG="\$PREV_TAG"/);
    expect(body).toMatch(/docker compose up -d --remove-orphans/);
    expect(body).toMatch(/echo "Rolled back to \$PREV_TAG\. Manual verification required\."/);
    expect(body).toMatch(/echo "No previous tag to roll back to\. Manual intervention required\."/);
  });

  it("Production environment binding + 10-attempt /health framing pinned: 'deploy-production: needs: build-image' + 'environment: name: production + url: https://api.driftstack.dev' + 'for i in 1 2 3 4 5 6 7 8 9 10; do' + 'curl -fsS http://127.0.0.1:7780/health > /dev/null' + 'echo \"production (tag) healthy\"' + 'sleep 3' — pinned so the production-env-binding-to-api.driftstack.dev + 10-attempt-3s-sleep /health + 7780-port commitment survives (drift to a tighter sleep budget would surface false-negative health failures during cold-start)", () => {
    expect(body).toMatch(/deploy-production:/);
    expect(body).toMatch(/needs: build-image/);
    expect(body).toMatch(/name: production/);
    expect(body).toMatch(/url: https:\/\/api\.driftstack\.dev/);
    expect(body).toMatch(/for i in 1 2 3 4 5 6 7 8 9 10; do/);
    expect(body).toMatch(/curl -fsS http:\/\/127\.0\.0\.1:7780\/health > \/dev\/null/);
    expect(body).toMatch(/echo "production \(tag\) healthy"/);
    expect(body).toMatch(/sleep 3/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
