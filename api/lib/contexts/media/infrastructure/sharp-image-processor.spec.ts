import sharp from 'sharp';
import { MEDIA_USAGE_SPECS } from '../domain';
import { SharpImageProcessor } from './sharp-image-processor';

function makePngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 220, g: 80, b: 80 },
    },
  }).png().toBuffer();
}

describe('SharpImageProcessor', () => {
  it('normalizes event images to webp within 1600px (byte-identical to the historical behavior)', async () => {
    const processor = new SharpImageProcessor();
    const input = {
      filename: 'poster.png',
      contentType: 'image/png',
      bytes: await makePngBuffer(2400, 1200),
    };

    const result = await processor.normalize(MEDIA_USAGE_SPECS['event-image'], input);
    const metadata = await sharp(result.bytes).metadata();

    expect(result.contentType).toBe('image/webp');
    expect(result.filename).toBe('poster.webp');
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(1600);
    expect(metadata.height).toBe(800);
  });

  it('square-crops avatars to 512px cover', async () => {
    const processor = new SharpImageProcessor();
    const result = await processor.normalize(MEDIA_USAGE_SPECS.avatar, {
      filename: 'me.png',
      contentType: 'image/png',
      bytes: await makePngBuffer(2400, 1200),
    });
    const metadata = await sharp(result.bytes).metadata();

    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
    expect(result.contentType).toBe('image/webp');
  });

  it('re-encodes ID photos (metadata stripped) within 2000px', async () => {
    const processor = new SharpImageProcessor();
    const withExif = await sharp(await makePngBuffer(2600, 1300))
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'sensitive' } } })
      .toBuffer();

    const result = await processor.normalize(MEDIA_USAGE_SPECS['id-photo'], {
      filename: 'passport.jpg',
      contentType: 'image/jpeg',
      bytes: withExif,
    });
    const metadata = await sharp(result.bytes).metadata();

    expect(result.contentType).toBe('image/webp');
    expect(metadata.width).toBe(2000);
    expect(metadata.exif).toBeUndefined();
  });

  it('passes gif uploads through only for the usage that allows it', async () => {
    const processor = new SharpImageProcessor();
    const gifBytes = Buffer.from(
      '47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b',
      'hex',
    );

    const result = await processor.normalize(MEDIA_USAGE_SPECS['event-image'], {
      filename: 'loop.gif',
      contentType: 'image/gif',
      bytes: gifBytes,
    });

    expect(result).toEqual({
      filename: 'loop.gif',
      contentType: 'image/gif',
      bytes: gifBytes,
    });
  });

  it('rejects invalid image bytes', async () => {
    const processor = new SharpImageProcessor();

    await expect(processor.normalize(MEDIA_USAGE_SPECS['event-image'], {
      filename: 'bad.png',
      contentType: 'image/png',
      bytes: Buffer.from('not-an-image'),
    })).rejects.toThrow('could not be processed');
  });
});
