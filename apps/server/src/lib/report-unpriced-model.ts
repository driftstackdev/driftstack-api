// A model with no list price was refused on Driftstack's key. Tell someone.
//
// That refusal is never the customer's doing. The registry lost a row, or a
// stored session carries an id no row describes (an older model, a hand-edited
// row), and every turn of such a session is refused until the price is added. It
// is OUR configuration fault, so it must reach a person — not only a counter.
//
// ⛔ WHY SENTRY AS WELL AS THE METRIC. `driftstack_bundled_llm_error_total
// {kind="model_unpriced"}` counts every refusal, and ops/alerts/driftstack.yml has
// a rule for it, but nothing scrapes production's /metrics: a Prometheus rule
// alone alerts nobody there. Sentry does.
//
// AT MOST ONCE PER MODEL PER PROCESS. The first refusal is the news; every later
// one for the same id is the same fault, and the counter still counts it.
//
// NO CUSTOMER DATA. The event carries the model id and the route template, and
// nothing else: `captureMessage` strips the ambient request, user, breadcrumb
// trail and transaction name (lib/sentry.ts; the last is the concrete request
// path, session id included), so no URL, account, session or message text rides
// along.
// The first line of defence is upstream of this file: tests/unit/
// every-model-a-customer-can-pick-on-our-key-has-a-price.test.ts fails the build
// before such a deploy exists.

import type { SentryClient } from './sentry.js';

/** The two routes that refuse a model on Driftstack's key. A closed set, so it
 *  is safe as a Sentry tag. */
export type UnpricedModelRoute = '/v1/agent-sessions' | '/v1/agent-sessions/:id/message';

/** Longer ids are cut: the id is a lookup key, not a payload. */
const MAX_MODEL_ID_CHARS = 100;
/**
 * Distinct ids remembered per process. An id at turn time is read from a stored
 * session whose model was validated against the registry when it was created, so
 * the real population is a handful of retired ids; the bound only keeps a
 * malformed table from growing this set without limit. Past it, new ids are still
 * refused and counted, and simply not reported again.
 */
const MAX_TRACKED_MODELS = 64;

export interface UnpricedModelReport {
  model: string;
  route: UnpricedModelRoute;
}

/**
 * A reporter with its own memory of what it has sent. Returns true when this
 * call sent an event, false when the model was already reported (or the bound
 * was reached, or there is no Sentry client). Never throws: a refusal must be
 * answered whether or not the report could be sent.
 */
export function createUnpricedModelReporter(): (
  sentry: SentryClient | undefined,
  report: UnpricedModelReport,
) => boolean {
  const reported = new Set<string>();
  return (sentry, { model, route }) => {
    if (sentry === undefined) return false;
    const id = model.slice(0, MAX_MODEL_ID_CHARS);
    if (reported.has(id) || reported.size >= MAX_TRACKED_MODELS) return false;
    reported.add(id);
    try {
      sentry.captureMessage({
        message: `Model "${id}" has no price and was refused on Driftstack's key. Add its price to the model registry.`,
        level: 'error',
        // One Sentry issue per model, however many turns it refuses.
        fingerprint: ['bundled-llm', 'model_unpriced', id],
        tags: { kind: 'model_unpriced', route },
        extra: { model: id, route },
      });
    } catch {
      // Fire-and-forget, like every Sentry call: the refusal stands regardless.
    }
    return true;
  };
}

/** The process-wide reporter. One per process, so each model is reported at
 *  most once per process. */
export const reportUnpricedModel = createUnpricedModelReporter();
