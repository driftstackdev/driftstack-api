// Nothing in git is a compiled executable.
//
// `packages/sdk-go/crypto_checkout` was an 8.2 MB Mach-O arm64 executable,
// tracked since the backend build-out commit. It is the output of `go build` in
// `examples/crypto_checkout/`, and `packages/sdk-go/.gitignore` already listed
// it — the ignore rule was added AFTER the file was committed, and gitignore
// does not untrack what is already tracked. So the repository stated the file
// should not be there and carried it anyway.
//
// What that costs is not abstract. It is 8.2 MB in every clone and in history
// permanently; it is built for one architecture, so it is dead weight to anyone
// not on an arm64 Mac; and the README points at `examples/crypto_checkout/main.go`,
// never at the binary, so nothing was using it.
//
// The failure mode is ordinary: someone runs the example to check it works,
// `go build` drops an executable beside the source, and `git add` on a directory
// takes it. The ignore rule prevents the NEXT one and does nothing about the one
// already in the index, which is exactly the state this found.
//
// So this checks the index rather than the ignore file. A rule saying a file
// should not be tracked is a statement of intent; whether it IS tracked is the
// fact, and only the second one is checkable.
//
// DETECTED BY CONTENT, not by extension or name. An extensionless `crypto_checkout`
// looks like a script until you read its first bytes; a name-based rule would
// have to guess, and the guesses are exactly what the last one slipped past.
// Mach-O, ELF and PE magic numbers cover the executables anyone here would
// produce — a Go example on a Mac, a Linux CI artifact, a Windows build.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** Every path git currently tracks. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p !== '');
}

/**
 * True when a file begins with an executable magic number.
 *
 *   Mach-O   feedface / feedfacf / cafebabe (fat), and their byte-swapped forms
 *   ELF      7f 45 4c 46
 *   PE       4d 5a  ("MZ")
 */
function isCompiledExecutable(absolutePath: string): boolean {
  let head: Buffer;
  try {
    if (statSync(absolutePath).size < 4) return false;
    head = readFileSync(absolutePath).subarray(0, 4);
  } catch {
    return false;
  }
  const magic = head.readUInt32BE(0);
  const MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
  if (MACHO.has(magic)) return true;
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true;
  if (head[0] === 0x4d && head[1] === 0x5a) return true;
  return false;
}

describe('no compiled binary is tracked in git', () => {
  it('CRITICAL the file list and the detector both work. The assertion below is "none of these is an executable", and an empty list has none of anything — a `git ls-files` that returned nothing, or a detector that never matched, would report the tree clean having examined it or nothing at all.', () => {
    const tracked = trackedFiles();
    // MEASURED: ~4,000 tracked paths.
    // V-939 — floor raised to just under the measured 4885; it stood at 500, so this
    // scan could have lost 90% of its corpus and still called itself non-vacuous.
    expect(tracked.length, 'files git tracks').toBeGreaterThan(4000);

    // The detector has to actually fire on something known to be executable.
    // `node` itself is one, and is present wherever this suite runs.
    expect(
      isCompiledExecutable(process.execPath),
      'the magic-number detector recognises a real executable',
    ).toBe(true);
    expect(
      isCompiledExecutable(resolve(REPO_ROOT, 'package.json')),
      'and does not fire on ordinary text',
    ).toBe(false);
  });

  it('CRITICAL no tracked file is a compiled executable. A build artifact in the index is permanent weight in every clone and in history, is usually built for one architecture, and arrives by the most ordinary route there is — running an example, then `git add` on the directory.', () => {
    const offenders = trackedFiles()
      .filter((relative) => isCompiledExecutable(resolve(REPO_ROOT, relative)))
      .sort();
    expect(offenders, 'tracked path(s) whose first bytes are an executable magic number:').toEqual(
      [],
    );
  });
});
