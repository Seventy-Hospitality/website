import { StyleSheet, Text, View } from 'react-native';
import { AppScreen } from '../../components/AppScreen';
import { SectionCard } from '../../components/SectionCard';
import { PrimaryButton } from '../../components/PrimaryButton';
import { Badge } from '../../components/Badge';
import { useToast } from '../../components/toast-context';
import { useSession } from '../../lib/session';
import { colors, spacing, typography } from '../../theme/tokens';

export function AccountScreen() {
  const { principal, emailVerified, needsOnboarding, signOut } = useSession();
  const { toast } = useToast();

  return (
    <AppScreen>
      <View style={styles.header}>
        <Text style={styles.title}>Account</Text>
        <Text style={styles.subtitle}>Manage your membership and preferences</Text>
      </View>

      <SectionCard title="Signed in">
        <Text style={styles.email}>{principal?.email ?? 'Unknown'}</Text>
        <View style={styles.badgeRow}>
          <Badge
            label={emailVerified ? 'Email verified' : 'Email unverified'}
            variant={emailVerified ? 'success' : 'warning'}
          />
          {needsOnboarding ? <Badge label="Onboarding pending" variant="accent" /> : null}
          {principal?.memberId ? <Badge label="Member" variant="neutral" /> : null}
        </View>
      </SectionCard>

      <SectionCard title="Coming soon" action={<Badge label="M6 package" variant="accent" />}>
        <Text style={styles.body}>
          Profile + avatar, lifetime stats, the member QR card, notification preferences, push
          registration, billing history, payment methods, membership change/cancel, account
          deletion, and Google/Apple linking arrive with the M6 package.
        </Text>
      </SectionCard>

      <PrimaryButton
        label="Sign Out"
        variant="ghost"
        onPress={() => {
          void signOut().catch(() => toast({ variant: 'error', message: 'Unable to sign out' }));
        }}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.xs,
  },
  title: {
    ...typography.h1,
    color: colors.text,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
  },
  email: {
    ...typography.bodyStrong,
    color: colors.text,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
});
