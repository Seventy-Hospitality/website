import { VersionConflictError } from './version-conflict-error';

export async function retryOnConflict<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VersionConflictError && attempt < maxRetries) {
        continue;
      }
      throw err;
    }
  }
}
