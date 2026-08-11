import type { UnitOfWork } from '@/lib/kernel';
import { IdVerificationStateError } from '../domain';
import type { IdVerificationRepository, IdVerificationRecord } from '../infrastructure/id-verification.repository';
import type { AuditLog, IdPhotoStore } from './ports';
import { IdVerificationService } from './id-verification.service';

function record(overrides: Partial<IdVerificationRecord> = {}): IdVerificationRecord {
  return {
    id: 'idv_1',
    memberId: 'mem_1',
    status: 'not_submitted',
    imageAssetRef: null,
    skippedAt: null,
    submittedAt: null,
    reviewedAt: null,
    reviewedByAdminId: null,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockRepo(): IdVerificationRepository {
  return {
    getByMemberId: vi.fn().mockResolvedValue(null),
    getOrCreate: vi.fn().mockResolvedValue(record()),
    setPhoto: vi.fn(),
    recordSkip: vi.fn(),
    transitionToSubmitted: vi.fn().mockResolvedValue(true),
    applyReview: vi.fn().mockResolvedValue(true),
    listByStatus: vi.fn().mockResolvedValue([]),
    deleteForMember: vi.fn(),
  } as unknown as IdVerificationRepository;
}

function mockPhotos(): IdPhotoStore {
  return {
    uploadIdPhoto: vi.fn().mockResolvedValue({ storagePath: 'private/id-photos/newphoto123456789012.webp' }),
    attachToMember: vi.fn(),
    deleteIdPhoto: vi.fn(),
    readIdPhoto: vi.fn().mockResolvedValue(null),
  };
}

function mockAudit(): AuditLog {
  return { append: vi.fn().mockResolvedValue({}) };
}

function mockUow(): UnitOfWork {
  return { execute: vi.fn(async (fn: any) => fn({})) } as unknown as UnitOfWork;
}

function build(overrides: {
  repo?: IdVerificationRepository;
  photos?: IdPhotoStore;
  audit?: AuditLog;
} = {}) {
  const repo = overrides.repo ?? mockRepo();
  const photos = overrides.photos ?? mockPhotos();
  const audit = overrides.audit ?? mockAudit();
  const service = new IdVerificationService(repo, photos, audit, mockUow());
  return { service, repo, photos, audit };
}

const UPLOAD = { filename: 'passport.jpg', contentType: 'image/jpeg', bytes: Buffer.from('img') };

describe('IdVerificationService.uploadPhoto', () => {
  it('uploads privately, attaches to the member, and replaces the previous photo', async () => {
    const repo = mockRepo();
    (repo.getOrCreate as ReturnType<typeof vi.fn>).mockResolvedValue(
      record({ imageAssetRef: 'private/id-photos/oldphoto1234567890ab.webp' }),
    );
    (repo.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue(
      record({ imageAssetRef: 'private/id-photos/newphoto123456789012.webp' }),
    );
    const { service, photos } = build({ repo });

    const view = await service.uploadPhoto('mem_1', UPLOAD);

    expect(photos.uploadIdPhoto).toHaveBeenCalledWith(UPLOAD);
    expect(photos.attachToMember).toHaveBeenCalledWith('private/id-photos/newphoto123456789012.webp', 'mem_1');
    expect(repo.setPhoto).toHaveBeenCalledWith('mem_1', 'private/id-photos/newphoto123456789012.webp');
    expect(photos.deleteIdPhoto).toHaveBeenCalledWith('private/id-photos/oldphoto1234567890ab.webp');
    expect(view.hasPhoto).toBe(true);
  });

  it('refuses an upload while the submission is under review', async () => {
    const repo = mockRepo();
    (repo.getOrCreate as ReturnType<typeof vi.fn>).mockResolvedValue(record({ status: 'submitted' }));
    const { service, photos } = build({ repo });

    await expect(service.uploadPhoto('mem_1', UPLOAD)).rejects.toThrow(IdVerificationStateError);
    expect(photos.uploadIdPhoto).not.toHaveBeenCalled();
  });
});

describe('IdVerificationService.submit', () => {
  it('moves a photographed row to submitted and audits it', async () => {
    const repo = mockRepo();
    (repo.getOrCreate as ReturnType<typeof vi.fn>).mockResolvedValue(
      record({ imageAssetRef: 'private/id-photos/newphoto123456789012.webp' }),
    );
    (repo.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue(
      record({ status: 'submitted', imageAssetRef: 'private/id-photos/newphoto123456789012.webp' }),
    );
    const audit = mockAudit();
    const { service } = build({ repo, audit });

    const view = await service.submit('mem_1');

    expect(repo.transitionToSubmitted).toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'id_verification.submitted',
      streamId: 'mem_1',
    }));
    expect(view.status).toBe('submitted');
  });

  it('refuses to submit without a photo', async () => {
    const { service, repo } = build();
    await expect(service.submit('mem_1')).rejects.toThrow(IdVerificationStateError);
    expect(repo.transitionToSubmitted).not.toHaveBeenCalled();
  });

  it('surfaces a lost submit race as a state error', async () => {
    const repo = mockRepo();
    (repo.getOrCreate as ReturnType<typeof vi.fn>).mockResolvedValue(
      record({ imageAssetRef: 'private/id-photos/newphoto123456789012.webp' }),
    );
    (repo.transitionToSubmitted as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { service } = build({ repo });

    await expect(service.submit('mem_1')).rejects.toThrow(IdVerificationStateError);
  });
});

describe('IdVerificationService.review', () => {
  it('decides via CAS, audits, and deletes the photo AFTER the transaction (short retention)', async () => {
    const repo = mockRepo();
    (repo.getByMemberId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(record({ status: 'submitted', imageAssetRef: 'private/id-photos/newphoto123456789012.webp' }))
      .mockResolvedValueOnce(record({ status: 'verified', imageAssetRef: null }));
    const audit = mockAudit();
    const { service, photos } = build({ repo, audit });

    const view = await service.review('mem_1', 'approve', 'usr_admin');

    expect(repo.applyReview).toHaveBeenCalledWith(
      'mem_1',
      expect.objectContaining({ status: 'verified', reviewedByAdminId: 'usr_admin' }),
      expect.anything(),
    );
    expect(photos.deleteIdPhoto).toHaveBeenCalledWith('private/id-photos/newphoto123456789012.webp');
    expect(audit.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'id_verification.approved',
      actorId: 'usr_admin',
    }));
    expect(view.status).toBe('verified');
  });

  it('keeps the rejection note visible to the member', async () => {
    const repo = mockRepo();
    (repo.getByMemberId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(record({ status: 'submitted', imageAssetRef: 'private/id-photos/newphoto123456789012.webp' }))
      .mockResolvedValueOnce(record({ status: 'rejected', note: 'Photo is blurry', imageAssetRef: null }));
    const { service } = build({ repo });

    const view = await service.review('mem_1', 'reject', 'usr_admin', 'Photo is blurry');

    expect(view.status).toBe('rejected');
    expect(view.note).toBe('Photo is blurry');
  });

  it('refuses to review a non-submitted row (and a lost CAS race)', async () => {
    const repo = mockRepo();
    (repo.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue(record({ status: 'not_submitted' }));
    const { service, photos } = build({ repo });

    await expect(service.review('mem_1', 'approve', 'usr_admin')).rejects.toThrow(IdVerificationStateError);
    expect(photos.deleteIdPhoto).not.toHaveBeenCalled();

    const raced = mockRepo();
    (raced.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue(
      record({ status: 'submitted', imageAssetRef: 'private/id-photos/newphoto123456789012.webp' }),
    );
    (raced.applyReview as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const lost = build({ repo: raced });
    await expect(lost.service.review('mem_1', 'approve', 'usr_admin')).rejects.toThrow(IdVerificationStateError);
  });
});

describe('IdVerificationService.readPhotoForStaff', () => {
  it('audits every staff view of a photo', async () => {
    const repo = mockRepo();
    (repo.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue(
      record({ status: 'submitted', imageAssetRef: 'private/id-photos/newphoto123456789012.webp' }),
    );
    const photos = mockPhotos();
    (photos.readIdPhoto as ReturnType<typeof vi.fn>).mockResolvedValue({
      body: {} as NodeJS.ReadableStream,
      contentType: 'image/jpeg',
      contentLength: 3,
    });
    const audit = mockAudit();
    const { service } = build({ repo, photos, audit });

    const photo = await service.readPhotoForStaff('mem_1', 'usr_staff');

    expect(photo).not.toBeNull();
    expect(audit.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'id_verification.photo_viewed',
      streamId: 'mem_1',
      actorId: 'usr_staff',
    }));
  });

  it('answers null (no audit) when there is no photo', async () => {
    const { service, audit } = build();
    expect(await service.readPhotoForStaff('mem_1', 'usr_staff')).toBeNull();
    expect(audit.append).not.toHaveBeenCalled();
  });
});

describe('IdVerificationService.skip', () => {
  it('records the skip without changing status', async () => {
    const repo = mockRepo();
    (repo.getByMemberId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(record({ skippedAt: new Date() }));
    const { service } = build({ repo });

    const view = await service.skip('mem_1');

    expect(repo.recordSkip).toHaveBeenCalled();
    expect(view.status).toBe('not_submitted');
    expect(view.skippedAt).not.toBeNull();
  });
});

describe('IdVerificationService.purgeForMember', () => {
  it('deletes the photo asset and the row', async () => {
    const repo = mockRepo();
    (repo.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue(
      record({ imageAssetRef: 'private/id-photos/newphoto123456789012.webp' }),
    );
    const { service, photos } = build({ repo });

    expect(await service.purgeForMember('mem_1')).toEqual({ photoDeleted: true });
    expect(photos.deleteIdPhoto).toHaveBeenCalledWith('private/id-photos/newphoto123456789012.webp');
    expect(repo.deleteForMember).toHaveBeenCalledWith('mem_1');
  });

  it('no-ops for a member who never touched verification', async () => {
    const { service, repo } = build();
    expect(await service.purgeForMember('mem_1')).toEqual({ photoDeleted: false });
    expect(repo.deleteForMember).not.toHaveBeenCalled();
  });
});
