import { MemberService } from './member.service';
import { MemberNotFoundError, DuplicateEmailError, MemberValidationError } from '../domain';
import type { MemberRepository } from '../infrastructure';

function mockRepo(): MemberRepository {
  return {
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    addNote: vi.fn(),
    setStripeCustomerId: vi.fn(),
    findByStripeCustomerId: vi.fn(),
  } as unknown as MemberRepository;
}

const VALID_INPUT = {
  email: 'test@example.com',
  firstName: 'John',
  lastName: 'Doe',
};

describe('MemberService', () => {
  describe('create', () => {
    it('validates and delegates to repository', async () => {
      const repo = mockRepo();
      const created = { id: '1', ...VALID_INPUT, phone: null, stripeCustomerId: null, createdAt: new Date(), updatedAt: new Date() };
      (repo.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

      const service = new MemberService(repo);
      const result = await service.create(VALID_INPUT);

      expect(repo.create).toHaveBeenCalledWith(VALID_INPUT);
      expect(result).toBe(created);
    });

    it('rejects invalid email', async () => {
      const service = new MemberService(mockRepo());
      await expect(service.create({ ...VALID_INPUT, email: 'bad' })).rejects.toThrow(MemberValidationError);
    });

    it('rejects empty first name', async () => {
      const service = new MemberService(mockRepo());
      await expect(service.create({ ...VALID_INPUT, firstName: '' })).rejects.toThrow(MemberValidationError);
    });

    it('wraps Prisma duplicate key as DuplicateEmailError', async () => {
      const repo = mockRepo();
      (repo.create as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'P2002' });

      const service = new MemberService(repo);
      await expect(service.create(VALID_INPUT)).rejects.toThrow(DuplicateEmailError);
    });
  });

  describe('getById', () => {
    it('returns member when found', async () => {
      const repo = mockRepo();
      const member = { id: '1', ...VALID_INPUT };
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(member);

      const service = new MemberService(repo);
      expect(await service.getById('1')).toBe(member);
    });

    it('throws MemberNotFoundError when not found', async () => {
      const repo = mockRepo();
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new MemberService(repo);
      await expect(service.getById('missing')).rejects.toThrow(MemberNotFoundError);
    });
  });

  describe('update', () => {
    it('validates email if provided', async () => {
      const repo = mockRepo();
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: '1' });

      const service = new MemberService(repo);
      await expect(service.update('1', { email: 'bad' })).rejects.toThrow(MemberValidationError);
    });

    it('throws MemberNotFoundError for missing member', async () => {
      const repo = mockRepo();
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new MemberService(repo);
      await expect(service.update('missing', { firstName: 'Jane' })).rejects.toThrow(MemberNotFoundError);
    });
  });

  describe('addNote', () => {
    it('validates content and delegates to repository', async () => {
      const repo = mockRepo();
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: '1' });
      const note = { id: 'n1', content: 'Hello', memberId: '1', authorId: 'usr_1', createdAt: new Date() };
      (repo.addNote as ReturnType<typeof vi.fn>).mockResolvedValue(note);

      const service = new MemberService(repo);
      const result = await service.addNote('1', 'usr_1', 'Hello');

      expect(repo.addNote).toHaveBeenCalledWith('1', 'usr_1', 'Hello');
      expect(result).toBe(note);
    });

    it('rejects empty note content', async () => {
      const service = new MemberService(mockRepo());
      await expect(service.addNote('1', 'usr_1', '')).rejects.toThrow(MemberValidationError);
    });

    it('throws MemberNotFoundError for missing member', async () => {
      const repo = mockRepo();
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new MemberService(repo);
      await expect(service.addNote('missing', 'usr_1', 'Hello')).rejects.toThrow(MemberNotFoundError);
    });
  });
});
