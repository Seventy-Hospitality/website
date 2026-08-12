/**
 * Expo push-token device registration for the account preferences screen (M6).
 *
 * When push notifications are enabled we register this device's Expo push token
 * with POST /api/me/devices; when disabled we DELETE it. Everything degrades
 * silently: on the simulator / web, without notification permission, or without
 * an EAS projectId, `getExpoPushTokenAsync` throws or returns nothing and the
 * helpers no-op rather than surfacing an error. The push preference boolean is
 * saved independently (optimistic), so a device-registration miss never blocks
 * the toggle.
 */
import { useCallback } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { api } from '../../lib/api';

type DevicePlatform = 'ios' | 'android';

function devicePlatform(): DevicePlatform | null {
  if (Platform.OS === 'ios' || Platform.OS === 'android') return Platform.OS;
  return null;
}

/**
 * Resolve this device's Expo push token, requesting permission if needed.
 * Returns null (never throws) when push is unavailable or declined.
 */
async function resolvePushToken(): Promise<string | null> {
  if (!devicePlatform()) return null;
  try {
    const current = await Notifications.getPermissionsAsync();
    let granted = current.granted;
    if (!granted && current.canAskAgain) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.granted;
    }
    if (!granted) return null;
    const token = await Notifications.getExpoPushTokenAsync();
    return token?.data ?? null;
  } catch {
    return null;
  }
}

export interface PushRegistrationController {
  /** Register this device's push token. Resolves false when unavailable. */
  enable: () => Promise<boolean>;
  /** Unregister this device's push token (best-effort). */
  disable: () => Promise<void>;
}

export function usePushRegistration(): PushRegistrationController {
  const enable = useCallback(async (): Promise<boolean> => {
    const token = await resolvePushToken();
    const platform = devicePlatform();
    if (!token || !platform) return false;
    try {
      await api.registerDevice({ token, platform });
      return true;
    } catch {
      return false;
    }
  }, []);

  const disable = useCallback(async (): Promise<void> => {
    const token = await resolvePushToken();
    if (!token) return;
    try {
      await api.unregisterDevice(token);
    } catch {
      // Idempotent server-side; a miss is harmless.
    }
  }, []);

  return { enable, disable };
}
