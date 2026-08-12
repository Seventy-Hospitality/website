import { render } from '@testing-library/react-native';
import { Image } from 'expo-image';
import { Avatar } from '../Avatar';
import { EventSpotlightCard } from '../EventSpotlightCard';
import { resolveApiAssetUrl } from '../../lib/api';

// EXPO_PUBLIC_API_URL is unset in tests, so API_URL falls back to the local
// dev origin; that is the base these relative paths resolve against.
function sourceUriOf(tree: ReturnType<typeof render>): string | undefined {
  const img = tree.UNSAFE_getByType(Image);
  const source = img.props.source;
  return typeof source === 'string' ? source : source?.uri;
}

test('resolveApiAssetUrl makes a relative media path absolute and leaves absolute/data urls alone', () => {
  expect(resolveApiAssetUrl('/uploads/event-images/x.jpg')).toMatch(/^https?:\/\/.+\/uploads\/event-images\/x\.jpg$/);
  expect(resolveApiAssetUrl('https://cdn.example.com/y.png')).toBe('https://cdn.example.com/y.png');
  expect(resolveApiAssetUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  expect(resolveApiAssetUrl(null)).toBeNull();
});

test('Avatar resolves a relative image src to an absolute url', () => {
  const tree = render(<Avatar name="Alice Chen" src="/uploads/avatars/a.jpg" />);
  expect(sourceUriOf(tree)).toBe(resolveApiAssetUrl('/uploads/avatars/a.jpg'));
});

test('EventSpotlightCard resolves a relative event image to an absolute url', () => {
  const event = {
    id: 'e1',
    title: 'Match',
    imageUrl: '/uploads/event-images/e.jpg',
    startsAt: '2026-08-14T19:00:00.000Z',
    endsAt: '2026-08-14T22:00:00.000Z',
    timezone: 'America/New_York',
  } as never;
  const tree = render(<EventSpotlightCard event={event} />);
  expect(sourceUriOf(tree)).toBe(resolveApiAssetUrl('/uploads/event-images/e.jpg'));
});
