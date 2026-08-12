import path from 'node:path';
import sharp from 'sharp';
import type { ImageProcessor, UploadImageInput } from '../application';
import { MediaValidationError, type MediaUsageSpec } from '../domain';

const NORMALIZED_MIME_TYPE = 'image/webp';
const NORMALIZED_EXTENSION = '.webp';
const SHARP_MAX_INPUT_PIXELS = 64_000_000;

function toWebpFilename(filename: string, fallbackBase: string): string {
  const parsed = path.parse(filename);
  const base = parsed.name || fallbackBase;
  return `${base}${NORMALIZED_EXTENSION}`;
}

/**
 * Normalizes uploads per usage spec: re-encode to webp at the spec's
 * dimensions/quality (EXIF orientation applied and metadata stripped — for
 * ID photos that includes GPS). Animated GIFs pass through untouched only
 * where the spec allows it (event art); every other usage always
 * re-encodes, which also neutralizes polyglot payloads.
 */
export class SharpImageProcessor implements ImageProcessor {
  async normalize(spec: MediaUsageSpec, input: UploadImageInput): Promise<UploadImageInput> {
    if (input.contentType === 'image/gif' && spec.normalization.passThroughAnimatedGif) {
      await this.assertValidImage(input.bytes, true);
      return input;
    }

    try {
      const bytes = await sharp(input.bytes, {
        animated: false,
        limitInputPixels: SHARP_MAX_INPUT_PIXELS,
      })
        .rotate()
        .resize({
          width: spec.normalization.maxDimensionPx,
          height: spec.normalization.maxDimensionPx,
          fit: spec.normalization.fit,
          withoutEnlargement: spec.normalization.fit === 'inside',
          ...(spec.normalization.fit === 'cover' ? { position: 'centre' as const } : {}),
        })
        .webp({
          quality: spec.normalization.quality,
        })
        .toBuffer();

      return {
        filename: toWebpFilename(input.filename, spec.usage),
        contentType: NORMALIZED_MIME_TYPE,
        bytes,
      };
    } catch (error) {
      throw toMediaValidationError(error);
    }
  }

  private async assertValidImage(bytes: Buffer, animated: boolean) {
    try {
      const metadata = await sharp(bytes, {
        animated,
        limitInputPixels: SHARP_MAX_INPUT_PIXELS,
      }).metadata();

      if (!metadata.width || !metadata.height) {
        throw new MediaValidationError('Image is invalid');
      }
    } catch (error) {
      throw toMediaValidationError(error);
    }
  }
}

function toMediaValidationError(error: unknown): MediaValidationError {
  if (error instanceof MediaValidationError) {
    return error;
  }

  return new MediaValidationError('Image is invalid or could not be processed');
}
