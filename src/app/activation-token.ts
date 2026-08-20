/**
 * A minimal supersession token for detecting stale async work. Each call to
 * `next()` invalidates every token issued before it. An in-flight operation
 * (e.g. `adapter.start()`, which can take seconds for the webcam) captures
 * the token it was issued, and after its await resolves checks
 * `isCurrent(token)` to discover whether a later activation — or a stop —
 * superseded it while it was in flight, so it can discard its own result
 * instead of wiring a stale adapter into the UI.
 */
export interface ActivationTokenSource {
  next(): number;
  isCurrent(token: number): boolean;
}

export function createActivationTokenSource(): ActivationTokenSource {
  let current = 0;

  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(token: number): boolean {
      return token === current;
    },
  };
}
