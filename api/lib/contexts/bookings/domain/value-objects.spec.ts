import { createTimeSlot, timeToMinutes, slotsOverlap, generateAvailableSlots } from './value-objects';
import type { TimeSlot } from './value-objects';

describe('timeToMinutes', () => {
  it('converts midnight', () => {
    expect(timeToMinutes('00:00')).toBe(0);
  });

  it('converts a morning time', () => {
    expect(timeToMinutes('09:30')).toBe(570);
  });

  it('converts noon', () => {
    expect(timeToMinutes('12:00')).toBe(720);
  });

  it('converts end of day', () => {
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  it('converts a time with single-digit hour', () => {
    expect(timeToMinutes('6:00')).toBe(360);
  });
});

describe('createTimeSlot', () => {
  it('creates a 60-minute slot', () => {
    const slot = createTimeSlot('09:00', 60);
    expect(slot).toEqual({ startTime: '09:00', endTime: '10:00' });
  });

  it('creates a 30-minute slot', () => {
    const slot = createTimeSlot('14:30', 30);
    expect(slot).toEqual({ startTime: '14:30', endTime: '15:00' });
  });

  it('creates a 90-minute slot', () => {
    const slot = createTimeSlot('08:00', 90);
    expect(slot).toEqual({ startTime: '08:00', endTime: '09:30' });
  });

  it('handles crossing hour boundary', () => {
    const slot = createTimeSlot('09:45', 30);
    expect(slot).toEqual({ startTime: '09:45', endTime: '10:15' });
  });

  it('pads end time with leading zeros', () => {
    const slot = createTimeSlot('00:00', 60);
    expect(slot).toEqual({ startTime: '00:00', endTime: '01:00' });
  });

  it('handles a slot ending at midnight-area times', () => {
    const slot = createTimeSlot('23:00', 60);
    expect(slot.endTime).toBe('24:00');
  });

  it('handles zero-minute duration', () => {
    const slot = createTimeSlot('10:00', 0);
    expect(slot).toEqual({ startTime: '10:00', endTime: '10:00' });
  });
});

describe('slotsOverlap', () => {
  it('detects fully overlapping slots', () => {
    const a: TimeSlot = { startTime: '09:00', endTime: '10:00' };
    const b: TimeSlot = { startTime: '09:00', endTime: '10:00' };
    expect(slotsOverlap(a, b)).toBe(true);
  });

  it('detects partial overlap (b starts during a)', () => {
    const a: TimeSlot = { startTime: '09:00', endTime: '10:00' };
    const b: TimeSlot = { startTime: '09:30', endTime: '10:30' };
    expect(slotsOverlap(a, b)).toBe(true);
  });

  it('detects partial overlap (a starts during b)', () => {
    const a: TimeSlot = { startTime: '09:30', endTime: '10:30' };
    const b: TimeSlot = { startTime: '09:00', endTime: '10:00' };
    expect(slotsOverlap(a, b)).toBe(true);
  });

  it('detects when one slot contains the other', () => {
    const a: TimeSlot = { startTime: '08:00', endTime: '12:00' };
    const b: TimeSlot = { startTime: '09:00', endTime: '10:00' };
    expect(slotsOverlap(a, b)).toBe(true);
  });

  it('returns false for adjacent slots (a before b)', () => {
    const a: TimeSlot = { startTime: '09:00', endTime: '10:00' };
    const b: TimeSlot = { startTime: '10:00', endTime: '11:00' };
    expect(slotsOverlap(a, b)).toBe(false);
  });

  it('returns false for adjacent slots (b before a)', () => {
    const a: TimeSlot = { startTime: '10:00', endTime: '11:00' };
    const b: TimeSlot = { startTime: '09:00', endTime: '10:00' };
    expect(slotsOverlap(a, b)).toBe(false);
  });

  it('returns false for non-adjacent non-overlapping slots', () => {
    const a: TimeSlot = { startTime: '09:00', endTime: '10:00' };
    const b: TimeSlot = { startTime: '14:00', endTime: '15:00' };
    expect(slotsOverlap(a, b)).toBe(false);
  });

  it('detects overlap with 1-minute overlap', () => {
    const a: TimeSlot = { startTime: '09:00', endTime: '10:00' };
    const b: TimeSlot = { startTime: '09:59', endTime: '11:00' };
    expect(slotsOverlap(a, b)).toBe(true);
  });
});

describe('generateAvailableSlots', () => {
  it('generates all slots when none are booked', () => {
    const slots = generateAvailableSlots('09:00', '12:00', 60, []);
    expect(slots).toEqual([
      { startTime: '09:00', endTime: '10:00' },
      { startTime: '10:00', endTime: '11:00' },
      { startTime: '11:00', endTime: '12:00' },
    ]);
  });

  it('excludes booked slots', () => {
    const booked: TimeSlot[] = [{ startTime: '10:00', endTime: '11:00' }];
    const slots = generateAvailableSlots('09:00', '12:00', 60, booked);
    expect(slots).toEqual([
      { startTime: '09:00', endTime: '10:00' },
      { startTime: '11:00', endTime: '12:00' },
    ]);
  });

  it('excludes multiple booked slots', () => {
    const booked: TimeSlot[] = [
      { startTime: '09:00', endTime: '10:00' },
      { startTime: '11:00', endTime: '12:00' },
    ];
    const slots = generateAvailableSlots('09:00', '12:00', 60, booked);
    expect(slots).toEqual([{ startTime: '10:00', endTime: '11:00' }]);
  });

  it('returns empty when all slots are booked', () => {
    const booked: TimeSlot[] = [
      { startTime: '09:00', endTime: '10:00' },
      { startTime: '10:00', endTime: '11:00' },
      { startTime: '11:00', endTime: '12:00' },
    ];
    const slots = generateAvailableSlots('09:00', '12:00', 60, booked);
    expect(slots).toEqual([]);
  });

  it('handles 30-minute slot durations', () => {
    const slots = generateAvailableSlots('09:00', '10:00', 30, []);
    expect(slots).toEqual([
      { startTime: '09:00', endTime: '09:30' },
      { startTime: '09:30', endTime: '10:00' },
    ]);
  });

  it('does not generate a slot that would exceed operating hours', () => {
    const slots = generateAvailableSlots('09:00', '10:30', 60, []);
    expect(slots).toEqual([{ startTime: '09:00', endTime: '10:00' }]);
  });

  it('returns empty when operating window is smaller than slot duration', () => {
    const slots = generateAvailableSlots('09:00', '09:30', 60, []);
    expect(slots).toEqual([]);
  });

  it('returns empty when operating window equals zero', () => {
    const slots = generateAvailableSlots('09:00', '09:00', 60, []);
    expect(slots).toEqual([]);
  });

  it('excludes a slot overlapping with a partial booking', () => {
    // Booking covers 09:30-10:30, which overlaps both the 09:00 and 10:00 slots
    const booked: TimeSlot[] = [{ startTime: '09:30', endTime: '10:30' }];
    const slots = generateAvailableSlots('09:00', '12:00', 60, booked);
    expect(slots).toEqual([{ startTime: '11:00', endTime: '12:00' }]);
  });
});
