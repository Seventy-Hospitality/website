import type { Readable } from 'node:stream';
import { createId } from '@paralleldrive/cuid2';
import {
  MEDIA_USAGE_SPECS,
  type ManagedMediaAsset,
  type MediaAsset,
  type MediaUsage,
  type MediaUsageSpec,
  buildStoragePath,
  contentTypeForObjectName,
  extensionForContentType,
  mediaInvariants,
  parseAssetPath,
  publicUrlFor,
} from '../domain';

export interface UploadImageInput {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface MediaAssetReadResult {
  body: Readable;
  contentType: string;
  contentLength?: number;
  cacheControl?: string;
  lastModifiedAt?: Date;
  etag?: string;
}

/**
 * Dumb object store keyed by the canonical storage path. Object naming,
 * asset assembly, validation and encryption all live in the service; the
 * adapters only move bytes.
 */
export interface MediaObjectStorage {
  put(
    storagePath: string,
    input: { bytes: Buffer; contentType: string; cacheControl: string },
  ): Promise<void>;
  get(storagePath: string): Promise<{
    body: Readable;
    contentLength?: number;
    lastModifiedAt?: Date;
    etag?: string;
  } | null>;
  /** True when the object existed (or the delete is confirmed effective). */
  delete(storagePath: string): Promise<boolean>;
}

export interface ImageProcessor {
  normalize(spec: MediaUsageSpec, input: UploadImageInput): Promise<UploadImageInput>;
}

/** Symmetric at-rest encryption for private usages (AES-256-GCM framing). */
export interface MediaCipher {
  encryptBytes(plaintext: Buffer): Buffer;
  decryptBytes(ciphertext: Buffer): Buffer;
}

/** Scheme tag recorded on rows whose stored object is encrypted. */
export const MEDIA_ENCRYPTION_V1 = 'aes-256-gcm.v1';

export interface MediaAssetOwner {
  ownerType: string;
  ownerId: string;
}

export interface ManagedMediaAssetRecord {
  storagePath: string;
  usage: string;
  status: string;
  contentType: string;
  sizeBytes: number;
  encryption: string | null;
  ownerType: string | null;
  ownerId: string | null;
}

export interface ManagedMediaAssetRepository {
  createPending(asset: MediaAsset, usage: MediaUsage, encryption: string | null): Promise<void>;
  getByPath(storagePath: string): Promise<ManagedMediaAssetRecord | null>;
  attachManagedAsset(storagePath: string, owner: MediaAssetOwner, attachedAt?: Date): Promise<void>;
  markManagedAssetDiscarded(storagePath: string, discardedAt?: Date): Promise<void>;
  /** Confirms the stored object is gone (retention proof). */
  markManagedAssetPurged(storagePath: string, purgedAt?: Date): Promise<void>;
  /**
   * Pending rows older than their per-usage cutoff that no owner column
   * still references (the repository consults the per-usage owner-reference
   * registry, so an attach whose write was lost is still protected).
   */
  listStalePendingAssets(cutoffs: Record<MediaUsage, Date>, limit: number): Promise<ManagedMediaAsset[]>;
  /** Discarded rows whose storage delete has not been confirmed yet. */
  listDiscardedUnpurged(limit: number): Promise<ManagedMediaAsset[]>;
  listAttachedForOwner(owner: MediaAssetOwner): Promise<ManagedMediaAsset[]>;
}

export interface CleanupStaleAssetsInput {
  /** Overrides every usage's pending TTL when set (cron query param). */
  maxAgeHours?: number;
  limit?: number;
  now?: Date;
}

export interface CleanupStaleAssetsResult {
  deletedCount: number;
  /** Public URLs only; private storage paths never leave the service. */
  deletedImageUrls: string[];
  cutoff: Date;
}

export class MediaService {
  constructor(
    private readonly storage: MediaObjectStorage,
    private readonly assetRepo: ManagedMediaAssetRepository,
    private readonly imageProcessor: ImageProcessor,
    /** Required for private usages; uploads to them throw without it. */
    private readonly cipher?: MediaCipher,
  ) {}

  async upload(usage: MediaUsage, input: UploadImageInput): Promise<MediaAsset> {
    const spec = MEDIA_USAGE_SPECS[usage];
    mediaInvariants.validateContentType(spec, input.contentType);
    mediaInvariants.validateSize(spec, input.bytes.byteLength);

    const normalized = await this.imageProcessor.normalize(spec, input);
    mediaInvariants.validateContentType(spec, normalized.contentType);
    mediaInvariants.validateSize(spec, normalized.bytes.byteLength);

    const extension = extensionForContentType(normalized.contentType) ?? '.bin';
    const storagePath = buildStoragePath(spec, `${createId()}${extension}`);

    let storedBytes = normalized.bytes;
    let encryption: string | null = null;
    if (spec.encryptAtRest) {
      if (!this.cipher) {
        throw new Error(`Media usage ${usage} requires encryption but no cipher is configured`);
      }
      storedBytes = this.cipher.encryptBytes(normalized.bytes);
      encryption = MEDIA_ENCRYPTION_V1;
    }

    await this.storage.put(storagePath, {
      bytes: storedBytes,
      contentType: encryption ? 'application/octet-stream' : normalized.contentType,
      cacheControl: spec.cacheControl,
    });

    const asset: MediaAsset = {
      storagePath,
      publicUrl: publicUrlFor(storagePath),
      // Always the PLAINTEXT type and size, never the ciphertext's.
      contentType: normalized.contentType,
      sizeBytes: normalized.bytes.byteLength,
      originalFilename: input.filename || storagePath,
    };
    await this.assetRepo.createPending(asset, usage, encryption);
    return asset;
  }

  /**
   * Serves a PUBLIC asset. Refuses private paths even though the public
   * routes only ever construct public ones — two independent guards.
   */
  async readPublicAsset(storagePath: string): Promise<MediaAssetReadResult | null> {
    const parsed = parseAssetPath(storagePath);
    if (!parsed || parsed.spec.visibility !== 'public') return null;

    const object = await this.storage.get(storagePath);
    if (!object) return null;

    return {
      body: object.body,
      contentType: contentTypeForObjectName(parsed.objectName),
      contentLength: object.contentLength,
      cacheControl: parsed.spec.cacheControl,
      lastModifiedAt: object.lastModifiedAt,
      etag: object.etag,
    };
  }

  /**
   * Serves a PRIVATE asset to an authorized caller (the route enforces the
   * policy; a deliberately separate method so a public read path can never
   * reach a private asset by forgetting a flag). Buffers fully before
   * returning: GCM cannot authenticate a stream until the last byte, and
   * unverified plaintext must never be sent.
   */
  async readPrivateAsset(storagePath: string, usage: MediaUsage): Promise<MediaAssetReadResult | null> {
    const parsed = parseAssetPath(storagePath);
    if (!parsed || parsed.spec.visibility !== 'private' || parsed.spec.usage !== usage) return null;

    const [record, object] = await Promise.all([
      this.assetRepo.getByPath(storagePath),
      this.storage.get(storagePath),
    ]);
    if (!record || !object) return null;

    let bytes = await bufferStream(object.body);
    if (record.encryption) {
      if (record.encryption !== MEDIA_ENCRYPTION_V1 || !this.cipher) {
        throw new Error(`Unsupported media encryption scheme: ${record.encryption}`);
      }
      bytes = this.cipher.decryptBytes(bytes);
    }

    const { Readable } = await import('node:stream');
    return {
      body: Readable.from(bytes),
      contentType: record.contentType,
      contentLength: bytes.byteLength,
      cacheControl: parsed.spec.cacheControl,
    };
  }

  isManagedAsset(storagePath: string | null | undefined): boolean {
    return Boolean(storagePath && parseAssetPath(storagePath));
  }

  /**
   * Points an uploaded asset at its owner. `expectUsage` fails closed: a
   * caller wired for one usage (event images) can never re-own an asset of
   * another (someone's ID photo) by being handed its path.
   */
  async attachAssetToOwner(
    storagePath: string | null | undefined,
    owner: MediaAssetOwner,
    options?: { expectUsage?: MediaUsage },
  ): Promise<void> {
    const parsed = storagePath ? parseAssetPath(storagePath) : null;
    if (!parsed) return;
    if (options?.expectUsage && parsed.spec.usage !== options.expectUsage) return;

    await this.assetRepo.attachManagedAsset(storagePath!, owner);
  }

  /**
   * Deletes an asset: mark discarded first, then delete the object, then
   * record the purge. If the process dies between the last two steps the
   * discarded-unpurged sweep retries the storage delete, so the DB can
   * always answer "is that government ID actually gone".
   */
  async deleteAsset(
    storagePath: string | null | undefined,
    options?: { expectUsage?: MediaUsage },
  ): Promise<boolean> {
    const parsed = storagePath ? parseAssetPath(storagePath) : null;
    if (!parsed) return false;
    if (options?.expectUsage && parsed.spec.usage !== options.expectUsage) return false;

    await this.assetRepo.markManagedAssetDiscarded(storagePath!);
    await this.storage.delete(storagePath!);
    await this.assetRepo.markManagedAssetPurged(storagePath!);
    return true;
  }

  /** Deletes every asset attached to an owner (account-deletion seam). */
  async deleteAssetsForOwner(owner: MediaAssetOwner): Promise<number> {
    const assets = await this.assetRepo.listAttachedForOwner(owner);
    let deleted = 0;
    for (const asset of assets) {
      if (await this.deleteAsset(asset.storagePath)) deleted += 1;
    }
    return deleted;
  }

  /**
   * Collects (a) pending uploads whose per-usage TTL lapsed and that no
   * owner column references, and (b) discarded rows whose storage delete
   * was never confirmed.
   */
  async cleanupStaleAssets(input: CleanupStaleAssetsInput = {}): Promise<CleanupStaleAssetsResult> {
    const now = input.now ?? new Date();
    const limit = coercePositiveInteger(input.limit, 100);
    const overrideHours =
      input.maxAgeHours !== undefined ? coercePositiveInteger(input.maxAgeHours, 24) : null;

    const cutoffs = Object.fromEntries(
      Object.values(MEDIA_USAGE_SPECS).map((spec) => [
        spec.usage,
        new Date(now.getTime() - (overrideHours ?? spec.pendingTtlHours) * 60 * 60 * 1000),
      ]),
    ) as Record<MediaUsage, Date>;

    const deletedImageUrls: string[] = [];
    let deletedCount = 0;

    for (const asset of await this.assetRepo.listStalePendingAssets(cutoffs, limit)) {
      await this.assetRepo.markManagedAssetDiscarded(asset.storagePath, now);
      await this.storage.delete(asset.storagePath);
      await this.assetRepo.markManagedAssetPurged(asset.storagePath, now);
      deletedCount += 1;
      const url = publicUrlFor(asset.storagePath);
      if (url) deletedImageUrls.push(url);
    }

    for (const asset of await this.assetRepo.listDiscardedUnpurged(limit)) {
      await this.storage.delete(asset.storagePath);
      await this.assetRepo.markManagedAssetPurged(asset.storagePath, now);
    }

    const oldestCutoff = new Date(Math.min(...Object.values(cutoffs).map((d) => d.getTime())));
    return { deletedCount, deletedImageUrls, cutoff: oldestCutoff };
  }
}

async function bufferStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function coercePositiveInteger(value: number | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}
