const MAX_URLS_PER_DELIVERY = 8;
const MAX_URL_BYTES = 8_192;
const DUPLICATE_WINDOW_MS = 2_000;
const REQUIRED_PREFIX = 'driftstack://';

type Unlisten = () => void;

export interface AppDeepLinkSources {
  getCurrent?: () => Promise<string[] | null>;
  onOpenUrl?: (handler: (urls: string[]) => void) => Promise<Unlisten>;
  onForwardedUrl?: (handler: (payload: unknown) => void) => Promise<Unlisten>;
}

interface InstallOptions {
  signal?: AbortSignal;
  now?: () => number;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Treat every native event payload as untrusted. Rust validates the
 * single-instance argv before forwarding it, but the plugin and event bus are
 * separate boundaries and should not be able to hand the app an unbounded
 * batch, another URL scheme, control characters, or an oversized argument.
 */
export function boundedDeepLinkUrls(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];

  const urls: string[] = [];
  for (const candidate of payload) {
    if (urls.length === MAX_URLS_PER_DELIVERY) break;
    if (
      typeof candidate !== 'string' ||
      !candidate.startsWith(REQUIRED_PREFIX) ||
      hasControlCharacter(candidate) ||
      utf8Length(candidate) > MAX_URL_BYTES
    ) {
      continue;
    }
    urls.push(candidate);
  }
  return urls;
}

/**
 * Register all native deep-link sources before consuming the cold-start URL.
 * macOS may report the same click through both the plugin and the
 * single-instance fallback, so a short rolling window suppresses only the
 * duplicate delivery while still allowing the customer to re-open the same
 * session later.
 */
export async function installAppDeepLinkSources(
  sources: AppDeepLinkSources,
  onUrls: (urls: string[]) => void,
  options: InstallOptions = {},
): Promise<Unlisten> {
  const now = options.now ?? Date.now;
  const recent = new Map<string, number>();
  const unlisteners: Unlisten[] = [];
  let active = options.signal?.aborted !== true;

  const deliver = (payload: unknown): void => {
    if (!active || options.signal?.aborted === true) return;

    const timestamp = now();
    for (const [url, seenAt] of recent) {
      if (timestamp - seenAt >= DUPLICATE_WINDOW_MS) recent.delete(url);
    }

    const accepted: string[] = [];
    for (const url of boundedDeepLinkUrls(payload)) {
      const last = recent.get(url);
      if (last !== undefined && timestamp - last < DUPLICATE_WINDOW_MS) continue;
      recent.set(url, timestamp);
      accepted.push(url);
    }

    if (accepted.length > 0) onUrls(accepted);
  };

  const register = async <Payload>(
    source: ((handler: (payload: Payload) => void) => Promise<Unlisten>) | undefined,
  ): Promise<void> => {
    if (source === undefined || !active) return;
    try {
      const unlisten = await source((payload) => deliver(payload));
      if (!active || options.signal?.aborted === true) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    } catch {
      // One unavailable source must not disable the other native source or the
      // cold-start query (browser previews have no Tauri event bridge).
    }
  };

  await Promise.all([register(sources.onOpenUrl), register(sources.onForwardedUrl)]);

  if (active && options.signal?.aborted !== true && sources.getCurrent !== undefined) {
    try {
      deliver(await sources.getCurrent());
    } catch {
      // A failed cold-start query does not tear down the live listeners.
    }
  }

  return () => {
    active = false;
    for (const unlisten of unlisteners.splice(0)) unlisten();
  };
}
