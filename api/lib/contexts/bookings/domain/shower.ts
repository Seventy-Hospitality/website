export interface Shower {
  id: string;
  name: string;
  slotDurationMinutes: number;
  operatingHoursStart: string;
  operatingHoursEnd: string;
  maxAdvanceDays: number;
  maxBookingsPerMemberPerDay: number;
  cancellationDeadlineMinutes: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
