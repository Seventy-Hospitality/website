import {
  IdVerificationStateError,
  assertCanSkip,
  assertCanSubmit,
  assertCanUploadPhoto,
  statusAfterReview,
} from './id-verification';

describe('ID verification state machine', () => {
  describe('assertCanUploadPhoto', () => {
    it('allows upload (and replacement) before submission and after rejection', () => {
      expect(() => assertCanUploadPhoto('not_submitted')).not.toThrow();
      expect(() => assertCanUploadPhoto('rejected')).not.toThrow();
    });

    it('freezes the photo while under review and after verification', () => {
      expect(() => assertCanUploadPhoto('submitted')).toThrow(IdVerificationStateError);
      expect(() => assertCanUploadPhoto('verified')).toThrow(IdVerificationStateError);
    });
  });

  describe('assertCanSubmit', () => {
    it('requires a photo', () => {
      expect(() => assertCanSubmit('not_submitted', false)).toThrow(IdVerificationStateError);
      expect(() => assertCanSubmit('not_submitted', true)).not.toThrow();
    });

    it('allows a retry after rejection', () => {
      expect(() => assertCanSubmit('rejected', true)).not.toThrow();
    });

    it('refuses double submission and re-submission after verification', () => {
      expect(() => assertCanSubmit('submitted', true)).toThrow(IdVerificationStateError);
      expect(() => assertCanSubmit('verified', true)).toThrow(IdVerificationStateError);
    });
  });

  describe('assertCanSkip', () => {
    it('allows skipping before submission and after rejection', () => {
      expect(() => assertCanSkip('not_submitted')).not.toThrow();
      expect(() => assertCanSkip('rejected')).not.toThrow();
    });

    it('refuses skipping mid-review or once verified', () => {
      expect(() => assertCanSkip('submitted')).toThrow(IdVerificationStateError);
      expect(() => assertCanSkip('verified')).toThrow(IdVerificationStateError);
    });
  });

  describe('statusAfterReview', () => {
    it('decides a submitted verification', () => {
      expect(statusAfterReview('submitted', 'approve')).toBe('verified');
      expect(statusAfterReview('submitted', 'reject')).toBe('rejected');
    });

    it('refuses to review anything not submitted', () => {
      for (const status of ['not_submitted', 'verified', 'rejected'] as const) {
        expect(() => statusAfterReview(status, 'approve')).toThrow(IdVerificationStateError);
      }
    });
  });
});
