// Human label for a byte cap, for messages that quote the cap back to the
// customer.
//
// The upload caps in routes/agent-sessions.ts are injectable, and the
// per-account one is operator-configurable
// (AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES → config → bootstrap → app → route).
// Their rejection messages used to carry the size as hardcoded prose, so a
// deployment that lowered the cap told the customer "at most 512 MB" while
// rejecting at whatever it was actually enforcing. Deriving the label from the
// effective value means the message cannot disagree with the check beside it.
//
// Binary units throughout, matching the values these caps are written in
// (`512 * 1024 * 1024` is 512 MiB, not 512 MB — the older "512 MB" wording was
// off by 4.9% as well as unfixed).

const KIB = 2 ** 10;
const MIB = 2 ** 20;
const GIB = 2 ** 30;

function trim(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded)
    ? rounded.toString()
    : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * `64 MiB`, `512 MiB`, `2 GiB`. Whole values carry no decimal; fractional ones
 * show up to two, trailing zeros trimmed.
 *
 * The unit steps down so a small injected cap still reads sensibly — the first
 * version stopped at MiB and rendered a ~10 KiB test cap as "0.01 MiB", which
 * is exactly the sort of message that sends a customer looking for a bug that
 * is not there.
 */
export function binarySizeLabel(bytes: number): string {
  if (bytes >= GIB) return `${trim(bytes / GIB)} GiB`;
  if (bytes >= MIB) return `${trim(bytes / MIB)} MiB`;
  if (bytes >= KIB) return `${trim(bytes / KIB)} KiB`;
  return `${trim(bytes)} bytes`;
}
