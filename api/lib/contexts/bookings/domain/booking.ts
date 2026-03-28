export type FacilityType = 'court' | 'shower';

export interface Booking {
  id: string;
  facilityType: FacilityType;
  facilityId: string;
  memberId: string;
  date: Date;
  startTime: string;
  endTime: string;
  status: 'confirmed' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}
