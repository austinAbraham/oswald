/**
 * Clock abstraction so library code can be made deterministic in tests.
 *
 * Library functions that need a timestamp should accept an injected `Clock`
 * rather than calling `Date.now()` directly. The CLI passes `systemClock`.
 */
export interface Clock {
  /** Current time as an ISO-8601 string. */
  nowIso(): string;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
};

/** Build a fixed clock for deterministic tests. */
export function fixedClock(iso: string): Clock {
  return { nowIso: () => iso };
}
