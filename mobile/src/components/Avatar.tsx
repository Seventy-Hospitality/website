import { useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { resolveApiAssetUrl } from '../lib/api';
import { colors, fonts } from '../theme/tokens';

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

interface AvatarProps {
  /** Full name; drives the initials fallback. */
  name: string;
  src?: string | null;
  size?: AvatarSize;
  style?: StyleProp<ViewStyle>;
}

const DIMENSIONS: Record<AvatarSize, { box: number; font: number }> = {
  sm: { box: 32, font: 13 },
  md: { box: 44, font: 16 },
  lg: { box: 64, font: 22 },
  xl: { box: 96, font: 32 },
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Circular avatar with an initials fallback when there is no image. */
export function Avatar({ name, src, size = 'md', style }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const { box, font } = DIMENSIONS[size];
  // Backend media URLs can be relative; RN needs an absolute URL to load them.
  const resolvedSrc = resolveApiAssetUrl(src ?? null);
  const showImage = Boolean(resolvedSrc) && !failed;

  return (
    <View
      accessibilityLabel={name}
      style={[styles.avatar, { width: box, height: box, borderRadius: box / 2 }, style]}
    >
      {showImage ? (
        <Image
          source={resolvedSrc as string}
          style={{ width: box, height: box }}
          contentFit="cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Text style={[styles.initials, { fontSize: font }]}>{initialsOf(name)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.border,
  },
  initials: {
    color: colors.text,
    fontFamily: fonts.displayBold,
  },
});
