/**
 * Onboarding step 3 (Figma onboarding/verify-identity 26:1037 / 40:490): the
 * government-ID capture, the last onboarding step. Native mirror of member-web
 * VerifyIdentityPage, translated from a drag-drop file zone to an
 * expo-image-picker camera/library capture.
 *
 * The photo rides the authenticated /api/me/id-verification endpoints into
 * PRIVATE encrypted storage (never a public upload path), and the API never
 * returns it, so the preview shown here is the locally captured image; a
 * resumed session that already uploaded shows a neutral tile.
 *
 * Leaving (Close or "Skip for now") records a skip: the step may only be left
 * answered, so the resume gate never bounces straight back into it.
 */
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { api, ApiError, type IdVerificationView } from '../../lib/api';
import { useToast } from '../../components/toast-context';
import { PrimaryButton } from '../../components/PrimaryButton';
import { Skeleton } from '../../components/Skeleton';
import { colors, radius, spacing, typography } from '../../theme/tokens';
import { GatedButton } from './components/GatedButton';
import { idVerificationQuery } from './queries';

export function VerifyIdentityScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const status = useQuery(idVerificationQuery);
  const view = status.data ?? null;

  const [localPhotoUri, setLocalPhotoUri] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const applyView = (next: IdVerificationView) => {
    queryClient.setQueryData(idVerificationQuery.queryKey, next);
  };

  /** After the ID step is answered, the resume read is stale: drop it so a
      later gate evaluation resolves 'done' rather than back to 'identity'. */
  const invalidateResume = () => {
    void queryClient.invalidateQueries({ queryKey: ['onboarding'], refetchType: 'none' });
    void queryClient.invalidateQueries({ queryKey: idVerificationQuery.queryKey, refetchType: 'none' });
  };

  const goHome = () => router.replace('/(tabs)');

  const upload = useMutation({
    mutationFn: api.uploadIdPhoto,
    onSuccess: (next, photo) => {
      applyView(next);
      setLocalPhotoUri(photo.uri);
      setUploadError(null);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ID_VERIFICATION_STATE') {
        void status.refetch();
        return;
      }
      setUploadError(
        error instanceof ApiError && error.code !== 'UNKNOWN'
          ? error.message
          : 'We could not upload the photo. Please try again.',
      );
    },
  });

  const submit = useMutation({
    mutationFn: api.submitIdVerification,
    onSuccess: (next) => {
      applyView(next);
      invalidateResume();
      toast({ variant: 'success', message: 'ID submitted for review.' });
      goHome();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ID_VERIFICATION_STATE') {
        void status.refetch();
        return;
      }
      toast({ variant: 'error', message: 'Could not submit your ID. Please try again.' });
    },
  });

  const skip = useMutation({
    mutationFn: api.skipIdVerification,
    onSuccess: (next) => {
      applyView(next);
      invalidateResume();
      goHome();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ID_VERIFICATION_STATE') {
        // The step no longer applies (submitted elsewhere): refresh and leave.
        void status.refetch();
        invalidateResume();
        goHome();
        return;
      }
      toast({ variant: 'error', message: 'Could not skip right now. Please try again.' });
    },
  });

  const answered = view !== null && view.status !== 'not_submitted';
  const canUpload = view !== null && !answered;
  const busy = upload.isPending || submit.isPending || skip.isPending;

  function leave() {
    if (busy) return;
    // Closing is an answer too: record the skip so the resume gate does not
    // bounce straight back into this step.
    if (canUpload) skip.mutate();
    else goHome();
  }

  async function pickFrom(source: 'camera' | 'library') {
    try {
      const permission =
        source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setUploadError(
          source === 'camera'
            ? 'Camera access is needed to take a photo of your ID.'
            : 'Photo library access is needed to choose an ID photo.',
        );
        return;
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({
              mediaTypes: ['images'],
              allowsEditing: true,
              quality: 0.8,
            })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              allowsEditing: true,
              quality: 0.8,
            });

      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      const name = asset.fileName ?? asset.uri.split('/').pop() ?? 'id-photo.jpg';
      const type = asset.mimeType ?? 'image/jpeg';
      setUploadError(null);
      upload.mutate({ uri: asset.uri, name, type });
    } catch {
      setUploadError('We could not open the camera. Please try again.');
    }
  }

  function chooseSource() {
    if (upload.isPending) return;
    Alert.alert('Add a photo of your ID', undefined, [
      { text: 'Take photo', onPress: () => void pickFrom('camera') },
      { text: 'Choose from library', onPress: () => void pickFrom('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable accessibilityRole="button" onPress={leave} hitSlop={8} disabled={busy}>
          <Text style={styles.close}>Close</Text>
        </Pressable>
        <Text style={styles.topTitle}>Verify Identity</Text>
        <View style={styles.topSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.welcome}>Welcome to Club70</Text>
        <Text style={styles.intro}>
          One last thing to get you set up: submit a photo of your government-issued ID. Our staff
          will use it to verify your identity upon first visit.
        </Text>

        {status.isPending && <Skeleton height={208} borderRadius={radius.lg} />}

        {status.isError && (
          <View style={styles.errorBox} accessibilityRole="alert">
            <Text style={styles.errorText}>We could not load your verification status.</Text>
            <PrimaryButton label="Try again" variant="ghost" onPress={() => void status.refetch()} />
          </View>
        )}

        {view !== null && answered && <AnsweredPanel view={view} />}

        {view !== null && !answered && (
          <>
            {view.hasPhoto && !upload.isPending ? (
              <View style={styles.previewZone}>
                {localPhotoUri ? (
                  <Image
                    style={styles.preview}
                    source={{ uri: localPhotoUri }}
                    contentFit="cover"
                    accessibilityLabel="Preview of your ID photo"
                  />
                ) : (
                  <View style={styles.previewFallback}>
                    <Ionicons name="image-outline" size={40} color={colors.textMuted} />
                    <Text style={styles.previewFallbackText}>ID photo on file</Text>
                  </View>
                )}
                <PrimaryButton label="Replace photo" variant="ghost" onPress={chooseSource} />
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Take or upload a photo of your ID"
                accessibilityState={{ busy: upload.isPending }}
                onPress={chooseSource}
                disabled={upload.isPending}
                style={styles.uploadZone}
              >
                <View style={styles.cameraCircle}>
                  <Ionicons name="camera-outline" size={30} color={colors.textMuted} />
                </View>
                <Text style={styles.uploadLabel}>
                  {upload.isPending ? 'Uploading photo…' : 'Take or upload a photo of your ID'}
                </Text>
              </Pressable>
            )}

            {uploadError && (
              <Text style={styles.uploadError} accessibilityRole="alert">
                {uploadError}
              </Text>
            )}

            <View style={styles.tips}>
              <Tip text="Ensure the text is clear and readable" />
              <Tip text="Avoid glare or shadows on the document" />
            </View>
          </>
        )}
      </ScrollView>

      <View style={styles.footer}>
        {answered ? (
          <PrimaryButton label="Continue" onPress={goHome} />
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => skip.mutate()}
            >
              <Text style={styles.skipLink}>Skip for now</Text>
            </Pressable>
            <GatedButton
              label="Submit ID"
              loading={submit.isPending}
              disabled={!view?.hasPhoto || skip.isPending}
              onPress={() => submit.mutate()}
            />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function Tip({ text }: { text: string }) {
  return (
    <View style={styles.tip}>
      <Ionicons name="checkmark-circle" size={18} color={colors.success} />
      <Text style={styles.tipText}>{text}</Text>
    </View>
  );
}

/** Submitted / verified / rejected: status instead of the upload zone. */
function AnsweredPanel({ view }: { view: IdVerificationView }) {
  const copy =
    view.status === 'verified'
      ? { title: 'Your ID is verified', body: 'You are all set; nothing more to do here.' }
      : view.status === 'rejected'
        ? {
            title: 'Your ID needs another look',
            body:
              view.note ??
              'Our staff could not verify your ID. You can submit a new photo from your account.',
          }
        : {
            title: 'Your ID is under review',
            body: 'Our staff will verify it shortly. You can start using Club70 in the meantime.',
          };

  return (
    <View style={styles.statusPanel} accessibilityRole="summary">
      <View style={styles.statusIcon}>
        <Ionicons name="shield-checkmark-outline" size={30} color={colors.accent} />
      </View>
      <Text style={styles.statusTitle}>{copy.title}</Text>
      <Text style={styles.statusBody}>{copy.body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  close: {
    ...typography.bodyStrong,
    color: colors.text,
    width: 64,
  },
  topTitle: {
    ...typography.h3,
    color: colors.text,
  },
  topSpacer: {
    width: 64,
  },
  body: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  welcome: {
    ...typography.display,
    color: colors.text,
    marginTop: spacing.sm,
  },
  intro: {
    ...typography.body,
    color: colors.textMuted,
  },
  errorBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  errorText: {
    ...typography.body,
    color: colors.text,
  },
  uploadZone: {
    minHeight: 208,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderActive,
    borderStyle: 'dashed',
    backgroundColor: colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  cameraCircle: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceOverlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadLabel: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  previewZone: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    padding: spacing.md,
    gap: spacing.md,
    alignItems: 'center',
  },
  preview: {
    width: '100%',
    height: 200,
    borderRadius: radius.md,
    backgroundColor: colors.backgroundMuted,
  },
  previewFallback: {
    width: '100%',
    height: 200,
    borderRadius: radius.md,
    backgroundColor: colors.backgroundMuted,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  previewFallbackText: {
    ...typography.body,
    color: colors.textMuted,
  },
  uploadError: {
    ...typography.body,
    color: colors.danger,
  },
  tips: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  tip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  tipText: {
    ...typography.body,
    color: colors.textMuted,
    flex: 1,
  },
  statusPanel: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  statusIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceOverlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusTitle: {
    ...typography.h3,
    color: colors.text,
    textAlign: 'center',
  },
  statusBody: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  footer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },
  skipLink: {
    ...typography.bodyStrong,
    color: colors.accent,
    textAlign: 'center',
  },
});
