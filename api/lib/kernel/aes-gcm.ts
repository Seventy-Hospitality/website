import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * AES-256-GCM for secrets and private assets at rest. The key is derived
 * from an app secret plus a purpose label, so independently-purposed
 * ciphers (provider refresh tokens, private media) can never decrypt each
 * other's output. A dedicated key env var can supersede the shared secret
 * later without a format change (the version prefix is the migration hook).
 *
 * The default label MUST stay 'refresh-token-cipher': it reproduces the key
 * that existing auth_identities.refreshTokenEnc values were encrypted
 * under; changing it silently bricks every stored Apple refresh token.
 */
export class AesGcmCipher {
  private readonly key: Buffer;

  constructor(secret: string, purposeLabel = 'refresh-token-cipher') {
    this.key = createHash('sha256').update(`${secret}:${purposeLabel}`).digest();
  }

  encrypt(plaintext: string): string {
    return `v1:${this.encryptBytes(Buffer.from(plaintext, 'utf8')).subarray(2).toString('base64')}`;
  }

  decrypt(ciphertext: string): string {
    if (!ciphertext.startsWith('v1:')) throw new Error('Unknown ciphertext version');
    const raw = Buffer.from(ciphertext.slice(3), 'base64');
    return this.decryptBytes(Buffer.concat([BYTES_MAGIC, raw])).toString('utf8');
  }

  /** Binary framing: 'v1' magic (2) || iv (12) || auth tag (16) || ciphertext. */
  encryptBytes(plaintext: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([BYTES_MAGIC, iv, tag, encrypted]);
  }

  decryptBytes(ciphertext: Buffer): Buffer {
    if (ciphertext.length < 30 || !ciphertext.subarray(0, 2).equals(BYTES_MAGIC)) {
      throw new Error('Unknown ciphertext version');
    }
    const iv = ciphertext.subarray(2, 14);
    const tag = ciphertext.subarray(14, 30);
    const encrypted = ciphertext.subarray(30);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
}

const BYTES_MAGIC = Buffer.from('v1', 'utf8');
