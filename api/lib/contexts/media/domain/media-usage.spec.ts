import {
  MEDIA_USAGE_SPECS,
  buildStoragePath,
  parseAssetPath,
  publicUrlFor,
} from './media-usage';

const NAME = 'ck2qwertyuiopasdfghj.webp';

describe('media path scheme', () => {
  it('public paths always start with /, private paths never do (whole registry)', () => {
    for (const spec of Object.values(MEDIA_USAGE_SPECS)) {
      const path = buildStoragePath(spec, NAME);
      if (spec.visibility === 'public') {
        expect(path.startsWith('/uploads/')).toBe(true);
      } else {
        expect(path.startsWith('/')).toBe(false);
        expect(path.startsWith('private/')).toBe(true);
      }
    }
  });

  it('round-trips build -> parse for every usage', () => {
    for (const spec of Object.values(MEDIA_USAGE_SPECS)) {
      const parsed = parseAssetPath(buildStoragePath(spec, NAME));
      expect(parsed?.spec.usage).toBe(spec.usage);
      expect(parsed?.objectName).toBe(NAME);
    }
  });

  it('refuses a private directory under the public prefix and vice versa', () => {
    expect(parseAssetPath(`/uploads/id-photos/${NAME}`)).toBeNull();
    expect(parseAssetPath(`private/event-images/${NAME}`)).toBeNull();
    expect(parseAssetPath(`private/avatars/${NAME}`)).toBeNull();
  });

  it('refuses traversal, encodings, nesting and unknown directories', () => {
    expect(parseAssetPath('/uploads/event-images/../../etc/passwd')).toBeNull();
    expect(parseAssetPath('/uploads/event-images/..%2Fsecret.webp')).toBeNull();
    expect(parseAssetPath(`/uploads/event-images/nested/${NAME}`)).toBeNull();
    expect(parseAssetPath(`/uploads/unknown/${NAME}`)).toBeNull();
    expect(parseAssetPath('/uploads/event-images/.hidden.webp')).toBeNull();
    expect(parseAssetPath('/uploads/event-images/short.webp')).toBeNull();
    expect(parseAssetPath(`/uploads/event-images/${NAME}%00.png`)).toBeNull();
  });

  it('publicUrlFor yields the path itself for public assets and null for private', () => {
    expect(publicUrlFor(`/uploads/avatars/${NAME}`)).toBe(`/uploads/avatars/${NAME}`);
    expect(publicUrlFor(`private/id-photos/${NAME}`)).toBeNull();
    expect(publicUrlFor('garbage')).toBeNull();
  });
});
