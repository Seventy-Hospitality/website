import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import type { SecretCipher } from '../application/ports';

/**
 * AES-256-GCM for provider refresh tokens at rest. The key is derived from
 * the app secret; a dedicated key env var can supersede it later without a
 * format change (the version prefix is the migration hook).
 */
export class AesGcmCipher implements SecretCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(`${secret}:refresh-token-cipher`).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
  }

  decrypt(ciphertext: string): string {
    if (!ciphertext.startsWith('v1:')) throw new Error('Unknown ciphertext version');
    const raw = Buffer.from(ciphertext.slice(3), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
