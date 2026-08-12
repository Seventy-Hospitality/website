/** Jest config for the Club70 mobile app (Expo SDK 54 / RN 0.81). */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest/setup.js'],
  moduleNameMapper: {
    '\\.(ttf|otf|woff|woff2|png|jpg|jpeg|gif|webp|svg)$': '<rootDir>/jest/asset-stub.js',
  },
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}'],
};
