import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { api, ApiError } from '../../lib/api';
import { FormField, Input, PrimaryButton, useToast } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { EMPTY_INVITE_SELECTION, type InviteSelection } from '../reserve/invites';
import { StepShell } from '../reserve/StepShell';
import { WizardFrame } from '../reserve/WizardFrame';
import { ClubMemberPicker } from './ClubMemberPicker';
import { useCoverPhoto } from './useCoverPhoto';
import { CLUB_DESCRIPTION_MAX, CLUB_NAME_MAX, canContinueClubDetails } from './clubs-lib';
import { useSession } from '../../lib/session';

/**
 * The 2-step create-club wizard (Figma create-club 95:4384 / invite-players
 * 95:4294): step 1 collects an optional cover photo, the required name, and an
 * optional description; step 2 picks the initial invitees. Create posts the
 * name/description/invitees in one call, then uploads the cover (best effort),
 * and lands on the new club's detail. Mirrors member-web's CreateClubPage.
 */
export function CreateClubScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { memberId } = useSession();

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selection, setSelection] = useState<InviteSelection>(EMPTY_INVITE_SELECTION);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const cover = useCoverPhoto();

  const goToClubs = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/clubs');
  }, [router]);

  const create = useMutation({
    mutationFn: async () => {
      const memberIds = selection.members.map((member) => member.id);
      const created = await api.createClub({
        name: name.trim(),
        description: description.trim() || undefined,
        inviteeMemberIds: memberIds.length > 0 ? memberIds : undefined,
      });
      let coverFailed = false;
      if (cover.image) {
        try {
          await api.uploadClubCover(created.club.id, cover.image);
        } catch {
          coverFailed = true;
        }
      }
      return { created, coverFailed };
    },
    onSuccess: ({ created, coverFailed }) => {
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      const invitedCount = created.invited.length;
      toast({
        variant: 'success',
        message:
          invitedCount > 0
            ? `${created.club.name} created. ${
                invitedCount === 1 ? '1 invite' : `${invitedCount} invites`
              } sent, pending acceptance.`
            : `${created.club.name} created.`,
      });
      if (coverFailed) {
        toast({
          variant: 'error',
          message: 'The cover photo could not be uploaded. You can add it from Edit club.',
        });
      }
      router.replace(`/clubs/${created.club.id}`);
    },
    onError: (error) => {
      setSubmitError(
        error instanceof ApiError && error.status === 422
          ? error.message
          : 'We could not create the club. Try again.',
      );
    },
  });

  const onBack = () => {
    if (create.isPending) return;
    if (step === 2) setStep(1);
    else goToClubs();
  };

  const onClose = () => {
    if (create.isPending) return;
    goToClubs();
  };

  return (
    <WizardFrame
      onBack={onBack}
      onClose={onClose}
      step={step}
      steps={2}
      stepName={step === 1 ? 'Club details' : 'Invite players'}
      chromeDisabled={create.isPending}
    >
      {step === 1 ? (
        <StepShell
          title="Create a club"
          footer={
            <PrimaryButton
              label="Continue"
              variant={canContinueClubDetails(name) ? 'primary' : 'ghost'}
              disabled={!canContinueClubDetails(name)}
              onPress={() => setStep(2)}
            />
          }
        >
          <CoverPhotoField cover={cover} />

          <FormField label="Group name">
            <Input
              placeholder="Enter name"
              value={name}
              onChangeText={setName}
              maxLength={CLUB_NAME_MAX}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="next"
            />
          </FormField>

          <FormField label="Description" hint="Optional">
            <Input
              placeholder="Description"
              value={description}
              onChangeText={setDescription}
              maxLength={CLUB_DESCRIPTION_MAX}
              multiline
              style={styles.textArea}
            />
          </FormField>
        </StepShell>
      ) : (
        <StepShell
          title="Invite players"
          subtitle={`Invited players must accept before they join ${name.trim() || 'your club'}.`}
          footer={
            <PrimaryButton
              label="Create club"
              loading={create.isPending}
              onPress={() => {
                setSubmitError(null);
                create.mutate();
              }}
            />
          }
        >
          <ClubMemberPicker
            selection={selection}
            onSelectionChange={setSelection}
            excludeMemberIds={memberId ? [memberId] : []}
          />
          {submitError ? (
            <Text accessibilityRole="alert" style={styles.formError}>
              {submitError}
            </Text>
          ) : null}
        </StepShell>
      )}
    </WizardFrame>
  );
}

function CoverPhotoField({ cover }: { cover: ReturnType<typeof useCoverPhoto> }) {
  return (
    <View style={styles.coverField}>
      {cover.image ? (
        <View style={styles.coverPreviewWrap}>
          <Image source={cover.image.uri} style={styles.coverPreview} contentFit="cover" />
          <View style={styles.coverButtons}>
            <View style={styles.coverButton}>
              <PrimaryButton label="Change photo" variant="secondary" onPress={cover.choose} />
            </View>
            <View style={styles.coverButton}>
              <PrimaryButton label="Remove" variant="ghost" onPress={cover.clear} />
            </View>
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a cover photo"
          onPress={cover.choose}
          style={({ pressed }) => [styles.coverTile, pressed ? styles.pressed : null]}
        >
          <View style={styles.cameraCircle}>
            <Ionicons name="camera-outline" size={28} color={colors.textMuted} />
          </View>
          <Text style={styles.coverLabel}>Add Cover Photo</Text>
        </Pressable>
      )}
      {cover.error ? (
        <Text accessibilityRole="alert" style={styles.formError}>
          {cover.error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  coverField: {
    gap: spacing.sm,
  },
  coverTile: {
    minHeight: 176,
    borderRadius: radius.lg,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  pressed: {
    opacity: 0.9,
  },
  cameraCircle: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceOverlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverLabel: {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  },
  coverPreviewWrap: {
    gap: spacing.sm,
  },
  coverPreview: {
    width: '100%',
    height: 176,
    borderRadius: radius.lg,
    backgroundColor: colors.backgroundMuted,
  },
  coverButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  coverButton: {
    flex: 1,
  },
  textArea: {
    minHeight: 96,
    paddingTop: spacing.sm,
    textAlignVertical: 'top',
  },
  formError: {
    color: colors.danger,
    fontFamily: fonts.body,
    fontSize: 13,
  },
});
