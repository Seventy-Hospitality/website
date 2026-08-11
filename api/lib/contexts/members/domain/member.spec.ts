import {
  generateMemberNumber,
  memberDisplayName,
  memberInvariants,
  noteInvariants,
  MEMBER_NUMBER_PATTERN,
  MemberValidationError,
} from './member';

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

describe('generateMemberNumber', () => {
  it('produces one uppercase letter plus five digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateMemberNumber()).toMatch(MEMBER_NUMBER_PATTERN);
    }
  });

  it('never uses the confusable letters I or O', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateMemberNumber()[0]).not.toMatch(/[IO]/);
    }
  });

  it('pads short digit runs to a fixed six-character width', () => {
    // random() = 0 picks the first letter and 00000.
    expect(generateMemberNumber(() => 0)).toBe('A00000');
  });

  it('covers the top of the range without overflowing', () => {
    expect(generateMemberNumber(() => 0.9999999)).toBe('Z99999');
  });
});

describe('memberDisplayName', () => {
  const base = { firstName: 'June', lastName: 'Park' };

  it('prefers the chosen display name', () => {
    expect(memberDisplayName({ ...base, displayName: 'JP' })).toBe('JP');
  });

  it('falls back to first + last when unset or blank', () => {
    expect(memberDisplayName({ ...base, displayName: null })).toBe('June Park');
    expect(memberDisplayName({ ...base, displayName: '   ' })).toBe('June Park');
  });
});

describe('validateDisplayName', () => {
  it('accepts null (clearing) and reasonable names', () => {
    expect(() => memberInvariants.validateDisplayName(null)).not.toThrow();
    expect(() => memberInvariants.validateDisplayName('Junebug')).not.toThrow();
  });

  it('rejects blank and over-length names', () => {
    expect(() => memberInvariants.validateDisplayName('   ')).toThrow(MemberValidationError);
    expect(() => memberInvariants.validateDisplayName('x'.repeat(61))).toThrow(MemberValidationError);
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
