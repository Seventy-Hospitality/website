export type Client = 'admin_web' | 'member_mobile';

export type StaffRole = 'staff' | 'admin';

/**
 * The authenticated caller attached to each request as `req.principal`.
 *
 * Three orthogonal axes, all read from the database per request and never
 * from the access token: who you are (`userId`/`email`/`emailVerified`),
 * what staff powers you hold (`staffRole`), and whether you have a club
 * profile (`memberId`). Entitlement (membership status, tier) is deliberately
 * absent: it changes on Stripe webhooks and is read where it is enforced.
 */
export interface Principal {
  userId: string;
  sessionId: string;
  email: string;
  emailVerified: boolean;
  staffRole: StaffRole | null;
  memberId: string | null;
  client: Client;
  /**
   * Set (never cleared) once the account-deletion pipeline has started:
   * the auth ladder freezes every policy above `authenticated` for this
   * user, so a half-deleted account cannot book, pay or create anything.
   */
  deletionRequestedAt: Date | null;
}
