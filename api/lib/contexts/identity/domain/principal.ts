export type Client = 'admin_web' | 'member_mobile';

export type StaffRole = 'staff' | 'admin';

/**
 * The authenticated caller attached to each request.
 * Stage 2 (policy rewrite) replaces this with the full Principal
 * (adds memberId and renames req.user to req.principal).
 */
export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
  email: string;
  emailVerifiedAt: Date | null;
  staffRole: StaffRole | null;
  client: Client;
}
