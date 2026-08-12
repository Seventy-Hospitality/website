import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '../../../src/lib/session';
import { ReservationDetailScreen } from '../../../src/features/reservations/ReservationDetailScreen';
import { colors } from '../../../src/theme/tokens';

/**
 * Reservation detail route (Figma reservation-details 225:3330 / 225:3586 /
 * 159:13854). This is the target M3's booking confirmation and M2's home
 * cards link to. Anonymous callers (e.g. a cold deep-link) are redirected to
 * sign-in; the not-a-participant (404) state is handled inside the screen.
 */
export default function ReservationDetailRoute() {
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
      <Stack.Screen options={{ headerShown: false }} />
      <ReservationDetailScreen reservationId={id} />
    </>
  );
}
