import {
  consumePendingMagicLinkState,
  createPendingMagicLinkState,
} from '../magic-link';

// Each test starts with no pending request (consume clears the single key).
beforeEach(async () => {
  await consumePendingMagicLinkState('');
});

describe('magic-link state binding', () => {
  it('accepts a callback whose state matches the pending request', async () => {
    const state = await createPendingMagicLinkState();
    expect(state).toBeTruthy();
    expect(await consumePendingMagicLinkState(state)).toBe(true);
  });

  it('is single-use: a matching state cannot be replayed', async () => {
    const state = await createPendingMagicLinkState();
    expect(await consumePendingMagicLinkState(state)).toBe(true);
    // A second callback (a replayed link) with the same state is rejected.
    expect(await consumePendingMagicLinkState(state)).toBe(false);
  });

  it('rejects an injected callback when NO request was pending', async () => {
    // The forced-login attack: a crafted deep link carrying attacker tokens and
    // an arbitrary state, with no magic link ever requested on this device.
    expect(await consumePendingMagicLinkState('attacker-supplied-state')).toBe(false);
  });

  it('rejects a callback whose state does not match the pending request', async () => {
    await createPendingMagicLinkState();
    expect(await consumePendingMagicLinkState('some-other-state')).toBe(false);
  });

  it('rejects a callback with a missing state even when a request is pending', async () => {
    await createPendingMagicLinkState();
    expect(await consumePendingMagicLinkState(undefined)).toBe(false);
  });

  it('burns the pending state on a failed attempt (no later match)', async () => {
    const state = await createPendingMagicLinkState();
    // A wrong-state attempt still consumes the pending request...
    expect(await consumePendingMagicLinkState('wrong')).toBe(false);
    // ...so the real state can no longer be used afterwards.
    expect(await consumePendingMagicLinkState(state)).toBe(false);
  });

  it('supersedes an earlier pending request with the latest one', async () => {
    const first = await createPendingMagicLinkState();
    const second = await createPendingMagicLinkState();
    expect(second).not.toBe(first);
    // Only the most recent request is valid.
    expect(await consumePendingMagicLinkState(first)).toBe(false);
  });
});
