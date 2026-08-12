import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '../../src/lib/session';
import { JoinClubScreen } from '../../src/features/clubs';
import { colors } from '../../src/theme/tokens';

/**
 * Join-via-invite-link route (`/clubs/join?token=...`), the target the shared
 * invite URL / QR resolves to. Anonymous callers are redirected to sign-in
 * (joining requires a member); invalid/expired/revoked links (410) are handled
 * inside the screen.
 */
export default function JoinClubRoute() {
  const { token } = useLocalSearchParams<{ token?: string }>();
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
      <JoinClubScreen token={typeof token === 'string' ? token : null} />
    </>
  );
}
