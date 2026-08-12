import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '../../../src/lib/session';
import { RescheduleWizardScreen } from '../../../src/features/reservations/RescheduleWizardScreen';
import { colors } from '../../../src/theme/tokens';

/**
 * Edit / reschedule route (Figma "Editing reservation" 152:12072). Full-screen,
 * outside the tab shell. Anonymous callers are redirected to sign-in; the
 * organizer / confirmed / not-started gates live inside the screen so a guest
 * or a stale link gets an explanation, not a raw error.
 */
export default function EditReservationRoute() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
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
      <RescheduleWizardScreen reservationId={id} />
    </>
  );
}
