-- Scheduling package B, step 4 (destructive, after code cutover): the legacy
-- booking tables are superseded by resource_types / resources / slot_claims /
-- reservations, and stream_checkpoints by the audit-log + outbox model
-- (dispatchedAt on events; no seq-cursor checkpoints).

DROP TABLE "club_event_courts";
DROP TABLE "bookings";
DROP TABLE "courts";
DROP TABLE "showers";
DROP TABLE "stream_checkpoints";
