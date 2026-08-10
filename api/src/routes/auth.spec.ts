import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import {
  EmailInUseError,
  InvalidCredentialsError,
  InvalidTokenError,
  IdentityConfigError,
  NotAuthorizedError,
  SessionExpiredError,
} from '@/lib/contexts/identity';

function fixtureUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usr_1',
    email: 'alice@example.com',
    name: 'Alice Chen',
    staffRole: null,
    status: 'active',
    emailVerifiedAt: null,
    termsAcceptedAt: null,
    termsVersion: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function fixtureIssued(overrides: Record<string, unknown> = {}) {
  return {
    user: fixtureUser(),
    sessionId: 'ses_1',
    client: 'member_mobile',
    accessToken: 'access_jwt',
    accessTokenExpiresAt: new Date('2026-08-10T12:10:00Z'),
    refreshToken: 'refresh_raw',
    refreshTokenExpiresAt: new Date('2026-09-10T12:00:00Z'),
    ...overrides,
  };
}

const { mockAuthenticationService, mockAccountLinkingService, mockSessionService } = vi.hoisted(() => ({
  mockAuthenticationService: {
    signUp: vi.fn(),
    signIn: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn().mockResolvedValue(undefined),
    requestPasswordReset: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi.fn().mockResolvedValue(undefined),
    sendMagicLink: vi.fn().mockResolvedValue(undefined),
    verifyMagicLink: vi.fn(),
    getWebUrl: vi.fn().mockReturnValue('https://app.test'),
  },
  mockAccountLinkingService: {
    issueNonce: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
  },
  mockSessionService: {
    validateAccessToken: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn().mockResolvedValue(undefined),
    revokeAllForUser: vi.fn().mockResolvedValue(2),
  },
}));

vi.mock('@/lib/container', () => ({
  authenticationService: mockAuthenticationService,
  accountLinkingService: mockAccountLinkingService,
  sessionService: mockSessionService,
}));

import { authRoutes } from './auth';

function authenticatedUser(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'usr_1',
    sessionId: 'ses_1',
    email: 'alice@example.com',
    emailVerifiedAt: null,
    staffRole: null,
    client: 'member_mobile',
    ...overrides,
  };
}

describe('auth routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuthenticationService.getWebUrl.mockReturnValue('https://app.test');
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    mockSessionService.refresh.mockRejectedValue(new InvalidTokenError());
    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.ready();
  });

  afterEach(() => app.close());

  describe('POST /api/auth/signup', () => {
    it('creates the account and returns the token pair', async () => {
      mockAuthenticationService.signUp.mockResolvedValue(fixtureIssued());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: { name: 'Alice Chen', email: 'alice@example.com', password: 'hunter2hunter2', phone: '555-0101' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.data.user).toEqual({
        id: 'usr_1',
        email: 'alice@example.com',
        name: 'Alice Chen',
        emailVerifiedAt: null,
        staffRole: null,
      });
      expect(body.data.accessToken).toBe('access_jwt');
      expect(body.data.refreshToken).toBe('refresh_raw');
      expect(mockAuthenticationService.signUp).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'alice@example.com' }),
        'member_mobile',
        expect.anything(),
      );
    });

    it('rejects a weak password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: { name: 'Alice', email: 'alice@example.com', password: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(mockAuthenticationService.signUp).not.toHaveBeenCalled();
    });

    it('returns 409 when the email is already registered', async () => {
      mockAuthenticationService.signUp.mockRejectedValue(new EmailInUseError());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: { name: 'Alice', email: 'alice@example.com', password: 'hunter2hunter2' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_IN_USE');
    });
  });

  describe('POST /api/auth/signin', () => {
    it('returns the token pair for valid credentials', async () => {
      mockAuthenticationService.signIn.mockResolvedValue(fixtureIssued());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/signin',
        payload: { email: 'alice@example.com', password: 'hunter2hunter2' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.accessToken).toBe('access_jwt');
    });

    it('maps invalid credentials to 401', async () => {
      mockAuthenticationService.signIn.mockRejectedValue(new InvalidCredentialsError());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/signin',
        payload: { email: 'alice@example.com', password: 'wrong-password' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('POST /api/auth/oauth/nonce', () => {
    it('returns a single-use nonce', async () => {
      mockAccountLinkingService.issueNonce.mockResolvedValue({
        nonce: 'raw_nonce',
        expiresAt: new Date('2026-08-10T12:10:00Z'),
      });

      const res = await app.inject({ method: 'POST', url: '/api/auth/oauth/nonce' });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ nonce: 'raw_nonce', expiresAt: '2026-08-10T12:10:00.000Z' });
    });
  });

  describe('POST /api/auth/oauth/google', () => {
    it('signs in with a verified ID token', async () => {
      mockAccountLinkingService.signInWithGoogle.mockResolvedValue(fixtureIssued());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/oauth/google',
        payload: { idToken: 'google_id_token', nonce: 'raw_nonce' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockAccountLinkingService.signInWithGoogle).toHaveBeenCalledWith(
        { idToken: 'google_id_token', nonce: 'raw_nonce' },
        'member_mobile',
        expect.anything(),
      );
    });

    it('maps an invalid token or burned nonce to 401', async () => {
      mockAccountLinkingService.signInWithGoogle.mockRejectedValue(new InvalidTokenError());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/oauth/google',
        payload: { idToken: 'bad', nonce: 'n' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 501 when the provider is not configured', async () => {
      mockAccountLinkingService.signInWithGoogle.mockRejectedValue(
        new IdentityConfigError('GOOGLE_OAUTH_CLIENT_IDS is not configured'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/oauth/google',
        payload: { idToken: 't', nonce: 'n' },
      });

      expect(res.statusCode).toBe(501);
      expect(res.json().error.code).toBe('NOT_CONFIGURED');
    });
  });

  describe('POST /api/auth/oauth/apple', () => {
    it('passes fullName and authorizationCode through', async () => {
      mockAccountLinkingService.signInWithApple.mockResolvedValue(fixtureIssued());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/oauth/apple',
        payload: {
          identityToken: 'apple_token',
          nonce: 'raw_nonce',
          authorizationCode: 'code',
          fullName: { givenName: 'Alice', familyName: 'Chen' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockAccountLinkingService.signInWithApple).toHaveBeenCalledWith(
        expect.objectContaining({
          identityToken: 'apple_token',
          authorizationCode: 'code',
          fullName: { givenName: 'Alice', familyName: 'Chen' },
        }),
        'member_mobile',
        expect.anything(),
      );
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('rotates a body-supplied refresh token and returns the new pair', async () => {
      mockSessionService.refresh.mockResolvedValue(fixtureIssued({ refreshToken: 'rotated_raw' }));

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken: 'refresh_raw' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.refreshToken).toBe('rotated_raw');
      expect(mockSessionService.refresh).toHaveBeenCalledWith('refresh_raw');
    });

    it('rotates the cookie for cookie clients and keeps tokens out of the body', async () => {
      mockSessionService.refresh.mockResolvedValue(fixtureIssued({ refreshToken: 'rotated_raw' }));

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { seventy_refresh: 'cookie_refresh' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(mockSessionService.refresh).toHaveBeenCalledWith('cookie_refresh');
      expect(res.json().data.refreshToken).toBeUndefined();
      expect(res.json().data.accessToken).toBeUndefined();
      const cookieNames = res.cookies.map((c) => c.name);
      expect(cookieNames).toContain('seventy_access');
      expect(cookieNames).toContain('seventy_refresh');
    });

    it('requires a token from body or cookie', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it('maps reuse detection to 401', async () => {
      mockSessionService.refresh.mockRejectedValue(new InvalidTokenError());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken: 'stolen' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/signout', () => {
    it('revokes the current session and clears cookies', async () => {
      mockSessionService.validateAccessToken.mockResolvedValue(authenticatedUser());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/signout',
        headers: { authorization: 'Bearer access_jwt' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { signedOut: true } });
      expect(mockSessionService.revoke).toHaveBeenCalledWith('ses_1', 'signout');
    });

    it('succeeds even without a valid session', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/signout' });
      expect(res.statusCode).toBe(200);
      expect(mockSessionService.revoke).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/auth/logout (legacy admin web)', () => {
    it('clears the session cookies', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { loggedOut: true } });
      const cleared = res.cookies.map((c) => c.name);
      expect(cleared).toEqual(expect.arrayContaining(['seventy_access', 'seventy_refresh', 'seventy_session']));
    });
  });

  describe('POST /api/auth/signout-all', () => {
    it('requires authentication', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/signout-all' });
      expect(res.statusCode).toBe(401);
    });

    it('revokes every session for the user', async () => {
      mockSessionService.validateAccessToken.mockResolvedValue(authenticatedUser());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/signout-all',
        headers: { authorization: 'Bearer access_jwt' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.revokedSessions).toBe(2);
      expect(mockSessionService.revokeAllForUser).toHaveBeenCalledWith('usr_1', 'signout_all');
    });
  });

  describe('POST /api/auth/password/forgot', () => {
    it('always returns success (prevents enumeration)', async () => {
      mockAuthenticationService.requestPasswordReset.mockRejectedValueOnce(new Error('boom'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/password/forgot',
        payload: { email: 'anyone@example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { sent: true } });
    });
  });

  describe('POST /api/auth/password/reset', () => {
    it('resets with a valid token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/password/reset',
        payload: { token: 'reset_token', password: 'newpassword123' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockAuthenticationService.resetPassword).toHaveBeenCalledWith('reset_token', 'newpassword123');
    });

    it('maps an invalid token to 401', async () => {
      mockAuthenticationService.resetPassword.mockRejectedValue(new InvalidTokenError());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/password/reset',
        payload: { token: 'bad', password: 'newpassword123' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/email/verify', () => {
    it('confirms the email and reports member claiming', async () => {
      mockAuthenticationService.verifyEmail.mockResolvedValue({ verified: true, claimedMemberId: 'mem_1' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/email/verify',
        payload: { token: 'verify_token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { verified: true, memberClaimed: true } });
    });
  });

  describe('POST /api/auth/email/resend', () => {
    it('requires authentication', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/email/resend' });
      expect(res.statusCode).toBe(401);
    });

    it('resends for the authenticated user', async () => {
      mockSessionService.validateAccessToken.mockResolvedValue(authenticatedUser());

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/email/resend',
        headers: { authorization: 'Bearer access_jwt' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockAuthenticationService.resendVerification).toHaveBeenCalledWith('usr_1');
    });
  });

  describe('POST /api/auth/magic-link', () => {
    it('returns success for valid email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/magic-link',
        payload: { email: 'admin@example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { sent: true } });
      expect(mockAuthenticationService.sendMagicLink).toHaveBeenCalledWith(
        'admin@example.com',
        { redirectTo: undefined },
      );
    });

    it('returns success even when sendMagicLink throws (prevents enumeration)', async () => {
      mockAuthenticationService.sendMagicLink.mockRejectedValueOnce(new Error('boom'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/magic-link',
        payload: { email: 'fail@example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { sent: true } });
    });

    it('rejects invalid email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/magic-link',
        payload: { email: 'not-an-email' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects disallowed mobile redirect target', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/magic-link',
        payload: { email: 'admin@example.com', redirectTo: 'https://evil.com/steal' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/auth/verify', () => {
    it('sets session cookies and redirects to /members on valid token', async () => {
      mockAuthenticationService.verifyMagicLink.mockResolvedValue(
        fixtureIssued({ client: 'admin_web', user: fixtureUser({ staffRole: 'admin' }) }),
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/verify?token=valid_token',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://app.test/members');
      expect(mockAuthenticationService.verifyMagicLink).toHaveBeenCalledWith(
        'valid_token',
        'admin_web',
        expect.anything(),
      );
      const cookies = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
      expect(cookies.seventy_access).toBe('access_jwt');
      expect(cookies.seventy_refresh).toBe('refresh_raw');
    });

    it('redirects with error for invalid token', async () => {
      mockAuthenticationService.verifyMagicLink.mockRejectedValue(new InvalidTokenError());

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/verify?token=bad_token',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://app.test/sign-in?error=invalid_token');
    });

    it('redirects with unknown error for non-token errors', async () => {
      mockAuthenticationService.verifyMagicLink.mockRejectedValue(new NotAuthorizedError());

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/verify?token=some_token',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://app.test/sign-in?error=unknown');
    });

    it('redirects to sign-in with error when token is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/verify',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://app.test/sign-in?error=missing_token');
    });

    it('returns tokens in the redirect URL for the mobile flow', async () => {
      mockAuthenticationService.verifyMagicLink.mockResolvedValue(fixtureIssued());

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/verify?token=valid_token&redirectTo=seventy%3A%2F%2Fauth%2Fcallback',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('seventy://auth/callback');
      expect(res.headers.location).toContain('token=access_jwt');
      expect(res.headers.location).toContain('refreshToken=refresh_raw');
      expect(mockAuthenticationService.verifyMagicLink).toHaveBeenCalledWith(
        'valid_token',
        'member_mobile',
        expect.anything(),
      );
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns user data for a valid access cookie', async () => {
      mockSessionService.validateAccessToken.mockResolvedValue(
        authenticatedUser({ staffRole: 'admin', client: 'admin_web' }),
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { seventy_access: 'valid_jwt' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: {
          userId: 'usr_1',
          email: 'alice@example.com',
          staffRole: 'admin',
          emailVerifiedAt: null,
        },
      });
    });

    it('supports bearer authentication', async () => {
      mockSessionService.validateAccessToken.mockResolvedValue(authenticatedUser());

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: 'Bearer access_jwt' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.userId).toBe('usr_1');
    });

    it('transparently rotates an expired access cookie via the refresh cookie', async () => {
      mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
      mockSessionService.refresh.mockResolvedValue(fixtureIssued({ client: 'admin_web' }));

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { seventy_access: 'expired_jwt', seventy_refresh: 'refresh_cookie' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.userId).toBe('usr_1');
      expect(mockSessionService.refresh).toHaveBeenCalledWith('refresh_cookie');
      const cookieNames = res.cookies.map((c) => c.name);
      expect(cookieNames).toContain('seventy_access');
    });

    it('returns null when no credentials are present', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/me' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: null });
      expect(mockSessionService.validateAccessToken).not.toHaveBeenCalled();
    });

    it('returns null when the session is expired and no refresh cookie exists', async () => {
      mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { seventy_access: 'expired_jwt' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: null });
    });

    it('returns null for a revoked account', async () => {
      mockSessionService.validateAccessToken.mockRejectedValue(new NotAuthorizedError());

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { seventy_access: 'revoked_jwt' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: null });
    });
  });
});
