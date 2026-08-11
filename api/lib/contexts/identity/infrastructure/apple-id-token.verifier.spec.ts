import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { IdentityConfigError, InvalidTokenError } from '../domain';

const { mockCreateRemoteJWKSet } = vi.hoisted(() => ({
  mockCreateRemoteJWKSet: vi.fn(),
}));

// Only the network-bound JWKS fetch is replaced; signature, issuer, audience,
// and expiry checks all run through the real jose verification.
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, createRemoteJWKSet: mockCreateRemoteJWKSet };
});

import { AppleIdTokenVerifier } from './apple-id-token.verifier';

const BUNDLE_ID = 'club.seventy.app';
const WEB_SERVICES_ID = 'club.seventy.web';
const NONCE_HASH = 'a'.repeat(64);

let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk = await exportJWK(pair.publicKey);
  mockCreateRemoteJWKSet.mockReturnValue(
    createLocalJWKSet({ keys: [{ ...jwk, alg: 'ES256', use: 'sig' }] }),
  );
});

function appleToken(overrides: {
  aud?: string;
  nonce?: string;
  issuer?: string;
  claims?: Record<string, unknown>;
} = {}) {
  return new SignJWT({
    nonce: overrides.nonce ?? NONCE_HASH,
    email: 'Relay@Example.com',
    email_verified: 'true',
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(overrides.issuer ?? 'https://appleid.apple.com')
    .setAudience(overrides.aud ?? BUNDLE_ID)
    .setSubject('apple_sub_1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('AppleIdTokenVerifier', () => {
  it('accepts the native bundle ID audience', async () => {
    const verifier = new AppleIdTokenVerifier([BUNDLE_ID, WEB_SERVICES_ID]);
    const assertion = await verifier.verify(await appleToken({ aud: BUNDLE_ID }), NONCE_HASH);

    expect(assertion).toMatchObject({
      provider: 'apple',
      subject: 'apple_sub_1',
      email: 'relay@example.com',
      emailVerified: true,
      isPrivateRelay: false,
    });
  });

  it('accepts the web services ID audience (Sign in with Apple JS)', async () => {
    const verifier = new AppleIdTokenVerifier([BUNDLE_ID, WEB_SERVICES_ID]);
    const assertion = await verifier.verify(await appleToken({ aud: WEB_SERVICES_ID }), NONCE_HASH);

    expect(assertion.subject).toBe('apple_sub_1');
  });

  it('still rejects the web audience when only the bundle ID is configured', async () => {
    const verifier = new AppleIdTokenVerifier([BUNDLE_ID]);

    await expect(
      verifier.verify(await appleToken({ aud: WEB_SERVICES_ID }), NONCE_HASH),
    ).rejects.toThrow(InvalidTokenError);
    await expect(verifier.verify(await appleToken({ aud: BUNDLE_ID }), NONCE_HASH)).resolves.toBeTruthy();
  });

  it('rejects an audience outside the allowlist', async () => {
    const verifier = new AppleIdTokenVerifier([BUNDLE_ID, WEB_SERVICES_ID]);

    await expect(
      verifier.verify(await appleToken({ aud: 'attacker.app' }), NONCE_HASH),
    ).rejects.toThrow(InvalidTokenError);
  });

  it('rejects a wrong issuer', async () => {
    const verifier = new AppleIdTokenVerifier([BUNDLE_ID]);

    await expect(
      verifier.verify(await appleToken({ issuer: 'https://evil.example' }), NONCE_HASH),
    ).rejects.toThrow(InvalidTokenError);
  });

  it('rejects a nonce mismatch', async () => {
    const verifier = new AppleIdTokenVerifier([BUNDLE_ID]);

    await expect(
      verifier.verify(await appleToken({ nonce: 'b'.repeat(64) }), NONCE_HASH),
    ).rejects.toThrow(InvalidTokenError);
  });

  it('flags private relay addresses', async () => {
    const verifier = new AppleIdTokenVerifier([BUNDLE_ID]);
    const assertion = await verifier.verify(
      await appleToken({ claims: { email: 'x@privaterelay.appleid.com', is_private_email: 'true' } }),
      NONCE_HASH,
    );

    expect(assertion.isPrivateRelay).toBe(true);
  });

  it('throws a config error when no audience is configured', async () => {
    const verifier = new AppleIdTokenVerifier([]);

    await expect(verifier.verify(await appleToken(), NONCE_HASH)).rejects.toThrow(IdentityConfigError);
  });
});
