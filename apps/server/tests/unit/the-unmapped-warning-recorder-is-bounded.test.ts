// ⛔ THE RECORDER'S KEY SPACE IS DEVICE-CONTROLLED, SO IT HAS TO BE BOUNDED.
//
// `unmappedEgressWarnings` is a MODULE-LEVEL singleton fed on every public read
// of a session — `GET /v1/sessions` walks a whole page of rows through it — and
// its `counts` map is keyed by `reportableEgressWarning(code)`. That function
// echoes any token of the shape `^[a-z0-9_]{1,64}$` VERBATIM, on purpose, so an
// operator can read a genuinely new layer's real name and classify it. The
// shape is a bound on each key's LENGTH and not on the NUMBER of distinct keys,
// and the strings come off `safeguardChecks[].layer`, which is 64 free
// characters from a device.
//
// So a device emitting `safeguard_failed:a1`, `safeguard_failed:a2`, … adds one
// permanent entry per distinct layer to a process-global map that is never
// pruned, and every subsequent list response re-walks a larger structure. The
// `logged` set is already capped at MAX_TRACKED_CODES; `counts` was not, and it
// is the half that grows.
//
// ⚠️ THE COUNT MUST NOT BE THE THING THAT GOES MISSING. Dropping the overflow
// entirely would make an unmapped-code flood — exactly the case worth
// noticing — look quieter than a single one. Past the cap, occurrences are
// folded into one bucket, so the total is still readable and the cardinality
// stops growing.

import { describe, expect, it } from 'vitest';

import {
  createUnmappedEgressWarningRecorder,
  UNMAPPED_OVERFLOW_KEY,
  customerSafeEgressWarnings,
} from '../../src/services/customer-safe-egress-warnings.js';

describe('the unmapped-warning recorder is bounded in cardinality', () => {
  it('CRITICAL 5000 distinct device-supplied codes do not grow the map without bound. The key is a device string and the recorder is process-wide, so an unbounded map is memory a device can allocate on our side, one entry per layer name it invents.', () => {
    const recorder = createUnmappedEgressWarningRecorder();

    for (let i = 0; i < 5000; i += 1) {
      recorder.record([`a_code_nobody_has_classified_${String(i)}`]);
    }

    expect(recorder.counts().size).toBeLessThanOrEqual(65);
  });

  it('CRITICAL no occurrence is lost past the cap — a flood must read LOUDER than one code, not quieter. The overflow bucket carries the rest of the total.', () => {
    const recorder = createUnmappedEgressWarningRecorder();

    for (let i = 0; i < 5000; i += 1) {
      recorder.record([`a_code_nobody_has_classified_${String(i)}`]);
    }

    let total = 0;
    for (const n of recorder.counts().values()) total += n;
    expect(total).toBe(5000);
    expect(recorder.counts().get(UNMAPPED_OVERFLOW_KEY)).toBeGreaterThan(0);
  });

  it('a code already tracked keeps counting under its own name after the cap is reached — the cap closes the map to NEW keys, it does not stop counting the ones an operator is already looking at', () => {
    const recorder = createUnmappedEgressWarningRecorder();
    recorder.record(['first_unclassified_code']);
    for (let i = 0; i < 5000; i += 1) {
      recorder.record([`filler_code_${String(i)}`]);
    }

    recorder.record(['first_unclassified_code']);

    expect(recorder.counts().get('first_unclassified_code')).toBe(2);
  });

  it('POSITIVE CONTROL — the mapper really does hand distinct keys to the recorder, so the arms above are exercising the real feed rather than a synthetic one', () => {
    const { unmapped } = customerSafeEgressWarnings([
      'safeguard_failed:layer_one',
      'safeguard_failed:layer_two',
      'a_code_nobody_has_classified',
    ]);

    expect(unmapped).toEqual([
      'safeguard_failed:layer_one',
      'safeguard_failed:layer_two',
      'a_code_nobody_has_classified',
    ]);
  });
});
