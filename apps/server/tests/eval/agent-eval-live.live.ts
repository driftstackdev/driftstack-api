// THE LIVE TIER. A real model plans every task from the customer's words.
//
// ⛔ NO DEFAULT SUITE COLLECTS THIS FILE, AND THAT IS THE POINT OF ITS NAME. It
// is `*.live.ts`, which no include glob in the repository matches; the only
// thing that names it is `vitest.live.config.ts` beside it, so reaching it takes
// an explicit `--config` on the command line. It was `*.test.ts` once, guarded
// by environment variables alone — and one of those is already exported in an
// ordinary developer shell, which is how a check of the skip path became 43 paid
// provider calls.
//
// Started through that config, it still runs only with `EVAL_LIVE=1` AND a key
// in the variable the chosen model's provider reads (for a Claude model, the one
// the product reads for its deployment key), and never with `CI` set. Otherwise its one test is SKIPPED, and its name says exactly how to run
// it. See `_lib/live-config.ts`.
//
// ⛔ AND IT PINS NOTHING. No outcome below is asserted, no baseline is written,
// and no count can fail this file: a nondeterministic number must not be able
// to fail a gate. What IS asserted is the instrument — the run stayed inside
// its spend cap, the report was written, and no secret is in it. Read the
// report; do not gate on it.

import { describe, expect, it } from 'vitest';
import { readLiveConfig } from './_lib/live-config.js';
import { runLiveSuite, writeLiveReport } from './_lib/live-report.js';
import { LIVE_TASKS } from './_lib/live-tasks.js';
import { gitSha } from './_lib/runner.js';

const config = readLiveConfig();

/** A live task is up to a few customer messages of up to four provider calls
 *  each, against a real network. Generous, because the spend cap — not this —
 *  is what bounds the run. */
const LIVE_TIMEOUT_MS = 60 * 60 * 1000;

describe('agent eval — LIVE tier (real planner, real model; never gates)', () => {
  // A CONDITIONAL skip, re-evaluated on every run — never a bare `.skip`, which
  // is a test nobody will ever run again.
  it.skipIf(!config.enabled)(
    config.enabled
      ? 'runs the live corpus inside its spend cap and writes a scrubbed report outside the repository'
      : `SKIPPED — ${config.why}`,
    async () => {
      if (!config.enabled) throw new Error('the live tier ran while disabled');
      const tasks =
        config.onlyTasks === null
          ? LIVE_TASKS
          : LIVE_TASKS.filter((task) => config.onlyTasks?.includes(task.id) === true);
      expect(tasks.length, 'EVAL_LIVE_TASKS named no task in the corpus').toBeGreaterThan(0);

      const { report, secrets } = await runLiveSuite({
        tasks,
        apiKey: config.apiKey,
        keySource: config.apiKeySource,
        model: config.model,
        // Every provider key in the environment, not only this run's: all of
        // them are scrubbed, and all of them are asserted absent below.
        providerKeys: config.providerKeys,
        reps: config.reps,
        maxTurns: config.maxTurns,
        caps: config.caps,
        thinkingPolicy: config.thinkingPolicy,
        structuredOutput: config.structuredOutput,
        devicePredatesTapLook: config.devicePredatesTapLook,
        tapLookOff: config.tapLookOff,
        gitSha: gitSha(),
      });
      // Refuses to write if a secret survived scrubbing; returns the scrubbed text.
      const written = writeLiveReport(report, secrets);
      // Printed, not only written: a report nobody opens is not a report — and
      // the path is the one thing whoever ran this needs next. The text is the
      // SCRUBBED text the writer returned, never a second rendering.
      // eslint-disable-next-line no-console
      console.log(
        `${written.text}\nlive eval report written to ${written.jsonPath} and ${written.textPath}`,
      );

      // ── the INSTRUMENT, which is all this file may assert ──────────────
      expect(report.spend.callsStarted).toBeLessThanOrEqual(config.caps.maxCalls);
      // The dollar cap is checked BEFORE each call, so the run can exceed it by
      // at most the one call that crossed it. A planning call is capped at
      // 8,192 output tokens — well under a dollar at any registry rate.
      expect(report.spend.estimatedUsd).toBeLessThan(config.caps.maxUsd + 1);
      for (const output of [written.json, written.text]) {
        for (const [name, value] of secrets) {
          expect(output.includes(value), `${name} is in the report`).toBe(false);
        }
      }
      // Positive control on the loop above: every provider key the environment
      // holds is among the secrets it checked.
      for (const name of config.providerKeys.keys()) {
        expect(secrets.has(name), `${name} was not checked`).toBe(true);
      }
      // A run in which the provider never once answered measured nothing, and
      // that is a fault in the setup (a bad key, no network) rather than a
      // result. It is the one way this file fails on what came back.
      const answered = report.tasks.some((task) =>
        task.reps.some((rep) =>
          rep.turns.some((turn) => turn.plans.some((p) => p.result !== 'threw')),
        ),
      );
      expect(
        answered,
        'no planning call succeeded — check the key and the network; see the report for the provider error',
      ).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );
});
