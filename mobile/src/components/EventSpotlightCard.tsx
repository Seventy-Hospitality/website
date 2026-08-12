import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { ClubEvent } from '../lib/api';
import { formatEventWindow } from '../lib/format';
import { colors, fonts, radius, shadows, spacing } from '../theme/tokens';

interface EventSpotlightCardProps {
  event: ClubEvent;
  onPress?: () => void;
  compact?: boolean;
}

export function EventSpotlightCard({ compact = false, event, onPress }: EventSpotlightCardProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        compact ? styles.compactCard : null,
        pressed ? styles.cardPressed : null,
      ]}
    >
      {event.imageUrl ? (
        <Image source={event.imageUrl} style={[styles.image, compact ? styles.compactImage : null]} contentFit="cover" />
      ) : (
        <View style={[styles.imageFallback, compact ? styles.compactImage : null]}>
          <Text style={styles.imageFallbackText}>Spotlight</Text>
        </View>
      )}
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={2}>
          {event.title}
        </Text>
        <Text style={styles.schedule}>{formatEventWindow(event.startsAt, event.endsAt)}</Text>
        {event.details ? (
          <Text style={styles.details} numberOfLines={compact ? 2 : 3}>
            {event.details}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 284,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.soft,
  },
  compactCard: {
    width: '100%',
  },
  cardPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.99 }],
  },
  image: {
    height: 160,
    width: '100%',
  },
  compactImage: {
    height: 132,
  },
  imageFallback: {
    height: 160,
    width: '100%',
    backgroundColor: colors.backgroundMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageFallbackText: {
    color: colors.accent,
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  copy: {
    padding: spacing.md,
    gap: spacing.xs,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 18,
  },
  schedule: {
    color: colors.accentMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
  },
  details: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
  },
});
