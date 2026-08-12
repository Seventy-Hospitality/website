import { minutesToTimeLabel, zonedMinutesSinceMidnight } from '@/lib/kernel';
import { DEFAULT_NOTIFICATION_PREFERENCES, planChannels } from '../domain';
import type { BookingReminderRepository } from '../infrastructure/booking-reminder.repository';
import type { DeviceRepository } from '../infrastructure/device.repository';
import type { NotificationPreferenceRepository } from '../infrastructure/notification-preference.repository';
import type {
  NotificationSender,
  PushSender,
  RecipientDirectory,
  ReservationNotificationView,
} from './ports';

/** Bookings context: confirmed reservations starting inside a window. */
export interface ReminderSource {
  listConfirmedStartingBetween(from: Date, to: Date): Promise<ReservationNotificationView[]>;
}

export interface ReminderRunResult {
  reservations: number;
  remindersSent: number;
  skipped: number;
  failed: number;
}

/**
 * Booking reminders (policy cron, hourly). The recorded window: every
 * CONFIRMED reservation starting within the next 24 hours, reminding its
 * CONFIRMED participants (pending invitees still have the invite itself to
 * answer; a reservation booked inside the window gets one reminder shortly
 * after booking, which doubles as its heads-up).
 *
 * Idempotency: one reminder per (reservation, member), via a claim on the
 * booking_reminders marker BEFORE sending. "Sent" means at least one
 * channel delivered; a member whose every enabled channel failed keeps a
 * pending marker and is retried next pass (retry, never drop). Channel
 * choice honors the independent bookingReminders toggle plus the push and
 * email toggles, and push goes only to registered devices.
 */
export class BookingReminderService {
  private readonly windowHours: number;

  constructor(
    private readonly source: ReminderSource,
    private readonly markers: BookingReminderRepository,
    private readonly preferences: NotificationPreferenceRepository,
    private readonly devices: DeviceRepository,
    private readonly emailSender: NotificationSender,
    private readonly pushSender: PushSender,
    private readonly recipients: RecipientDirectory,
    private readonly config: { timezone: string; windowHours?: number },
  ) {
    this.windowHours = config.windowHours ?? 24;
  }

  async sendDueReminders(now: Date = new Date()): Promise<ReminderRunResult> {
    const to = new Date(now.getTime() + this.windowHours * 60 * 60 * 1000);
    const due = await this.source.listConfirmedStartingBetween(now, to);

    const result: ReminderRunResult = { reservations: due.length, remindersSent: 0, skipped: 0, failed: 0 };

    for (const reservation of due) {
      const confirmed = reservation.participants.filter((participant) => participant.status === 'confirmed');
      for (const participant of confirmed) {
        try {
          const outcome = await this.remindOne(reservation, participant.memberId);
          result[outcome === 'sent' ? 'remindersSent' : 'skipped'] += 1;
        } catch (error) {
          result.failed += 1;
          console.error(
            `[reminders] failed for reservation ${reservation.id}, member ${participant.memberId}; will retry`,
            error,
          );
        }
      }
    }

    return result;
  }

  private async remindOne(
    reservation: ReservationNotificationView,
    memberId: string,
  ): Promise<'sent' | 'skipped'> {
    const contact = await this.recipients.getContact(memberId);
    if (!contact) return 'skipped';

    const prefs = (await this.preferences.getForMember(memberId)) ?? { ...DEFAULT_NOTIFICATION_PREFERENCES };
    const memberDevices = await this.devices.listForMember(memberId);
    const plan = planChannels('booking_reminder', prefs, memberDevices.length > 0);
    if (!plan.email && !plan.push) return 'skipped'; // opted out: no marker, no send

    if ((await this.markers.claim(reservation.id, memberId)) === 'already_sent') return 'skipped';

    const startMinutes = zonedMinutesSinceMidnight(reservation.startsAt, this.config.timezone, reservation.localDate);
    const endMinutes = zonedMinutesSinceMidnight(reservation.endsAt, this.config.timezone, reservation.localDate);
    const timeRange = `${minutesToTimeLabel(startMinutes)} to ${minutesToTimeLabel(endMinutes)}`;

    // "Sent" means at least one channel delivered: a retry after a partial
    // failure would otherwise double-send the channel that worked.
    let delivered = false;
    let lastError: unknown = null;

    if (plan.email) {
      try {
        await this.emailSender.send({
          type: 'booking-reminder',
          to: contact.email,
          firstName: contact.firstName,
          typeName: reservation.typeName,
          resourceName: reservation.resourceName,
          date: reservation.localDate,
          timeRange,
          reference: reservation.reference,
        });
        delivered = true;
      } catch (error) {
        lastError = error;
      }
    }

    if (plan.push) {
      try {
        await this.pushSender.send(
          memberDevices.map((device) => ({
            token: device.token,
            title: 'Upcoming booking',
            body: `${reservation.typeName} on ${reservation.localDate}, ${timeRange} (${reservation.resourceName})`,
            data: { reservationId: reservation.id },
          })),
        );
        delivered = true;
      } catch (error) {
        lastError = error;
      }
    }

    if (!delivered) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      await this.markers.recordFailure(reservation.id, memberId, message);
      throw lastError instanceof Error ? lastError : new Error(message);
    }

    await this.markers.markSent(reservation.id, memberId);
    if (lastError) {
      console.error(
        `[reminders] partial delivery for reservation ${reservation.id}, member ${memberId} (marked sent)`,
        lastError,
      );
    }
    return 'sent';
  }
}
