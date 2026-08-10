-- Emails are normalized (lowercased + trimmed) at every application entry point;
-- bring existing rows in line. Fails loudly on case-only duplicates via the
-- existing unique indexes, which would need manual resolution.
UPDATE "users" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));
UPDATE "members" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));
UPDATE "magic_link_tokens" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));
