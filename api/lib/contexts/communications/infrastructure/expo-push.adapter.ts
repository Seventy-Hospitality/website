import type { PushMessage, PushSender } from '../application/ports';

/**
 * Expo push delivery over the HTTP API (https://exp.host/--/api/v2/push/send).
 *
 * Config-gated exactly like the Resend adapter: without EXPO_PUSH_ACCESS_TOKEN
 * the adapter logs instead of sending, so every decision and persistence
 * path (recipient matrix, preference gating, delivery ledger) runs for real
 * in keyless environments and only the external call is skipped.
 *
 * A non-2xx response throws, which leaves the outbox row pending and the
 * ledger claim unsent, so the dispatcher retries instead of dropping.
 * Per-receipt errors (e.g. DeviceNotRegistered) are not consumed here;
 * pruning dead tokens is a recorded follow-up in decisions-notifications.md.
 */
export class ExpoPushAdapter implements PushSender {
  private static readonly ENDPOINT = 'https://exp.host/--/api/v2/push/send';
  private static readonly BATCH_SIZE = 100; // Expo's documented request cap

  constructor(private readonly accessToken: string) {}

  async send(messages: PushMessage[]): Promise<void> {
    if (messages.length === 0) return;

    if (!this.accessToken) {
      for (const message of messages) {
        console.log(`[push] ${message.title} → ${message.token}`, message.body);
      }
      return;
    }

    for (let i = 0; i < messages.length; i += ExpoPushAdapter.BATCH_SIZE) {
      const batch = messages.slice(i, i + ExpoPushAdapter.BATCH_SIZE);
      const response = await fetch(ExpoPushAdapter.ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(
          batch.map((message) => ({
            to: message.token,
            title: message.title,
            body: message.body,
            ...(message.data ? { data: message.data } : {}),
          })),
        ),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Expo push send failed (${response.status}): ${detail.slice(0, 200)}`);
      }
    }
  }
}
