import { RateLimiter } from '../../pipeline/rate-limiter.js';
import { logger } from '../../services/logger.js';

const MILLIONVERIFIER_BASE_URL = 'https://api.millionverifier.com/api/v3';

// MillionVerifier's documented limit is ~80 req/s on the real-time endpoint.
// 50/s gives headroom while keeping the verify step from being the bottleneck.
const limiter = new RateLimiter(50, 1_000);

/**
 * Map MillionVerifier's `result` field to the pipeline's normalized status.
 *
 * MillionVerifier returns one of: ok, catch_all, unknown, error, disposable,
 * invalid. We treat catch_all as 'unknown' (some teams treat it as deliverable
 * and accept the higher bounce risk — flip via MILLIONVERIFIER_INCLUDE_CATCHALL).
 *
 * @param {string} result
 * @returns {'valid' | 'invalid' | 'unknown'}
 */
export function mapMillionVerifierResult(result) {
  switch ((result || '').toLowerCase()) {
    case 'ok':
    case 'valid':
      return 'valid';
    case 'invalid':
    case 'disposable':
      return 'invalid';
    case 'catch_all':
      return process.env.MILLIONVERIFIER_INCLUDE_CATCHALL === 'true' ? 'valid' : 'unknown';
    case 'unknown':
    case 'error':
    default:
      return 'unknown';
  }
}

/**
 * Verify a single email against MillionVerifier v3 real-time endpoint.
 *
 * GET /api/v3/?api={key}&email={email}&timeout=10
 *
 * Response body: { email, result, score, quality, free, role, ... }
 *
 * @param {string} email
 * @returns {Promise<{ status: 'valid'|'invalid'|'unknown', raw: object|null }>}
 */
export async function verifySingle(email) {
  await limiter.acquire();

  const apiKey = process.env.MILLIONVERIFIER_API_KEY;
  if (!apiKey) {
    logger.error('MILLIONVERIFIER_API_KEY not set');
    return { status: 'unknown', raw: null };
  }

  const url = `${MILLIONVERIFIER_BASE_URL}/?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=10`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn('MillionVerifier non-2xx', { email, status: res.status });
      return { status: 'unknown', raw: null };
    }
    const data = await res.json();
    return { status: mapMillionVerifierResult(data.result), raw: data };
  } catch (err) {
    logger.warn('MillionVerifier request failed', { email, error: err.message });
    return { status: 'unknown', raw: null };
  }
}

/**
 * Verify many emails concurrently. Caller controls concurrency; default 25
 * stays well under the limiter (50/s) so we don't queue more than ~half a
 * second of work at any moment.
 *
 * @param {Array<string>} emails
 * @param {object} [opts]
 * @param {number} [opts.concurrency=25]
 * @returns {Promise<Map<string, 'valid'|'invalid'|'unknown'>>}
 */
export async function verifyMany(emails, opts = {}) {
  const concurrency = opts.concurrency ?? 25;
  const results = new Map();

  for (let i = 0; i < emails.length; i += concurrency) {
    const batch = emails.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map(async (email) => {
        const r = await verifySingle(email);
        return [email, r.status];
      })
    );
    for (const [email, status] of settled) results.set(email, status);

    if ((i + batch.length) % 500 === 0 || i + batch.length === emails.length) {
      logger.info('MillionVerifier progress', {
        processed: i + batch.length,
        total: emails.length,
      });
    }
  }

  return results;
}

export function isConfigured() {
  return Boolean(process.env.MILLIONVERIFIER_API_KEY);
}
