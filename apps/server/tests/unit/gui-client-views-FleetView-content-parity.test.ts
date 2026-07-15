// W482.C — drift guard for apps/gui-client/src/views/FleetView.tsx.
// V-346 Fleet view. Drift here either drops the 'local-only
// registry, no server-side fleet management' framing
// (architectural intent silently shifts to a server-managed
// fleet and the founder ends up coupling the GUI to a feature
// that doesn't exist) or breaks the window.confirm destroy
// guard (clicking Remove drops the fleet member without a
// chance to abort — accidental delete with no undo).
//
//   • V-346 framing pinned: 'Fleet view. Lists Mac mini fleet
//     members the founder has declared locally; pings each
//     member's /version on demand.' + 'Local-only registry
//     (tauri-plugin-store). The fleet is the founder's choice
//     of API server URLs to ping; no server-side fleet
//     management.' + V-244 placeholder replacement framing.
//   • FormState 4-field (draft + errors + editingId + visible);
//     EMPTY_DRAFT base + EMPTY_DRAFT_FORM at module bottom.
//   • Delegation to fleet-members lib: addFleetMember /
//     listFleetMembers / pingFleetMember / removeFleetMember /
//     updateFleetMember / validateDraft.
//   • Ping-all: Promise.all + per-member ping with 'pending'
//     intermediate state.
//   • sort by label localeCompare.
//   • window.confirm destroy guard with `Remove "${label}"
//     from the fleet?` prompt.
//   • Per-member display: ok-pill with durationMs / unreachable
//     pill + error message; driver + playwrightBrowser + version
//     line.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/FleetView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W482.C apps/gui-client/src/views/FleetView.tsx content parity', () => {
  const body = read(LIB);

  it("V-346 framing pinned: 'V-346 — Fleet view. Lists Mac mini fleet members the founder has declared locally; pings each member's /version on demand to surface reachability + driver mode + version.' + local-only-registry framing 'Local-only registry (tauri-plugin-store). The fleet is the founder's choice of API server URLs to ping; no server-side fleet management. Each member is a (label, baseUrl) pair.' + V-244 placeholder replacement note", () => {
    expect(body).toMatch(
      /\/\/ V-346 — Fleet view\. Lists Mac mini fleet members the founder has\s*\n?\s*\/\/ declared locally; pings each member's \/version on demand to surface\s*\n?\s*\/\/ reachability \+ driver mode \+ version\./,
    );
    expect(body).toMatch(
      /\/\/ Local-only registry \(tauri-plugin-store\)\. The fleet is the\s*\n?\s*\/\/ founder's choice of API server URLs to ping; no server-side fleet\s*\n?\s*\/\/ management\. Each member is a \(label, baseUrl\) pair\./,
    );
    expect(body).toMatch(
      /\/\/ This view replaces the V-244 NotYet placeholder for the\s*\n?\s*\/\/ "Cluster → Mac mini fleet" sidebar entry\./,
    );
  });

  it("FormState 4-field (draft: FleetMemberDraft + errors + editingId nullable + visible boolean); EMPTY_DRAFT module constant {label:'', baseUrl:'', notes: null}; EMPTY_DRAFT_FORM at module bottom for the reset-after-submit path", () => {
    expect(body).toMatch(
      /interface FormState \{\s*\n?\s*draft: FleetMemberDraft;\s*\n?\s*errors: DraftValidation\['errors'\];\s*\n?\s*editingId: string \| null;\s*\n?\s*visible: boolean;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const EMPTY_DRAFT: FleetMemberDraft = \{\s*\n?\s*label: '',\s*\n?\s*baseUrl: '',\s*\n?\s*notes: null,\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const EMPTY_DRAFT_FORM: FormState = \{\s*\n?\s*draft: EMPTY_DRAFT,\s*\n?\s*errors: \{\},\s*\n?\s*editingId: null,\s*\n?\s*visible: false,\s*\n?\s*\};/,
    );
  });

  it('Lib delegation: listFleetMembers + addFleetMember + updateFleetMember + removeFleetMember + pingFleetMember + validateDraft imports from ../lib/fleet-members; refresh = useCallback wrapping listFleetMembers in try/catch/finally (catch→humanized setLoadError, finally→setLoading(false)) so a failed read never leaks internals or sticks on a blank loading screen; ping useCallback sets pings[id]=pending then sets final result', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*addFleetMember,\s*\n?\s*listFleetMembers,\s*\n?\s*pingFleetMember,\s*\n?\s*removeFleetMember,\s*\n?\s*updateFleetMember,\s*\n?\s*validateDraft,/,
    );
    expect(body).toContain("import { humanizeError } from '../lib/humanize-error';");
    expect(body).toMatch(
      /const refresh = useCallback\(async \(\) => \{\s*\n?\s*setLoadError\(null\);\s*\n?\s*try \{\s*\n?\s*const all = await listFleetMembers\(\);\s*\n?\s*setMembers\(all\);\s*\n?\s*\} catch \(err\) \{\s*\n?\s*setLoadError\(\s*\n?\s*humanizeError\(\s*\n?\s*err,\s*\n?\s*"Couldn't read the saved fleet\. Check the app's file permissions and try again\.",\s*\n?\s*\),\s*\n?\s*\);\s*\n?\s*\} finally \{\s*\n?\s*setLoading\(false\);\s*\n?\s*\}\s*\n?\s*\}, \[\]\);/,
    );
    expect(body).toContain('const ping = useCallback((member: FleetMember): Promise<void> => {');
    expect(body).toContain("setPings((prev) => ({ ...prev, [member.id]: 'pending' }));");
    expect(body).toContain('const result = await pingFleetMember(member);');
    expect(body).toContain('setPings((prev) => ({ ...prev, [member.id]: result }));');
  });

  it('Ping-all uses Promise.all (parallel pings, not sequential — fleet of 10 minis pings concurrently); sort = useMemo with label localeCompare ascending — pinned so the list stays alphabetically sortable and parallel-pinged', () => {
    expect(body).toContain(
      'const pingPromisesRef = useRef<Map<string, Promise<void>>>(new Map());',
    );
    expect(body).toContain('const existing = pingPromisesRef.current.get(member.id);');
    expect(body).toContain('if (existing !== undefined) return existing;');
    expect(body).toContain('pingPromisesRef.current.set(member.id, task);');
    expect(body).toContain('if (pingingAllRef.current) return;');
    expect(body).toMatch(
      /const pingAll = useCallback\(async \(\) => \{[\s\S]*?await Promise\.all\(members\.map\(\(m\) => ping\(m\)\)\);[\s\S]*?\}, \[members, ping\]\);/,
    );
    expect(body).toMatch(
      /const sorted = useMemo\(\s*\n?\s*\(\) => \[\.\.\.members\]\.sort\(\(a, b\) => a\.label\.localeCompare\(b\.label\)\),\s*\n?\s*\[members\],\s*\n?\s*\);/,
    );
    expect(body).toContain("disabled={p === 'pending'}");
    expect(body).toContain("aria-busy={p === 'pending'}");
    expect(body).toContain("{p === 'pending' ? 'Pinging…' : 'Ping'}");
  });

  it("Form lifecycle: startCreate / startEdit both setTimeout 0 focus to first input via formRef.current?.querySelector('input')?.focus(); submitForm: validateDraft + setForm errors if !ok + addFleetMember or updateFleetMember + reset via setForm({...EMPTY_DRAFT_FORM}) + refresh()", () => {
    expect(body).toMatch(
      /setTimeout\(\(\) => formRef\.current\?\.querySelector\('input'\)\?\.focus\(\), 0\);/,
    );
    expect(body).toContain('async function submitForm(): Promise<void> {');
    expect(body).toContain('const v = validateDraft(form.draft);');
    expect(body).toContain('setForm({ ...form, errors: v.errors });');
    expect(body).toContain('await updateFleetMember(form.editingId, form.draft);');
    expect(body).toContain('await addFleetMember(form.draft);');
    expect(body).toContain('setForm({ ...EMPTY_DRAFT_FORM });');
    expect(body).toContain('await refresh();');
    // The add/update is wrapped so a registry-write failure surfaces a dismissible
    // banner instead of escaping as an unhandled rejection (which would blank the app).
    expect(body).toContain('setActionError(');
  });

  it('destroy guard: branded useConfirm(`Remove "${member.label}" from the fleet?`) early-return if !confirmed + then removeFleetMember + clean up pings[id] entry (delete) + refresh() — pinned so accidental Remove clicks have an abort path with no recoverable trash bin (window.confirm is flaky in the Tauri WKWebView, so the branded modal is the reliable shape)', () => {
    expect(body).toContain('async function destroy(member: FleetMember): Promise<void> {');
    expect(body).toContain("{ confirmLabel: 'Remove' }");
    expect(body).toContain('await removeFleetMember(member.id);');
    expect(body).toContain('delete next[member.id];');
  });

  it("Per-member ping display: 'pinging…' intermediate / ok pill 'ok · {durationMs}ms' in status-ready / unreachable pill in status-error; driver+playwrightBrowser+version conditional line with `(${playwrightBrowser})` suffix when present + ` · v${version}` suffix when present + driver ?? 'unknown' fallback", () => {
    expect(body).toMatch(
      /\{p === 'pending' && <span className="text-2xs text-ink-muted">pinging…<\/span>\}\s*\n?\s*\{p && p !== 'pending' && p\.ok && \(\s*\n?\s*<span className="rounded-full bg-status-ready\/20 px-2 py-0\.5 text-2xs font-medium uppercase tracking-wide text-status-ready">\s*\n?\s*ok · \{p\.durationMs\}ms\s*\n?\s*<\/span>\s*\n?\s*\)\}\s*\n?\s*\{p && p !== 'pending' && !p\.ok && \(\s*\n?\s*<span className="rounded-full bg-status-error\/20 px-2 py-0\.5 text-2xs font-medium uppercase tracking-wide text-status-error">\s*\n?\s*unreachable\s*\n?\s*<\/span>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /driver: <span className="mono">\{p\.driver \?\? 'unknown'\}<\/span>\s*\n?\s*\{p\.playwrightBrowser \? ` \(\$\{p\.playwrightBrowser\}\)` : ''\}\s*\n?\s*\{p\.version \? ` · v\$\{p\.version\}` : ''\}/,
    );
  });

  it('Field subcomponent: section-label + children + error?: optional inline status-error message — pinned so the form-field convention stays consistent (no inline error-message duplication)', () => {
    expect(body).toMatch(
      /function Field\(\{\s*\n?\s*label,\s*\n?\s*error,\s*\n?\s*children,\s*\n?\s*\}: \{\s*\n?\s*label: string;\s*\n?\s*error: string \| undefined;\s*\n?\s*children: React\.ReactNode;\s*\n?\s*\}\): JSX\.Element \{\s*\n?\s*return \(\s*\n?\s*<label className="flex flex-col gap-1\.5">\s*\n?\s*<span className="section-label">\{label\}<\/span>\s*\n?\s*\{children\}\s*\n?\s*\{error !== undefined && <span className="text-2xs text-status-error">\{error\}<\/span>\}/,
    );
  });

  it("Load-error state: when !loading && loadError !== null → 'Couldn't load the fleet' status-error label + the error message + 'Try again' button (onClick=refresh); empty state is gated on loadError === null so a failed read shows the error, not the misleading 'No fleet members yet'", () => {
    expect(body).toMatch(
      /\{!loading && loadError !== null && \(\s*\n?\s*<div className="flex flex-col items-center gap-3 rounded border border-surface-divider bg-surface-raised p-8 text-center">\s*\n?\s*<span className="section-label text-status-error">Couldn't load the fleet<\/span>/,
    );
    expect(body).toMatch(
      /<button type="button" className="btn-secondary" onClick=\{\(\) => void refresh\(\)\}>\s*\n?\s*Try again\s*\n?\s*<\/button>/,
    );
    expect(body).toMatch(
      /\{!loading && loadError === null && sorted\.length === 0 && !form\.visible && \(/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
