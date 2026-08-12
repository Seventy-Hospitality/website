import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '../../src/lib/session';
import { BookingWizardScreen } from '../../src/features/reserve/BookingWizardScreen';
import { colors } from '../../src/theme/tokens';

/**
 * The booking wizard route (Figma "Booking badminton court" 26:630).
 * Full-screen, outside the tab shell. Anonymous callers (e.g. a cold
 * deep-link) are redirected to sign-in; the active-member gate lives inside
 * the wizard so a lapsed member gets an explanation, not a raw 403.
 */
export default function ReserveWizardRoute() {
  const { status } = useSession();

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (status === 'anonymous') {
    return <Redirect href="/auth/sign-in" />;
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false, animation: 'slide_from_bottom' }} />
      <BookingWizardScreen />
    </>
  );
}
