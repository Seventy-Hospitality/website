import type { PrismaClient } from '@prisma/client';
import type { ManagedMediaAssetRepository, MediaAssetOwner } from '../application';
import {
  type ManagedMediaAsset,
  EVENT_IMAGE_USAGE,
  MEDIA_ASSET_STATUS_ATTACHED,
  MEDIA_ASSET_STATUS_DISCARDED,
  MEDIA_ASSET_STATUS_PENDING,
  type MediaAsset,
} from '../domain';

function toManagedMediaAsset(record: {
  publicPath: string;
  usage: string;
  status: string;
  contentType: string;
  sizeBytes: number;
  originalFilename: string;
  ownerType: string | null;
  ownerId: string | null;
  createdAt: Date;
  attachedAt: Date | null;
  discardedAt: Date | null;
}): ManagedMediaAsset {
  return {
    publicPath: record.publicPath,
    usage: EVENT_IMAGE_USAGE,
    status: record.status as ManagedMediaAsset['status'],
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    originalFilename: record.originalFilename,
    ownerType: record.ownerType,
    ownerId: record.ownerId,
    createdAt: record.createdAt,
    attachedAt: record.attachedAt,
    discardedAt: record.discardedAt,
  };
}

export class PrismaManagedMediaAssetRepository implements ManagedMediaAssetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createPendingEventImage(asset: MediaAsset): Promise<void> {
    await this.prisma.managedMediaAsset.create({
      data: {
        publicPath: asset.publicPath,
        usage: EVENT_IMAGE_USAGE,
        status: MEDIA_ASSET_STATUS_PENDING,
        contentType: asset.contentType,
        sizeBytes: asset.sizeBytes,
        originalFilename: asset.originalFilename,
      },
    });
  }

  async attachManagedAsset(publicPath: string, owner: MediaAssetOwner, attachedAt = new Date()): Promise<void> {
    await this.prisma.managedMediaAsset.updateMany({
      where: {
        publicPath,
        usage: EVENT_IMAGE_USAGE,
        discardedAt: null,
      },
      data: {
        status: MEDIA_ASSET_STATUS_ATTACHED,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        attachedAt,
      },
    });
  }

  async markManagedAssetDiscarded(publicPath: string, discardedAt = new Date()): Promise<void> {
    await this.prisma.managedMediaAsset.updateMany({
      where: {
        publicPath,
        usage: EVENT_IMAGE_USAGE,
        discardedAt: null,
      },
      data: {
        status: MEDIA_ASSET_STATUS_DISCARDED,
        ownerType: null,
        ownerId: null,
        discardedAt,
      },
    });
  }

  async listStalePendingEventImages(createdBefore: Date, limit: number): Promise<ManagedMediaAsset[]> {
    const candidates = await this.prisma.managedMediaAsset.findMany({
      where: {
        usage: EVENT_IMAGE_USAGE,
        status: MEDIA_ASSET_STATUS_PENDING,
        discardedAt: null,
        createdAt: { lt: createdBefore },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(limit * 4, limit),
      select: {
        publicPath: true,
        usage: true,
        status: true,
        contentType: true,
        sizeBytes: true,
        originalFilename: true,
        ownerType: true,
        ownerId: true,
        createdAt: true,
        attachedAt: true,
        discardedAt: true,
      },
    });

    if (candidates.length === 0) {
      return [];
    }

    const candidatePaths = candidates.map((asset: { publicPath: string }) => asset.publicPath);
    // Safety net: never delete an asset something already points at, even if
    // its attach write was lost (club-event images and club covers share the
    // managed pipeline).
    const [referencedEventImages, referencedClubCovers] = await Promise.all([
      this.prisma.clubEvent.findMany({
        where: { imageUrl: { in: candidatePaths } },
        select: { imageUrl: true },
      }),
      this.prisma.club.findMany({
        where: { coverImageUrl: { in: candidatePaths } },
        select: { coverImageUrl: true },
      }),
    ]);

    const referencedPaths = new Set(
      [
        ...referencedEventImages.map((event) => event.imageUrl),
        ...referencedClubCovers.map((club) => club.coverImageUrl),
      ].filter((imageUrl): imageUrl is string => Boolean(imageUrl)),
    );

    return candidates
      .filter((asset: { publicPath: string }) => !referencedPaths.has(asset.publicPath))
      .slice(0, limit)
      .map(toManagedMediaAsset);
  }
}
