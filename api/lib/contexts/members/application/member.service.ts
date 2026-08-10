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
}

function isDuplicateKeyError(err: unknown): boolean {
  return err != null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002';
}
