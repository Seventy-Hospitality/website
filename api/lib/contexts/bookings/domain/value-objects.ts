// ── Time Slot ──

export interface TimeSlot {
  startTime: string; // HH:mm wall-clock
  endTime: string;   // HH:mm wall-clock
}

export function createTimeSlot(startTime: string, durationMinutes: number): TimeSlot {
  const [h, m] = startTime.split(':').map(Number);
  const totalMinutes = h * 60 + m + durationMinutes;
  const endH = Math.floor(totalMinutes / 60);
  const endM = totalMinutes % 60;
  return {
    startTime,
    endTime: `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`,
  };
}

export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function slotsOverlap(a: TimeSlot, b: TimeSlot): boolean {
  const aStart = timeToMinutes(a.startTime);
  const aEnd = timeToMinutes(a.endTime);
  const bStart = timeToMinutes(b.startTime);
  const bEnd = timeToMinutes(b.endTime);
  return aStart < bEnd && bStart < aEnd;
}

// ── Availability ──

export function generateAvailableSlots(
  operatingStart: string,
  operatingEnd: string,
  slotDurationMinutes: number,
  existingBookings: TimeSlot[],
): TimeSlot[] {
  const startMin = timeToMinutes(operatingStart);
  const endMin = timeToMinutes(operatingEnd);
  const slots: TimeSlot[] = [];

  for (let min = startMin; min + slotDurationMinutes <= endMin; min += slotDurationMinutes) {
    const candidate = createTimeSlot(
      `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`,
      slotDurationMinutes,
    );
    const taken = existingBookings.some((b) => slotsOverlap(candidate, b));
    if (!taken) slots.push(candidate);
  }

  return slots;
}
