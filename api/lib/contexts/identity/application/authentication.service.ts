import type { UnitOfWork } from '@/lib/kernel/unit-of-work';
import type { NotificationService } from '@/lib/contexts/communications/application';
import {
  generateToken,
  hashToken,
  tokenExpiry,
  InvalidTokenError,
  InvalidCredentialsError,
  NotAuthorizedError,
  AccountUnavailableError,
  EmailInUseError,
  type Client,
} from '../domain';
import type { UserRepository, IdentityUser } from '../infrastructure/user.repository';
import type { CredentialRepository } from '../infrastructure/credential.repository';
import type { AuthTokenRepository } from '../infrastructure/auth-token.repository';
import type { AuditLog, PasswordHasher } from './ports';
import type { SessionService, IssuedSession, SessionMeta } from './session.service';
import { MemberClaimService, splitFullName } from './member-claiming';

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isUniqueViolation(err: unknown): boolean {
  return err != null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002';
}

export class AuthenticationService {
  /** Lazily-built valid hash so unknown-email sign-ins cost a real verify. */
  private timingEqualizer: Promise<string> | null = null;

  constructor(
    private readonly users: UserRepository,
    private readonly credentials: CredentialRepository,
    private readonly tokens: AuthTokenRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly memberClaims: MemberClaimService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly verifyBaseUrl: string,
    private readonly webUrl: string,
  ) {}

  // ── Password ──

  async signUp(input: SignUpInput, client: Client, meta?: SessionMeta): Promise<IssuedSession> {
    const email = normalizeEmail(input.email);
    const name = input.name.trim();
    const secretHash = await this.hasher.hash(input.password);

    let user: IdentityUser;
    try {
      user = await this.uow.execute(async (tx) => {
        const created = await this.users.createUser({ email, name }, tx);
        await this.credentials.upsertPassword(created.id, secretHash, tx);
        await this.memberClaims.createProfileIfAbsent(tx, created, {
          ...splitFullName(name),
          phone: input.phone,
        });
        await this.audit.append(tx, {
          streamType: 'user',
          streamId: created.id,
          eventType: 'UserSignedUp',
          data: { email, method: 'password' },
          actorId: created.id,
        });
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new EmailInUseError();
      throw err;
    }

    // Best-effort; /email/resend covers delivery failures.
    await this.sendVerificationEmail(user).catch(() => {});

    return this.sessions.issue(user, client, meta);
  }

  async signIn(email: string, password: string, client: Client, meta?: SessionMeta): Promise<IssuedSession> {
    const user = await this.users.findByEmail(normalizeEmail(email));
    const credential = user ? await this.credentials.findPassword(user.id) : null;

    if (!user || !credential) {
      // Equalize timing with a real verification against a throwaway hash.
      this.timingEqualizer ??= this.hasher.hash('timing-equalizer');
      await this.hasher.verify(await this.timingEqualizer, password);
      throw new InvalidCredentialsError();
    }

    const valid = await this.hasher.verify(credential.secretHash, password);
    if (!valid) throw new InvalidCredentialsError();
    if (user.status !== 'active') throw new AccountUnavailableError();

    if (this.hasher.needsRehash(credential.secretHash)) {
      const rehashed = await this.hasher.hash(password);
      await this.credentials.upsertPassword(user.id, rehashed).catch(() => {});
    }

    return this.sessions.issue(user, client, meta);
  }

  // ── Email verification ──

  async verifyEmail(token: string): Promise<{ verified: true; claimedMemberId: string | null }> {
    const hash = hashToken(token);
    return this.uow.execute(async (tx) => {
      const consumed = await this.tokens.consume('email_verification', hash, tx);
      if (!consumed) throw new InvalidTokenError();

      const user = await this.users.findById(consumed.identifier, tx);
      if (!user || user.status !== 'active') throw new InvalidTokenError();
      if (user.emailVerifiedAt) return { verified: true, claimedMemberId: null };

      const now = new Date();
      await this.users.markEmailVerified(user.id, now, tx);
      await this.audit.append(tx, {
        streamType: 'user',
        streamId: user.id,
        eventType: 'EmailVerified',
        data: { email: user.email, method: 'email_token' },
        actorId: user.id,
      });
      // Email-verification proves the inbox received the token, not that
      // whoever holds the account (its password may be an attacker's) is its
      // owner — so it does not prove account control. A billing-carrying row
      // is therefore withheld here and claimed only via magic link / OAuth /
      // password reset.
      const { claimedMemberId } = await this.memberClaims.claimIfEligible(
        tx,
        { ...user, emailVerifiedAt: now },
        { accountControlProven: false },
      );
      return { verified: true, claimedMemberId };
    });
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.status !== 'active' || user.emailVerifiedAt) return;
    await this.sendVerificationEmail(user);
  }

  private async sendVerificationEmail(user: IdentityUser): Promise<void> {
    const { token, hash } = generateToken();
    await this.tokens.invalidateAll('email_verification', user.id);
    await this.tokens.create({
      purpose: 'email_verification',
      identifier: user.id,
      tokenHash: hash,
      expiresAt: tokenExpiry('email_verification'),
    });
    const verifyUrl = new URL('/verify-email', this.webUrl);
    verifyUrl.searchParams.set('token', token);
    await this.notifications.sendEmailVerification(user.email, verifyUrl.toString());
  }

  // ── Password reset ──

  /** Always resolves silently; never reveals whether the email exists. */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.users.findByEmail(normalizeEmail(email));
    if (!user || user.status !== 'active') return;

    const { token, hash } = generateToken();
    await this.tokens.invalidateAll('password_reset', user.id);
    await this.tokens.create({
      purpose: 'password_reset',
      identifier: user.id,
      tokenHash: hash,
      expiresAt: tokenExpiry('password_reset'),
    });
    const resetUrl = new URL('/reset-password', this.webUrl);
    resetUrl.searchParams.set('token', token);
    await this.notifications.sendPasswordReset(user.email, resetUrl.toString());
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const hash = hashToken(token);
    const secretHash = await this.hasher.hash(newPassword);

    await this.uow.execute(async (tx) => {
      const consumed = await this.tokens.consume('password_reset', hash, tx);
      if (!consumed) throw new InvalidTokenError();

      const user = await this.users.findById(consumed.identifier, tx);
      if (!user || user.status !== 'active') throw new InvalidTokenError();

      await this.credentials.upsertPassword(user.id, secretHash, tx);
      await this.tokens.invalidateAll('password_reset', user.id, tx);

      // Completing an emailed reset proves inbox ownership AND replaces the
      // credential, so the resetter now controls the account.
      if (!user.emailVerifiedAt) {
        const now = new Date();
        await this.users.markEmailVerified(user.id, now, tx);
        await this.audit.append(tx, {
          streamType: 'user',
          streamId: user.id,
          eventType: 'EmailVerified',
          data: { email: user.email, method: 'password_reset' },
          actorId: user.id,
        });
        await this.memberClaims.claimIfEligible(
          tx,
          { ...user, emailVerifiedAt: now },
          { accountControlProven: true },
        );
      }

      await this.audit.append(tx, {
        streamType: 'user',
        streamId: user.id,
        eventType: 'PasswordReset',
        data: {},
        actorId: user.id,
      });

      // Revoke inside the transaction: a failed revoke must roll the whole
      // reset back (and stay retryable) rather than leaving the password
      // changed while every pre-reset session — the attacker's included —
      // keeps authenticating.
      await this.sessions.revokeAllForUser(user.id, 'password_reset', { tx });
    });
  }

  // ── Magic link (admin sign-in and member account recovery) ──

  /**
   * Send a magic link email to any active account: it is the recovery path
   * when a member has neither their password nor their provider to hand.
   * Does not reveal whether the email exists — always returns silently.
   */
  async sendMagicLink(email: string, options?: { redirectTo?: string | null }): Promise<void> {
    const normalized = normalizeEmail(email);
    const user = await this.users.findByEmail(normalized);
    if (!user || user.status !== 'active') return; // Silent — no enumeration

    const { token, hash } = generateToken();
    await this.tokens.create({
      purpose: 'magic_link',
      identifier: normalized,
      tokenHash: hash,
      expiresAt: tokenExpiry('magic_link'),
    });

    const verifyUrl = new URL('/api/auth/verify', this.verifyBaseUrl);
    verifyUrl.searchParams.set('token', token);
    if (options?.redirectTo) {
      verifyUrl.searchParams.set('redirectTo', options.redirectTo);
    }

    await this.notifications.sendMagicLink(normalized, verifyUrl.toString());
  }

  async verifyMagicLink(token: string, client: Client, meta?: SessionMeta): Promise<IssuedSession> {
    const hash = hashToken(token);

    const user = await this.uow.execute(async (tx) => {
      const consumed = await this.tokens.consume('magic_link', hash, tx);
      if (!consumed) throw new InvalidTokenError();

      const found = await this.users.findByEmail(consumed.identifier, tx);
      if (!found || found.status !== 'active') throw new NotAuthorizedError();

      if (!found.emailVerifiedAt) {
        // The link arrived in their inbox; that is verification, so it also
        // makes the account eligible to claim a staff-created member profile.
        const now = new Date();
        await this.users.markEmailVerified(found.id, now, tx);
        const verified = { ...found, emailVerifiedAt: now };
        await this.audit.append(tx, {
          streamType: 'user',
          streamId: verified.id,
          eventType: 'EmailVerified',
          data: { email: verified.email, method: 'magic_link' },
          actorId: verified.id,
        });
        // The clicker of the magic link is the party being handed a session,
        // so this path proves account control.
        await this.memberClaims.claimIfEligible(tx, verified, { accountControlProven: true });
        return verified;
      }
      return found;
    });

    return this.sessions.issue(user, client, meta);
  }

  getWebUrl(): string {
    return this.webUrl;
  }
}
