/* Global test mocks for native modules the unit tests do not exercise. */

// expo-crypto -> real Node hashing + UUIDs, so sha256Hex and the magic-link
// state are genuinely verified rather than stubbed to a constant.
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
  digestStringAsync: jest.fn(async (_algo, value) =>
    require('crypto').createHash('sha256').update(value).digest('hex'),
  ),
  randomUUID: jest.fn(() => require('crypto').randomUUID()),
}));

// expo-secure-store -> in-memory store.
jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    getItemAsync: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    setItemAsync: jest.fn(async (key, value) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key) => {
      store.delete(key);
    }),
  };
});

// Heavy native modules that are only reached at runtime, never in unit tests.
jest.mock('@stripe/stripe-react-native', () => ({
  StripeProvider: ({ children }) => children,
  useStripe: () => ({ initPaymentSheet: jest.fn(), presentPaymentSheet: jest.fn() }),
}));

jest.mock('react-native-qrcode-svg', () => 'QRCode');

// expo-clipboard -> a spyable no-op (the club invite "Copy link" action).
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
}));

// Icon + image modules render as simple host components in tests.
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
