import { Argon2Hasher } from './argon2.hasher';

describe('Argon2Hasher', () => {
  const hasher = new Argon2Hasher();

  it('hashes and verifies a password round-trip', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify(hash, 'incorrect horse')).toBe(false);
  });

  it('produces argon2id PHC strings with the OWASP baseline parameters', async () => {
    const hash = await hasher.hash('some password');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('produces a unique salt per hash', async () => {
    const a = await hasher.hash('same password');
    const b = await hasher.hash('same password');
    expect(a).not.toBe(b);
  });

  it('returns false instead of throwing on a malformed hash', async () => {
    expect(await hasher.verify('not-a-phc-string', 'password')).toBe(false);
  });

  describe('needsRehash', () => {
    it('is false for a freshly produced hash', async () => {
      const hash = await hasher.hash('password123');
      expect(hasher.needsRehash(hash)).toBe(false);
    });

    it('is true for weaker parameters', () => {
      expect(hasher.needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
    });

    it('is true for a non-argon2id hash', () => {
      expect(hasher.needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
    });
  });
});
