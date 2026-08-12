import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius, spacing } from '../theme/tokens';

interface EmptyStateViewProps {
  title: string;
  description: string;
}

export function EmptyStateView({ description, title }: EmptyStateViewProps) {
  return (
    <View style={styles.container}>
      <View style={styles.glyph}>
        <View style={styles.glyphStem} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.description}>{description}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  glyph: {
    width: 46,
    height: 46,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: 'rgba(229, 240, 164, 0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphStem: {
    width: 2,
    height: 52,
    backgroundColor: 'rgba(229, 240, 164, 0.2)',
    position: 'absolute',
    bottom: -28,
    transform: [{ rotate: '30deg' }],
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 16,
  },
  description: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 240,
    lineHeight: 18,
  },
});
