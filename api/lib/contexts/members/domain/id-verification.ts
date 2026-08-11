// ── Government-ID verification (pure state machine) ──
//
//   not_submitted --submit--> submitted --approve--> verified
//        ^  \ skip (records skippedAt, status unchanged)     \
//        |   \________________________________________________\
//        |                                                --reject--> rejected
//        +-- rejected --upload/submit--> submitted (retry loop)
//
// Photo uploads are allowed (and replace the previous photo) while
// not_submitted or rejected; a submission under review is immutable and a
// verified member has nothing left to upload. The photo itself is a
// PRIVATE media asset, deleted after the review decision and on account
// deletion (short retention).

export type IdVerificationStatus = 'not_submitted' | 'submitted' | 'verified' | 'rejected';
export type IdReviewDecision = 'approve' | 'reject';

export class IdVerificationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdVerificationStateError';
  }
}

export function assertCanUploadPhoto(status: IdVerificationStatus): void {
  if (status === 'submitted') {
    throw new IdVerificationStateError('Your ID is already under review');
  }
  if (status === 'verified') {
    throw new IdVerificationStateError('Your ID is already verified');
  }
}

export function assertCanSubmit(status: IdVerificationStatus, hasPhoto: boolean): void {
  assertCanUploadPhoto(status);
  if (!hasPhoto) {
    throw new IdVerificationStateError('Upload a photo of your ID before submitting');
  }
}

export function assertCanSkip(status: IdVerificationStatus): void {
  if (status === 'submitted') {
    throw new IdVerificationStateError('Your ID is already under review');
  }
  if (status === 'verified') {
    throw new IdVerificationStateError('Your ID is already verified');
  }
}

export function statusAfterReview(current: IdVerificationStatus, decision: IdReviewDecision): IdVerificationStatus {
  if (current !== 'submitted') {
    throw new IdVerificationStateError('Only a submitted ID can be reviewed');
  }
  return decision === 'approve' ? 'verified' : 'rejected';
}
