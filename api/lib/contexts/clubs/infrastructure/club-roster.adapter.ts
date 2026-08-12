import type { PrismaClient } from '@prisma/client';
import { ClubInviteNotAllowedError, type ClubRoster, type ClubRosterPort } from '@/lib/contexts/bookings/domain';

/**
 * The clubs side of the bookings ClubRosterPort: expands club chips into the
 * club's CURRENT member set (snapshot at invite time; later joins do not
 * join the reservation). Fails closed when the inviter is not a member of
 * every requested club, answering identically for a nonexistent club so the
 * invite path cannot be used to probe club ids.
 */
export class ClubRosterAdapter implements ClubRosterPort {
  constructor(private readonly prisma: PrismaClient) {}

  async getRostersForInviter(clubIds: string[], inviterId: string): Promise<ClubRoster[]> {
    const unique = [...new Set(clubIds)];
    if (unique.length === 0) return [];

    const rows = await this.prisma.clubMember.findMany({
      where: { clubId: { in: unique } },
      select: { clubId: true, memberId: true },
    });

    const byClub = new Map<string, string[]>();
    for (const row of rows) {
      const roster = byClub.get(row.clubId);
      if (roster) roster.push(row.memberId);
      else byClub.set(row.clubId, [row.memberId]);
    }

    // A club always has at least its owner, so "no rows" IS "no such club";
    // both fail the same membership check.
    for (const clubId of unique) {
      if (!byClub.get(clubId)?.includes(inviterId)) throw new ClubInviteNotAllowedError();
    }

    return unique.map((clubId) => ({ clubId, memberIds: byClub.get(clubId)! }));
  }
}
