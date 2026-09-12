// The ONE narrow door from the updater to Sentry, and it exists for a bundling
// reason rather than a design one.
//
// ⛔ `import('@sentry/browser')` — a DYNAMIC NAMESPACE import — cannot be
// tree-shaken. The namespace object has to exist at runtime, so Rollup keeps
// every export in that chunk, including `replayIntegration`, `feedbackIntegration`
// and their rrweb dependency. `updater.ts` did exactly that, and it shipped:
// measured on the published bundles, gui-v0.1.51 contained no rrweb and 0.1.52
// contained a new 362,020-byte lazily-loaded chunk holding Session Replay, User
// Feedback and rrweb — +403,926 B of embedded frontend, of which only 32,030
// was the app growing for the release's actual work.
//
// Nothing registered those integrations, so nothing recorded and no widget
// rendered; `telemetry.ts` drops 'Replay' from the defaults besides. But a
// privacy-facing product does not carry a DOM recorder in its binary on the
// strength of nothing having turned it on, and the size was paid by every
// customer on every platform.
//
// A NAMED static import here is shakeable, and the dynamic boundary moves to
// this file — so `updater.ts` keeps the property it wanted (the Sentry runtime
// stays out of a node unit test's module graph) without dragging the rest of
// the SDK into the build. Keep this module to re-exports of the exact functions
// a caller needs; adding `export * from '@sentry/browser'` here would restore
// the defect in a line that looks like tidying.
export { captureException } from '@sentry/browser';
