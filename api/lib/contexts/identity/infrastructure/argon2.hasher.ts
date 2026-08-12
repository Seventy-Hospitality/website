import { hash, verify, Algorithm } from '@node-rs/argon2';
import type { PasswordHasher } from '../application/ports';

// OWASP baseline for argon2id: m=19456 KiB, t=2, p=1, 32-byte output.
const PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export class Argon2Hasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return hash(password, PARAMS); // PHC string, params + salt self-described
  }

  async verify(phcHash: string, password: string): Promise<boolean> {
    try {
      return await verify(phcHash, password);
    } catch {
      return false; // malformed hash = no match, never a 500
    }
  }

  needsRehash(phcHash: string): boolean {
    const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phcHash);
    if (!match) return true;
    const [, m, t, p] = match;
    return (
      Number(m) !== PARAMS.memoryCost ||
      Number(t) !== PARAMS.timeCost ||
      Number(p) !== PARAMS.parallelism
    );
  }
}
