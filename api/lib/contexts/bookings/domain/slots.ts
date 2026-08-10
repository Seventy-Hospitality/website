import { timeLabelToMinutes, wallTimeToUtc } from '@/lib/kernel';
import { InvalidSlotSelectionError, OutsideOperatingHoursError } from './errors';

/**
 * Slot math on the venue wall clock. Positions are minutes from venue-local
 * midnight of an anchor date and may exceed 1440 for past-midnight slots
 * ("24:30" = 00:30 the next day, still counting against the anchor date).
 * Instants are derived per boundary through the venue zone, so wall times
 * stay put across DST transitions.
 */

export interface SlotGridConfig {
  slotDurationMinutes: number;
  opStartMinutes: number;
  opEndMinutes: number;
}

export interface InstantRange {
  startsAt: Date;
  endsAt: Date;
}

export interface ClaimRange {
  resourceId: string;
  startsAt: Date;
  endsAt: Date;
}

/** All grid start positions inside operating hours. */
export function generateSlotStarts(config: SlotGridConfig): number[] {
  const starts: number[] = [];
  for (
    let minute = config.opStartMinutes;
    minute + config.slotDurationMinutes <= config.opEndMinutes;
    minute += config.slotDurationMinutes
  ) {
    starts.push(minute);
  }
  return starts;
}

/**
 * Validate a client slot selection ("HH:MM" labels, hours may exceed 24):
 * well-formed, deduplicated, grid-aligned, inside operating hours and
 * contiguous. Returns sorted start positions plus the total duration.
 */
export function parseSlotSelection(
  labels: string[],
  config: SlotGridConfig,
): { startMinutes: number[]; durationMinutes: number } {
  if (labels.length === 0) {
    throw new InvalidSlotSelectionError('At least one slot is required');
  }

  const minutes = labels.map((label) => {
    if (!/^\d{2}:\d{2}$/.test(label)) {
      throw new InvalidSlotSelectionError(`Invalid slot time: ${label}`);
    }
    return timeLabelToMinutes(label);
  });

  const unique = [...new Set(minutes)].sort((a, b) => a - b);
  if (unique.length !== minutes.length) {
    throw new InvalidSlotSelectionError('Duplicate slots in selection');
  }

  for (const start of unique) {
    if ((start - config.opStartMinutes) % config.slotDurationMinutes !== 0) {
      throw new InvalidSlotSelectionError('Slots must align to the booking grid');
    }
    if (start < config.opStartMinutes || start + config.slotDurationMinutes > config.opEndMinutes) {
      throw new OutsideOperatingHoursError(config.opStartMinutes, config.opEndMinutes);
    }
  }

  for (let i = 1; i < unique.length; i++) {
    if (unique[i] !== unique[i - 1] + config.slotDurationMinutes) {
      throw new InvalidSlotSelectionError('Slots must be contiguous');
    }
  }

  return {
    startMinutes: unique,
    durationMinutes: unique.length * config.slotDurationMinutes,
  };
}

/** The instant range a validated selection occupies on a given local date. */
export function selectionToRange(
  dateKey: string,
  startMinutes: number[],
  config: SlotGridConfig,
  timeZone: string,
): InstantRange {
  const first = startMinutes[0];
  const last = startMinutes[startMinutes.length - 1];
  return {
    startsAt: wallTimeToUtc(dateKey, first, timeZone),
    endsAt: wallTimeToUtc(dateKey, last + config.slotDurationMinutes, timeZone),
  };
}

export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Free slot starts per resource for one local date. Availability MUST be
 * computed per resource before any union: four contiguous slots may each be
 * free on some resource while no single resource is free for all four.
 */
export function freeSlotStartsByResource(params: {
  dateKey: string;
  config: SlotGridConfig;
  resourceIds: string[];
  claims: ClaimRange[];
  timeZone: string;
  /** Slots starting at or before this instant are dropped (today's past). */
  notBefore?: Date;
}): Map<string, number[]> {
  const grid = generateSlotStarts(params.config);
  const claimsByResource = new Map<string, ClaimRange[]>();
  for (const claim of params.claims) {
    const list = claimsByResource.get(claim.resourceId);
    if (list) list.push(claim);
    else claimsByResource.set(claim.resourceId, [claim]);
  }

  const free = new Map<string, number[]>(params.resourceIds.map((id) => [id, []]));

  for (const start of grid) {
    const slotStart = wallTimeToUtc(params.dateKey, start, params.timeZone);
    if (params.notBefore && slotStart <= params.notBefore) continue;
    const slotEnd = wallTimeToUtc(params.dateKey, start + params.config.slotDurationMinutes, params.timeZone);

    for (const resourceId of params.resourceIds) {
      const claimed = (claimsByResource.get(resourceId) ?? []).some((claim) =>
        rangesOverlap(slotStart, slotEnd, claim.startsAt, claim.endsAt),
      );
      if (!claimed) free.get(resourceId)!.push(start);
    }
  }

  return free;
}

/** Union across resources of a type: what the picker shows. */
export function unionSlotStarts(perResource: Map<string, number[]>): number[] {
  const union = new Set<number>();
  for (const starts of perResource.values()) {
    for (const start of starts) union.add(start);
  }
  return [...union].sort((a, b) => a - b);
}

/**
 * Resources able to host the ENTIRE selection, in the given resource order.
 * The quote and create paths must both run this: the union can show a slot
 * set no single resource can host (per-resource fragmentation).
 */
export function resourcesFreeForSelection(
  perResource: Map<string, number[]>,
  startMinutes: number[],
  resourceOrder: string[],
): string[] {
  return resourceOrder.filter((resourceId) => {
    const free = new Set(perResource.get(resourceId) ?? []);
    return startMinutes.every((start) => free.has(start));
  });
}

/** Integer cents, rounded half-up on the rare odd-rate boundary. */
export function computeTotalCents(hourlyRateCents: number, durationMinutes: number): number {
  return Math.round((hourlyRateCents * durationMinutes) / 60);
}
