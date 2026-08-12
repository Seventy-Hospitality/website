import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '../../src/lib/session';
import { CreateClubScreen } from '../../src/features/clubs';
import { colors } from '../../src/theme/tokens';

/**
 * The create-club wizard route (Figma create-club 95:4384). Full-screen,
 * outside the tab shell. Anonymous callers are redirected to sign-in.
 */
export default function CreateClubRoute() {
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
      <CreateClubScreen />
    </>
  );
}
