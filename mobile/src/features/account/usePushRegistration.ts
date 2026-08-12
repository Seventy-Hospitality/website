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
 * Resolve this device's Expo push token. Returns null (never throws) when push
 * is unavailable or declined. `promptIfNeeded` gates the OS permission prompt:
 * enabling push may ask, but disabling must NEVER prompt (turning a toggle OFF
 * should not pop a permission dialog; if permission was never granted there is
 * nothing registered to remove anyway).
 */
async function resolvePushToken(promptIfNeeded: boolean): Promise<string | null> {
  if (!devicePlatform()) return null;
  try {
    const current = await Notifications.getPermissionsAsync();
    let granted = current.granted;
    if (!granted) {
      if (!promptIfNeeded || !current.canAskAgain) return null;
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
    const token = await resolvePushToken(true);
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
    // Never prompt when turning push off.
    const token = await resolvePushToken(false);
    if (!token) return;
    try {
      await api.unregisterDevice(token);
    } catch {
      // Idempotent server-side; a miss is harmless.
    }
  }, []);

  return { enable, disable };
}
