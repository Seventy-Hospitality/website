/**
 * Claim writes lose races in two shapes, observed against real Postgres:
 *
 * - SQLSTATE 23P01 (exclusion_violation): the writer blocked on the earlier
 *   insert, which committed first.
 * - SQLSTATE 40P01 (deadlock_detected): both conflicting claim inserts were
 *   mid-flight in the GiST index and each waited on the other; Postgres
 *   kills one. 40001 (serialization_failure) is the same story under
 *   stricter isolation.
 *
 * All of them mean "somebody else owns that range now, retry the next
 * candidate in a fresh transaction", so the repositories map them all to
 * SlotUnavailableError, never a 500. Depending on the code path Prisma
 * surfaces the SQLSTATE as a raw-query failure (P2010 with meta.code), a
 * wrapped driver-adapter error (cause carries the pg error), or only in the
 * message text; check all three.
 */

const CLAIM_CONFLICT_SQLSTATES = new Set(['23P01', '40P01', '40001']);

export function isClaimConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
    cause?: unknown;
  };

  if (typeof candidate.code === 'string' && CLAIM_CONFLICT_SQLSTATES.has(candidate.code)) return true;
  if (typeof candidate.meta?.code === 'string' && CLAIM_CONFLICT_SQLSTATES.has(candidate.meta.code)) return true;
  if (typeof candidate.message === 'string') {
    for (const sqlstate of CLAIM_CONFLICT_SQLSTATES) {
      if (candidate.message.includes(sqlstate)) return true;
    }
    if (candidate.message.includes('no_overlapping_claims')) return true;
    if (candidate.message.includes('deadlock detected')) return true;
  }

  const cause = candidate.cause;
  if (cause && typeof cause === 'object') {
    const inner = cause as { code?: unknown; message?: unknown };
    if (typeof inner.code === 'string' && CLAIM_CONFLICT_SQLSTATES.has(inner.code)) return true;
    if (typeof inner.message === 'string' && inner.message.includes('no_overlapping_claims')) return true;
  }

  return false;
}

/**
 * A unique violation on reservations_series_occurrence_key (the raw-SQL
 * partial unique on (seriesId, localDate)): another materializer pass
 * created this occurrence first. Prisma surfaces schema-unknown indexes as
 * P2002 with the index name in meta/message, or as the raw 23505 SQLSTATE
 * depending on the path; check both plus the index name.
 */
export function isSeriesOccurrenceConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown; target?: unknown };
    message?: unknown;
    cause?: unknown;
  };

  const mentionsIndex = (value: unknown): boolean =>
    typeof value === 'string' && value.includes('series_occurrence');

  if (mentionsIndex(candidate.message)) return true;
  if (mentionsIndex(candidate.meta?.target)) return true;
  if (Array.isArray(candidate.meta?.target) && candidate.meta.target.some(mentionsIndex)) return true;

  const cause = candidate.cause;
  if (cause && typeof cause === 'object') {
    const inner = cause as { message?: unknown; constraint?: unknown };
    if (mentionsIndex(inner.message) || mentionsIndex(inner.constraint)) return true;
  }

  // Fall back on the bare unique-violation codes: a series insert has no
  // other plausible unique (references come from a Postgres sequence).
  return candidate.code === 'P2002' || candidate.code === '23505' || candidate.meta?.code === '23505';
}
