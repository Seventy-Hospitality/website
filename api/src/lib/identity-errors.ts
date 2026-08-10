import type { FastifyReply } from 'fastify';
import {
  AccountUnavailableError,
  EmailInUseError,
  IdentityConfigError,
  InvalidCredentialsError,
  InvalidTokenError,
  LinkRejectedError,
  NotAuthorizedError,
  SessionExpiredError,
} from '@/lib/contexts/identity';
import { error } from './responses';

const LINK_REJECTION_STATUS: Record<LinkRejectedError['reason'], number> = {
  email_required: 400,
  account_unavailable: 403,
  provider_email_unverified: 409,
  linked_to_other_account: 409,
  provider_already_linked: 409,
  account_email_unverified: 403,
  not_linked: 404,
  last_credential: 409,
};

/** Shared identity error -> HTTP mapping for every route that authenticates. */
export function handleIdentityError(reply: FastifyReply, err: unknown) {
  if (err instanceof EmailInUseError) return error(reply, 'EMAIL_IN_USE', err.message, 409);
  if (err instanceof InvalidCredentialsError) return error(reply, 'INVALID_CREDENTIALS', err.message, 401);
  if (err instanceof AccountUnavailableError) return error(reply, 'ACCOUNT_UNAVAILABLE', err.message, 403);
  if (err instanceof LinkRejectedError) {
    return error(reply, 'LINK_REJECTED', err.message, LINK_REJECTION_STATUS[err.reason]);
  }
  if (err instanceof InvalidTokenError) return error(reply, 'INVALID_TOKEN', err.message, 401);
  if (err instanceof SessionExpiredError) return error(reply, 'SESSION_EXPIRED', err.message, 401);
  if (err instanceof NotAuthorizedError) return error(reply, 'FORBIDDEN', err.message, 403);
  if (err instanceof IdentityConfigError) return error(reply, 'NOT_CONFIGURED', err.message, 501);
  throw err;
}
