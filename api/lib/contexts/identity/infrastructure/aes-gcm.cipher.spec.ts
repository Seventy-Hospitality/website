import { AesGcmCipher } from './aes-gcm.cipher';

describe('AesGcmCipher', () => {
  const cipher = new AesGcmCipher('some-app-secret');

  it('round-trips plaintext', () => {
    const encrypted = cipher.encrypt('apple-refresh-token-value');
    expect(encrypted).toMatch(/^v1:/);
    expect(cipher.decrypt(encrypted)).toBe('apple-refresh-token-value');
  });

  it('produces distinct ciphertexts for the same plaintext (fresh IV)', () => {
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('fails to decrypt with a different key', () => {
    const other = new AesGcmCipher('another-secret');
    const encrypted = cipher.encrypt('secret-value');
    expect(() => other.decrypt(encrypted)).toThrow();
  });

  it('rejects unknown ciphertext versions', () => {
    expect(() => cipher.decrypt('v9:abcdef')).toThrow('Unknown ciphertext version');
  });
});
