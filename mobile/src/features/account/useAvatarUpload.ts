/**
 * Avatar picker + upload for the account screen (M6). Wraps expo-image-picker
 * (camera or library) with the same client-side validation the backend media
 * spec enforces (JPG/PNG/WebP, 5 MB), so the member gets an inline message
 * instead of a 413/422. On a valid pick it runs api.uploadAvatar and patches
 * the ['profile'] cache, mirroring member-web's optimistic avatar mutation.
 */
import { useCallback } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type MyProfile } from '../../lib/api';
import { useToast } from '../../components';

/** Mirror of MEDIA_USAGE_SPECS.avatar (api/lib/contexts/media). */
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_BYTES = 5 * 1024 * 1024;

const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function inferType(asset: ImagePicker.ImagePickerAsset): string {
  if (asset.mimeType) return asset.mimeType;
  const ext = (asset.fileName ?? asset.uri).split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? 'image/jpeg';
}

/** Validate a picked avatar; returns an error message or null. */
export function avatarImageError(image: { type: string; size?: number | null }): string | null {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(image.type)) {
    return 'Avatars must be JPG, PNG, or WebP files.';
  }
  if (image.size != null && image.size > MAX_BYTES) {
    return 'Avatars must be 5 MB or smaller.';
  }
  return null;
}

export interface AvatarUploadController {
  /** Prompt camera vs library, pick + validate, then upload. */
  choose: () => void;
  isUploading: boolean;
}

export function useAvatarUpload(): AvatarUploadController {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const upload = useMutation({
    mutationFn: (image: { uri: string; name: string; type: string }) => api.uploadAvatar(image),
    onSuccess: ({ avatarUrl }) => {
      queryClient.setQueryData<MyProfile>(['profile'], (prev) =>
        prev ? { ...prev, member: { ...prev.member, avatarUrl } } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      toast({ variant: 'success', message: 'Profile photo updated.' });
    },
    onError: (error) => {
      const message =
        error instanceof ApiError && (error.code === 'INVALID_IMAGE' || error.code === 'FILE_TOO_LARGE')
          ? error.message
          : 'We could not update your photo. Please try again.';
      toast({ variant: 'error', message });
    },
  });

  const pickFrom = useCallback(
    async (source: 'camera' | 'library') => {
      try {
        const permission =
          source === 'camera'
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          toast({
            variant: 'error',
            message:
              source === 'camera'
                ? 'Camera access is needed to take a profile photo.'
                : 'Photo library access is needed to choose a profile photo.',
          });
          return;
        }

        const result =
          source === 'camera'
            ? await ImagePicker.launchCameraAsync({
                mediaTypes: ['images'],
                allowsEditing: true,
                aspect: [1, 1],
                quality: 0.8,
              })
            : await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsEditing: true,
                aspect: [1, 1],
                quality: 0.8,
              });

        if (result.canceled || result.assets.length === 0) return;
        const asset = result.assets[0];
        const type = inferType(asset);
        const validation = avatarImageError({ type, size: asset.fileSize ?? null });
        if (validation) {
          toast({ variant: 'error', message: validation });
          return;
        }
        const name = asset.fileName ?? asset.uri.split('/').pop() ?? 'avatar.jpg';
        upload.mutate({ uri: asset.uri, name, type });
      } catch {
        toast({ variant: 'error', message: 'We could not open the photo picker. Please try again.' });
      }
    },
    [toast, upload],
  );

  const choose = useCallback(() => {
    Alert.alert('Update profile photo', undefined, [
      { text: 'Take photo', onPress: () => void pickFrom('camera') },
      { text: 'Choose from library', onPress: () => void pickFrom('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [pickFrom]);

  return { choose, isUploading: upload.isPending };
}
