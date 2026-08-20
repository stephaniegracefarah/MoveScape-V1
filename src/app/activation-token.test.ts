import { describe, expect, it } from 'vitest';
import { createActivationTokenSource } from './activation-token';

describe('createActivationTokenSource', () => {
  it('an issued token is current until superseded', () => {
    const source = createActivationTokenSource();
    const a = source.next();
    expect(source.isCurrent(a)).toBe(true);
  });

  it('issuing a new token supersedes every earlier one', () => {
    const source = createActivationTokenSource();
    const a = source.next();
    const b = source.next();
    expect(source.isCurrent(a)).toBe(false);
    expect(source.isCurrent(b)).toBe(true);
  });

  it('models a late resolution being rejected after supersession', () => {
    const source = createActivationTokenSource();
    // First activation begins (e.g. webcam start() is in flight)...
    const first = source.next();
    // ...before it resolves, a second click supersedes it.
    const second = source.next();
    // The first activation's await now resolves, late: it must recognize
    // it was superseded and not wire itself into the UI.
    expect(source.isCurrent(first)).toBe(false);
    expect(source.isCurrent(second)).toBe(true);
  });

  it('a stop (next() with no follow-up activation) invalidates a pending token', () => {
    const source = createActivationTokenSource();
    const pending = source.next();
    source.next(); // Stop clicked: invalidate without starting anything new
    expect(source.isCurrent(pending)).toBe(false);
  });
});
