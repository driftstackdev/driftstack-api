// Shared numeric boundary checks for driver-facing behavioural generators.
// JavaScript comparisons do not reject NaN (`NaN <= 0` is false), so every
// physical coordinate/timing override must establish finiteness explicitly
// before interpolation or allocation.

export function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite (got ${String(value)})`);
  }
}

export function requirePositiveFinite(name: string, value: number): void {
  requireFinite(name, value);
  if (value <= 0) {
    throw new Error(`${name} must be > 0 (got ${String(value)})`);
  }
}

export function requireUnitInterval(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1 (got ${String(value)})`);
  }
}

export function requireIntegerInRange(name: string, value: number, min: number, max: number): void {
  requireFinite(name, value);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be between ${min} and ${max} and be an integer (got ${String(value)})`,
    );
  }
}
