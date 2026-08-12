import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import { colors, radius } from '../../theme/tokens';

/** Amenity code -> Ionicons glyph. Falls back to a calendar for the unknown. */
const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  badminton_court: 'tennisball-outline',
  tennis_court: 'tennisball-outline',
  tennis_simulator: 'golf-outline',
  mahjong_table: 'grid-outline',
  shower: 'water-outline',
};

export function resourceTypeGlyph(code: string): keyof typeof Ionicons.glyphMap {
  return ICONS[code] ?? 'calendar-outline';
}

/** The bare glyph, for composing inside a caller-provided tile. */
export function ResourceTypeIcon({ code, size = 22 }: { code: string; size?: number }) {
  return <Ionicons name={resourceTypeGlyph(code)} size={size} color={colors.accent} />;
}

/** Tinted square tile wrapping the amenity glyph (browse row + cards). */
export function ResourceTypeTile({ code, size = 46 }: { code: string; size?: number }) {
  return (
    <View style={[styles.tile, { width: size, height: size }]}>
      <ResourceTypeIcon code={code} size={Math.round(size * 0.48)} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceOverlay,
  },
});
