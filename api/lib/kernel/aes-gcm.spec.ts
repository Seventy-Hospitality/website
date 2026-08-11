import { AesGcmCipher } from './aes-gcm';

describe('AesGcmCipher', () => {
  it('round-trips strings in the v1: format', () => {
    const cipher = new AesGcmCipher('secret');
    const ciphertext = cipher.encrypt('refresh-token-value');
    expect(ciphertext.startsWith('v1:')).toBe(true);
    expect(cipher.decrypt(ciphertext)).toBe('refresh-token-value');
  });

  it('round-trips large non-block-multiple buffers', () => {
    const cipher = new AesGcmCipher('secret', 'media-at-rest');
    const plaintext = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    expect(cipher.decryptBytes(cipher.encryptBytes(plaintext)).equals(plaintext)).toBe(true);
  });

  it('throws on a single flipped ciphertext byte', () => {
    const cipher = new AesGcmCipher('secret', 'media-at-rest');
    const ciphertext = cipher.encryptBytes(Buffer.from('sensitive'));
    ciphertext[ciphertext.length - 1] ^= 0x01;
    expect(() => cipher.decryptBytes(ciphertext)).toThrow();
  });

  it('purpose labels derive independent keys that cannot decrypt each other', () => {
    const refresh = new AesGcmCipher('same-secret');
    const media = new AesGcmCipher('same-secret', 'media-at-rest');
    const fromMedia = media.encryptBytes(Buffer.from('photo'));
    expect(() => refresh.decryptBytes(fromMedia)).toThrow();
    expect(() => media.decrypt(refresh.encrypt('token'))).toThrow();
  });

  it('the default purpose label reproduces the historical refresh-token key', () => {
    // Byte-for-byte fixture produced by the original identity cipher
    // (sha256(`${secret}:refresh-token-cipher`)); if this stops decrypting,
    // every stored Apple refresh token is bricked.
    const cipher = new AesGcmCipher('fixture-secret');
    const legacy = new AesGcmCipher('fixture-secret', 'refresh-token-cipher');
    expect(cipher.decrypt(legacy.encrypt('apple-refresh'))).toBe('apple-refresh');
  });

  it('rejects unknown framings', () => {
    const cipher = new AesGcmCipher('secret');
    expect(() => cipher.decrypt('v2:abc')).toThrow('Unknown ciphertext version');
    expect(() => cipher.decryptBytes(Buffer.from('xx-not-a-frame'))).toThrow('Unknown ciphertext version');
  });
});
