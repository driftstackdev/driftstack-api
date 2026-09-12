/**
 * Convert low-level browser, Tauri, and API failures into safe customer copy.
 * Callers supply a task-specific fallback; known transport classes get a
 * consistent actionable explanation without exposing exception internals.
 */
export function humanizeError(
  error: unknown,
  fallback = 'Something went wrong. Try again.',
): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const normalized = `${name} ${message}`.toLowerCase();

  // The SDK's DriftstackError carries a stable kind/status, but its title,
  // detail, and message come from the remote problem body. Classify from the
  // contract fields and never reflect that prose into the installed client.
  const record =
    error !== null && typeof error === 'object'
      ? (error as { kind?: unknown; status?: unknown; issues?: unknown })
      : null;
  const kind = typeof record?.kind === 'string' ? record.kind : '';
  const status =
    typeof record?.status === 'number' && Number.isInteger(record.status) ? record.status : 0;
  if (kind !== '' && kind !== 'transport') {
    const problemKind = kind === 'validation' ? 'validation-failed' : kind.replaceAll('_', '-');
    // The SDK's ValidationError carries the server's Zod flatten() in `issues`.
    // Only the field NAMES cross into copy — see validationFieldNames.
    return fixedApiErrorMessage(
      `${PROBLEM_TYPE_PREFIX}${problemKind}`,
      status,
      undefined,
      validationFieldNames(record?.issues),
    );
  }
  if (status >= 400 && status <= 599) return fixedApiErrorMessage('', status);

  if (/abort|timed? out|timeout/.test(normalized)) {
    return 'The request took too long. Check your connection and try again.';
  }
  // ⭐ ADDITIVE (2026-09-12, owner's updater row). The three alternatives after
  // `dns` are reqwest 0.13.3's own `Display` prefixes, and they were the entire
  // reason a dropped download rendered the generic fallback: the bundle is
  // fetched in RUST, not the webview, so none of the browser-fetch vocabulary
  // above can ever match it. reqwest writes the kind and then
  // ` for url (<url>)` and NEVER appends its source
  // (reqwest-0.13.3/src/error.rs:236-284), and the plugin's `Error::Reqwest` is
  // `#[error(transparent)]`, so exactly these strings cross the IPC —
  // `.send()` failures as `error sending request`, and a connection dropped
  // part-way through the ~26 MiB body as one of the other two
  // (tauri-plugin-updater-2.10.1/src/updater.rs:686, :706).
  // MEASURED: no other string in apps/gui-client/src, apps/server/src or
  // packages contains any of the three, so no pre-existing caller moves.
  if (
    /failed to fetch|fetch failed|network(?:error| request)?|load failed|offline|internet|connection (?:failed|lost|refused)|dns|error sending request|error decoding response body|request or response body error/.test(
      normalized,
    )
  ) {
    return 'Check your connection and try again.';
  }
  // ⭐ ADDITIVE (2026-09-12, owner's updater row). Real verification failures
  // never contain the word "signature" and were therefore degrading to the
  // caller's generic fallback — measured against the vendored
  // tauri-plugin-updater 2.10.1, whose verifier errors are `#[error(transparent)]`
  // so the customer sees the underlying Display:
  //   • `minisign_verify::Error::InvalidEncoding` → "Invalid encoding in minisign data"
  //   • `Error::Base64(DecodeError)` → base64-0.22.1/src/decode.rs's own four:
  //     "Invalid symbol 33, offset 5.", "Invalid last symbol 61, offset 42.",
  //     "Invalid input length: 21", "Invalid padding".
  //
  // ⛔ THE BARE TOKEN `base64` WAS HERE AND HAD TO GO — it was over-reach in BOTH
  // directions, MEASURED 2026-09-12:
  //   • it can never match the error it was added for. `DecodeError` is
  //     `#[error(transparent)]` through the plugin, and not one of the four
  //     Displays above contains the string "base64"; and
  //   • it DID change this shared classifier for other callers, which is what
  //     "additive" was protecting. `humanizeError` has ~50 call sites (including
  //     `main.tsx`, which funnels every unhandled rejection through it), and two
  //     real in-tree messages carry the word — `parse-wireguard.ts:251`
  //     ("PrivateKey is not a 44-char base64 key") and `data_base64 is not valid
  //     base64.` Both came back as *"This download couldn't be verified."*
  // Replaced by the decoder's remaining SHAPES, which are what the widening was
  // actually for: two of them ("Invalid last symbol …", "Invalid input length:
  // …") were still reaching the fallback, i.e. the exact defect this row says it
  // closed, for the exact class it targeted.
  //
  // A bare "Invalid padding" is still deliberately NOT matched: it is too
  // generic to justify telling a customer their download could not be verified.
  // None of the six pre-existing arms of humanize-error.test.ts change.
  if (
    /signature|minisign|invalid (?:last )?symbol \d+, offset|invalid input length:|checksum|integrity|verif(?:y|ied|ication)/.test(
      normalized,
    )
  ) {
    return "This download couldn't be verified. Try again later.";
  }
  const httpStatus = normalized.match(/\bhttp\s+(\d{3})\b/)?.[1];
  if (httpStatus !== undefined) {
    const status = Number(httpStatus);
    if (status === 401 || status === 403) {
      return 'Your sign-in or API key was not accepted. Check Settings and try again.';
    }
    if (status >= 500) return 'The service is temporarily unavailable. Try again shortly.';
    return "The request couldn't be completed. Check your input and try again.";
  }
  return fallback;
}
import { fixedApiErrorMessage, validationFieldNames } from './api-errors';

const PROBLEM_TYPE_PREFIX = 'https://errors.driftstack.dev/';
