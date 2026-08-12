import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '../../../src/lib/session';
import { ClubDetailScreen } from '../../../src/features/clubs';
import { colors } from '../../../src/theme/tokens';

/**
 * Club detail route (Figma club-detail 99:5623). The target the clubs tab, the
 * create wizard, and a join both land on. Anonymous callers (e.g. a cold
 * deep-link) are redirected to sign-in; the not-a-member (404) state is handled
 * inside the screen.
 */
export default function ClubDetailRoute() {
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
      <ClubDetailScreen clubId={id} />
    </>
  );
}
