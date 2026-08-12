import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { resolveApiAssetUrl, type MyClub } from '../../lib/api';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { memberCountLabel, roleLabel } from './clubs-lib';

/**
 * A club card on the clubs tab (Figma your-clubs 91:3774): the cover image
 * (or a people-icon fallback) with the club name and "N Members · Role" meta
 * overlaid on a bottom shade. The whole card is a link into the club detail.
 */
export function ClubCard({ club, onPress }: { club: MyClub; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${club.name}: ${memberCountLabel(club.memberCount)}, you are ${
        club.myRole === 'owner' ? 'the owner' : 'a member'
      }`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      {club.coverImageUrl ? (
        <Image source={resolveApiAssetUrl(club.coverImageUrl) as string} style={styles.cover} contentFit="cover" />
      ) : (
        <View style={[styles.cover, styles.coverFallback]}>
          <Ionicons name="people" size={44} color={colors.surfaceMuted} />
        </View>
      )}
      <View style={styles.shade} />
      <View style={styles.overlay}>
        <Text style={styles.name} numberOfLines={1}>
          {club.name}
        </Text>
        <Text style={styles.meta}>
          {memberCountLabel(club.memberCount)}
          <Text style={styles.metaSep}>{'   ·   '}</Text>
          {roleLabel(club.myRole)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    height: 176,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    justifyContent: 'flex-end',
  },
  pressed: {
    opacity: 0.92,
  },
  cover: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  coverFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceOverlay,
  },
  shade: {
    ...StyleSheet.absoluteFillObject,
    top: '45%',
    backgroundColor: 'rgba(12, 18, 13, 0.55)',
  },
  overlay: {
    padding: spacing.md,
    gap: 2,
  },
  name: {
    color: colors.text,
    fontFamily: fonts.displayHeavy,
    fontSize: 24,
  },
  meta: {
    color: colors.text,
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
  },
  metaSep: {
    color: colors.textMuted,
  },
});
