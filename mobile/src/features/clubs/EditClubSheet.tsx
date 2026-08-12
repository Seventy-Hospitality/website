import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { api, type ClubDetail } from '../../lib/api';
import { FormField, Input, PrimaryButton, Sheet, useToast } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { CLUB_DESCRIPTION_MAX, CLUB_NAME_MAX, canContinueClubDetails } from './clubs-lib';
import { useCoverPhoto } from './useCoverPhoto';

/** Sentinel so onError can tell a saved-but-cover-failed run from a hard fail. */
class CoverUploadFailed extends Error {}

interface EditClubSheetProps {
  club: ClubDetail;
  open: boolean;
  onClose: () => void;
}

/**
 * Edit a club (owner-only; Figma edit reuses the create fields). Sends a PATCH
 * with only the changed name/description (and coverImageUrl:null to drop the
 * cover); a NEW cover always rides the multipart endpoint, never the PATCH.
 * Mirrors member-web's EditClubSheet.
 */
export function EditClubSheet({ club, open, onClose }: EditClubSheetProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [name, setName] = useState(club.name);
  const [description, setDescription] = useState(club.description ?? '');
  const [removeCover, setRemoveCover] = useState(false);
  const cover = useCoverPhoto();

  // Re-seed from the current club each time the sheet opens (no stale drafts).
  useEffect(() => {
    if (open) {
      setName(club.name);
      setDescription(club.description ?? '');
      setRemoveCover(false);
      cover.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, club.id]);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const nameChanged = trimmedName !== club.name;
  const descriptionChanged = trimmedDescription !== (club.description ?? '');
  const coverRemoved = removeCover && club.coverImageUrl !== null && cover.image === null;
  const dirty = nameChanged || descriptionChanged || coverRemoved || cover.image !== null;

  const save = useMutation({
    mutationFn: async () => {
      const patch: { name?: string; description?: string | null; coverImageUrl?: null } = {};
      if (nameChanged) patch.name = trimmedName;
      if (descriptionChanged) patch.description = trimmedDescription || null;
      if (coverRemoved) patch.coverImageUrl = null;
      if (Object.keys(patch).length > 0) await api.updateClub(club.id, patch);
      if (cover.image) {
        try {
          await api.uploadClubCover(club.id, cover.image);
        } catch {
          throw new CoverUploadFailed();
        }
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      toast({ variant: 'success', message: 'Club updated.' });
      onClose();
    },
    onError: (error) => {
      if (error instanceof CoverUploadFailed) {
        void queryClient.invalidateQueries({ queryKey: ['clubs'] });
        toast({
          variant: 'error',
          message: 'Your changes were saved, but the cover photo could not be uploaded.',
        });
        onClose();
        return;
      }
      toast({ variant: 'error', message: 'We could not save your changes. Try again.' });
    },
  });

  const showExistingCover = club.coverImageUrl !== null && !removeCover && cover.image === null;
  const previewUri = cover.image?.uri ?? (showExistingCover ? club.coverImageUrl : null);

  const requestClose = () => {
    if (!save.isPending) onClose();
  };

  return (
    <Sheet open={open} onClose={requestClose} title="Edit club">
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.coverField}>
          {previewUri ? (
            <View style={styles.coverPreviewWrap}>
              <Image source={previewUri} style={styles.coverPreview} contentFit="cover" />
              <View style={styles.coverButtons}>
                <View style={styles.coverButton}>
                  <PrimaryButton label="Replace photo" variant="secondary" onPress={cover.choose} />
                </View>
                <View style={styles.coverButton}>
                  <PrimaryButton
                    label="Remove photo"
                    variant="ghost"
                    onPress={() => {
                      cover.clear();
                      setRemoveCover(true);
                    }}
                  />
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
                <Ionicons name="camera-outline" size={26} color={colors.textMuted} />
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

        <FormField label="Group name" error={trimmedName.length === 0 ? 'Enter a club name' : undefined}>
          <Input
            value={name}
            onChangeText={setName}
            maxLength={CLUB_NAME_MAX}
            autoCapitalize="words"
            hasError={trimmedName.length === 0}
          />
        </FormField>

        <FormField label="Description" hint="Optional">
          <Input
            value={description}
            onChangeText={setDescription}
            maxLength={CLUB_DESCRIPTION_MAX}
            multiline
            style={styles.textArea}
          />
        </FormField>

        <View style={styles.actions}>
          <PrimaryButton
            label="Save changes"
            loading={save.isPending}
            disabled={!(dirty && canContinueClubDetails(name))}
            onPress={() => save.mutate()}
          />
          <PrimaryButton label="Cancel" variant="ghost" disabled={save.isPending} onPress={requestClose} />
        </View>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scroll: {
    maxHeight: 520,
  },
  content: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  coverField: {
    gap: spacing.sm,
  },
  coverTile: {
    minHeight: 148,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
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
    width: 52,
    height: 52,
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
    height: 148,
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
    minHeight: 88,
    paddingTop: spacing.sm,
    textAlignVertical: 'top',
  },
  actions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  formError: {
    color: colors.danger,
    fontFamily: fonts.body,
    fontSize: 13,
  },
});
