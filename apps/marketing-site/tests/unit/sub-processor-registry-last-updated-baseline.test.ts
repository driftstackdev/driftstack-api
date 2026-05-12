// W304.C — drift guard for SUB_PROCESSOR_REGISTER_LAST_UPDATED.
// The value must be a real ISO-8601 date (YYYY-MM-DD) and within
// the last 18 months — anything older suggests the registry hasn't
// been reviewed in too long and customers won't trust it as a
// current artefact.

import { describe, expect, it } from 'vitest';
import { SUB_PROCESSOR_REGISTER_LAST_UPDATED } from '../../src/data/sub-processors';

describe('W304.C SUB_PROCESSOR_REGISTER_LAST_UPDATED baseline', () => {
  it('value is a YYYY-MM-DD ISO date', () => {
    expect(SUB_PROCESSOR_REGISTER_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('date is not in the future', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(SUB_PROCESSOR_REGISTER_LAST_UPDATED <= today).toBe(true);
  });

  it('date is no older than 18 months', () => {
    const updated = new Date(SUB_PROCESSOR_REGISTER_LAST_UPDATED + 'T00:00:00Z').getTime();
    const eighteenMonthsAgo = Date.now() - 18 * 30 * 24 * 60 * 60 * 1000;
    expect(updated).toBeGreaterThan(eighteenMonthsAgo);
  });
});
