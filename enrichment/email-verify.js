import { verifyEmails as apolloVerify } from './apollo-verify.js';
import { verifyMany as millionverifierVerifyMany, isConfigured as millionverifierConfigured } from './verifiers/millionverifier.js';
import { logger } from '../services/logger.js';

/**
 * Provider-agnostic email verification.
 *
 * Dispatches on `EMAIL_VERIFY_PROVIDER`:
 *   - "apollo" (default) → existing Apollo implementation, unchanged behavior
 *   - "millionverifier"  → MillionVerifier v3 (~$0.005/verify vs Apollo ~$0.04)
 *
 * Returns the same shape as apollo-verify.verifyEmails(): only contacts with
 * `emailStatus === 'valid'`, attached as a new property. Drop-in compatible.
 *
 * @param {Array<object>} contacts
 * @returns {Promise<Array<object>>}
 */
export async function verifyEmails(contacts) {
  const provider = (process.env.EMAIL_VERIFY_PROVIDER || 'apollo').toLowerCase();

  if (provider === 'millionverifier') {
    if (!millionverifierConfigured()) {
      // Fail loud — silently falling back to Apollo would change the cost
      // line item without the operator noticing.
      throw new Error(
        'EMAIL_VERIFY_PROVIDER=millionverifier but MILLIONVERIFIER_API_KEY is unset'
      );
    }
    return verifyViaMillionVerifier(contacts);
  }

  if (provider !== 'apollo') {
    logger.warn('Unknown EMAIL_VERIFY_PROVIDER, falling back to apollo', { provider });
  }

  return apolloVerify(contacts);
}

/**
 * MillionVerifier path. Mirrors the apollo-verify shape so the orchestrator
 * doesn't care which provider ran.
 */
async function verifyViaMillionVerifier(contacts) {
  const withEmail = contacts.filter((c) => c.email);
  if (withEmail.length === 0) return [];

  const emails = withEmail.map((c) => c.email);
  logger.info('Starting email verification (MillionVerifier)', { count: emails.length });

  const statuses = await millionverifierVerifyMany(emails);

  const verified = withEmail
    .map((c) => ({
      ...c,
      emailStatus: statuses.get(c.email) || 'unknown',
      emailVerifyProvider: 'millionverifier',
    }))
    .filter((c) => c.emailStatus === 'valid');

  logger.info('Email verification complete (MillionVerifier)', {
    total: emails.length,
    valid: verified.length,
    rate: `${((verified.length / emails.length) * 100).toFixed(1)}%`,
  });

  return verified;
}
