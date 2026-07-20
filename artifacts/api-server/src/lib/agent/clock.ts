/**
 * Testable clock module.
 *
 * Scheduler decision logic calls `getNow()` instead of `new Date()` directly
 * so that scenario tests can freeze or advance time without monkey-patching
 * the global Date object.
 *
 * Usage in production code:   const now = getNow();
 * Usage in tests/scenarios:   setTestClock(() => new Date("2026-08-01"));
 *                              advanceClock(24 * 60 * 60 * 1000); // +1 day
 *                              setTestClock(); // restore real clock
 */

type ClockFn = () => Date;

let _override: ClockFn | undefined;

/** Returns the current time. Override with setTestClock() in tests. */
export function getNow(): Date {
  return _override ? _override() : new Date();
}

/**
 * Freeze or restore the clock.
 * - Pass a function to freeze: `setTestClock(() => new Date("2026-08-01"))`
 * - Pass nothing to restore real time: `setTestClock()`
 */
export function setTestClock(fn?: ClockFn): void {
  _override = fn;
}

/**
 * Advance the (possibly already frozen) test clock by `ms` milliseconds.
 * If the clock isn't frozen yet, freezes it first at the current real time.
 */
export function advanceClock(ms: number): void {
  const base = _override ? _override() : new Date();
  const advanced = new Date(base.getTime() + ms);
  _override = () => new Date(advanced);
}
