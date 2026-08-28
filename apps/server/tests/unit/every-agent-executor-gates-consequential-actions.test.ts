// No agent executor may dispatch an unapproved consequential action.
//
// `agent-consequential-action.ts` classifies an intent as consequential — a
// purchase, a payment, an account deletion — and `consequentialHalt` turns one
// the customer has not approved THIS RUN into a halt that stops the plan
// BEFORE the dispatch happens. The customer then approves and the plan re-runs
// with the action's signature in `approvedConsequentialActions`.
//
// All three executors do this today, and the control-plane one says why in its
// own comment: "Identical gate to Stub/RealAgentExecutor: the go-live swap must
// NOT silently drop it (a real box would otherwise execute the action for
// real)." That sentence is the whole risk. The executors are swapped by
// configuration, so the difference between a rehearsal and a real purchase is
// which class the container happened to construct.
//
// WHAT ALREADY COVERS THIS, AND WHERE IT STOPS. Each executor has behavioural
// tests that exercise the gate, and a content-parity guard pins the text of the
// two files the executors live in. Both are keyed on the members that exist:
// the parity guard names two FILE paths, the behavioural tests name three
// CLASSES. A fourth executor — in a new file, for a new transport — is covered
// by neither. Nothing would fail. That is the same shape as the redaction guard
// in `every-intent-emission-goes-through-the-public-projection`, and its header
// states the reasoning better than a restatement would: a source-shape guard is
// deliberate here because it "has to fail for code that does not exist yet,
// which no runtime assertion can do".
//
// SCOPE, STATED. This asserts that each implementation CALLS the shared gate,
// and that it does so before its first `await this.…` dispatch. It does not and
// cannot assert the gate is correct — that is `agent-consequential-action`'s
// own tests — nor that a sufficiently creative executor could not dispatch
// through a free function instead of a method. It closes the case that actually
// recurs: a new implementation of a known interface that omits a step every
// sibling performs.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Executor {
  readonly cls: string;
  readonly file: string;
  readonly body: string;
}

/**
 * Every `class X implements AgentExecutor`, with its brace-matched body.
 *
 * Comments are stripped first. The gate is discussed at length in prose in all
 * three files — the control-plane one names `consequentialHalt` in a comment
 * four lines above where it calls it — so a scan over raw text would report a
 * class as gated on the strength of a sentence describing the gate.
 */
function executors(): Executor[] {
  const found: Executor[] = [];
  for (const file of tsFiles(SRC)) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/class\s+(\w+)\s+implements\s+AgentExecutor\s*\{/g)) {
      const open = code.indexOf('{', m.index + m[0].length - 1);
      let depth = 0;
      for (let i = open; i < code.length; i += 1) {
        if (code[i] === '{') depth += 1;
        else if (code[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            found.push({ cls: m[1]!, file, body: code.slice(open, i) });
            break;
          }
        }
      }
    }
  }
  return found;
}

const EXECUTORS = executors();
const rel = (f: string): string => f.slice(f.indexOf('/src/') + 1);

describe('every agent executor gates consequential actions', () => {
  it('CRITICAL the scan finds the implementations and their bodies. Every assertion below is satisfied by an empty set, and a brace-matcher that returned truncated bodies would report each one ungated — the opposite failure, equally silent. Both floors are here so neither direction passes quietly.', () => {
    expect(EXECUTORS.map((e) => e.cls).sort(), 'classes implementing AgentExecutor').toEqual([
      'ControlPlaneAgentExecutor',
      'RealAgentExecutor',
      'StubAgentExecutor',
    ]);
    for (const e of EXECUTORS) {
      expect(e.body.length, `${e.cls} body parsed out of ${rel(e.file)}`).toBeGreaterThan(200);
    }
  });

  it('CRITICAL every executor calls the shared consequential-action gate. The executors are selected by configuration, so which one runs is a deployment detail — an implementation that skips the gate turns a rehearsal into a real purchase, payment or account deletion with no customer approval, and every sibling looks correct beside it.', () => {
    const ungated = EXECUTORS.filter((e) => !/\bconsequentialHalt\s*\(/.test(e.body)).map(
      (e) => `${e.cls} (${rel(e.file)})`,
    );
    expect(ungated, 'executor(s) dispatching without the consequential-action gate:').toEqual([]);
  });

  it('CRITICAL the gate runs BEFORE the dispatch. Calling it afterwards reads identically in a diff and is worthless: the purchase has already happened, and the halt merely reports it. Only executors that dispatch through `await this.…` are checked, and the floor below keeps that from silently becoming none of them.', () => {
    const dispatching = EXECUTORS.filter((e) => /await\s+this\.\w+\(/.test(e.body));
    expect(
      dispatching.length,
      'executors that dispatch through a method call — if this reaches 0 the arm is vacuous',
    ).toBeGreaterThanOrEqual(2);
    const late = dispatching
      .filter((e) => {
        const gate = e.body.search(/\bconsequentialHalt\s*\(/);
        const dispatch = e.body.search(/await\s+this\.\w+\(/);
        return gate === -1 || gate > dispatch;
      })
      .map((e) => `${e.cls} (${rel(e.file)})`);
    expect(late, 'executor(s) whose gate runs after the first dispatch:').toEqual([]);
  });
});
