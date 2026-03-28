import { memberInvariants, noteInvariants, MemberValidationError } from './member';

describe('memberInvariants', () => {
  describe('validateEmail', () => {
    it('accepts valid email', () => {
      expect(() => memberInvariants.validateEmail('test@example.com')).not.toThrow();
    });

    it('rejects invalid email', () => {
      expect(() => memberInvariants.validateEmail('not-an-email')).toThrow(MemberValidationError);
      expect(() => memberInvariants.validateEmail('')).toThrow(MemberValidationError);
    });
  });

  describe('validateName', () => {
    it('accepts valid names', () => {
      expect(() => memberInvariants.validateName('John', 'Doe')).not.toThrow();
    });

    it('rejects empty first name', () => {
      expect(() => memberInvariants.validateName('', 'Doe')).toThrow(MemberValidationError);
      expect(() => memberInvariants.validateName('  ', 'Doe')).toThrow(MemberValidationError);
    });

    it('rejects empty last name', () => {
      expect(() => memberInvariants.validateName('John', '')).toThrow(MemberValidationError);
    });
  });

  describe('canDelete', () => {
    it('allows deletion without active membership', () => {
      expect(() => memberInvariants.canDelete(false)).not.toThrow();
    });

    it('blocks deletion with active membership', () => {
      expect(() => memberInvariants.canDelete(true)).toThrow(MemberValidationError);
    });
  });
});

describe('noteInvariants', () => {
  describe('validateContent', () => {
    it('accepts valid content', () => {
      expect(() => noteInvariants.validateContent('A note')).not.toThrow();
    });

    it('rejects empty content', () => {
      expect(() => noteInvariants.validateContent('')).toThrow(MemberValidationError);
      expect(() => noteInvariants.validateContent('   ')).toThrow(MemberValidationError);
    });

    it('rejects content over 5000 characters', () => {
      expect(() => noteInvariants.validateContent('x'.repeat(5001))).toThrow(MemberValidationError);
    });

    it('accepts content at exactly 5000 characters', () => {
      expect(() => noteInvariants.validateContent('x'.repeat(5000))).not.toThrow();
    });
  });
});
