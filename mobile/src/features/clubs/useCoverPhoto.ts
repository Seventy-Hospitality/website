/**
 * Cover-photo picker for the create/edit club flows (M5). Wraps
 * expo-image-picker (camera or library) with the same client-side validation
 * member-web runs before upload (accepted type + 5 MB cap), so the member sees
 * an inline message rather than a backend 413/422. The picked image is held as
 * a { uri, name, type, size } ready for api.uploadClubCover's multipart body.
 */
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { coverImageError } from './clubs-lib';

export interface CoverImage {
  uri: string;
  name: string;
  type: string;
  size: number | null;
}

const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

function inferType(asset: ImagePicker.ImagePickerAsset): string {
  if (asset.mimeType) return asset.mimeType;
  const ext = (asset.fileName ?? asset.uri).split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? 'image/jpeg';
}

export interface CoverPhotoController {
  image: CoverImage | null;
  error: string | null;
  /** Prompt for camera vs library, then pick + validate. */
  choose: () => void;
  /** Drop the picked image (does not affect an already-saved cover). */
  clear: () => void;
  setError: (message: string | null) => void;
}

export function useCoverPhoto(): CoverPhotoController {
  const [image, setImage] = useState<CoverImage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickFrom = useCallback(async (source: 'camera' | 'library') => {
    try {
      const permission =
        source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setError(
          source === 'camera'
            ? 'Camera access is needed to take a cover photo.'
            : 'Photo library access is needed to choose a cover photo.',
        );
        return;
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8 });

      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      const type = inferType(asset);
      const size = asset.fileSize ?? null;
      const validation = coverImageError({ type, size });
      if (validation) {
        setError(validation);
        return;
      }
      const name = asset.fileName ?? asset.uri.split('/').pop() ?? 'cover.jpg';
      setError(null);
      setImage({ uri: asset.uri, name, type, size });
    } catch {
      setError('We could not open the photo picker. Please try again.');
    }
  }, []);

  const choose = useCallback(() => {
    Alert.alert('Add a cover photo', undefined, [
      { text: 'Take photo', onPress: () => void pickFrom('camera') },
      { text: 'Choose from library', onPress: () => void pickFrom('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [pickFrom]);

  const clear = useCallback(() => {
    setImage(null);
    setError(null);
  }, []);

  return { image, error, choose, clear, setError };
}
