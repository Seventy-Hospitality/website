import { memberInvariants, noteInvariants, MemberNotFoundError, DuplicateEmailError } from '../domain';
import type { MemberRepository } from '../infrastructure';

export interface CreateMemberInput {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export interface UpdateMemberInput {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string | null;
}

export interface ListMembersQuery {
  search?: string;
  status?: string;
  page: number;
  limit: number;
}

export class MemberService {
  constructor(private readonly repo: MemberRepository) {}

  async list(query: ListMembersQuery) {
    return this.repo.list(query);
  }

  /** Member-facing directory search: names only, never emails or staff. */
  async search(query: string, limit: number, offset = 0) {
    return this.repo.searchByNamePrefix(query, limit, offset);
  }

  /**
   * Default (pre-search) directory page for the invite picker: alphabetical,
   * the caller excluded, same names-only projection as search.
   */
  async browseDirectory(callerMemberId: string, limit: number, offset = 0) {
    return this.repo.listDirectory({ excludeMemberId: callerMemberId, offset, limit });
  }

  async getById(id: string) {
    const member = await this.repo.getById(id);
    if (!member) throw new MemberNotFoundError(id);
    return member;
  }

  async create(input: CreateMemberInput) {
    memberInvariants.validateEmail(input.email);
    memberInvariants.validateName(input.firstName, input.lastName);

    try {
      return await this.repo.create(input);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new DuplicateEmailError(input.email);
      }
      throw err;
    }
  }

  async update(id: string, input: UpdateMemberInput) {
    if (input.email) memberInvariants.validateEmail(input.email);

    const existing = await this.repo.getById(id);
    if (!existing) throw new MemberNotFoundError(id);

    try {
      return await this.repo.update(id, input);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new DuplicateEmailError(input.email!);
      }
      throw err;
    }
  }
  async addNote(memberId: string, authorId: string, content: string) {
    noteInvariants.validateContent(content);
    const member = await this.repo.getById(memberId);
    if (!member) throw new MemberNotFoundError(memberId);
    return this.repo.addNote(memberId, authorId, content);
  }

  /** Self-service display-name edit (account screen). */
  async updateDisplayName(memberId: string, displayName: string | null) {
    const normalized = displayName?.trim() || null;
    memberInvariants.validateDisplayName(normalized);
    const existing = await this.repo.getById(memberId);
    if (!existing) throw new MemberNotFoundError(memberId);
    return this.repo.updateProfile(memberId, { displayName: normalized });
  }

  /**
   * Swap the avatar pointer; returns the replaced path so the caller (the
   * account context) can drop the old asset through the media pipeline.
   */
  async setAvatar(memberId: string, avatarUrl: string | null): Promise<{ previousAvatarUrl: string | null }> {
    const existing = await this.repo.getById(memberId);
    if (!existing) throw new MemberNotFoundError(memberId);
    await this.repo.setAvatarUrl(memberId, avatarUrl);
    return { previousAvatarUrl: existing.avatarUrl };
  }

  /**
   * Account-deletion seam: scrub PII, tombstone the email, retire the
   * member number (the anonymized row keeps it), unlink the user. Keeps
   * the row and stripeCustomerId. Idempotent.
   */
  async scrubForAccountDeletion(memberId: string): Promise<{ previousAvatarUrl: string | null }> {
    return this.repo.scrubForAccountDeletion(memberId);
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return err != null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002';
}
