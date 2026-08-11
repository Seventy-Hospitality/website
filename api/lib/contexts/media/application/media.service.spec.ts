import { Readable } from 'node:stream';
import { AesGcmCipher } from '@/lib/kernel/aes-gcm';
import {
  MEDIA_ENCRYPTION_V1,
  MediaService,
  type ImageProcessor,
  type ManagedMediaAssetRepository,
  type MediaObjectStorage,
} from './media.service';
import { MediaValidationError, type ManagedMediaAsset } from '../domain';

const PUBLIC_NAME = 'ck2qwertyuiopasdfghj.webp';
const PUBLIC_PATH = `/uploads/event-images/${PUBLIC_NAME}`;
const AVATAR_PATH = `/uploads/avatars/${PUBLIC_NAME}`;
const PRIVATE_PATH = `private/id-photos/${PUBLIC_NAME}`;

function mockStorage(): MediaObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
  };
}

function mockAssetRepo(): ManagedMediaAssetRepository {
  return {
    createPending: vi.fn(),
    getByPath: vi.fn().mockResolvedValue(null),
    attachManagedAsset: vi.fn(),
    markManagedAssetDiscarded: vi.fn(),
    markManagedAssetPurged: vi.fn(),
    listStalePendingAssets: vi.fn().mockResolvedValue([]),
    listDiscardedUnpurged: vi.fn().mockResolvedValue([]),
    listAttachedForOwner: vi.fn().mockResolvedValue([]),
  };
}

const passthroughProcessor: ImageProcessor = {
  normalize: async (_spec, input) => input,
};

const cipher = new AesGcmCipher('test-secret', 'media-at-rest');

function makeManagedAsset(overrides: Partial<ManagedMediaAsset> = {}): ManagedMediaAsset {
  return {
    storagePath: PUBLIC_PATH,
    publicUrl: PUBLIC_PATH,
    usage: 'event-image',
    status: 'pending',
    contentType: 'image/webp',
    sizeBytes: 128,
    originalFilename: 'poster.png',
    encryption: null,
    ownerType: null,
    ownerId: null,
    createdAt: new Date('2026-04-01T12:00:00.000Z'),
    attachedAt: null,
    discardedAt: null,
    purgedAt: null,
    ...overrides,
  };
}

function buildService(overrides: {
  storage?: MediaObjectStorage;
  assetRepo?: ManagedMediaAssetRepository;
} = {}) {
  const storage = overrides.storage ?? mockStorage();
  const assetRepo = overrides.assetRepo ?? mockAssetRepo();
  const service = new MediaService(storage, assetRepo, passthroughProcessor, cipher);
  return { service, storage, assetRepo };
}

describe('MediaService.upload', () => {
  it('stores public uploads plaintext under /uploads and records a pending row', async () => {
    const { service, storage, assetRepo } = buildService();

    const asset = await service.upload('event-image', {
      filename: 'poster.png',
      contentType: 'image/png',
      bytes: Buffer.from('png-bytes'),
    });

    expect(asset.storagePath).toMatch(/^\/uploads\/event-images\/[a-z0-9]{20,32}\.png$/);
    expect(asset.publicUrl).toBe(asset.storagePath);
    expect(asset.contentType).toBe('image/png');
    expect(asset.sizeBytes).toBe(9);

    expect(storage.put).toHaveBeenCalledWith(asset.storagePath, {
      bytes: Buffer.from('png-bytes'),
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(assetRepo.createPending).toHaveBeenCalledWith(asset, 'event-image', null);
  });

  it('encrypts private uploads at rest; the row keeps PLAINTEXT type and size', async () => {
    const { service, storage, assetRepo } = buildService();
    const plaintext = Buffer.from('id-photo-bytes');

    const asset = await service.upload('id-photo', {
      filename: 'passport.jpg',
      contentType: 'image/jpeg',
      bytes: plaintext,
    });

    // Private path: bare key, no leading slash, never a URL.
    expect(asset.storagePath).toMatch(/^private\/id-photos\/[a-z0-9]{20,32}\.jpg$/);
    expect(asset.publicUrl).toBeNull();
    expect(asset.sizeBytes).toBe(plaintext.byteLength);
    expect(asset.contentType).toBe('image/jpeg');

    const put = (storage.put as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(put[1].contentType).toBe('application/octet-stream');
    expect(put[1].cacheControl).toBe('no-store');
    expect(put[1].bytes.equals(plaintext)).toBe(false);
    expect(cipher.decryptBytes(put[1].bytes).equals(plaintext)).toBe(true);

    expect(assetRepo.createPending).toHaveBeenCalledWith(asset, 'id-photo', MEDIA_ENCRYPTION_V1);
  });

  it('rejects content types the usage does not accept (gif avatar)', async () => {
    const { service } = buildService();
    await expect(
      service.upload('avatar', { filename: 'a.gif', contentType: 'image/gif', bytes: Buffer.from('gif') }),
    ).rejects.toThrow(MediaValidationError);
  });

  it('refuses private uploads when no cipher is configured', async () => {
    const storage = mockStorage();
    const assetRepo = mockAssetRepo();
    const service = new MediaService(storage, assetRepo, passthroughProcessor);
    await expect(
      service.upload('id-photo', { filename: 'p.jpg', contentType: 'image/jpeg', bytes: Buffer.from('x') }),
    ).rejects.toThrow(/requires encryption/);
    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe('MediaService reads', () => {
  it('readPublicAsset serves public assets with the usage cache policy', async () => {
    const { service, storage } = buildService();
    (storage.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      body: Readable.from(Buffer.from('img')),
      contentLength: 3,
    });

    const result = await service.readPublicAsset(PUBLIC_PATH);
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe('image/webp');
    expect(result!.cacheControl).toBe('public, max-age=31536000, immutable');
  });

  it('readPublicAsset refuses private paths and malformed names', async () => {
    const { service, storage } = buildService();
    expect(await service.readPublicAsset(PRIVATE_PATH)).toBeNull();
    expect(await service.readPublicAsset('/uploads/id-photos/' + PUBLIC_NAME)).toBeNull();
    expect(await service.readPublicAsset('/uploads/event-images/..%2Fsecret.webp')).toBeNull();
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('readPrivateAsset decrypts and reports the plaintext length', async () => {
    const { service, storage, assetRepo } = buildService();
    const plaintext = Buffer.from('the-photo');
    (storage.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      body: Readable.from(cipher.encryptBytes(plaintext)),
      contentLength: 999,
    });
    (assetRepo.getByPath as ReturnType<typeof vi.fn>).mockResolvedValue({
      storagePath: PRIVATE_PATH,
      usage: 'id-photo',
      status: 'attached',
      contentType: 'image/jpeg',
      sizeBytes: plaintext.byteLength,
      encryption: MEDIA_ENCRYPTION_V1,
      ownerType: 'member',
      ownerId: 'mem_1',
    });

    const result = await service.readPrivateAsset(PRIVATE_PATH, 'id-photo');
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe('image/jpeg');
    expect(result!.contentLength).toBe(plaintext.byteLength);
    expect(result!.cacheControl).toBe('no-store');

    const chunks: Buffer[] = [];
    for await (const chunk of result!.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(plaintext)).toBe(true);
  });

  it('readPrivateAsset refuses public paths and usage mismatches', async () => {
    const { service } = buildService();
    expect(await service.readPrivateAsset(PUBLIC_PATH, 'id-photo')).toBeNull();
    expect(await service.readPrivateAsset(PRIVATE_PATH, 'event-image' as never)).toBeNull();
  });

  it('readPrivateAsset throws on tampered ciphertext rather than serving garbage', async () => {
    const { service, storage, assetRepo } = buildService();
    const tampered = cipher.encryptBytes(Buffer.from('photo'));
    tampered[tampered.length - 1] ^= 0xff;
    (storage.get as ReturnType<typeof vi.fn>).mockResolvedValue({ body: Readable.from(tampered) });
    (assetRepo.getByPath as ReturnType<typeof vi.fn>).mockResolvedValue({
      storagePath: PRIVATE_PATH,
      usage: 'id-photo',
      status: 'attached',
      contentType: 'image/jpeg',
      sizeBytes: 5,
      encryption: MEDIA_ENCRYPTION_V1,
      ownerType: 'member',
      ownerId: 'mem_1',
    });

    await expect(service.readPrivateAsset(PRIVATE_PATH, 'id-photo')).rejects.toThrow();
  });
});

describe('MediaService.attachAssetToOwner', () => {
  it('attaches managed assets to an owner', async () => {
    const { service, assetRepo } = buildService();
    await service.attachAssetToOwner(PUBLIC_PATH, { ownerType: 'club-event', ownerId: 'evt_1' });
    expect(assetRepo.attachManagedAsset).toHaveBeenCalledWith(PUBLIC_PATH, {
      ownerType: 'club-event',
      ownerId: 'evt_1',
    });
  });

  it('refuses to re-own an asset of another usage (an ID photo handed to the event path)', async () => {
    const { service, assetRepo } = buildService();
    await service.attachAssetToOwner(PRIVATE_PATH, { ownerType: 'club-event', ownerId: 'evt_1' }, { expectUsage: 'event-image' });
    expect(assetRepo.attachManagedAsset).not.toHaveBeenCalled();
  });
});

describe('MediaService.deleteAsset', () => {
  it('marks discarded BEFORE deleting the object, then records the purge', async () => {
    const calls: string[] = [];
    const storage = mockStorage();
    const assetRepo = mockAssetRepo();
    (assetRepo.markManagedAssetDiscarded as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('discard');
    });
    (storage.delete as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('delete');
      return true;
    });
    (assetRepo.markManagedAssetPurged as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('purge');
    });
    const { service } = buildService({ storage, assetRepo });

    expect(await service.deleteAsset(PUBLIC_PATH)).toBe(true);
    expect(calls).toEqual(['discard', 'delete', 'purge']);
  });

  it('usage-pinned delete refuses other usages', async () => {
    const { service, storage } = buildService();
    expect(await service.deleteAsset(PRIVATE_PATH, { expectUsage: 'event-image' })).toBe(false);
    expect(await service.deleteAsset(AVATAR_PATH, { expectUsage: 'event-image' })).toBe(false);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('ignores unmanaged paths', async () => {
    const { service, storage } = buildService();
    expect(await service.deleteAsset('/etc/passwd')).toBe(false);
    expect(await service.deleteAsset(null)).toBe(false);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe('MediaService.deleteAssetsForOwner', () => {
  it('deletes every attached asset of the owner', async () => {
    const { service, storage, assetRepo } = buildService();
    (assetRepo.listAttachedForOwner as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeManagedAsset({ storagePath: AVATAR_PATH, usage: 'avatar' }),
      makeManagedAsset({ storagePath: PRIVATE_PATH, usage: 'id-photo', publicUrl: null }),
    ]);

    const deleted = await service.deleteAssetsForOwner({ ownerType: 'member', ownerId: 'mem_1' });

    expect(deleted).toBe(2);
    expect(storage.delete).toHaveBeenCalledWith(AVATAR_PATH);
    expect(storage.delete).toHaveBeenCalledWith(PRIVATE_PATH);
  });
});

describe('MediaService.cleanupStaleAssets', () => {
  it('collects stale pending assets per usage and retries unconfirmed purges', async () => {
    const { service, storage, assetRepo } = buildService();
    const now = new Date('2026-04-04T12:00:00.000Z');
    (assetRepo.listStalePendingAssets as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeManagedAsset(),
      makeManagedAsset({ storagePath: PRIVATE_PATH, usage: 'id-photo', publicUrl: null }),
    ]);
    (assetRepo.listDiscardedUnpurged as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeManagedAsset({ storagePath: AVATAR_PATH, usage: 'avatar', status: 'discarded' }),
    ]);

    const result = await service.cleanupStaleAssets({ maxAgeHours: 24, limit: 10, now });

    expect(assetRepo.listStalePendingAssets).toHaveBeenCalledWith(
      {
        'event-image': new Date('2026-04-03T12:00:00.000Z'),
        avatar: new Date('2026-04-03T12:00:00.000Z'),
        'id-photo': new Date('2026-04-03T12:00:00.000Z'),
      },
      10,
    );
    // Stale pending: discarded, deleted, purged.
    expect(assetRepo.markManagedAssetDiscarded).toHaveBeenCalledWith(PUBLIC_PATH, now);
    expect(storage.delete).toHaveBeenCalledWith(PUBLIC_PATH);
    expect(assetRepo.markManagedAssetPurged).toHaveBeenCalledWith(PUBLIC_PATH, now);
    // Purge retry for the already-discarded avatar.
    expect(storage.delete).toHaveBeenCalledWith(AVATAR_PATH);
    expect(assetRepo.markManagedAssetPurged).toHaveBeenCalledWith(AVATAR_PATH, now);

    // Private storage paths never leave the service.
    expect(result.deletedCount).toBe(2);
    expect(result.deletedImageUrls).toEqual([PUBLIC_PATH]);
  });

  it('uses per-usage pending TTLs when no override is given', async () => {
    const { service, assetRepo } = buildService();
    const now = new Date('2026-04-04T12:00:00.000Z');

    await service.cleanupStaleAssets({ now });

    const cutoffs = (assetRepo.listStalePendingAssets as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(cutoffs['event-image']).toEqual(new Date('2026-04-03T12:00:00.000Z'));
    expect(cutoffs['id-photo']).toEqual(new Date('2026-04-03T12:00:00.000Z'));
  });
});
