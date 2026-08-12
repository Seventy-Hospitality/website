/**
 * App preferences (Figma app-preferences 107:9789), native. Notification
 * toggles saved optimistically per key with rollback (ported from member-web's
 * AppPreferencesPage), Expo push-device registration wired to the push toggle,
 * plus the Data & privacy / Help & support / About rows and the delete-account
 * entry.
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { api, type NotificationPreferences } from '../../lib/api';
import { PrimaryButton, Skeleton, useToast } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { AccountFrame } from './AccountFrame';
import { preferencesQuery } from './account-data';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { usePushRegistration } from './usePushRegistration';

type PreferenceKey = keyof NotificationPreferences;

const TOGGLES: { key: PreferenceKey; label: string }[] = [
  { key: 'pushNotifications', label: 'Push notifications' },
  { key: 'emailNotifications', label: 'Email notifications' },
  { key: 'bookingReminders', label: 'Booking reminders' },
];

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

export function PreferencesScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const preferences = useQuery(preferencesQuery);
  const push = usePushRegistration();

  // Register this device once when the screen opens with push already enabled.
  const pushBootstrapped = useRef(false);
  useEffect(() => {
    if (!pushBootstrapped.current && preferences.data?.pushNotifications) {
      pushBootstrapped.current = true;
      void push.enable();
    }
  }, [preferences.data?.pushNotifications, push]);

  const update = useMutation({
    mutationKey: ['preferences-update'],
    mutationFn: (patch: Partial<NotificationPreferences>) => api.putPreferences(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: preferencesQuery.queryKey });
      const previous = queryClient.getQueryData<NotificationPreferences>(preferencesQuery.queryKey);
      queryClient.setQueryData<NotificationPreferences>(preferencesQuery.queryKey, (prev) =>
        prev ? { ...prev, ...patch } : prev,
      );
      return { previous };
    },
    onError: (_error, patch, context) => {
      // Roll back ONLY this patch's keys, so a slow save never clobbers another
      // toggle the member flipped while it was in flight.
      const previous = context?.previous;
      if (previous) {
        queryClient.setQueryData<NotificationPreferences>(preferencesQuery.queryKey, (prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          for (const key of Object.keys(patch) as PreferenceKey[]) next[key] = previous[key];
          return next;
        });
      }
      toast({ variant: 'error', message: 'We could not save that setting. Please try again.' });
    },
    onSuccess: (server, patch) => {
      queryClient.setQueryData<NotificationPreferences>(preferencesQuery.queryKey, (prev) => {
        if (!prev) return server;
        const next = { ...prev };
        for (const key of Object.keys(patch) as PreferenceKey[]) next[key] = server[key];
        return next;
      });
    },
    onSettled: () => {
      // Converge once, only when this was the last in-flight toggle.
      if (queryClient.isMutating({ mutationKey: ['preferences-update'] }) === 1) {
        void queryClient.invalidateQueries({ queryKey: preferencesQuery.queryKey });
      }
    },
  });

  const onToggle = (key: PreferenceKey, next: boolean) => {
    update.mutate({ [key]: next });
    if (key === 'pushNotifications') {
      if (next) void push.enable();
      else void push.disable();
    }
  };

  return (
    <AccountFrame title="App preferences" backLabel="Back to account" backTo="/(tabs)/account">
      {/* ── Notifications ── */}
      {preferences.isPending ? (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>Notifications</Text>
          <Skeleton height={168} borderRadius={radius.lg} />
        </View>
      ) : preferences.isError ? (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>Notifications</Text>
          <View style={styles.errorBox} accessibilityRole="alert">
            <Text style={styles.errorText}>We could not load your preferences.</Text>
            <PrimaryButton
              label="Try again"
              variant="secondary"
              onPress={() => void preferences.refetch()}
            />
          </View>
        </View>
      ) : (
        <SettingsGroup label="Notifications">
          {TOGGLES.map(({ key, label }) => (
            <SettingsRow
              key={key}
              label={label}
              trailing={
                <Switch
                  value={preferences.data[key]}
                  onValueChange={(next) => onToggle(key, next)}
                  accessibilityLabel={label}
                  trackColor={{ false: colors.surfaceOverlay, true: colors.accent }}
                  thumbColor={colors.text}
                  ios_backgroundColor={colors.surfaceOverlay}
                />
              }
            />
          ))}
        </SettingsGroup>
      )}

      {/* ── Data & privacy ── */}
      <SettingsGroup label="Data & privacy">
        <SettingsRow label="Privacy policy" comingSoon />
        <SettingsRow
          icon="key-outline"
          label="Sign-in methods"
          onPress={() => router.push('/account/sign-in-methods')}
        />
        <SettingsRow
          label="Delete my account"
          accent
          onPress={() => router.push('/account/delete')}
        />
      </SettingsGroup>

      {/* ── Help & support ── */}
      <SettingsGroup label="Help & support">
        <SettingsRow label="Contact us" comingSoon />
        <SettingsRow label="Rate the app" comingSoon />
      </SettingsGroup>

      {/* ── About ── */}
      <SettingsGroup label="About">
        <SettingsRow label="Version" value={APP_VERSION} />
        <SettingsRow label="Terms of Service" comingSoon />
      </SettingsGroup>
    </AccountFrame>
  );
}

const styles = StyleSheet.create({
  group: {
    gap: spacing.sm,
  },
  groupLabel: {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginLeft: spacing.xs,
  },
  errorBox: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  errorText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 15,
  },
});
