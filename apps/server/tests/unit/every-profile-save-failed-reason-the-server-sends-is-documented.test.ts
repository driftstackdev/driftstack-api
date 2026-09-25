// Every `reason` the server can put on a `session.profile_save_failed` webhook is
// the set the customer reference lists — derived from both sides.
//
// The reasons were a device enum and nothing else, and the docs listed them by
// hand. The server now sends one the device never does: `profile_not_loaded`,
// when a session started without its profile's stored state and its save-back
// was refused so it could not replace that state. A reason a customer receives
// and cannot look up is a reason they cannot act on, and a documented reason the
// server can no longer send is a branch in their handler that never runs. So
// the list the reference gives is compared with the list the server exports, in
// both directions.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROFILE_SAVE_FAILED_WEBHOOK_REASONS } from '../../src/services/profile-save-failed-relay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const REFERENCES = ['apps/docs/src/pages/webhooks/events.md', 'docs/api/webhook-events.md'];

/** The backticked values of the "`reason` is one of … Any other failure" sentence. */
function documentedReasons(path: string): string[] {
  const doc = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  const section = /### `session\.profile_save_failed`([\s\S]*?)(?=\n## |\n### )/.exec(doc)?.[1];
  expect(section, `${path} has no session.profile_save_failed section`).toBeDefined();
  const sentence = /`reason`\s+is\s+one\s+of([\s\S]*?)Any\s+other\s+failure/.exec(
    section ?? '',
  )?.[1];
  expect(sentence, `${path} does not list the reasons`).toBeDefined();
  return [...(sentence ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!).sort();
}

describe('every profile_save_failed reason the server sends is documented', () => {
  it('the server list carries the refusal reason next to the device reasons', () => {
    expect(PROFILE_SAVE_FAILED_WEBHOOK_REASONS).toContain('profile_not_loaded');
    expect(PROFILE_SAVE_FAILED_WEBHOOK_REASONS).toContain('upload_failed');
  });

  for (const path of REFERENCES) {
    it(`${path} lists exactly the reasons the server sends`, () => {
      expect(documentedReasons(path)).toEqual([...PROFILE_SAVE_FAILED_WEBHOOK_REASONS].sort());
    });
  }
});
