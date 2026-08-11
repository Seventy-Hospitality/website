// The cipher moved to the kernel (media's private assets share it, under a
// different purpose label); identity keeps re-exporting so its wiring and
// stored refresh tokens are untouched. The default purpose label
// 'refresh-token-cipher' reproduces the original key derivation.
export { AesGcmCipher } from '@/lib/kernel/aes-gcm';
