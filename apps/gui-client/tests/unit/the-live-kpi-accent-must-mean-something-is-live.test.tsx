import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The Command Center's "Active" tile carried a bare `accent`, so a count of
 * ZERO rendered in the live/ready colour — the page's most-read number saying
 * "running" while nothing was running.
 *
 * ⭐ This is the same defect class as `safeguards_passed` returning true off an
 * empty array and as an unmeasured metric rendering as 0: a positive signal
 * asserted from the absence of the thing it claims. It is worth a guard because
 * it reads as styling and behaves as a claim.
 */

const SRC = resolve(__dirname, '../../src/views/CommandCenterView.tsx');
const body = readFileSync(SRC, 'utf8');

describe('the live KPI accent must mean something is live', () => {
  it('the Active tile accents on the VALUE, never unconditionally', () => {
    // The tile must not carry a bare `accent` prop.
    expect(body, 'Active must not be accented unconditionally').not.toMatch(
      /label="Active"[\s\S]{0,400}?\n\s*accent\s*\n/,
    );
    expect(body).toMatch(/accent=\{liveNow !== null && liveNow > 0\}/);
  });

  it('the KPI value is rendered larger than its label', () => {
    // The value is what the card exists to show. It was text-xl — barely above
    // body copy — which is why a strip of four read as labels with footnotes.
    expect(body).toMatch(/mono text-3xl font-semibold leading-none tabular-nums/);
  });
});

describe('the onboarding checklist must not assert from unknown data', () => {
  it('renders only once accountMe is known', () => {
    // ⛔ The step predicates read `accountMe?.profile_count ?? 0`, which turns
    // UNKNOWN into "you have none" — so before accountMe loads, or if it fails,
    // a customer with 25 profiles is told to "Create a profile". The KPI strip
    // renders the SAME field as "—" for exactly that case, so the page
    // contradicted itself: one component said unknown, the other said
    // incomplete.
    //
    // Same defect as accenting Active at 0 — a definite claim asserted from
    // absent data — and the third instance of that shape on this one page.
    expect(body).toMatch(
      /!onboardingDismissed && !onboardingCompleted && accountMe !== null && \(/,
    );
  });
});
