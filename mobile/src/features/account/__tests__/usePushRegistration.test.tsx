import { renderHook, act } from '@testing-library/react-native';

const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockGetExpoPushToken = jest.fn();
const mockRegisterDevice = jest.fn();
const mockUnregisterDevice = jest.fn();

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (...a: unknown[]) => mockGetPermissions(...a),
  requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
  getExpoPushTokenAsync: (...a: unknown[]) => mockGetExpoPushToken(...a),
}));

jest.mock('../../../lib/api', () => ({
  api: {
    registerDevice: (...a: unknown[]) => mockRegisterDevice(...a),
    unregisterDevice: (...a: unknown[]) => mockUnregisterDevice(...a),
  },
}));

// jest-expo defaults Platform.OS to 'ios', so devicePlatform() resolves.
import { usePushRegistration } from '../usePushRegistration';

beforeEach(() => {
  mockGetPermissions.mockReset();
  mockRequestPermissions.mockReset();
  mockGetExpoPushToken.mockReset();
  mockRegisterDevice.mockReset();
  mockUnregisterDevice.mockReset();
  mockGetExpoPushToken.mockResolvedValue({ data: 'ExponentPushToken[abc]' });
});

test('disable() never prompts for permission (toggling push off)', async () => {
  mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: true });
  const { result } = renderHook(() => usePushRegistration());

  await act(async () => {
    await result.current.disable();
  });

  expect(mockRequestPermissions).not.toHaveBeenCalled();
  // Nothing was registered (permission never granted), so nothing to unregister.
  expect(mockUnregisterDevice).not.toHaveBeenCalled();
});

test('disable() unregisters when permission is already granted', async () => {
  mockGetPermissions.mockResolvedValue({ granted: true, canAskAgain: false });
  const { result } = renderHook(() => usePushRegistration());

  await act(async () => {
    await result.current.disable();
  });

  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(mockUnregisterDevice).toHaveBeenCalledWith('ExponentPushToken[abc]');
});

test('enable() may prompt when permission can be asked', async () => {
  mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: true });
  mockRequestPermissions.mockResolvedValue({ granted: true });
  const { result } = renderHook(() => usePushRegistration());

  await act(async () => {
    await result.current.enable();
  });

  expect(mockRequestPermissions).toHaveBeenCalled();
  expect(mockRegisterDevice).toHaveBeenCalledWith({ token: 'ExponentPushToken[abc]', platform: 'ios' });
});
