/**
 * Inline display-name editor for the account header (M6). Ported from
 * member-web's DisplayNameForm: a labelled text field that PATCHes the profile,
 * patches the ['profile'] and ['home'] caches on success, and clears back to
 * the "First Last" fallback when left blank.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type HomeFeed, type HomeMember, type MyProfile } from '../../lib/api';
import { FormField, Input, PrimaryButton } from '../../components';
import { colors, spacing } from '../../theme/tokens';

interface DisplayNameEditorProps {
  member: HomeMember;
  onDone: () => void;
}

export function DisplayNameEditor({ member, onDone }: DisplayNameEditorProps) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(member.displayName ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (displayName: string | null) => api.updateProfile({ displayName }),
    onSuccess: ({ member: updated }) => {
      queryClient.setQueryData<MyProfile>(['profile'], (prev) =>
        prev ? { ...prev, member: updated } : prev,
      );
      queryClient.setQueryData<HomeFeed>(['home'], (prev) =>
        prev ? { ...prev, member: updated } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      onDone();
    },
    onError: (err) => {
      setError(
        err instanceof ApiError && err.status === 422
          ? err.message
          : 'We could not save your name. Please try again.',
      );
    },
  });

  const submit = () => {
    if (save.isPending) return;
    const trimmed = value.trim();
    const next = trimmed || null;
    if (next === (member.displayName ?? null)) {
      onDone();
      return;
    }
    setError(null);
    save.mutate(next);
  };

  return (
    <View style={styles.form}>
      <FormField
        label="Display name"
        error={error ?? undefined}
        hint={`Leave blank to use ${member.firstName} ${member.lastName}.`}
      >
        <Input
          value={value}
          onChangeText={(text) => {
            setValue(text);
            if (error) setError(null);
          }}
          placeholder={`${member.firstName} ${member.lastName}`}
          autoFocus
          maxLength={60}
          autoCapitalize="words"
          returnKeyType="done"
          onSubmitEditing={submit}
          hasError={Boolean(error)}
          accessibilityLabel="Display name"
        />
      </FormField>
      <View style={styles.actions}>
        <PrimaryButton label="Save" loading={save.isPending} onPress={submit} />
        <PrimaryButton
          label="Cancel"
          variant="ghost"
          disabled={save.isPending}
          onPress={onDone}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: {
    alignSelf: 'stretch',
    gap: spacing.md,
    backgroundColor: colors.bgElevated,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  actions: {
    gap: spacing.sm,
  },
});
