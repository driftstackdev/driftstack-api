// U1–U4 (owner 2026-09-12): *"Update to 0.1.51 failed: Update couldn't be
// installed. Try again."* — *"often this happens! i see it very often"*.
//
// The owner's sentence was itself a measurement: that string is the FALLBACK
// argument at UpdateBanner's catch, so the failure matched none of
// humanizeError's four regexes — which rules out every signature-named class
// and the timeout class and leaves a filesystem / permission / `os error N` /
// HTTP-status / relaunch failure. And nothing logged it: installLogCapture
// patches `console.*` plus the window `error`/`unhandledrejection` listeners,
// and an awaited rejection inside a `try` fires neither.
//
// ⛔ THE FIRST ARM USED TO OVER-REACH, AND NARROWING IT IS PART OF THE FIX. It
// read `expect(screen.getByRole('status')).not.toHaveTextContent(/ENOENT|
// private\/tmp/i)` — and `role="status"` is the OUTER banner div, while
// `toHaveTextContent` reads `textContent`, which includes text inside a CLOSED
// `<details>`. So the assertion did not say "no raw text in the sentence", it
// said "no raw text anywhere in the banner", which forbids the disclosure U1
// asks for. It is now scoped to the HEADLINE, where the rule actually belongs,
// and paired with a POSITIVE arm asserting the disclosure does carry the real
// text — without that pair, deleting the disclosure would read green.
//
// (The fixture path contains the word `key`, which is what made it look like a
// policy violation. A genuine macOS updater path — /var/folders/…/
// tauri_updated_app — is the same shape: a local filesystem path, not a remote
// problem body. See the note at the top of lib/updater.ts.)
//
// ⚠️ FOUR ASSERTIONS IN THIS FILE WERE VACUOUS AND HAVE BEEN TIGHTENED, not
// relaxed. Each was MEASURED green under a mutation of the thing it named:
//   • `expect(log).toContain('platform=')` / `toContain('platform:')` match
//     `formatUpdateFailure`'s and `details`' own format strings whatever the
//     value is — `updatePlatformLabel()` → `return ''` left them green, so a
//     build that recorded no platform would have shipped clean. Now `\S`-bearing,
//     with the label's own arm in updater.test.ts.
//   • nothing read `captureException`'s SECOND argument, so deleting the
//     `fingerprint` (the stated mechanism for not minting a fresh issue per
//     customer, i.e. the only thing that makes the owner's *frequency* claim
//     measurable) or the whole `tags`/`contexts` block was green.
//   • `expect(downloadAndInstall).toHaveBeenCalledTimes(1)` in the relaunch arm
//     is about the AUTOMATIC retry. It says nothing about the Retry BUTTON,
//     which was rendered and did re-install.
//
// MUTATIONS RUN 2026-09-12 (this round), each restored and verified
// byte-identical by sha256 AND `diff -q` against a snapshot — see the report.
// Every guard added below was broken once and watched go red.

import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from '@tauri-apps/plugin-updater';
import { UpdateBanner } from '../../src/components/UpdateBanner';
import {
  checkForUpdate,
  recordUpdateFailure,
  RELEASES_URL,
  type AvailableUpdate,
} from '../../src/lib/updater';
import { clearLogEntries, getLogEntries } from '../../src/lib/log-buffer';

/**
 * ⛔ A BARE STRING, WHICH IS THE REAL REJECTION SHAPE — and the single reason
 * this file disables `prefer-promise-reject-errors`. Traced 2026-09-12: the
 * plugin's `Error` serializes as `serializer.serialize_str(self.to_string())`
 * (tauri-plugin-updater-2.10.1/src/error.rs), the IPC response is
 * `application/json` so `response.json()` yields a string, and
 * `__TAURI_INTERNALS__.invoke` rejects with that value verbatim. A fixture that
 * rejected with `new Error(...)` would exercise a shape the real updater never
 * produces and would leave `rawUpdateFailureReason`'s string branch — the one
 * the owner's failure actually takes — untested.
 */
function rejectLikeThePlugin(text: string): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above: the plugin rejects with a bare string, not an Error.
  return Promise.reject(text);
}

// The dev log's on-disk mirror: stubbed so the assertions below are about the
// buffer the DevLogPanel reads, not about a Tauri fs capability this process
// does not have.
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 'AppData' },
  mkdir: vi.fn(() => Promise.resolve()),
  writeTextFile: vi.fn(() => Promise.resolve()),
}));

// U1's second sink. `updater.ts` imports @sentry/browser lazily, so this mock is
// what `recordUpdateFailure` reaches.
//
// Typed rather than a bare `vi.fn()`: an untyped mock infers an empty tuple for
// `mock.calls[0]`, so reading the SECOND argument — the fingerprint and tags,
// which nothing used to read — is a TS2493 rather than an assertion.
const captureException = vi.hoisted(() =>
  vi.fn((_error: unknown, _context?: unknown): void => undefined),
);
vi.mock('@sentry/browser', () => ({
  captureException,
  init: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
}));

/** The real install closure from lib/updater.ts, over a fake plugin `Update`. */
async function installable(over: {
  downloadAndInstall: (cb?: (e: unknown) => void) => Promise<void>;
  relaunch?: () => Promise<void>;
}): Promise<AvailableUpdate> {
  const offered = {
    version: '0.1.51',
    currentVersion: '0.1.50',
    body: null,
    downloadAndInstall: over.downloadAndInstall,
  } as unknown as Update;
  const update = await checkForUpdate({
    check: () => Promise.resolve(offered),
    relaunch: over.relaunch ?? ((): Promise<void> => Promise.resolve()),
    currentVersion: () => Promise.resolve('0.1.50'),
    canSelfInstall: () => true,
    // macOS: platformNeedsManualRelaunch() is !win, so the relaunch IS ours.
    needsManualRelaunch: () => true,
  });
  if (update === null) throw new Error('fixture did not offer an update');
  return update;
}

const clickInstall = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: 'Install & restart' }));
};

const logText = (): string =>
  getLogEntries()
    .map((e) => `${e.level} ${e.text}`)
    .join('\n');

beforeEach(() => {
  clearLogEntries();
  captureException.mockClear();
});

describe('UpdateBanner error copy', () => {
  it('keeps raw installer exception details out of the SENTENCE', async () => {
    const update: AvailableUpdate = {
      version: '2.0.0',
      currentVersion: '1.0.0',
      notes: null,
      install: vi.fn(() => Promise.reject(new Error('spawn helper ENOENT /private/tmp/key'))),
    };
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    await waitFor(() =>
      expect(screen.getByTestId('update-error-headline')).toHaveTextContent(
        /couldn't be installed/i,
      ),
    );
    // The headline is the customer-facing sentence — the humanized class only.
    expect(screen.getByTestId('update-error-headline')).not.toHaveTextContent(
      /ENOENT|private\/tmp/i,
    );
  });

  it("U1 the disclosure carries the plugin's own text, and Copy details carries the whole diagnostic", async () => {
    const update: AvailableUpdate = {
      version: '2.0.0',
      currentVersion: '1.0.0',
      notes: null,
      install: vi.fn(() => Promise.reject(new Error('spawn helper ENOENT /private/tmp/key'))),
    };
    // Typed to the real signature so `mock.calls[0][0]` is a string rather than
    // an element of the empty tuple a `() => …` mock infers (TS2493).
    const writeText = vi.fn((_text: string): Promise<void> => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    // The POSITIVE half of the pair: without this, deleting the disclosure
    // passes the arm above.
    const reason = await screen.findByTestId('update-error-reason');
    expect(reason).toHaveTextContent('spawn helper ENOENT /private/tmp/key');

    await userEvent.click(screen.getByTestId('update-copy-details'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const [copied] = writeText.mock.calls[0] as [string];
    expect(copied).toContain('spawn helper ENOENT /private/tmp/key');
    expect(copied).toContain('1.0.0 → 2.0.0');
    // ⚠️ `toContain('platform:')` matched `details`' own literal whatever the
    // value was — measured green with `updatePlatformLabel()` stubbed to ''.
    expect(copied).toMatch(/platform: \S/);
    // One attempt, so no "first attempt" line and no second-attempt block: the
    // disclosure must not render a label onto an empty string.
    expect(copied).toContain('attempts: 1');
    expect(copied).not.toContain('first attempt:');
    expect(screen.queryByTestId('update-error-first-reason')).toBeNull();
  });

  it('a rejection with NO text renders no disclosure at all, rather than one opening onto nothing', async () => {
    const update: AvailableUpdate = {
      version: '2.0.0',
      currentVersion: '1.0.0',
      notes: null,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a rejection that carries no text is the case under test
      install: vi.fn(() => Promise.reject('')),
    };
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    await screen.findByTestId('update-error-headline');
    expect(screen.queryByTestId('update-error-details')).toBeNull();
    expect(screen.queryByTestId('update-copy-details')).toBeNull();
    // …and the log still says something a reader can act on.
    await waitFor(() => expect(logText()).toContain('reason: (the rejection carried no text)'));
  });

  it('Copy details says so when the WebView has no clipboard, instead of a dead click', async () => {
    const update: AvailableUpdate = {
      version: '2.0.0',
      currentVersion: '1.0.0',
      notes: null,
      install: vi.fn(() => Promise.reject(new Error('spawn helper ENOENT'))),
    };
    // A locked-down WKWebView leaves navigator.clipboard undefined, which is
    // what `writeClipboardText` turns into a rejection for exactly this recovery.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    await userEvent.click(await screen.findByTestId('update-copy-details'));
    await waitFor(() =>
      expect(screen.getByTestId('update-copy-details')).toHaveTextContent("Couldn't copy"),
    );
  });

  it('U1 a rejection that did NOT come through the install closure is still recorded', async () => {
    // A caller-supplied closure (or the download-only reject) reaches the same
    // catch, and a reason shown to the customer that no log carries is the
    // defect this row is about.
    const update: AvailableUpdate = {
      version: '2.0.0',
      currentVersion: '1.0.0',
      notes: null,
      install: vi.fn(() => Promise.reject(new Error('spawn helper ENOENT /private/tmp/key'))),
    };
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();
    await waitFor(() => {
      expect(logText()).toContain('spawn helper ENOENT /private/tmp/key');
    });
    expect(logText()).toContain('error [updater] install failed');
    await waitFor(() => expect(captureException).toHaveBeenCalledTimes(1));
  });
});

describe('U4 — an os error 13 install failure, end to end through the real closure', () => {
  // U4 asks for one guard over a fake `install`. This drives the PRODUCTION
  // closure instead (`checkForUpdate` → `install()` → `downloadAndInstall`),
  // which is strictly stronger: the retry, the diagnostic and the stage are the
  // real ones, and (c) is measured at the call the retry actually repeats.
  const OS_ERROR_13 = 'Permission denied (os error 13)';

  it('CRITICAL surfaces the real text, logs it to BOTH sinks, retries exactly once, and offers the download', async () => {
    // A BARE STRING, which is the real rejection shape: the plugin's `Error`
    // serializes as `serialize_str(self.to_string())`, the IPC response is JSON,
    // and `invoke` rejects with the parsed value verbatim — so
    // `e instanceof Error` is false on the path that matters.
    const downloadAndInstall = vi.fn(() => rejectLikeThePlugin(OS_ERROR_13));
    const update = await installable({ downloadAndInstall });
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    // (a) the reason contains the real text, and the sentence does not.
    const reason = await screen.findByTestId('update-error-reason');
    expect(reason).toHaveTextContent(OS_ERROR_13);
    expect(screen.getByTestId('update-error-headline')).not.toHaveTextContent(/os error/i);
    // ⚠️ "Try again." IS FALSE ONCE THE APP HAS ALREADY TRIED TWICE, and it
    // invites a third full download plus another admin prompt for a failure that
    // has now failed twice. Only the FALLBACK moved; a reason `humanizeError`
    // classifies still gets its own sentence (see the connection arm below).
    expect(screen.getByTestId('update-error-headline')).toHaveTextContent(
      "Update to 0.1.51 failed: Update couldn't be installed. Driftstack already retried once.",
    );

    // (b) logged — the dev log carries the raw reason, the stage, the version
    // pair and the platform.
    const log = logText();
    expect(log).toContain(OS_ERROR_13);
    expect(log).toContain('stage=download');
    expect(log).toContain('0.1.50 → 0.1.51');
    expect(log).toMatch(/platform=\S/);
    // The PAIR: attempt 1 says it is retrying, attempt 2 says it is not. A log
    // that carried only the final attempt could not tell a maintainer the retry
    // had fired at all.
    expect(log).toContain('attempt=1 0.1.50 → 0.1.51');
    expect(log).toMatch(/attempt=1[^\n]*retrying=yes/);
    expect(log).toMatch(/attempt=2[^\n]*retrying=no/);

    // ⛔ EXACTLY ONE SENTRY EVENT, NOT TWO. Sentry is the FREQUENCY signal and
    // the owner's *"i see it very often"* has to be checked against it, so it
    // gets one event per user-visible failure. It used to get both attempts —
    // which also meant a retry that SUCCEEDED filed an `error`-level
    // `UpdateInstallFailure` about an update that worked (pinned below), leaving
    // the issue count equal to neither the number of failures nor the number of
    // affected customers. The dev-log PAIR above is where "the retry fired"
    // lives.
    await waitFor(() => {
      expect(captureException).toHaveBeenCalledTimes(1);
    });
    // …and the grouping is read, not assumed. Nothing used to touch the second
    // argument, so deleting the fingerprint — the whole mechanism for not
    // minting a fresh issue per customer, since an `os error 13` line carries a
    // machine-specific path — was a green mutation.
    expect(captureException.mock.calls[0]?.[1]).toMatchObject({
      level: 'error',
      fingerprint: ['update-install-failed', 'download'],
      // `toMatchObject` is recursively partial, so a plain nested object is the
      // subset match — and does not hand eslint an `any` the way
      // `expect.objectContaining` does.
      tags: {
        update_stage: 'download',
        update_from: '0.1.50',
        update_to: '0.1.51',
      },
    });

    // (c) EXACTLY once — two calls total, never three.
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);

    // (d) never a dead end: Retry AND the release link.
    expect(screen.getByTestId('update-install')).toHaveTextContent('Retry');
    expect(screen.getByTestId('update-download')).toHaveAttribute('href', RELEASES_URL);
    expect(screen.getByTestId('update-download')).toHaveAttribute(
      'rel',
      expect.stringContaining('noopener'),
    );
    // ⚠️ `rel` was asserted and `target` was not. In a Tauri WebView a
    // same-frame navigation to github.com replaces the app UI with no way back,
    // which is the dead end U3 exists to remove.
    expect(screen.getByTestId('update-download')).toHaveAttribute('target', '_blank');
  });

  it('CRITICAL after a retry the disclosure carries BOTH reasons — the second one is usually the wreckage', async () => {
    // ⛔ THE RETRY MADE THE CUSTOMER-VISIBLE HALF LESS DIAGNOSABLE THAN THE LOG.
    // Only attempt 2's reason was disclosed and copied, and this is the REALISTIC
    // macOS sequence rather than a contrived one: `install_inner` moves the live
    // bundle out at updater.rs:1255 before the final rename, so a second
    // attempt's `fs::rename(extract_path → …)` fails ENOENT and the customer
    // pasted a reason that points at nothing.
    const FIRST = 'Operation not permitted (os error 1)';
    const SECOND = 'No such file or directory (os error 2)';
    let calls = 0;
    const downloadAndInstall = vi.fn((): Promise<void> => {
      calls += 1;
      return rejectLikeThePlugin(calls === 1 ? FIRST : SECOND);
    });
    const writeText = vi.fn((_text: string): Promise<void> => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const update = await installable({ downloadAndInstall });
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    expect(await screen.findByTestId('update-error-first-reason')).toHaveTextContent(FIRST);
    expect(screen.getByTestId('update-error-reason')).toHaveTextContent(SECOND);

    await userEvent.click(screen.getByTestId('update-copy-details'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const [copied] = writeText.mock.calls[0] as [string];
    expect(copied).toContain(`first attempt: ${FIRST}`);
    expect(copied).toContain(`reason: ${SECOND}`);
    expect(copied).toContain('attempts: 2');
  });

  it('⛔ a retry that SUCCEEDS files NO Sentry failure, and attempt 1 is in the log before the relaunch', async () => {
    // ⛔ THE DEFECT: `report` runs in `attemptDownload`'s catch, before the
    // outcome is known, and nothing retracts it — so a successful update minted
    // an `error`-level Sentry event fingerprinted
    // ['update-install-failed','download'], corrupting the very count the
    // owner's *"i see it very often"* has to be measured against. Sentry gets
    // one event per user-visible failure; this update had none.
    //
    // ⚠️ THE `logAtRelaunch` HALF IS A PROPERTY PIN, NOT A MECHANISM GUARD, and
    // saying so is the point. It looked like a race — `recordUpdateFailure`
    // awaits a lazy `import()` before calling `record()`, and the next line of
    // this path replaces the process — so an `await settleReports(pending)` was
    // added before `deps.relaunch()`. MEASURED: deleting that await left this
    // arm GREEN, because `./log-buffer` is a STATIC import at main.tsx:4 (in the
    // registry from boot, so the import settles in one microtask) and attempt
    // 2's whole `downloadAndInstall` sits in between. The mechanism was removed
    // as complexity bought for a race that does not occur; the ordering stays
    // asserted here so a future change that DOES introduce the race is caught.
    let calls = 0;
    const downloadAndInstall = vi.fn((): Promise<void> => {
      calls += 1;
      return calls === 1
        ? rejectLikeThePlugin('Permission denied (os error 13)')
        : Promise.resolve();
    });
    let logAtRelaunch = '';
    const update = await installable({
      downloadAndInstall,
      relaunch: () => {
        logAtRelaunch = logText();
        return Promise.resolve();
      },
    });

    await expect(update.install()).resolves.toBeUndefined();
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);

    // The dev log IS the diagnostic and is written either way — `retrying=yes`
    // is the honest thing and is how a maintainer learns the retry fired.
    expect(logAtRelaunch, 'written before the process would have been replaced').toMatch(
      /attempt=1[^\n]*retrying=yes/,
    );
    expect(logAtRelaunch).toContain('Permission denied (os error 13)');
    // Sentry is the frequency signal, and this update SUCCEEDED.
    expect(captureException, 'a successful update is not a failure').not.toHaveBeenCalled();
  });

  it('recordUpdateFailure sends a will-retry diagnostic to the dev log ONLY', async () => {
    // The same rule at the unit boundary, so it is observable without a retry
    // race: `willRetry` means the customer has not been told anything yet and
    // may never be.
    await recordUpdateFailure({
      stage: 'download',
      reason: 'Permission denied (os error 13)',
      attempt: 1,
      willRetry: true,
      fromVersion: '0.1.50',
      toVersion: '0.1.51',
      platform: 'MacIntel',
    });
    expect(logText()).toMatch(/error \[updater] install failed[^\n]*retrying=yes/);
    expect(captureException).not.toHaveBeenCalled();

    // The positive control in the same breath: the attempt the customer DOES
    // see reaches both sinks.
    await recordUpdateFailure({
      stage: 'download',
      reason: 'Permission denied (os error 13)',
      attempt: 2,
      willRetry: false,
      fromVersion: '0.1.50',
      toVersion: '0.1.51',
      platform: 'MacIntel',
    });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('⛔ the credential in the download URL reaches no sink — not the log, not the clipboard, not the screen', async () => {
    // MEASURED 2026-09-12 with `curl -I -L` on the real release asset: GitHub
    // 302s to release-assets.githubusercontent.com with an Azure SAS query
    // carrying `sig=` and `jwt=`, and reqwest appends ` for url (<that>)` to
    // every send/body error. `scrubText` (telemetry.ts:300-309) knows `token`,
    // `secret` and `signature` but neither `sig` nor `jwt`, and
    // `contexts.update.reason` goes through the key-name-based `scrubObject`
    // untouched — so disclosing the reason published a live credential to three
    // places at once.
    const WITH_SAS =
      'error sending request for url (https://release-assets.githubusercontent.com/ghpra/122/d8e0?sp=r&sig=7GLePhCRf%2BEs&jwt=eyJ0eXAiOiJKV1QifQ.p.s)';
    const downloadAndInstall = vi.fn(() => rejectLikeThePlugin(WITH_SAS));
    const writeText = vi.fn((_text: string): Promise<void> => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const update = await installable({ downloadAndInstall });
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    const shown = await screen.findByTestId('update-error-reason');
    await userEvent.click(screen.getByTestId('update-copy-details'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const [copied] = writeText.mock.calls[0] as [string];
    const sentry = JSON.stringify(captureException.mock.calls);

    for (const [where, text] of [
      ['the dev log', logText()],
      ['the clipboard', copied],
      ['the screen', shown.textContent ?? ''],
      ['Sentry', sentry],
    ] as [string, string][]) {
      expect(text, where).not.toMatch(/\bsig=/);
      expect(text, where).not.toMatch(/\bjwt=/);
      // …while staying diagnostic: which CDN served which asset survives.
      expect(text, where).toContain('release-assets.githubusercontent.com');
    }

    // U2's network class, end to end: reqwest's own wording now retries AND gets
    // the connection sentence instead of the generic fallback. This was the
    // owner's exact sentence, with no retry, for the commonest failure there is.
    expect(downloadAndInstall, 'the network class is retried').toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('update-error-headline')).toHaveTextContent(
      'Check your connection and try again.',
    );
  });

  it('U2 the retry is VISIBLE in the banner — and it still shows PROGRESS', async () => {
    // A no-op default rather than `null`: TS narrows a `let x: T | null = null`
    // that is only reassigned inside a callback back to `null` at the call site
    // (TS2349), and a cast there would hide the one thing worth checking.
    let releaseSecond: () => void = () => undefined;
    // An external counter rather than `downloadAndInstall.mock.calls.length`:
    // referring to the mock inside its own initializer is a circular reference
    // TS cannot type (TS2349), and the second attempt has to HANG so the
    // "Retrying…" state is observable instead of flashing past in one tick.
    let calls = 0;
    let emit: (e: unknown) => void = () => undefined;
    const downloadAndInstall = vi.fn((cb?: (e: unknown) => void): Promise<void> => {
      calls += 1;
      if (calls === 1) return rejectLikeThePlugin(OS_ERROR_13);
      emit = cb ?? emit;
      return new Promise<void>((resolve) => {
        releaseSecond = () => resolve();
      });
    });
    const update = await installable({ downloadAndInstall });
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    // ⛔ THE BAR USED TO GO DEAD FOR THE WHOLE SECOND ATTEMPT. 'retrying' was a
    // PHASE that replaced 'installing', and the render discarded the live
    // fraction — `onProgress` kept firing and `setFraction` kept updating state
    // nothing displayed, so the customer watched a static "Retrying…" through a
    // second ~26 MiB download. That is exactly the "it just sat there" report
    // the visible retry exists to prevent. It is a FLAG now, so the verb changes
    // and the percentage stays.
    await screen.findByText('Retrying… 0%');
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);

    emit({ event: 'Started', data: { contentLength: 100 } });
    emit({ event: 'Progress', data: { chunkLength: 60 } });
    await screen.findByText('Retrying… 60%');
    expect(screen.queryByText('Retrying…'), 'not the bare literal any more').toBeNull();

    releaseSecond();
  });

  it('U2 a signature failure is NEVER retried — once, loudly, forever', async () => {
    const downloadAndInstall = vi.fn(() =>
      rejectLikeThePlugin('The signature verification failed'),
    );
    const update = await installable({ downloadAndInstall });
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    await waitFor(() =>
      expect(screen.getByTestId('update-error-headline')).toHaveTextContent(
        /couldn't be verified/i,
      ),
    );
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    // Still not a dead end, even though retrying is pointless.
    expect(screen.getByTestId('update-download')).toHaveAttribute('href', RELEASES_URL);
    expect(screen.getByTestId('update-download')).toHaveAttribute('target', '_blank');
  });

  it('U2 a minisign failure is NEVER retried — the word "signature" is absent from it', async () => {
    // ⛔ The arm that kills the obvious denylist. `minisign_verify::Error::
    // InvalidEncoding` Displays as this, and a gate phrased "retry unless the
    // message names a signature" would retry a SIGNATURE failure.
    const downloadAndInstall = vi.fn(() =>
      rejectLikeThePlugin('Invalid encoding in minisign data'),
    );
    const update = await installable({ downloadAndInstall });
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    await screen.findByTestId('update-error-reason');
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('update-error-headline')).toHaveTextContent(/couldn't be verified/i);
  });

  it('CRITICAL a failed RELAUNCH is not reported as a failed install — the message used to be a lie', async () => {
    // `relaunch()` is awaited inside the same `try` as `downloadAndInstall()`,
    // and macOS always relaunches. So an install that SUCCEEDED and then failed
    // to restart rendered "Update couldn't be installed", wrong in both halves.
    const downloadAndInstall = vi.fn(() => Promise.resolve());
    const update = await installable({
      downloadAndInstall,
      relaunch: () => rejectLikeThePlugin('process.restart not allowed'),
    });
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    const headline = await screen.findByTestId('update-error-headline');
    expect(headline).toHaveTextContent(
      "Update 0.1.51 installed, but the app couldn't restart itself. Quit and reopen Driftstack.",
    );
    expect(headline).not.toHaveTextContent(/couldn't be installed/i);
    // Not retried: the bundle is already on disk.
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(logText()).toContain('stage=relaunch'));

    // ⛔ AND NEITHER BUTTON MAY RENDER, because both deny the headline. The
    // assertion above is about the AUTOMATIC retry; the Retry BUTTON was a
    // different proposition and was asserted by nothing — it called
    // `update.install()` again, re-downloading the full bundle and re-running
    // `install_inner` against an app ALREADY on the new version, including the
    // window at updater.rs:1255-1302 where the live bundle sits in a `TempDir`
    // that is deleted if the final rename fails. "Download" sent the customer
    // to fetch a version already on their disk.
    expect(screen.queryByTestId('update-install'), 'it is already installed').toBeNull();
    expect(screen.queryByTestId('update-download'), 'they already have it').toBeNull();
    // Not a dead end: the headline names the one action that works, and the
    // banner can still be dismissed.
    expect(screen.getByTestId('update-dismiss')).toBeInTheDocument();
  });

  it('the DOWNLOAD stage keeps both actions — the gate is the stage, not the error phase', async () => {
    // The positive control for the arm above. Without it, gating the buttons on
    // `phase === 'error'` alone would pass it.
    const downloadAndInstall = vi.fn(() =>
      rejectLikeThePlugin('The signature verification failed'),
    );
    const update = await installable({ downloadAndInstall });
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await clickInstall();

    await screen.findByTestId('update-error-headline');
    expect(screen.getByTestId('update-install')).toHaveTextContent('Retry');
    expect(screen.getByTestId('update-download')).toBeInTheDocument();
  });
});
