/**
 * Flow-local primary button that can render a disabled (muted, non-interactive)
 * state. M0's PrimaryButton has no `disabled` prop, but the checkout ("Confirm
 * membership" until the terms are accepted) and ID ("Submit ID" until a photo
 * exists) steps both need the Figma's disabled affordance. This wraps
 * PrimaryButton so we reuse its exact visuals rather than forking them.
 *
 * NOTE (for the component-library owner): add a `disabled` prop to
 * src/components/PrimaryButton and replace this wrapper.
 */
import { View } from 'react-native';
import { PrimaryButton } from '../../../components/PrimaryButton';

interface GatedButtonProps {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost';
}

export function GatedButton({
  label,
  onPress,
  loading = false,
  disabled = false,
  variant = 'primary',
}: GatedButtonProps) {
  if (disabled) {
    return (
      <View
        // Muted + non-interactive, still announced as a disabled button.
        style={{ opacity: 0.45 }}
        pointerEvents="none"
        accessibilityRole="button"
        accessibilityState={{ disabled: true }}
        accessibilityLabel={label}
      >
        <PrimaryButton label={label} variant={variant} />
      </View>
    );
  }
  return <PrimaryButton label={label} onPress={onPress} loading={loading} variant={variant} />;
}
