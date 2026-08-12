import { createHash } from 'crypto';
import {
  MEMBER_QR_TOKEN_TTL_SECONDS,
  QrTokenError,
  signMemberQrToken,
  verifyMemberQrToken,
} from './qr-token';

const KEY = createHash('sha256').update('test-secret:member-qr').digest();
const OTHER_KEY = createHash('sha256').update('other-secret:member-qr').digest();
const NOW = new Date('2026-08-11T12:00:00Z');

describe('member QR token', () => {
  it('signs and verifies within the TTL', () => {
    const { token, expiresAt } = signMemberQrToken('mem_1', KEY, NOW);

    expect(token.startsWith('MQR1.')).toBe(true);
    expect(expiresAt).toEqual(new Date(NOW.getTime() + MEMBER_QR_TOKEN_TTL_SECONDS * 1000));
    // The raw member id must not be readable without decoding, and the
    // token must never simply BE the member id or number.
    expect(token).not.toContain('mem_1');

    const claims = verifyMemberQrToken(token, KEY, new Date(NOW.getTime() + 59_000));
    expect(claims.memberId).toBe('mem_1');
    expect(claims.expiresAt).toEqual(expiresAt);
  });

  it('rejects an expired token', () => {
    const { token } = signMemberQrToken('mem_1', KEY, NOW);
    expect(() => verifyMemberQrToken(token, KEY, new Date(NOW.getTime() + 61_000))).toThrow(QrTokenError);
    try {
      verifyMemberQrToken(token, KEY, new Date(NOW.getTime() + 61_000));
    } catch (err) {
      expect((err as QrTokenError).reason).toBe('expired');
    }
  });

  it('rejects a tampered payload (member id swap)', () => {
    const { token } = signMemberQrToken('mem_1', KEY, NOW);
    const [prefix, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, m: 'mem_2' }), 'utf8').toString('base64url');

    expect(() => verifyMemberQrToken(`${prefix}.${forgedPayload}.${signature}`, KEY, NOW)).toThrow(QrTokenError);
  });

  it('rejects a forged expiry extension', () => {
    const { token } = signMemberQrToken('mem_1', KEY, NOW);
    const [prefix, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 3600 }), 'utf8').toString('base64url');

    expect(() => verifyMemberQrToken(`${prefix}.${forged}.${signature}`, KEY, NOW)).toThrow(QrTokenError);
  });

  it('rejects a token signed with the wrong secret', () => {
    const { token } = signMemberQrToken('mem_1', OTHER_KEY, NOW);
    try {
      verifyMemberQrToken(token, KEY, NOW);
      expect.unreachable();
    } catch (err) {
      expect((err as QrTokenError).reason).toBe('tampered');
    }
  });

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'MQR1.only-two', 'NOPE.a.b', 'MQR1.!!!.###', 'mem_1']) {
      expect(() => verifyMemberQrToken(bad, KEY, NOW)).toThrow(QrTokenError);
    }
  });
});
