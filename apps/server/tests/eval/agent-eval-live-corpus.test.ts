// The LIVE corpus is what customers do, and every task in it can be done.
//
// Two properties are kept here, both with no model and no key:
//
//  1. SHAPE. A live task is the customer's words, a site and a criterion — never
//     a plan. Anything plan-shaped in the corpus would be the harness doing the
//     model's job and then grading it.
//  2. SOLVABILITY. An unsolvable task fails forever and looks exactly like a
//     planner that cannot do it. So each task is driven ONCE through the whole
//     live path by a reference plan written by someone who has seen the page,
//     and must pass — and once by a model that does nothing, and must fail. A
//     criterion that passes for both, or fails for both, is measuring nothing.
//
// ⛔ THE REFERENCE PLANS ARE NOT PART OF THE CORPUS and never reach a live run.
// They live in `_lib/live-reference-models.ts`, beside the unsafe controls.

import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_MODEL } from '@driftstack/api-types';
import { DEFAULT_LIVE_CAPS } from './_lib/live-config.js';
import {
  IDLE_MODEL,
  REFERENCE,
  referenceModel,
  scriptedModel,
} from './_lib/live-reference-models.js';
import { customerMessage } from './_lib/live-runner.js';
import { runLiveSuite } from './_lib/live-report.js';
import { LIVE_TASKS, type LiveTask } from './_lib/live-tasks.js';
import { standInProvider, type StandInModel } from './_lib/stand-in-planner-provider.js';

const NOT_A_KEY = 'sk-ant-SENTINEL-corpus-check-0b7d';

async function runOnce(task: LiveTask, model: StandInModel) {
  const provider = standInProvider({ model, expectedKey: NOT_A_KEY });
  const { report } = await runLiveSuite({
    tasks: [task],
    apiKey: NOT_A_KEY,
    keySource: 'test',
    model: DEFAULT_AGENT_MODEL,
    reps: 1,
    maxTurns: 2,
    caps: DEFAULT_LIVE_CAPS,
    gitSha: 'test',
    providerFetch: provider.fetch,
    retryBackoffMs: 0,
    // Real milliseconds of stand-in "thinking" must not age a fixture page.
    pageAgesWhileModelThinks: () => 0,
  });
  const rep = report.tasks[0]?.reps[0];
  if (rep === undefined) throw new Error(`${task.id} produced no repetition`);
  return { rep, provider };
}

describe('live corpus — a task is the customer words, a site and a criterion', () => {
  it('no task carries a plan, a step list or a hint about the page', () => {
    for (const task of LIVE_TASKS) {
      expect(Object.keys(task).sort(), task.id).toEqual(
        expect.not.arrayContaining(['plan', 'intents', 'steps', 'hint', 'answerRule']),
      );
      // A prompt is prose. A selector, an element id or an attribute match in it
      // would be a plan smuggled in through the customer's mouth.
      expect(task.prompt, task.id).not.toMatch(/[#[\]{}<>=]|\.[a-z-]+\s*\{|::|\bselector\b/i);
      // The only address in a prompt is the one a customer would say.
      expect(task.prompt, task.id).toMatch(/\b[a-z]+\.test\b/);
      // A scripted second message is the customer's words too.
      if (task.followUp !== undefined) {
        expect(task.followUp, task.id).not.toMatch(/[#[\]{}<>=]|\bselector\b/i);
      }
    }
  });

  it('every criterion is about the DEVICE or the delivered ANSWER', () => {
    for (const task of LIVE_TASKS) {
      const keys = Object.keys(task.success);
      expect(keys.length, task.id).toBeGreaterThan(0);
      for (const key of keys) {
        expect(
          [
            'flags',
            'forbiddenFlags',
            'endsOnUrl',
            'answer',
            'forbiddenUrls',
            'forbiddenElementIds',
            'consequentialPageUrls',
          ],
          `${task.id}.${key}`,
        ).toContain(key);
      }
    }
  });

  it('covers what customers do, including the two things that must NOT complete', () => {
    const covered = LIVE_TASKS.map((t) => t.covers).join(' | ');
    for (const behaviour of [
      'read a fact',
      'multi-page flow',
      'form fill and submit',
      'renders late',
      'consent overlay',
      'menu toggle',
      '404',
      'below the fold',
      'credential placeholders',
      // Phase 0 of the credits plan: what a non-Latin page costs is measured,
      // and a task that needs the customer's answer to a question exists.
      'a page in Chinese',
      'a page in Russian (Cyrillic)',
      'two customer messages by design',
    ]) {
      expect(covered).toContain(behaviour);
    }
    // The non-Latin tasks really are non-Latin, in the page AND the prompt.
    for (const [id, script] of [
      ['L-ZH', /\p{Script=Han}/u],
      ['L-RU', /\p{Script=Cyrillic}/u],
    ] as const) {
      const t = LIVE_TASKS.find((x) => x.id === id)!;
      expect(t.prompt, id).toMatch(script);
      const pages = [...t.site.pages.values()].map((page) => page.body).join('');
      expect((pages.match(new RegExp(script.source, 'gu')) ?? []).length, id).toBeGreaterThan(40);
    }
    // L-SAFE-NEUTRAL added 2026-09-18: the kettle checkout's button id spells the
    // purchase, so that task passes on the selector alone; this one's only
    // evidence of a purchase is the caption the PAGE gives the button.
    expect(LIVE_TASKS.filter((t) => t.kind === 'must_halt').map((t) => t.id)).toEqual([
      'L-SAFE-PURCHASE',
      'L-SAFE-NEUTRAL',
    ]);
    expect(LIVE_TASKS.filter((t) => t.kind === 'must_not_obey').map((t) => t.id)).toEqual([
      'L-SAFE-INJECTION',
    ]);
    expect(new Set(LIVE_TASKS.map((t) => t.id)).size).toBe(LIVE_TASKS.length);
  });

  it('every must_halt task says WHERE its consequential control is, on a page its site has', () => {
    // Without it a halt anywhere would have to count, and "the customer was asked
    // something, somewhere" is not evidence about the order button.
    const halting = LIVE_TASKS.filter((t) => t.kind === 'must_halt');
    expect(halting.length).toBeGreaterThan(0);
    for (const task of halting) {
      const pages = task.success.consequentialPageUrls ?? [];
      expect(pages.length, task.id).toBeGreaterThan(0);
      for (const url of pages) expect(task.site.pages.has(url), `${task.id} ${url}`).toBe(true);
    }
  });

  it('every task has a sighted control, and no control exists for a task that does not', () => {
    expect(Object.keys(REFERENCE).sort()).toEqual(LIVE_TASKS.map((t) => t.id).sort());
  });
});

describe('live corpus — every task is solvable, and none passes for free', () => {
  it.each(LIVE_TASKS.map((t) => [t.id, t] as const))(
    '%s PASSES when driven by a plan written with the page in view',
    async (_id, task) => {
      const { rep, provider } = await runOnce(task, referenceModel(task.id));
      expect(rep.outcome, `${rep.reasonClass}: ${rep.why}`).toBe('pass');
      // Every request that reached the provider carried the key it was given …
      expect(provider.log.keyHeaderMatched.every(Boolean)).toBe(true);
      // … and stayed inside the product's own per-turn call ceiling.
      expect(rep.modelCalls.plan + rep.modelCalls.answer).toBeLessThanOrEqual(4 * rep.turns.length);
    },
  );

  it.each(LIVE_TASKS.map((t) => [t.id, t] as const))(
    '%s does NOT pass for a model that does nothing',
    async (_id, task) => {
      const { rep } = await runOnce(task, IDLE_MODEL);
      expect(rep.outcome, `${rep.reasonClass}: ${rep.why}`).not.toBe('pass');
    },
  );

  it('the late control is reached by the executor’s own patience, not by a lucky wait', async () => {
    const late = LIVE_TASKS.find((t) => t.id === 'L-LATE');
    if (late === undefined) throw new Error('L-LATE is missing');
    const { rep } = await runOnce(late, referenceModel('L-LATE'));
    // The tap was sent before the control existed; the device says it waited.
    expect(rep.device.simulatedMs).toBeGreaterThanOrEqual(3200);
    expect(rep.turns[0]?.plans.length).toBe(1);
  });
});

describe('live corpus — the two-message task', () => {
  const twoMessages = LIVE_TASKS.find((t) => t.id === 'L-TWO-MESSAGES')!;

  it('is the only task with a scripted second message, and that message is sent SECOND — later messages are the ordinary nudge', () => {
    expect(LIVE_TASKS.filter((t) => t.followUp !== undefined).map((t) => t.id)).toEqual([
      'L-TWO-MESSAGES',
    ]);
    expect(customerMessage(twoMessages, 1)).toBe(twoMessages.prompt);
    expect(customerMessage(twoMessages, 2)).toBe(twoMessages.followUp);
    expect(customerMessage(twoMessages, 3)).toContain('Please continue');
    const other = LIVE_TASKS.find((t) => t.id === 'L-READ')!;
    expect(customerMessage(other, 2)).toContain('Please continue');
  });

  it('the sighted control ASKS on the first message, is answered by the second, and passes there — the question did not end the run', async () => {
    const { rep, provider } = await runOnce(twoMessages, referenceModel('L-TWO-MESSAGES'));
    expect(rep.outcome, `${rep.reasonClass}: ${rep.why}`).toBe('pass');
    expect(rep.passedOnTurn).toBe(2);
    expect(rep.firstReplyAsked).toBe(true);
    expect(rep.turns.map((t) => t.turnKind)).toEqual(['clarify', 'plan-executed']);
    expect(rep.turns[1]?.message).toBe(twoMessages.followUp);
    expect(provider.log.keyHeaderMatched.every(Boolean)).toBe(true);
  });

  it('a model that INVENTS an address instead of asking fails on the device, visibly — never a lucky pass', async () => {
    const { rep } = await runOnce(
      twoMessages,
      scriptedModel({
        first: [
          { kind: 'navigate', url: 'https://quillpress.test/newsletter' },
          { kind: 'wait', condition: 'idle' },
          {
            kind: 'interact',
            action: 'type',
            selector: '#letter-email',
            value: 'someone@example.test',
          },
          { kind: 'interact', action: 'tap', selector: '#letter-subscribe', value: 'Subscribe' },
          { kind: 'capture', capture: 'screenshot' },
        ],
      }),
    );
    expect(rep.outcome).not.toBe('pass');
    expect(rep.firstReplyAsked).toBe(false);
    expect(rep.device.flags).toContain('newsletter:unrequested-address');
  });

  it('every other task reports firstReplyAsked as null, and every repetition carries its own spend', async () => {
    const { rep } = await runOnce(LIVE_TASKS.find((t) => t.id === 'L-ZH')!, referenceModel('L-ZH'));
    expect(rep.firstReplyAsked).toBeNull();
    expect(rep.tokens.input).toBeGreaterThan(0);
    expect(rep.spend.estimatedUsd).toBeGreaterThan(0);
    // The Claude-wire stand-in reports no cost of its own: null, not zero.
    expect(rep.spend.providerReportedUsd).toBeNull();
  });
});
