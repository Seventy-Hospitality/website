import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { formatSlotRange } from './booking';

interface SlotPillProps {
  /** Wall-clock "HH:MM" start label. */
  slot: string;
  slotDurationMinutes: number;
  selected: boolean;
  onToggle: () => void;
}

/**
 * One bookable 30-minute slot as an accessible toggle (Figma select-time
 * 286:8257). Only bookable slots are rendered, so there is no disabled
 * state. Exposed for M4's reschedule wizard to reuse the same cell.
 */
export function SlotPill({ slot, slotDurationMinutes, selected, onToggle }: SlotPillProps) {
  const label = formatSlotRange(slot, slotDurationMinutes);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      onPress={onToggle}
      style={({ pressed }) => [
        styles.pill,
        selected ? styles.pillSelected : null,
        pressed ? styles.pillPressed : null,
      ]}
    >
      <Text style={[styles.label, selected ? styles.labelSelected : null]}>{label}</Text>
      <View style={[styles.check, selected ? styles.checkSelected : null]}>
        {selected ? <Ionicons name="checkmark" size={15} color={colors.textOnAccent} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pillSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.surfaceOverlay,
  },
  pillPressed: {
    opacity: 0.9,
  },
  label: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
  },
  labelSelected: {
    color: colors.text,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  checkSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
});
