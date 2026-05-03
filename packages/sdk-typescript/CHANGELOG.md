# Changelog

All notable changes to the Driftstack TypeScript SDK. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pre-1.0 stability policy

The SDK is at **0.1.x**; the public surface is stable enough to
build against (every release is checked through the marshalling
round-trip tests in `tests/unit/wire-shape.test.ts`) but minor
versions may introduce additive changes — new methods, new fields,
new error subclasses. **Patch versions** (0.1.x → 0.1.y) are
strictly fixes and additive types. **Minor versions** (0.1 → 0.2)
may include schema renames if the iPhone-archetype reference rig
discovers a wire-shape divergence. **Breaking changes** that affect
shipping customer code are deferred until 1.0; pre-1.0 customers
should pin against `^0.1.0` rather than an exact version.

## [0.1.5] - 2026-05-03

### Added

- **`SessionTimeoutError`** — new typed error subclass mapping
  the `https://errors.driftstack.dev/session-timeout` problem type
  (status 504). Distinguished from `DriverError` so callers can
  react specifically to "the operation didn't finish within the
  per-call timeout I supplied" without conflating with downstream
  driver failures. Carries `timeoutMs: number | undefined` from
  the problem extension. See V-044 [control].

  ```ts
  try {
    await client.sessions.interact(sid, { action: t, timeout_ms: 5000 });
  } catch (err) {
    if (err instanceof SessionTimeoutError) {
      // Retry with a longer timeout, or surface to the user.
      console.log(`Op timed out after ${err.timeoutMs} ms`);
    }
  }
  ```

- HTTP-layer regression tests for `RevokedKeyError`,
  `ExpiredKeyError`, and `SessionTimeoutError` mappings.

## [0.1.4] - 2026-05-03

### Removed

- `InteractAction.tap.offset` removed from the public surface. Same
  L-001 vector as `tap_at`: a coordinate primitive on the
  customer-facing schema lets a customer bypass the behavioral
  simulation layer for the offset portion of the interaction. Bounded
  coordinates are still coordinates. See `docs/locked-decisions.md`
  L-001 in the control-plane repo and V-042 [control].

### Migration

If existing code passes `offset: { x, y }` to `tap`, the value is now
silently stripped (Zod's default unknown-key behavior on object
schemas). Re-express the intent through selector specificity:
better selectors, child-element targeting, ARIA-role qualifiers, or
text-content matching. Examples:

```ts
// Before (0.1.x):
client.sessions.interact(id, {
  action: { kind: 'tap', selector: 'button.cta', offset: { x: 0, y: 50 } },
});

// After (0.1.4+):
// Identify the actual sub-element you wanted to hit:
client.sessions.interact(id, {
  action: { kind: 'tap', selector: 'button.cta .icon-arrow' },
});
```

If your app genuinely needs coordinate-level addressing (because
you're driving the session from a screenshot, not from DOM
selectors), that lives on the gui-control plane — a separate
endpoint gated behind the `gui_control` API-key scope and not
exposed in this SDK.

## [0.1.3] - 2026-05-03

### Added

- Wire-shape regression tests at `tests/unit/wire-shape.test.ts`
  (13 tests). Locks the canonical JSON shape for `InteractAction`
  (5 variants), `WaitCondition` (4 variants), and `NavigateRequest`.
  Asserts L-001 rejection of `tap_at` / `type_focused` on the
  customer-facing surface (these live on the gui-control plane,
  not exposed in this SDK). See V-037 in the control-plane repo.

### Changed

- Re-cut: `tap_at` and `type_focused` removed from
  `InteractActionSchema`. They were briefly added in 0.1.2 (V-032
  in the control-plane repo) for the self-hosted GUI's
  manual-control input forwarding. Per L-001 in
  `docs/locked-decisions.md`, customer-facing schemas stay
  intent-only — coordinate primitives bypass the behavioral
  simulation layer and erode the moat. The GUI now uses a
  separate, scope-gated endpoint (`/v1/sessions/:id/gui-input`,
  `gui_control` API-key scope) that customer SDKs do not expose.

## [0.1.2] - 2026-05-02

### Added

- `tap_at` and `type_focused` variants on `InteractActionSchema`
  (subsequently reverted in 0.1.3 — see above).

### Notes

- Brief release; superseded by 0.1.3 within hours.

## [0.1.1] - 2026-05-02

### Changed

- `verifyWebhookSignature` is now `async` (returns `Promise<boolean>`)
  because the underlying HMAC implementation switched from Node's
  `crypto` module to the Web Crypto API for browser-isomorphism.
  Sub-millisecond runtime cost; doesn't affect throughput. Callers
  must `await` the result.
- Body input type widened: accepts `string | Uint8Array | ArrayBuffer`
  instead of `Buffer` (which was Node-specific).

### Why

- The previous `verifyWebhookSignature` used `node:crypto` which
  Vite/rollup couldn't bundle for browser environments — the
  Tauri-based GUI client (control-plane repo) had a hand-written
  fetch wrapper as a workaround. Rewriting to Web Crypto API
  closes that gap; the SDK is now usable in Node 20+, every modern
  browser, Tauri WebViews, Cloudflare Workers, Deno, and Bun.

## [0.1.0] - 2026-05-02

### Added

- Inaugural release. `Driftstack` client + four resource accessors
  (`sessions`, `apiKeys`, `usage`, `webhooks`).
- Discriminated-union types for `InteractAction` (`tap`, `type`,
  `scroll`, `press`) and `WaitCondition` (`selector`,
  `selector_hidden`, `url_matches`, `time`).
- Error hierarchy: `DriftstackError` base with `kind` discriminator;
  subclasses `BadRequestError`, `ValidationError`, `AuthError`,
  `InvalidKeyError`, `RevokedKeyError`, `RateLimitError`,
  `NotFoundError`, `TransportError`, etc.
- Built-in retry on transient transport + rate-limit errors;
  honours server `Retry-After`.
- `verifyWebhookSignature` helper (Stripe-style HMAC-SHA256
  signature verification).
- Public packages on npm under `@driftstack/sdk` (this) +
  `@driftstack/api-types` (shared Zod schemas, re-exports types).
