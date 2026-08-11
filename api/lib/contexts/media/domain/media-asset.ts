import type { MediaUsage, MediaUsageSpec } from './media-usage';

export interface MediaAsset {
  /**
   * The canonical asset key. For public usages it doubles as the browser
   * URL ("/uploads/<dir>/<name>"); for private usages it is a bare
   * "private/<dir>/<name>" key that no route can serve.
   */
  storagePath: string;
  /** Browser URL for public assets; null for private ones. */
  publicUrl: string | null;
  /** Normalized PLAINTEXT content type and size (never the ciphertext's). */
  contentType: string;
  sizeBytes: number;
  originalFilename: string;
}

export const MEDIA_ASSET_STATUS_PENDING = 'pending';
export const MEDIA_ASSET_STATUS_ATTACHED = 'attached';
export const MEDIA_ASSET_STATUS_DISCARDED = 'discarded';

export interface ManagedMediaAsset extends MediaAsset {
  usage: MediaUsage;
  status:
    | typeof MEDIA_ASSET_STATUS_PENDING
    | typeof MEDIA_ASSET_STATUS_ATTACHED
    | typeof MEDIA_ASSET_STATUS_DISCARDED;
  /** Encryption scheme of the stored object (null = plaintext). */
  encryption: string | null;
  ownerType: string | null;
  ownerId: string | null;
  createdAt: Date;
  attachedAt: Date | null;
  discardedAt: Date | null;
  /** Set once the object is confirmed gone from storage (retention proof). */
  purgedAt: Date | null;
}

export const mediaInvariants = {
  validateContentType(spec: MediaUsageSpec, contentType: string): void {
    if (!spec.acceptedMimeTypes.includes(contentType)) {
      throw new MediaValidationError(spec.invalidTypeMessage);
    }
  },

  validateSize(spec: MediaUsageSpec, sizeBytes: number): void {
    if (sizeBytes <= 0) {
      throw new MediaValidationError('Image upload is empty');
    }
    if (sizeBytes > spec.maxUploadBytes) {
      throw new MediaValidationError(spec.tooLargeMessage);
    }
  },
};

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}
