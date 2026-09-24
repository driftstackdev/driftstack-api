// GUI audit #4 — the desktop sign-in key is refused, by design, for a few
// account changes, and the app must say where they ARE made.
//
// Every key "Sign in with browser" mints is a `cli_device` key. The server
// refuses such keys on the account-takeover operations — among them the two the
// app offers: Team invite / remove, and the Anthropic key save / test / clear
// (server `middleware/device-key-deny.ts`). Nothing the customer does in the app
// can change that answer, so a refusal is not an error to retry: the app shows
// that these changes are managed in the web dashboard, links to it, and disables
// the controls. Before this, Team read the 403 as "Only the account owner can
// manage the team." — which told the OWNER they were not the owner.
//
// The discriminator is the server's `detail` sentence, matched by equality, as
// `isDesktopCredentialRefusalDetail` does for the Free-plan route policy. Both
// 403s share one problem `type` (forbidden), so the sentence is all there is.
// ⚠️ The server throws a string literal, not a shared constant, so the GUI test
// `the-browser-sign-in-key-is-sent-to-the-web-dashboard-for-team-and-key-changes`
// reads the server source and fails if the sentence there changes.

import { useSyncExternalStore } from 'react';

/** The server's device-key refusal, verbatim (`registerDeviceKeyDenyGate`). */
export const DEVICE_KEY_REFUSAL_DETAIL =
  'This operation is not permitted with a device-provisioned key. Use a dashboard session.';

export function isDeviceKeyRefusalDetail(detail: string | undefined): detail is string {
  return detail === DEVICE_KEY_REFUSAL_DETAIL;
}

/** A thrown SDK error (or any `{ status, detail }`) that is the device-key refusal. */
export function isDeviceKeyRefusal(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const { status, detail } = err as { status?: unknown; detail?: unknown };
  return status === 403 && typeof detail === 'string' && isDeviceKeyRefusalDetail(detail);
}

// ── "seen" memory ────────────────────────────────────────────────────────────
// The refusal is a fact about the KEY, not about the view that met it: a
// refused Team invite proves the Anthropic key controls will be refused too. So
// it is remembered per credential (deployment + key) for this run of the app,
// and every view reading it re-renders when it changes. A different key, or a
// different deployment, starts unknown again. Only a short fingerprint of the
// key is held here, never the key itself.

const refusedCredentials = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function credentialFingerprint(apiKey: string, baseUrl: string): string {
  // FNV-1a over "baseUrl\nkey" — identity only, not security: it is never sent
  // anywhere and a collision would only mis-disable a control until restart.
  let h = 0x811c9dc5;
  const s = `${baseUrl.replace(/\/+$/, '')}\n${apiKey}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${String(s.length)}`;
}

export function markDeviceKeyRefused(apiKey: string | null, baseUrl: string): void {
  if (apiKey === null || apiKey.length === 0) return;
  const id = credentialFingerprint(apiKey, baseUrl);
  if (refusedCredentials.has(id)) return;
  refusedCredentials.add(id);
  version += 1;
  for (const l of listeners) l();
}

export function isDeviceKeyRefused(apiKey: string | null, baseUrl: string): boolean {
  if (apiKey === null || apiKey.length === 0) return false;
  return refusedCredentials.has(credentialFingerprint(apiKey, baseUrl));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True once the server has refused this credential as a device key. */
export function useDeviceKeyRefused(apiKey: string | null, baseUrl: string): boolean {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return isDeviceKeyRefused(apiKey, baseUrl);
}

/** Test seam: forget every refusal (a fresh app run). */
export function resetDeviceKeyRefusalsForTests(): void {
  refusedCredentials.clear();
  version += 1;
  for (const l of listeners) l();
}
