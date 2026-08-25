// W484.C — drift guard for apps/gui-client/src/views/ProxiesView.tsx.
// Proxy CRUD view. Drift here can misstate the shipped encrypted account-sync
// boundary or break the port default of 1080 (SOCKS5 default port — without it
// the form initializes empty and customers don't know what port to type).
//
//   • Framing pinned: protected local registry plus encrypted owner-account
//     sync when a proxy is selected for a session.
//   • EMPTY_DRAFT 5-field with port 1080 SOCKS5 default.
//   • editor state-machine 3-variant union (idle / add /
//     edit{id}).
//   • CRUD delegation: addProxy / listProxies / removeProxy /
//     updateProxy / validateDraft / DraftValidation /
//     ProxyConfig / ProxyDraft imports from ../lib/proxies.
//   • Honest empty-state framing: credentials are protected locally and synced
//     in encrypted form to the account when used for a session.
//   • ProxyForm: validateDraft on submit + 1-65535 port range +
//     username/password optional with empty→null normalization.
//   • friendlyError delegates to shared humanizeError with an
//     operation-specific actionable fallback.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/ProxiesView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W484.C apps/gui-client/src/views/ProxiesView.tsx content parity', () => {
  const body = read(LIB);

  it('pins the protected-local plus encrypted owner-account sync boundary', () => {
    expect(body).toMatch(
      /\/\/ Proxy management — protected local registry plus encrypted account sync\./,
    );
    expect(body).toMatch(
      /owner-scoped account_proxies record whose secret fields are encrypted under\s*\n?\s*\/\/ the account key hierarchy\./,
    );
    expect(body).not.toMatch(/never uploaded|never go to the Driftstack control plane/i);
  });

  it("ListState 4-field (proxies + loading + error nullable + notice nullable — the transient unbind confirmation, e.g. 'N profiles were unbound from the deleted proxy'); EMPTY_DRAFT 6-field with label:'' + scheme:'socks5' + host:'' + port:1080 (SOCKS5 default) + username:null + password:null — pinned so the SOCKS5 default port doesn't drift, customer can submit without typing a port", () => {
    expect(body).toMatch(
      /interface ListState \{\s*\n?\s*proxies: ProxyConfig\[\];\s*\n?\s*loading: boolean;\s*\n?\s*error: string \| null;\s*\n?\s*\/\*\* Transient confirmation, e\.g\. "N profiles were unbound from the deleted proxy"\. \*\/\s*\n?\s*notice: string \| null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const EMPTY_DRAFT: ProxyDraft = \{\s*\n?\s*label: '',\s*\n?\s*scheme: 'socks5',\s*\n?\s*host: '',\s*\n?\s*port: 1080,\s*\n?\s*username: null,\s*\n?\s*password: null,\s*\n?\s*\};/,
    );
  });

  it("editor state-machine 3-variant union: { kind: 'idle' } | { kind: 'add' } | { kind: 'edit'; id: string }; busyId nullable for remove operation gating; handleSave dispatches on editor.kind (add → addProxy / edit → updateProxy with editor.id); on a connection-field change the edit path invalidates the cached probe; handleRemove sets busyId + invalidates the deleted proxy's cached probe", () => {
    expect(body).toMatch(
      /const \[editor, setEditor\] = useState<\s*\n?\s*\{ kind: 'idle' \} \| \{ kind: 'add' \} \| \{ kind: 'edit'; id: string \}\s*\n?\s*>\(\{ kind: 'idle' \}\);/,
    );
    // dispatch on editor.kind: add → addProxy, edit → updateProxy(editId, …).
    // Pinned as two independent branch anchors rather than one regex chained
    // across the whole block. What sits BETWEEN the call and the `} else if` is
    // the branch's own business, and freezing that adjacency makes any statement
    // added inside the branch read as a REMOVED dispatch — which is what this
    // assertion did report when the post-save probe was added.
    expect(body).toMatch(/if \(editor\.kind === 'add'\) \{\s*\n\s*await addProxy\(draft\);/);
    expect(body).toMatch(/\} else if \(editor\.kind === 'edit'\) \{/);
    expect(body).toContain('const editId = editor.id;');
    expect(body).toContain('await updateProxy(editId, draft);');
    // edit path drops the cached probe when the connection target changed
    expect(body).toMatch(/const connChanged =/);
    expect(body).toMatch(/void invalidateProbe\(editId\)\.catch/);
    // delete path invalidates the removed proxy's cached probe too
    expect(body).toContain('await removeProxy(id);');
    expect(body).toMatch(/void invalidateProbe\(id\)\.catch/);
  });

  it("CRUD lib delegation: addProxy / listProxies / removeProxy / testProxy / updateProxy / validateDraft + DraftValidation / ProxyConfig / ProxyDraft / ProxyTestResult type imports from '../lib/proxies' — pinned so the CRUD + native-probe layer stays delegated to lib/proxies (view stays presentation-only)", () => {
    // V-1171 — this was one regex chaining the whole import list in source order, so
    // adding a symbol at the head of the list broke it while the property it guards was
    // untouched. `isProxyUsable` was added and the pin failed for import ORDER, which is
    // not what "the view stays presentation-only" means. Rewritten as one assertion per
    // delegated symbol: order-independent, additive-safe, and it now fails only when a
    // symbol actually stops being delegated.
    // `[^}]*` and not `[\s\S]*?`: the lazy form starts at the FIRST `import {` in the file
    // and runs to the proxies module, swallowing the React and component imports on the
    // way — which credited `useCallback` to ../lib/proxies and would have passed even if a
    // delegated symbol moved to another module. Caught by reading a mutation's message
    // rather than only its firing.
    const block = /import \{([^}]*)\} from '\.\.\/lib\/proxies';/.exec(body);
    expect(
      block,
      'the ../lib/proxies import block is gone — the view may have inlined the CRUD layer',
    ).not.toBeNull();
    const imported = new Set(
      (block?.[1] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^type\s+/, ''))
        .filter((s) => s.length > 0),
    );
    for (const symbol of [
      'addProxy',
      'listProxies',
      'removeProxy',
      'resolveEndpoint',
      'testProxy',
      'updateProxy',
      'validateDraft',
      'DraftValidation',
      'EndpointResolveResult',
      'ProxyConfig',
      'ProxyDraft',
      'ProxyTestResult',
    ]) {
      expect([...imported], `${symbol} is no longer delegated to ../lib/proxies`).toContain(symbol);
    }
  });

  it('pins honest protected-local and encrypted account-sync empty-state copy plus the Add CTA', () => {
    expect(body).toMatch(
      /Add a SOCKS5 endpoint to route session traffic through your own egress IP\. Proxy\s*\n?\s*credentials are protected locally and synced in encrypted form to your account when used\s*\n?\s*for a session\./,
    );
    expect(body).toMatch(/>\s*Add a proxy\s*<\/button>/);
  });

  it("ProxyForm submit: synchronous ref single-flight + awaited onSave + inert/busy form lock; port input type='number' min=1 max=65535; username/password empty → null", () => {
    expect(body).toMatch(
      /async function handleSubmit\(e: React\.FormEvent<HTMLFormElement>\): Promise<void> \{[\s\S]*?if \(submitInFlightRef\.current\) return;[\s\S]*?submitInFlightRef\.current = true;[\s\S]*?await onSave\(draft\);[\s\S]*?submitInFlightRef\.current = false;[\s\S]*?setSubmitting\(false\);/,
    );
    expect(body).toMatch(/const locked = saving \|\| submitting;/);
    expect(body).toMatch(/aria-busy=\{locked\}/);
    expect(body).toMatch(/aria-disabled=\{locked\}/);
    expect(body).toMatch(
      /if \(locked\) form\.setAttribute\('inert', ''\);\s*\n?\s*else form\.removeAttribute\('inert'\);/,
    );
    expect(body).toMatch(/\? mode === 'add'\s*\n?\s*\? 'Adding…'\s*\n?\s*: 'Saving…'/);
    expect(body).toMatch(
      /<input\s*\n?\s*type="number"\s*\n?\s*className="form-input mono"\s*\n?\s*min=\{1\}\s*\n?\s*max=\{65535\}\s*\n?\s*value=\{draft\.port\}\s*\n?\s*onChange=\{\(e\) => setField\('port', Number\(e\.target\.value\)\)\}/,
    );
    expect(body).toMatch(
      /onChange=\{\(e\) =>\s*\n?\s*setField\('username', e\.target\.value\.length > 0 \? e\.target\.value : null\)\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /onChange=\{\(e\) =>\s*\n?\s*setField\('password', e\.target\.value\.length > 0 \? e\.target\.value : null\)\s*\n?\s*\}/,
    );
  });

  it('parent save is also ref-single-flight, keeps the editor locked through refresh, and releases in finally', () => {
    expect(body).toMatch(/const saveInFlightRef = useRef\(false\);/);
    expect(body).toMatch(
      /async function handleSave\(draft: ProxyDraft\): Promise<void> \{\s*\n?\s*if \(saveInFlightRef\.current\) return;\s*\n?\s*saveInFlightRef\.current = true;\s*\n?\s*setSaving\(true\);/,
    );
    expect(body).toMatch(
      /await refresh\(\);\s*\n?\s*\/\/ Keep the form mounted and locked through refresh[\s\S]*?setEditor\(\{ kind: 'idle' \}\);/,
    );
    expect(body).toMatch(
      /finally \{\s*\n?\s*saveInFlightRef\.current = false;\s*\n?\s*setSaving\(false\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/saving=\{saving\}[\s\S]*?onSave=\{handleSave\}/);
  });

  it("Edit-mode initial draft via toDraft helper: ProxyConfig → ProxyDraft carries label/host/port/username/password + scheme + the openvpn/wireguard config block (each only when present), strips id+createdAt+other server-side fields; ProxyForm label conditional 'Add proxy' / 'Edit proxy' for mode header + 'Add proxy' / 'Save changes' submit button — pinned so the verb matches the noun (add vs edit) AND so editing a VPN proxy doesn't drop its scheme/config (the silent revert-to-SOCKS5 data-loss bug)", () => {
    expect(body).toMatch(
      /function toDraft\(p: ProxyConfig\): ProxyDraft \{[\s\S]*?return \{\s*\n?\s*label: p\.label,\s*\n?\s*host: p\.host,\s*\n?\s*port: p\.port,\s*\n?\s*username: p\.username,\s*\n?\s*password: p\.password,\s*\n?\s*\.\.\.\(p\.scheme !== undefined \? \{ scheme: p\.scheme \} : \{\}\),\s*\n?\s*\.\.\.\(p\.openvpn !== undefined \? \{ openvpn: p\.openvpn \} : \{\}\),\s*\n?\s*\.\.\.\(p\.wireguard !== undefined \? \{ wireguard: p\.wireguard \} : \{\}\),\s*\n?\s*\};\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /<span className="section-label text-accent">\s*\n?\s*\{mode === 'add' \? 'Add proxy' : 'Edit proxy'\}\s*\n?\s*<\/span>/,
    );
    expect(body).toMatch(/: mode === 'add'\s*\n?\s*\? 'Add proxy'\s*\n?\s*: 'Save changes'/);
  });

  it("ProxyRow (the W3121 sortable grid, replacing the card deck): per-row host:port endpoint + username shown only when set (no leak when blank) + createdAt via <RelativeTime iso=p.createdAt tooltipPrefix=\"Added\"> + Edit + Remove (Remove disabled while that row is busy with a 'Removing…' label, gated through `busy` = busyId===p.id at the call site); password never rendered anywhere — pinned so credentials don't leak into the UI", () => {
    // The page moved from a three-column card deck to a sortable grid, so the
    // MARKUP moved with it (span → div, new classNames). Every property this arm
    // was written to protect is unchanged and re-pinned below against the row;
    // the only assertion dropped is the exact card-era element shape, which was
    // never the point.
    //
    // Endpoint host:port still formatted per row.
    expect(body).toMatch(/\{p\.host\}:\{p\.port\}/);
    // Auth: the username is surfaced only when present — a proxy with no auth
    // simply omits it, so credentials are never invented.
    expect(body).toMatch(/p\.username !== null && p\.username\.length > 0 &&/);
    expect(body).toMatch(/\{p\.username\}/);
    expect(body).toMatch(/<RelativeTime iso=\{p\.createdAt\} tooltipPrefix="Added" \/>/);
    // Remove gating rides the row's `busy` prop (busy === busyId===p.id at the
    // ProxyTable call site).
    expect(body).toMatch(/busy=\{busyId === p\.id\}/);
    expect(body).toMatch(
      /onClick=\{onRemove\}\s*\n?\s*disabled=\{busy\}\s*\n?\s*>\s*\n?\s*\{busy \? 'Removing…' : 'Remove'\}/,
    );
    // ⛔ The password must never be rendered into the markup. Unchanged, and the
    // reason this arm exists at all.
    expect(body).not.toMatch(/\{p\.password\}/);
  });

  it('friendlyError delegates to shared safe humanization with operation-specific actionable fallbacks; Field subcomponent keeps label + optional error + children', () => {
    expect(body).toMatch(/import \{ humanizeError \} from '\.\.\/lib\/humanize-error';/);
    expect(body).toMatch(
      /function friendlyError\(err: unknown, fallback: string\): string \{\s*\n?\s*return humanizeError\(err, fallback\);\s*\n?\s*\}/,
    );
    expect(body).toContain('friendlyError(err, "Couldn\'t load proxies. Try again.")');
    expect(body).toContain(
      'friendlyError(err, "Couldn\'t save this proxy. Check the details and try again.")',
    );
    expect(body).toContain('friendlyError(err, "Couldn\'t remove this proxy. Try again.")');
    expect(body).not.toContain("return 'unknown error'");
    expect(body).toMatch(
      /function Field\(\{\s*\n?\s*label,\s*\n?\s*error,\s*\n?\s*children,\s*\n?\s*\}: \{\s*\n?\s*label: string;\s*\n?\s*error\?: string;\s*\n?\s*children: React\.ReactNode;\s*\n?\s*\}\): JSX\.Element \{/,
    );
  });

  it('post-save probe: a saved proxy is tested immediately — on add always, on edit only when the connection target changed; the row is resolved from a FRESH list because refresh() state has not committed; and BOTH failure paths are swallowed so a probe that cannot run never reports a successful save as failed', () => {
    // A label-only rename must NOT re-probe: same endpoint, and the cached
    // verdict still describes it. So the edit path arms the probe inside the
    // connChanged branch, not beside it.
    expect(body).toContain("let testAfterSave: 'added' | 'edited' | null = null;");
    expect(body).toContain("testAfterSave = 'added';");
    expect(body).toContain("testAfterSave = 'edited';");
    // The `(?!\n {8}\})` is the whole assertion: it forbids the branch's own
    // closing brace between the `if` and the assignment. A plain `[\s\S]*?` gap
    // spans that brace, so it matches just as happily when the line has been
    // moved OUT of the branch — i.e. it would pin nothing. Verified by moving
    // the statement below the brace and watching this fail.
    expect(body).toMatch(/if \(connChanged\) \{(?:(?!\n {8}\})[\s\S])*?testAfterSave = 'edited';/);

    // Resolved from a fresh list, not `state.proxies`: setState from refresh()
    // has not committed, so component state is still the PREVIOUS registry and
    // would not contain the row that was just added.
    expect(body).toContain('const fresh = await listProxies()');
    expect(body).toMatch(/const target =\s*\n?\s*fresh === null/);
    // addProxy does not return the created row, so the added one is matched on
    // the endpoint tuple the customer just entered.
    expect(body).toContain('p.host === draft.host && p.port === draft.port');
    expect(body).toContain('fresh.find((p) => p.id === editedId)');
    // `editedId` is read off the editor BEFORE it is reset to idle.
    expect(body).toMatch(/const editedId =[\s\S]{0,120}?setEditor\(\{ kind: 'idle' \}\);/);

    // This block sits inside the save's try, so these two catches are the ONLY
    // thing stopping a failed probe from surfacing as "Couldn't save this
    // proxy" on a proxy that saved fine. They are load-bearing, not defensive
    // habit — hence pinned individually.
    expect(body).toContain('await listProxies().catch(() => null)');
    expect(body).toContain('void handleTest(target).catch(() => undefined)');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
