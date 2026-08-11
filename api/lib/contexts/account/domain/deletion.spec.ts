import {
  DELETION_STEPS,
  MAX_DELETION_ATTEMPTS,
  nextAttemptDelayMs,
  pendingSteps,
} from './deletion';

describe('deletion step order', () => {
  it('revokes Apple BEFORE erasing the identity rows, and finalizes last', () => {
    expect(DELETION_STEPS.indexOf('revoke_apple')).toBeLessThan(DELETION_STEPS.indexOf('erase_credentials'));
    expect(DELETION_STEPS.indexOf('cancel_reservations')).toBeLessThan(DELETION_STEPS.indexOf('close_billing'));
    expect(DELETION_STEPS[DELETION_STEPS.length - 1]).toBe('finalize');
  });

  it('quiesces (freeze + revoke sessions) FIRST, before anything destructive', () => {
    // The freeze is a pipeline step, not creation-only code, so every
    // resume path re-applies it to a request that persisted but never
    // managed to quiesce.
    expect(DELETION_STEPS[0]).toBe('quiesce');
  });
});

describe('nextAttemptDelayMs', () => {
  it('backs off exponentially and caps at six hours', () => {
    expect(nextAttemptDelayMs(0)).toBe(60_000);
    expect(nextAttemptDelayMs(1)).toBe(120_000);
    expect(nextAttemptDelayMs(3)).toBe(480_000);
    expect(nextAttemptDelayMs(15)).toBe(6 * 60 * 60 * 1000);
    expect(nextAttemptDelayMs(MAX_DELETION_ATTEMPTS)).toBe(6 * 60 * 60 * 1000);
  });
});

describe('pendingSteps', () => {
  it('keeps the canonical order and drops completed steps', () => {
    const remaining = pendingSteps({
      quiesce: { completedAt: '2026-08-11T11:59:59Z' },
      cancel_reservations: { completedAt: '2026-08-11T12:00:00Z' },
      release_participations: { completedAt: '2026-08-11T12:00:01Z' },
      close_billing: { attempts: 2, lastError: 'stripe unavailable' },
    });
    expect(remaining[0]).toBe('close_billing');
    expect(remaining).not.toContain('quiesce');
    expect(remaining).not.toContain('cancel_reservations');
  });
});
