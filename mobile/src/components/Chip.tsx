import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius, spacing } from '../theme/tokens';

interface ChipProps {
  label: string;
  /** Optional leading content (e.g. a small Avatar for invite chips). */
  leading?: ReactNode;
  /** When set, renders a labelled remove button. */
  onRemove?: () => void;
}

/** Compact removable token, e.g. selected players on a booking invite. */
export function Chip({ label, leading, onRemove }: ChipProps) {
  return (
    <View style={styles.chip}>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label}`}
          onPress={onRemove}
          hitSlop={8}
          style={styles.remove}
        >
          <Ionicons name="close" size={14} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.border,
  },
  leading: {
    marginLeft: -4,
  },
  label: {
    color: colors.text,
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    maxWidth: 180,
  },
  remove: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
