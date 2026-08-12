import { createHash } from 'crypto';
import {
  authenticateWithProvider,
  googleAdapter,
  OAuthNotConfiguredError,
  sha256Hex,
  type FederatedAdapter,
} from '../oauth';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('sha256Hex', () => {
  it('produces the standard lowercase-hex SHA-256 digest', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex('a-raw-nonce')).toBe(sha256('a-raw-nonce'));
  });
});

describe('authenticateWithProvider', () => {
  it('hands the adapter sha256(nonce) and returns the RAW nonce', async () => {
    const authenticate = jest.fn(async (hashedNonce: string) => {
      expect(hashedNonce).toBe(sha256('raw-nonce-123'));
      return { idToken: 'id-token-xyz' };
    });
    const adapter: FederatedAdapter = {
      provider: 'google',
      isConfigured: () => true,
      isAvailable: async () => true,
      authenticate,
    };
    const fetchNonce = jest.fn(async () => ({ nonce: 'raw-nonce-123' }));

    const result = await authenticateWithProvider(adapter, fetchNonce);

    expect(fetchNonce).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      provider: 'google',
      idToken: 'id-token-xyz',
      rawNonce: 'raw-nonce-123',
      fullName: undefined,
    });
  });

  it('throws OAuthNotConfiguredError without ever fetching a nonce', async () => {
    const fetchNonce = jest.fn(async () => ({ nonce: 'n' }));
    const adapter: FederatedAdapter = {
      provider: 'apple',
      isConfigured: () => false,
      isAvailable: async () => false,
      authenticate: jest.fn(),
    };

    await expect(authenticateWithProvider(adapter, fetchNonce)).rejects.toBeInstanceOf(
      OAuthNotConfiguredError,
    );
    expect(fetchNonce).not.toHaveBeenCalled();
  });
});

describe('adapter degradation', () => {
  it('reports Google as not configured when no client IDs are set', () => {
    expect(googleAdapter.isConfigured()).toBe(false);
  });
});
