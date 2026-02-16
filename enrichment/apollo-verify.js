import { apolloLimiter } from '../pipeline/rate-limiter.js';
import { logger } from '../services/logger.js';

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

/**
 * Verify a batch of emails via Apollo.
 * Apollo supports up to 10 emails per verification request.
 *
 * @param {Array<string>} emails - Emails to verify
 * @returns {Map<string, string>} - Map of email → status ('valid', 'invalid', 'unknown')
 */
async function verifyBatch(emails) {
  await apolloLimiter.acquire();

  try {
    const res = await fetch(`${APOLLO_BASE_URL}/email_verification/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': APOLLO_API_KEY,
      },
      body: JSON.stringify({ emails }),
    });

    if (!res.ok) {
      logger.error('Apollo email verification failed', { status: res.status });
      // Return unknown for all on failure
      return new Map(emails.map((e) => [e, 'unknown']));
    }

    const data = await res.json();
    const results = new Map();

    for (const result of data.email_verifications || []) {
      results.set(result.email, result.status || 'unknown');
    }

    return results;
  } catch (err) {
    logger.error('Apollo email verification error', { error: err.message });
    return new Map(emails.map((e) => [e, 'unknown']));
  }
}

/**
 * Verify all emails in a contacts array.
 * Returns only contacts with verified ('valid') emails.
 *
 * @param {Array<object>} contacts - Contacts with `email` field
 * @returns {Array<object>} - Contacts with verified emails, plus `emailStatus` field
 */
export async function verifyEmails(contacts) {
  const withEmail = contacts.filter((c) => c.email);
  const emails = withEmail.map((c) => c.email);

  if (emails.length === 0) return [];

  logger.info('Starting email verification', { count: emails.length });

  const allResults = new Map();
  const batchSize = 10;

  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);
    const batchResults = await verifyBatch(batch);

    for (const [email, status] of batchResults) {
      allResults.set(email, status);
    }
  }

  const verified = withEmail
    .map((c) => ({
      ...c,
      emailStatus: allResults.get(c.email) || 'unknown',
    }))
    .filter((c) => c.emailStatus === 'valid');

  logger.info('Email verification complete', {
    total: emails.length,
    valid: verified.length,
    rate: `${((verified.length / emails.length) * 100).toFixed(1)}%`,
  });

  return verified;
}
