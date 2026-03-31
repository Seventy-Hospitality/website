import { JwtService } from './jwt.service';

const SECRET = 'test-secret-key-at-least-32-chars-long';

describe('JwtService', () => {
  describe('sign + verify round-trip', () => {
    it('returns the original payload claims', async () => {
      const jwt = new JwtService(SECRET);
      const payload = { sub: 'usr_1', sid: 'ses_1', email: 'test@example.com' };

      const token = await jwt.sign(payload);
      const result = await jwt.verify(token);

      expect(result).not.toBeNull();
      expect(result!.sub).toBe('usr_1');
      expect(result!.sid).toBe('ses_1');
      expect(result!.email).toBe('test@example.com');
    });

    it('includes issuer claim', async () => {
      const jwt = new JwtService(SECRET);
      const token = await jwt.sign({ sub: 'usr_1', sid: 'ses_1', email: 'a@b.com' });
      const result = await jwt.verify(token);

      expect(result!.iss).toBe('seventy');
    });

    it('includes iat and exp claims', async () => {
      const jwt = new JwtService(SECRET);
      const token = await jwt.sign({ sub: 'usr_1', sid: 'ses_1', email: 'a@b.com' });
      const result = await jwt.verify(token);

      expect(result!.iat).toBeTypeOf('number');
      expect(result!.exp).toBeTypeOf('number');
      expect(result!.exp!).toBeGreaterThan(result!.iat!);
    });
  });

  describe('verify', () => {
    it('returns null for a garbage token', async () => {
      const jwt = new JwtService(SECRET);
      const result = await jwt.verify('not.a.jwt');

      expect(result).toBeNull();
    });

    it('returns null for a token signed with a different secret', async () => {
      const jwt1 = new JwtService(SECRET);
      const jwt2 = new JwtService('different-secret-key-also-32-chars-long');

      const token = await jwt1.sign({ sub: 'usr_1', sid: 'ses_1', email: 'a@b.com' });
      const result = await jwt2.verify(token);

      expect(result).toBeNull();
    });

    it('returns null for an empty string', async () => {
      const jwt = new JwtService(SECRET);
      const result = await jwt.verify('');

      expect(result).toBeNull();
    });
  });

  describe('sign', () => {
    it('produces a three-part JWT string', async () => {
      const jwt = new JwtService(SECRET);
      const token = await jwt.sign({ sub: 'usr_1', sid: 'ses_1', email: 'a@b.com' });

      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });
  });
});
