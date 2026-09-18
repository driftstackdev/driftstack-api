// WHAT BYTES A LIVE RUN ACTUALLY MEASURED.
//
// ⛔ A COMMIT SHA IS NOT PROVENANCE FOR AN UNCOMMITTED TREE. The live tier is run
// while the product is being changed, so every "after" report of one round
// printed the SAME short sha as the "before" report — each certifying itself as
// the code it was measured against — and the prompt and loop had moved between
// runs. So a report now carries hashes of what the planner is actually given
// (both prompts and both reply schemas) and of every agent service file, taken at
// the START and at the END of the run. Two reports are about the same product
// only when these match; a report whose start and end differ was measured on a
// tree that changed under it, and says so.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __TEST_ONLY__ } from '../../../src/services/agent-decomposer-claude.js';

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../..', import.meta.url));

/** Where a turn starts: the runtime, the planner and the executor a live run
 *  builds. Everything they import is found from here. */
const TURN_ENTRY_POINTS = [
  'services/agent-runtime.ts',
  'services/agent-decomposer-claude.ts',
  'services/agent-executor-control-plane.ts',
];

/**
 * Every server source file a turn's code can load: the entry points and,
 * transitively, every relative import they make.
 *
 * ⛔ WHY THE IMPORT CLOSURE AND NOT "every agent-*.ts". The first version hashed
 * every agent service by name, and flagged a run as changed-under-it because
 * another agent's session was writing an unrelated watchdog file in the same
 * shared tree. A stamp that moves for code the turn never loads is as useless as
 * one that does not move for code it does. Derived, so a file added to the turn
 * path tomorrow is covered without anyone remembering this list.
 */
function turnSourceFiles(): string[] {
  const seen = new Set<string>();
  const queue = TURN_ENTRY_POINTS.map((rel) => join(SRC, rel));
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), (m[1] ?? '').replace(/\.js$/, '.ts'));
      if (target.startsWith(SRC)) queue.push(target);
    }
  }
  return [...seen].map((file) => relative(SRC, file)).sort();
}

export { turnSourceFiles };

export interface LiveSourceStamp {
  systemPromptSha256: string;
  answerSystemPromptSha256: string;
  planReplySchemaSha256: string;
  answerReplySchemaSha256: string;
  /** Every server source file a turn can load (see {@link turnSourceFiles}),
   *  in path order, hashed as one stream of (path, bytes) — the planner, the
   *  loop, the look, the gate and everything they import. */
  agentSourceSha256: string;
  agentSourceFiles: number;
  /** Whether the tree differs from its commit in the product source, so the sha
   *  names only the BASE of what ran. Null when git could not be asked. */
  productSourceDirty: boolean | null;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function liveSourceStamp(): LiveSourceStamp {
  const files = turnSourceFiles();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(join(SRC, rel)));
    hash.update('\0');
  }
  let productSourceDirty: boolean | null;
  try {
    productSourceDirty =
      execFileSync(
        'git',
        ['status', '--porcelain', '--', 'apps/server/src', 'packages/api-types/src'],
        { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim().length > 0;
  } catch {
    productSourceDirty = null;
  }
  return {
    systemPromptSha256: sha256(__TEST_ONLY__.SYSTEM_PROMPT),
    answerSystemPromptSha256: sha256(__TEST_ONLY__.ANSWER_SYSTEM_PROMPT),
    planReplySchemaSha256: sha256(JSON.stringify(__TEST_ONLY__.PLAN_REPLY_SCHEMA)),
    answerReplySchemaSha256: sha256(JSON.stringify(__TEST_ONLY__.ANSWER_REPLY_SCHEMA)),
    agentSourceSha256: hash.digest('hex'),
    agentSourceFiles: files.length,
    productSourceDirty,
  };
}

/** Same bytes, as far as the stamp can tell. */
export function sameSource(a: LiveSourceStamp, b: LiveSourceStamp): boolean {
  return (
    a.systemPromptSha256 === b.systemPromptSha256 &&
    a.answerSystemPromptSha256 === b.answerSystemPromptSha256 &&
    a.planReplySchemaSha256 === b.planReplySchemaSha256 &&
    a.answerReplySchemaSha256 === b.answerReplySchemaSha256 &&
    a.agentSourceSha256 === b.agentSourceSha256
  );
}
