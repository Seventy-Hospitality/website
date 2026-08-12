import 'dotenv/config';
import { mediaService } from '@/lib/container';

const maxAgeHours = coercePositiveInteger(process.env.MEDIA_STALE_UPLOAD_MAX_AGE_HOURS, 24);
const limit = coercePositiveInteger(process.env.MEDIA_STALE_UPLOAD_CLEANUP_LIMIT, 100);

const result = await mediaService.cleanupStaleAssets({
  maxAgeHours,
  limit,
});

console.log(JSON.stringify({
  job: 'cleanup-event-images',
  ...result,
}));

function coercePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}
