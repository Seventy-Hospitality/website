import { minutesToTimeLabel, zonedMinutesSinceMidnight } from '@/lib/kernel';
import {
  CHANNEL_POLICIES,
  decideNotifications,
  planChannels,
  reservationDispatchGate,
  type NotificationDecision,
  type NotificationKind,
  type OutboxEventLike,
  type RecipientRef,
} from '../domain';
import type { Notification } from '../domain/notifications';
import type { DeviceRepository } from '../infrastructure/device.repository';
import type { NotificationPreferenceRepository } from '../infrastructure/notification-preference.repository';
import type { DeliveredNotificationRepository } from '../infrastructure/delivered-notification.repository';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../domain';
import type {
  ClubDirectory,
  NotificationSender,
  PushMessage,
  PushSender,
  RecipientDirectory,
  ReservationDirectory,
  ReservationNotificationView,
} from './ports';

/** The outbox row shape handed to the sink (structurally OutboxEventRecord). */
export type DispatchableEvent = OutboxEventLike & { id: string };

export interface DispatchResult {
  failedEventIds: string[];
}

export interface NotificationDispatchConfig {
  /** Venue timezone used to render dates/times in notifications. */
  timezone: string;
  /**
   * Where staff alerts go. Unset means staff alerts have no recipient:
   * they are skipped (with a warn log) and the event still dispatches.
   */
  staffAlertEmail: string | null;
}

/**
 * The outbox consumer: turns audit-log rows into notifications.
 *
 * The DECISION (who + which channels) is the pure domain matrix in
 * notification-decision.ts; this service resolves recipient references
 * through container-wired read ports, gates channels through the member's
 * preferences and registered devices, and guards every send with the
 * delivered-notifications ledger:
 *
 *   claim (eventSeq, recipient, channel) -> send -> mark sent
 *
 * The ledger auto-commits outside the dispatch transaction, so a batch that
 * fails halfway retries WITHOUT double-sending what already went out, and a
 * claim that never reached "sent" is re-claimed on the retry (retry, never
 * drop). Per-event failures are reported to the dispatcher, which leaves
 * exactly those events pending.
 *
 * Failures are isolated per (recipient, channel): one persistently failing
 * send never starves co-recipients of the same event (every recipient and
 * channel is attempted on every pass), and the event stays pending until
 * EVERY owed send has been delivered.
 *
 * A recipient or subject that no longer resolves (deleted member, deleted
 * reservation or club) means there is nothing to say: the decision
 * evaporates and the event dispatches as audit-only.
 */
export class NotificationDispatchService {
  constructor(
    private readonly ledger: DeliveredNotificationRepository,
    private readonly preferences: NotificationPreferenceRepository,
    private readonly devices: DeviceRepository,
    private readonly emailSender: NotificationSender,
    private readonly pushSender: PushSender,
    private readonly recipients: RecipientDirectory,
    private readonly reservations: ReservationDirectory,
    private readonly clubs: ClubDirectory,
    private readonly config: NotificationDispatchConfig,
  ) {}

  async deliver(events: DispatchableEvent[]): Promise<DispatchResult> {
    const failedEventIds: string[] = [];
    for (const event of events) {
      try {
        await this.deliverOne(event);
      } catch (error) {
        failedEventIds.push(event.id);
        console.error(
          `[notifications] delivery failed for event seq=${event.seq} (${event.eventType}); will retry`,
          error,
        );
      }
    }
    return { failedEventIds };
  }

  /** Throws when any owed send is still undelivered, keeping the event pending. */
  private async deliverOne(event: DispatchableEvent): Promise<void> {
    const decisions = decideNotifications(event);
    let undelivered = 0;
    for (const decision of decisions) {
      undelivered +=
        decision.recipient.kind === 'staff'
          ? await this.deliverStaffAlert(event, decision.kind)
          : await this.deliverToMembers(event, decision);
    }
    if (undelivered > 0) {
      throw new Error(`${undelivered} send(s) still owed; their ledger claims stay pending`);
    }
  }

  /**
   * claim -> send -> mark for ONE (recipient, channel), isolating failure to
   * that pair: a throw from the sender records the failure on the pending
   * claim and reports 1 undelivered send instead of unwinding the loop over
   * the event's other recipients and channels.
   */
  private async guardedSend(
    event: DispatchableEvent,
    recipient: string,
    channel: 'email' | 'push',
    send: () => Promise<void>,
  ): Promise<number> {
    if ((await this.ledger.claim(event.seq, recipient, channel)) === 'already_sent') return 0;
    try {
      await send();
    } catch (error) {
      await this.recordFailure(event.seq, recipient, channel, error);
      console.error(
        `[notifications] ${channel} send failed for event seq=${event.seq} (${event.eventType}), recipient=${recipient}; will retry`,
        error,
      );
      return 1;
    }
    await this.ledger.markSent(event.seq, recipient, channel);
    return 0;
  }

  // ── Staff alerts ──

  private async deliverStaffAlert(event: DispatchableEvent, kind: NotificationKind): Promise<number> {
    const to = this.config.staffAlertEmail;
    if (!to) {
      console.warn(
        `[notifications] STAFF_ALERT_EMAIL not configured; dropping staff alert for ${event.eventType} (seq=${event.seq})`,
      );
      return 0;
    }

    return this.guardedSend(event, 'staff', 'email', () =>
      this.emailSender.send(this.buildStaffAlert(event, kind, to)),
    );
  }

  private buildStaffAlert(event: DispatchableEvent, kind: NotificationKind, to: string): Notification {
    const data = asRecord(event.data);
    switch (kind) {
      case 'staff_dispute_opened':
        return {
          type: 'staff-alert',
          to,
          subject: 'Payment dispute opened',
          detail:
            `A dispute was opened on charge ${data.chargeId ?? event.streamId}. ` +
            `Frozen reservations: ${Array.isArray(data.reservationIds) && data.reservationIds.length > 0 ? data.reservationIds.join(', ') : 'none'}. ` +
            'A dispute always needs a human: respond in the Stripe dashboard.',
        };
      case 'staff_refund_failed':
        return {
          type: 'staff-alert',
          to,
          subject: 'Booking refund failed',
          detail:
            `A refund of ${formatCents(data.amountCents)} for reservation ${event.streamId} failed at Stripe ` +
            `(payment intent ${data.stripePaymentIntentId ?? 'unknown'}). ` +
            'The settlement row is marked failed; the member is owed this money until it is re-issued.',
        };
      case 'staff_deletion_blocked':
      default:
        return {
          type: 'staff-alert',
          to,
          subject: 'Account deletion blocked',
          detail:
            `The account-deletion request for user ${event.streamId} is blocked and needs a human: ` +
            `${Array.isArray(data.reasons) && data.reasons.length > 0 ? data.reasons.join('; ') : JSON.stringify(event.data)}.`,
        };
    }
  }

  // ── Member notifications ──

  /** Returns how many owed sends are still undelivered (0 = event settled). */
  private async deliverToMembers(event: DispatchableEvent, decision: NotificationDecision): Promise<number> {
    const policy = CHANNEL_POLICIES[decision.kind];

    // Booking kinds render from (and resolve recipients through) the
    // reservation; a reservation that no longer exists has nothing to say.
    const needsReservation = decision.kind.startsWith('booking_') || decision.kind === 'series_booked';
    const reservation = needsReservation ? await this.reservations.getNotificationView(event.streamId) : null;
    if (needsReservation && !reservation) return 0;

    // Some kinds only make sense against the reservation's status at
    // dispatch time: an invite during a pending_payment checkout waits for
    // the reservation to confirm, and evaporates if the hold expires (no
    // phantom invitations to a booking that never happened).
    if (reservation) {
      const gate = reservationDispatchGate(decision.kind, reservation.status);
      if (gate === 'drop') return 0;
      if (gate === 'defer') {
        console.log(
          `[notifications] deferring ${decision.kind} for event seq=${event.seq}: reservation ${reservation.id} is ${reservation.status}`,
        );
        return 1;
      }
    }

    let memberIds = await this.resolveMemberIds(decision.recipient, reservation);
    if (policy.suppressActor && event.actorId) {
      memberIds = memberIds.filter((memberId) => memberId !== event.actorId);
    }

    let undelivered = 0;
    for (const memberId of [...new Set(memberIds)]) {
      const contact = await this.recipients.getContact(memberId);
      if (!contact) continue; // deleted or unknown member: nothing to deliver

      const prefs = (await this.preferences.getForMember(memberId)) ?? { ...DEFAULT_NOTIFICATION_PREFERENCES };
      const memberDevices = await this.devices.listForMember(memberId);
      const plan = planChannels(decision.kind, prefs, memberDevices.length > 0);

      if (plan.email) {
        const email = await this.buildEmail(event, decision.kind, contact.email, contact.firstName, reservation);
        if (email) {
          undelivered += await this.guardedSend(event, memberId, 'email', () => this.emailSender.send(email));
        }
      }

      if (plan.push) {
        const content = await this.buildPush(event, decision.kind, reservation);
        if (content) {
          const messages: PushMessage[] = memberDevices.map((device) => ({
            token: device.token,
            title: content.title,
            body: content.body,
            data: content.data,
          }));
          undelivered += await this.guardedSend(event, memberId, 'push', () => this.pushSender.send(messages));
        }
      }
    }
    return undelivered;
  }

  private async resolveMemberIds(
    recipient: RecipientRef,
    reservation: ReservationNotificationView | null,
  ): Promise<string[]> {
    switch (recipient.kind) {
      case 'member':
        return [recipient.memberId];
      case 'members':
        return recipient.memberIds;
      case 'reservation_organizer':
        return reservation ? [reservation.organizerId] : [];
      case 'reservation_participants':
        // Declined/withdrawn members opted out of hearing more about it.
        return reservation
          ? reservation.participants
              .filter((participant) => participant.status === 'confirmed' || participant.status === 'pending')
              .map((participant) => participant.memberId)
          : [];
      case 'club_invitation_inviter': {
        const view = await this.clubs.getInvitationView(recipient.invitationId);
        return view?.inviterMemberId ? [view.inviterMemberId] : [];
      }
      case 'staff':
        return [];
    }
  }

  // ── Content ──

  private timeRange(view: { startsAt: Date; endsAt: Date; localDate: string }): string {
    const start = zonedMinutesSinceMidnight(view.startsAt, this.config.timezone, view.localDate);
    const end = zonedMinutesSinceMidnight(view.endsAt, this.config.timezone, view.localDate);
    return `${minutesToTimeLabel(start)} to ${minutesToTimeLabel(end)}`;
  }

  private async firstNameOf(memberId: unknown): Promise<string> {
    if (typeof memberId !== 'string' || memberId.length === 0) return 'A member';
    const contact = await this.recipients.getContact(memberId);
    return contact?.firstName ?? 'A member';
  }

  private async buildEmail(
    event: DispatchableEvent,
    kind: NotificationKind,
    to: string,
    firstName: string,
    reservation: ReservationNotificationView | null,
  ): Promise<Notification | null> {
    const data = asRecord(event.data);
    switch (kind) {
      case 'booking_invite':
        return reservation
          ? {
              type: 'booking-invite',
              to,
              inviterFirstName: await this.firstNameOf(data.invitedById),
              typeName: reservation.typeName,
              date: reservation.localDate,
              timeRange: this.timeRange(reservation),
              reference: reservation.reference,
            }
          : null;
      case 'booking_rescheduled':
        return reservation
          ? {
              type: 'booking-rescheduled',
              to,
              typeName: reservation.typeName,
              date: reservation.localDate,
              timeRange: this.timeRange(reservation),
              reference: reservation.reference,
            }
          : null;
      case 'booking_confirmed':
        return reservation
          ? {
              type: 'booking-confirmed',
              to,
              firstName,
              typeName: reservation.typeName,
              resourceName: reservation.resourceName,
              date: reservation.localDate,
              timeRange: this.timeRange(reservation),
              reference: reservation.reference,
            }
          : null;
      case 'booking_cancelled':
        return reservation
          ? {
              type: 'booking-cancelled',
              to,
              typeName: reservation.typeName,
              date: reservation.localDate,
              timeRange: this.timeRange(reservation),
              reference: reservation.reference,
            }
          : null;
      case 'series_booked':
        return reservation
          ? {
              type: 'series-booked',
              to,
              typeName: reservation.typeName,
              date: reservation.localDate,
              timeRange: this.timeRange(reservation),
              reference: reservation.reference,
            }
          : null;
      case 'series_occurrence_skipped':
        return {
          type: 'series-skipped',
          to,
          typeName: typeof data.typeName === 'string' ? data.typeName : 'court',
          date: typeof data.localDate === 'string' ? data.localDate : 'the coming week',
          reason: typeof data.reason === 'string' ? data.reason : 'slot_unavailable',
        };
      case 'club_invite': {
        const clubName = await this.clubs.getClubName(event.streamId);
        if (!clubName) return null; // club deleted before dispatch
        return {
          type: 'club-invite',
          to,
          inviterFirstName: await this.firstNameOf(data.inviterId),
          clubName,
        };
      }
      case 'id_verification_approved':
        return { type: 'id-approved', to, firstName };
      case 'id_verification_rejected':
        return {
          type: 'id-rejected',
          to,
          firstName,
          note: typeof data.note === 'string' ? data.note : null,
        };
      case 'payment_failed':
        return { type: 'payment-failed', to, memberName: firstName };
      default:
        // Push-only kinds (accept/decline/withdraw pings) have no email shape.
        return null;
    }
  }

  private async buildPush(
    event: DispatchableEvent,
    kind: NotificationKind,
    reservation: ReservationNotificationView | null,
  ): Promise<{ title: string; body: string; data?: Record<string, unknown> } | null> {
    const data = asRecord(event.data);
    const link = reservation ? { reservationId: reservation.id } : undefined;
    switch (kind) {
      case 'booking_invite':
        return reservation
          ? {
              title: 'Booking invitation',
              body: `${await this.firstNameOf(data.invitedById)} invited you to ${reservation.typeName} on ${reservation.localDate}, ${this.timeRange(reservation)}`,
              data: link,
            }
          : null;
      case 'booking_invite_accepted':
        return reservation
          ? {
              title: 'Invitation accepted',
              body: `${await this.firstNameOf(data.memberId)} accepted your ${reservation.typeName} invitation for ${reservation.localDate}`,
              data: link,
            }
          : null;
      case 'booking_invite_declined':
        return reservation
          ? {
              title: 'Invitation declined',
              body: `${await this.firstNameOf(data.memberId)} declined your ${reservation.typeName} invitation for ${reservation.localDate}`,
              data: link,
            }
          : null;
      case 'booking_participant_withdrawn':
        return reservation
          ? {
              title: 'Participant withdrew',
              body: `${await this.firstNameOf(data.memberId)} withdrew from your ${reservation.typeName} booking on ${reservation.localDate}`,
              data: link,
            }
          : null;
      case 'booking_rescheduled':
        return reservation
          ? {
              title: 'Booking rescheduled',
              body: `${reservation.typeName} moved to ${reservation.localDate}, ${this.timeRange(reservation)}. Please accept or decline the new time.`,
              data: link,
            }
          : null;
      case 'booking_cancelled':
        return reservation
          ? {
              title: 'Booking cancelled',
              body: `${reservation.typeName} on ${reservation.localDate}, ${this.timeRange(reservation)} was cancelled`,
              data: link,
            }
          : null;
      case 'series_booked':
        return reservation
          ? {
              title: 'Weekly booking scheduled',
              body: `${reservation.typeName} booked for ${reservation.localDate}, ${this.timeRange(reservation)}`,
              data: link,
            }
          : null;
      case 'series_occurrence_skipped':
        return {
          title: 'Weekly booking skipped',
          body: `Your weekly ${typeof data.typeName === 'string' ? data.typeName : 'court'} booking could not be scheduled for ${typeof data.localDate === 'string' ? data.localDate : 'the coming week'}`,
        };
      case 'club_invite': {
        const clubName = await this.clubs.getClubName(event.streamId);
        return clubName
          ? {
              title: 'Club invitation',
              body: `${await this.firstNameOf(data.inviterId)} invited you to join ${clubName}`,
              data: { clubId: event.streamId },
            }
          : null;
      }
      case 'club_invite_accepted': {
        const view = typeof data.invitationId === 'string' ? await this.clubs.getInvitationView(data.invitationId) : null;
        if (!view) return null;
        return {
          title: 'Club invitation accepted',
          body: `${await this.firstNameOf(view.inviteeMemberId)} joined ${view.clubName}`,
          data: { clubId: view.clubId },
        };
      }
      case 'id_verification_approved':
        return { title: 'ID verified', body: 'Your identity has been verified. You are all set.' };
      case 'id_verification_rejected':
        return {
          title: 'ID could not be verified',
          body: 'We could not verify your ID. Please upload a new photo and submit again.',
        };
      default:
        // Email-only kinds (receipts, payment dunning) have no push shape.
        return null;
    }
  }

  private async recordFailure(seq: number, recipient: string, channel: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.ledger.recordFailure(seq, recipient, channel, message);
    } catch {
      // Bookkeeping only; the rethrown send error drives the retry.
    }
  }
}

function asRecord(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

function formatCents(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `$${(value / 100).toFixed(2)}`
    : 'an unknown amount';
}
