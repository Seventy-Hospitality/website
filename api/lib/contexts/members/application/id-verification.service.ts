import type { UnitOfWork } from '@/lib/kernel';
import {
  IdVerificationStateError,
  assertCanSkip,
  assertCanSubmit,
  assertCanUploadPhoto,
  statusAfterReview,
  type IdReviewDecision,
  type IdVerificationStatus,
} from '../domain';
import type {
  IdVerificationQueueRow,
  IdVerificationRecord,
  IdVerificationRepository,
} from '../infrastructure/id-verification.repository';
import type { AuditLog, IdPhotoStore, UploadedImage } from './ports';

const STREAM_TYPE = 'id_verification';

export interface IdVerificationStatusView {
  status: IdVerificationStatus;
  hasPhoto: boolean;
  skippedAt: Date | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  /** The rejection note, shown to the member so they can fix and retry. */
  note: string | null;
}

function toStatusView(record: IdVerificationRecord | null): IdVerificationStatusView {
  if (!record) {
    return { status: 'not_submitted', hasPhoto: false, skippedAt: null, submittedAt: null, reviewedAt: null, note: null };
  }
  return {
    status: record.status,
    hasPhoto: record.imageAssetRef !== null,
    skippedAt: record.skippedAt,
    submittedAt: record.submittedAt,
    reviewedAt: record.reviewedAt,
    note: record.status === 'rejected' ? record.note : null,
  };
}

/**
 * Government-ID verification: private encrypted photo storage (never the
 * public /uploads path), manual staff review, short retention (the photo
 * is deleted the moment a review decides, and on account deletion). Every
 * staff view of a photo is audited.
 */
export class IdVerificationService {
  constructor(
    private readonly repo: IdVerificationRepository,
    private readonly photos: IdPhotoStore,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async getStatus(memberId: string): Promise<IdVerificationStatusView> {
    return toStatusView(await this.repo.getByMemberId(memberId));
  }

  /** Upload or replace the photo (allowed until submitted / after rejection). */
  async uploadPhoto(memberId: string, upload: UploadedImage): Promise<IdVerificationStatusView> {
    const existing = await this.repo.getOrCreate(memberId);
    assertCanUploadPhoto(existing.status);

    const { storagePath } = await this.photos.uploadIdPhoto(upload);
    await this.photos.attachToMember(storagePath, memberId);
    await this.repo.setPhoto(memberId, storagePath);
    if (existing.imageAssetRef && existing.imageAssetRef !== storagePath) {
      await this.photos.deleteIdPhoto(existing.imageAssetRef);
    }
    return toStatusView(await this.repo.getByMemberId(memberId));
  }

  async submit(memberId: string): Promise<IdVerificationStatusView> {
    await this.uow.execute(async (tx) => {
      const record = await this.repo.getOrCreate(memberId, tx);
      assertCanSubmit(record.status, record.imageAssetRef !== null);
      const applied = await this.repo.transitionToSubmitted(memberId, new Date(), tx);
      if (!applied) throw new IdVerificationStateError('Your ID is already under review');
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: memberId,
        eventType: 'id_verification.submitted',
        data: {},
        actorId: memberId,
      });
    });
    return toStatusView(await this.repo.getByMemberId(memberId));
  }

  /** Records the skip; status stays wherever it is (resume-able later). */
  async skip(memberId: string): Promise<IdVerificationStatusView> {
    await this.uow.execute(async (tx) => {
      const record = await this.repo.getByMemberId(memberId, tx);
      assertCanSkip(record?.status ?? 'not_submitted');
      await this.repo.recordSkip(memberId, new Date(), tx);
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: memberId,
        eventType: 'id_verification.skipped',
        data: {},
        actorId: memberId,
      });
    });
    return toStatusView(await this.repo.getByMemberId(memberId));
  }

  // ── Staff review ──

  async listQueue(status: IdVerificationStatus = 'submitted'): Promise<IdVerificationQueueRow[]> {
    return this.repo.listByStatus(status);
  }

  /**
   * Streams the private photo to an authorized staff caller. Every view is
   * audited: "who looked at whose government ID, when" must be answerable.
   */
  async readPhotoForStaff(memberId: string, staffUserId: string) {
    const record = await this.repo.getByMemberId(memberId);
    if (!record?.imageAssetRef) return null;

    const photo = await this.photos.readIdPhoto(record.imageAssetRef);
    if (!photo) return null;

    await this.uow.execute(async (tx) => {
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: memberId,
        eventType: 'id_verification.photo_viewed',
        data: {},
        actorId: staffUserId,
      });
    });
    return photo;
  }

  /**
   * Approve/reject a submission. CAS on status=submitted (two staff racing
   * produce one decision); the photo pointer is nulled in the deciding
   * transaction and the object deleted after commit (short retention).
   */
  async review(
    memberId: string,
    decision: IdReviewDecision,
    reviewedByAdminId: string,
    note?: string | null,
  ): Promise<IdVerificationStatusView> {
    const photoToDelete = await this.uow.execute(async (tx) => {
      const record = await this.repo.getByMemberId(memberId, tx);
      if (!record) throw new IdVerificationStateError('Only a submitted ID can be reviewed');
      const nextStatus = statusAfterReview(record.status, decision);
      const applied = await this.repo.applyReview(
        memberId,
        { status: nextStatus, reviewedByAdminId, note: note ?? null, when: new Date() },
        tx,
      );
      if (!applied) throw new IdVerificationStateError('Only a submitted ID can be reviewed');
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: memberId,
        eventType: decision === 'approve' ? 'id_verification.approved' : 'id_verification.rejected',
        data: { note: note ?? null },
        actorId: reviewedByAdminId,
      });
      return record.imageAssetRef;
    });

    await this.photos.deleteIdPhoto(photoToDelete);
    return toStatusView(await this.repo.getByMemberId(memberId));
  }

  /** Account-deletion seam: photo asset + row are purged outright. */
  async purgeForMember(memberId: string): Promise<{ photoDeleted: boolean }> {
    const record = await this.repo.getByMemberId(memberId);
    if (!record) return { photoDeleted: false };
    await this.photos.deleteIdPhoto(record.imageAssetRef);
    await this.repo.deleteForMember(memberId);
    return { photoDeleted: record.imageAssetRef !== null };
  }
}
