import { generateToken, hashToken, tokenExpiry, TOKEN_TTL_MINUTES } from './tokens';

describe('generateToken', () => {
  it('returns a token and its hash', () => {
    const { token, hash } = generateToken();
    expect(token).toHaveLength(64); // 32 bytes hex
    expect(hash).toHaveLength(64); // sha256 hex
    expect(hash).toBe(hashToken(token));
  });

  it('generates unique tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.token).not.toBe(b.token);
  });
});

describe('tokenExpiry', () => {
  it('applies the per-purpose TTL', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    expect(tokenExpiry('magic_link', now).getTime()).toBe(
      now.getTime() + TOKEN_TTL_MINUTES.magic_link * 60 * 1000,
    );
    expect(tokenExpiry('password_reset', now).getTime()).toBe(
      now.getTime() + 30 * 60 * 1000,
    );
    expect(tokenExpiry('email_verification', now).getTime()).toBe(
      now.getTime() + 24 * 60 * 60 * 1000,
    );
    expect(tokenExpiry('oauth_nonce', now).getTime()).toBe(now.getTime() + 10 * 60 * 1000);
  });
});
