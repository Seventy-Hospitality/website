import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '../../src/lib/session';
import { colors } from '../../src/theme/tokens';

/**
 * Stack for the account sub-screens (billing, preferences, payment-method,
 * change-membership, delete, sign-in-methods). Full-screen, outside the tab
 * shell. The session gate lives here so each route stays a thin screen wrapper;
 * anonymous callers (e.g. a cold deep-link) are redirected to sign-in.
 */
export default function AccountStackLayout() {
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

  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
