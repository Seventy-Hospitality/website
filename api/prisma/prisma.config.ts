import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

dotenv.config({ path: path.resolve(import.meta.dirname, '../.env') });

export default defineConfig({
  schema: path.join(import.meta.dirname, 'schema.prisma'),
  migrate: {
    async url() {
      return process.env.DATABASE_URL!;
    },
  },
  studio: {
    async url() {
      return process.env.DATABASE_URL!;
    },
  },
  migrations: {
    seed: 'npx tsx prisma/seed.ts',
  },
});
