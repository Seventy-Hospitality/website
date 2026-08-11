import path from 'node:path';

// ── Usage registry ──
// Every image the API manages belongs to exactly one usage; the spec drives
// validation, normalization, storage layout, caching and encryption, so a
// new kind of image is one registry entry (the compiler then forces the
// owner-reference lookup in the repository via `satisfies Record<MediaUsage>`
// before the cleanup sweeper will accept it).

export const MEDIA_USAGES = ['event-image', 'avatar', 'id-photo'] as const;
export type MediaUsage = (typeof MEDIA_USAGES)[number];
export type MediaVisibility = 'public' | 'private';

export interface MediaUsageSpec {
  usage: MediaUsage;
  /** Storage directory segment (also the URL segment for public usages). */
  directory: string;
  visibility: MediaVisibility;
  acceptedMimeTypes: readonly string[];
  maxUploadBytes: number;
  normalization: {
    maxDimensionPx: number;
    fit: 'inside' | 'cover';
    quality: number;
    /** GIFs skip re-encoding (animation survives); only sane for public art. */
    passThroughAnimatedGif: boolean;
  };
  cacheControl: string;
  encryptAtRest: boolean;
  /** How long an un-attached upload may sit before the sweeper collects it. */
  pendingTtlHours: number;
  invalidTypeMessage: string;
  tooLargeMessage: string;
}

export const MEDIA_USAGE_SPECS: Record<MediaUsage, MediaUsageSpec> = {
  'event-image': {
    usage: 'event-image',
    directory: 'event-images',
    visibility: 'public',
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    maxUploadBytes: 5 * 1024 * 1024,
    normalization: { maxDimensionPx: 1600, fit: 'inside', quality: 82, passThroughAnimatedGif: true },
    cacheControl: 'public, max-age=31536000, immutable',
    encryptAtRest: false,
    pendingTtlHours: 24,
    invalidTypeMessage: 'Event images must be JPG, PNG, WebP, or GIF files',
    tooLargeMessage: 'Event images must be 5 MB or smaller',
  },
  avatar: {
    usage: 'avatar',
    directory: 'avatars',
    // No GIF: the animated pass-through would skip the square crop entirely.
    visibility: 'public',
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxUploadBytes: 5 * 1024 * 1024,
    normalization: { maxDimensionPx: 512, fit: 'cover', quality: 82, passThroughAnimatedGif: false },
    cacheControl: 'public, max-age=31536000, immutable',
    encryptAtRest: false,
    pendingTtlHours: 24,
    invalidTypeMessage: 'Avatars must be JPG, PNG, or WebP files',
    tooLargeMessage: 'Avatars must be 5 MB or smaller',
  },
  'id-photo': {
    usage: 'id-photo',
    directory: 'id-photos',
    visibility: 'private',
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxUploadBytes: 10 * 1024 * 1024,
    // Always re-encoded (strips EXIF/GPS, neutralizes polyglots); generous
    // dimensions and quality so staff can read the small print.
    normalization: { maxDimensionPx: 2000, fit: 'inside', quality: 90, passThroughAnimatedGif: false },
    cacheControl: 'no-store',
    encryptAtRest: true,
    pendingTtlHours: 24,
    invalidTypeMessage: 'ID photos must be JPG, PNG, or WebP files',
    tooLargeMessage: 'ID photos must be 10 MB or smaller',
  },
};

// ── Path scheme ──
// Public assets live at "/uploads/<directory>/<objectName>" — the storage
// path IS the browser URL. Private assets live at
// "private/<directory>/<objectName>" — deliberately WITHOUT a leading
// slash, so a private path can never match a Fastify route, be used as an
// <img src>, or be produced by concatenation onto the public prefix.

const UPLOADS_PUBLIC_PREFIX = '/uploads';
const PRIVATE_PREFIX = 'private';

/** cuid + image extension; excludes traversal, encodings, dotfiles, nesting. */
const OBJECT_NAME_PATTERN = /^[a-z0-9]{20,32}\.(jpg|jpeg|png|webp|gif)$/i;

export function buildStoragePath(spec: MediaUsageSpec, objectName: string): string {
  return spec.visibility === 'public'
    ? `${UPLOADS_PUBLIC_PREFIX}/${spec.directory}/${objectName}`
    : `${PRIVATE_PREFIX}/${spec.directory}/${objectName}`;
}

export interface ParsedAssetPath {
  spec: MediaUsageSpec;
  objectName: string;
}

/**
 * Whitelist parse of a storage path. Null unless: the prefix form agrees
 * with the usage's declared visibility, the directory is an exact registry
 * match, and the object name is a bare cuid+extension.
 */
export function parseAssetPath(storagePath: string): ParsedAssetPath | null {
  for (const spec of Object.values(MEDIA_USAGE_SPECS)) {
    const prefix =
      spec.visibility === 'public'
        ? `${UPLOADS_PUBLIC_PREFIX}/${spec.directory}/`
        : `${PRIVATE_PREFIX}/${spec.directory}/`;
    if (!storagePath.startsWith(prefix)) continue;
    const objectName = storagePath.slice(prefix.length);
    if (!OBJECT_NAME_PATTERN.test(objectName)) return null;
    return { spec, objectName };
  }
  return null;
}

/** The browser URL for a public asset; null for private ones. */
export function publicUrlFor(storagePath: string): string | null {
  const parsed = parseAssetPath(storagePath);
  if (!parsed || parsed.spec.visibility !== 'public') return null;
  return storagePath;
}

// ── Extensions ──

const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function extensionForContentType(contentType: string): string | null {
  return MIME_TYPE_EXTENSIONS[contentType] ?? null;
}

export function contentTypeForObjectName(objectName: string): string {
  return EXTENSION_CONTENT_TYPES[path.posix.extname(objectName).toLowerCase()] ?? 'application/octet-stream';
}
