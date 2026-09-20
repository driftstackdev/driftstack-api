# Perf regression check

`scripts/check-bench-regression.mjs` (V-165) compares the latest `npm run bench:json` output in `tmp/bench-results.json` against the checked-in baseline at `docs/benchmarks/baseline.ci.json`. CI runs it in the **advisory** `Perf regression check (advisory)` job (`continue-on-error: true`); it is not a hard gate.

```bash
npm run bench:json            # writes tmp/bench-results.json (~1 minute)
npm run bench:check-regression
```

## Each benchmark is compared against the run's own speed

A shared CI runner's speed is a property of the machine, not of the code. On 2026-09-20 this check had failed five consecutive runs on `main`, including commits that touched none of the benchmarked code: in the last of them all nine benchmarks were 54-70% slower than baseline **together**, a bare `node:crypto` sha256 digest among them. That is one slow runner, not nine regressions — and a check that always fails is a check everyone learns to scroll past, so the real regression it exists to catch would have arrived invisible.

So the run gets a **speed factor**: the _median_ of `current hz / baseline hz` over the benchmarks present in both runs. Each benchmark is then compared as `current hz / factor` against its baseline, at the same threshold. A uniformly slow (or fast) runner moves every ratio together, the median moves with them, and nothing is flagged. One benchmark that slowed down _relative to the rest_ still stands out.

The estimator is the median and not the mean so that the one genuine regression in the set cannot drag the factor toward itself and hide inside it.

The raw percentages are printed next to the normalised ones. Normalisation changes what is **flagged**, never what is **reported**.

## What median-normalisation cannot see

**A real regression that hit half or more of the benchmarks together.** A Node upgrade, a dependency that slowed every hash, a change to a hot path they all share — the median moves with them, and the check reads it as a slow runner and says nothing.

The check answers _"did anything get slower than the rest of this run"_. It does not answer _"did anything get slower than it used to be"_. The raw percentages in the output are the only thing that answers the second question, which is why they are always printed, and why the factor itself is always printed: a factor far from `1.0` is **either** different hardware **or** exactly this blind spot, and nothing in the output can tell you which. Reading a factor of `0.37`, ask both questions.

### The boundary is exactly half

Not "most" — half. With `k` of `n` benchmarks 60% slower and the default 50% threshold:

| `k`             | What the median does                                                           | Flagged                                                 |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `k < n/2`       | sits on an unaffected benchmark; the factor does not move                      | **all `k`** (4 of 9 → 4)                                |
| `k = n/2`, even | averages one affected and one unaffected ratio, landing halfway (factor `0.7`) | **none** — 60% normalises to 42.9%, under the threshold |
| `k > n/2`       | sits on an affected benchmark; the regression normalises to 0%                 | **none** (5 of 9 → 0)                                   |

With the repo's nine benchmarks, five have to move together before the check goes quiet. The output states this line for the run in front of it.

### Why one global median, and not a median per bench file

Per file, the three `webhook-signature.bench.ts` benchmarks would be normalised against each other. Our own change slowing all three by 60% is `k = n` for that file: the per-file factor becomes `0.4` and all three read as 0% slower — a real regression, ours, erased. The same three inside the global nine are `k = 3 of 9`, the global median does not move, and all three are flagged at 60%. **The smaller the group a factor is drawn from, the more of a shared regression it swallows**, so the factor is drawn from every benchmark in the run.

### The other direction — crying wolf

Normalisation assumes the machine moves every benchmark by roughly the same ratio. It does not, quite. In the 2026-09-20 CI run the nine ratios spanned `0.301` to `0.464` around a median of `0.375`, so on a run where no code had changed the slowest benchmark normalised to 19.9% slower and the fastest to 23.6% faster. That is about 2.5× of headroom under the 50% threshold — but it is one observation of one pair of machines. A runner class whose relative profile differs more (a different crypto implementation; a smaller cache against the 10 KB body benchmark) can flag a benchmark with no code change behind it. Re-recording the baseline on the runner class being compared is what shrinks that spread, and it is what the `⚠ DIFFERENT HARDWARE` notice asks for.

Run-to-run noise is not the cry-wolf risk: the local benchmarks report `rme` between 0.2% and 5.9%, an order of magnitude below the threshold.

### Not measured is not passed

A baseline benchmark that did not appear in the run at all is printed as `[missing]`, and a pair whose rate is non-finite (or whose baseline rate is zero) is printed as `[unmeasured]`. Neither is folded into the summary line: when either is present the report says **"All COMPARED benchmarks within threshold."** and names the count that was not checked. Neither changes the exit code — a rename legitimately produces one `[missing]` and one `[new]` — so the printed line is the whole signal.

A current rate of exactly `0` is not `[unmeasured]`: it is a real measurement of a benchmark that completed nothing, a 100% slowdown, and it is flagged as one.

Two guardrails make the hardware-or-regression ambiguity loud rather than quiet:

| Guardrail       | Value | Behaviour                                                                                                                                                                                                                                                           |
| --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HARDWARE_BAND` | `2`   | Outside `[0.5, 2.0]` the run is more than 2× slower or faster than the machine the baseline came from. The output prints a `⚠ DIFFERENT HARDWARE` notice naming the re-record command: every raw percentage is then mostly a machine difference, not a code change. |
| `MIN_SHARED`    | `3`   | Fewer than three benchmarks present in both runs and the script **refuses** to normalise, compares the raw numbers, and says so, rather than dividing by a factor drawn from one or two samples.                                                                    |

A benchmark that is new in the results — no baseline entry — is reported as `[new]`, never flagged, and does not vote on the factor.

## Re-recording the baseline

When the notice says the baseline does not describe this runner, re-record it **on that runner class**:

```bash
npm run bench:json
PERF_REGRESSION_RECORD_NEW=1 npm run bench:check-regression
```

That writes `docs/benchmarks/baseline.ci.json` and exits `0` without comparing anything. Commit the file.

The record carries the hardware, not just the numbers — `recordedAtIso`, `node`, `os`, `arch`, `cpu` — because a baseline whose machine is unknown cannot tell a later run whether it is comparing across hardware classes, which is the condition that produced the five red runs.

## Environment

| Variable                        | Default                            | Effect                                                            |
| ------------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `PERF_REGRESSION_THRESHOLD`     | `0.50`                             | Fractional slowdown (relative to the rest of the run) that flags. |
| `PERF_REGRESSION_RESULTS_PATH`  | `tmp/bench-results.json`           | Input, as written by `npm run bench:json`.                        |
| `PERF_REGRESSION_BASELINE_PATH` | `docs/benchmarks/baseline.ci.json` | Baseline to compare against.                                      |
| `PERF_REGRESSION_RECORD_NEW`    | unset                              | `1` replaces the baseline with the current run and exits `0`.     |

Exit codes: `0` nothing flagged · `1` at least one benchmark flagged · `2` bootstrap (no baseline file; the current run was recorded as one, commit it).

## Why it stays advisory

`auth-path.md`, `rate-limit.md` and `webhook-signature.md` all note that bench results on shared runners are too noisy to fail builds on. Median-normalisation removes the _whole-runner_ component of that noise; it does not remove per-benchmark variance, and it introduces the blind spot above. Flipping the job from advisory to a hard gate is a decision for the owner, with sustained low-noise runs as the evidence.

## Tests

`scripts/tests/a-uniformly-slower-runner-is-not-nine-regressions.test.ts` covers the pure exports (`flatten`, `speedFactor`, `compare`, `formatReport`, `baselineRecord`) and runs the script end to end, using the real numbers from the failing CI run as one fixture. `apps/server/tests/unit/scripts-check-bench-regression-content-parity.test.ts` and `apps/server/tests/unit/ops-scripts-load-bench-subprocessor-dr-content-parity.test.ts` pin the script's commitments as text.
