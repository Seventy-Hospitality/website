import { StyleSheet, View } from 'react-native';
import BaseQRCode from 'react-native-qrcode-svg';
import { radius, spacing } from '../theme/tokens';

interface QRCodeProps {
  /** The encoded payload (member QR token, club invite URL, ...). */
  value: string;
  size?: number;
  /** Dark module color. Kept high-contrast for scannability. */
  color?: string;
  backgroundColor?: string;
}

/**
 * QR primitive wrapping react-native-qrcode-svg with a padded quiet zone so
 * codes stay scannable on the dark theme (used by the member card sheet and
 * club invite QR). Colors default to dark-on-white for reliable scanning.
 */
export function QRCode({ value, size = 200, color = '#0d130f', backgroundColor = '#ffffff' }: QRCodeProps) {
  return (
    <View style={[styles.frame, { backgroundColor }]}>
      <BaseQRCode value={value} size={size} color={color} backgroundColor={backgroundColor} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    padding: spacing.md,
    borderRadius: radius.lg,
    alignSelf: 'center',
  },
});
