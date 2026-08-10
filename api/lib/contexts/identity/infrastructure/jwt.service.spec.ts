import { SignJWT } from 'jose';
import { JwtService } from './jwt.service';

const SECRET = 'test-secret-key-at-least-32-chars-long';

describe('JwtService', () => {
  describe('signAccessToken + verifyAccessToken round-trip', () => {
    it('returns sub, sid and typ', async () => {
      const jwt = new JwtService(SECRET);
      const { token } = await jwt.signAccessToken({ sub: 'usr_1', sid: 'ses_1' });
      const result = await jwt.verifyAccessToken(token);

      expect(result).not.toBeNull();
      expect(result!.sub).toBe('usr_1');
      expect(result!.sid).toBe('ses_1');
      expect(result!.typ).toBe('access');
    });

    it('carries no role or email claim', async () => {
      const jwt = new JwtService(SECRET);
      const { token } = await jwt.signAccessToken({ sub: 'usr_1', sid: 'ses_1' });
      const result = await jwt.verifyAccessToken(token);

      expect(result).not.toHaveProperty('role');
      expect(result).not.toHaveProperty('email');
      expect(result).not.toHaveProperty('staffRole');
    });

    it('includes issuer and a 10-minute expiry', async () => {
      const jwt = new JwtService(SECRET);
      const { token, expiresAt } = await jwt.signAccessToken({ sub: 'usr_1', sid: 'ses_1' });
      const result = await jwt.verifyAccessToken(token);

      expect(result!.iss).toBe('seventy');
      expect(result!.exp! - result!.iat!).toBe(10 * 60);
      expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
      expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    });
  });

  describe('verifyAccessToken', () => {
    it('returns null for a garbage token', async () => {
      const jwt = new JwtService(SECRET);
      expect(await jwt.verifyAccessToken('not.a.jwt')).toBeNull();
    });

    it('returns null for a token signed with a different secret', async () => {
      const jwt1 = new JwtService(SECRET);
      const jwt2 = new JwtService('different-secret-key-also-32-chars-long');

      const { token } = await jwt1.signAccessToken({ sub: 'usr_1', sid: 'ses_1' });
      expect(await jwt2.verifyAccessToken(token)).toBeNull();
    });

    it('returns null for a token without typ access', async () => {
      const jwt = new JwtService(SECRET);
      const foreign = await new SignJWT({ sub: 'usr_1', sid: 'ses_1', typ: 'refresh' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('seventy')
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode(SECRET));

      expect(await jwt.verifyAccessToken(foreign)).toBeNull();
    });

    it('returns null for an expired token', async () => {
      const jwt = new JwtService(SECRET);
      const expired = await new SignJWT({ sub: 'usr_1', sid: 'ses_1', typ: 'access' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .setIssuer('seventy')
        .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
        .sign(new TextEncoder().encode(SECRET));

      expect(await jwt.verifyAccessToken(expired)).toBeNull();
    });
  });
});
