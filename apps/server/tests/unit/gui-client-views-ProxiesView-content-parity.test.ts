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
    // dispatch on editor.kind: add → addProxy, edit → updateProxy(editId, …)
    expect(body).toMatch(
      /if \(editor\.kind === 'add'\) \{\s*\n?\s*await addProxy\(draft\);\s*\n?\s*\} else if \(editor\.kind === 'edit'\) \{/,
    );
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
    expect(body).toMatch(
      /import \{\s*\n?\s*addProxy,\s*\n?\s*listProxies,\s*\n?\s*removeProxy,\s*\n?\s*resolveEndpoint,\s*\n?\s*testProxy,\s*\n?\s*updateProxy,\s*\n?\s*validateDraft,\s*\n?\s*type DraftValidation,\s*\n?\s*type EndpointResolveResult,\s*\n?\s*type ProxyConfig,\s*\n?\s*type ProxyDraft,\s*\n?\s*type ProxyTestResult,\s*\n?\s*\} from '\.\.\/lib\/proxies';/,
    );
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

  it("ProxyCard (Console restyle of the old 5-col ProxyTable): per-card host:port endpoint + username shown only when set (no leak when blank) + createdAt via <RelativeTime iso=p.createdAt tooltipPrefix=\"Added\"> + Edit + Remove buttons (Remove disabled while that card is busy with a 'Removing…' label, gated through the card's `busy` prop = busyId===p.id at the call site); password never rendered anywhere — pinned so credentials don't leak into the UI", () => {
    // Endpoint host:port still formatted per card.
    expect(body).toMatch(/\{p\.host\}:\{p\.port\}/);
    // Auth: the username is surfaced only when present (the em-dash table
    // fallback is gone — a card with no auth simply omits the username),
    // so credentials are never invented and the password is never shown.
    expect(body).toMatch(/p\.username !== null && p\.username\.length > 0 &&/);
    expect(body).toMatch(/<span className="mono truncate">\{p\.username\}<\/span>/);
    expect(body).toMatch(/<RelativeTime iso=\{p\.createdAt\} tooltipPrefix="Added" \/>/);
    // Remove gating moved onto the card's `busy` prop (busy === busyId===p.id
    // at the ProxyList call site).
    expect(body).toMatch(/busy=\{busyId === p\.id\}/);
    expect(body).toMatch(
      /onClick=\{onRemove\}\s*\n?\s*disabled=\{busy\}\s*\n?\s*>\s*\n?\s*\{busy \? 'Removing…' : 'Remove'\}/,
    );
    // The password must never be rendered into the card markup.
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

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
