import { instantlyLimiter } from '../pipeline/rate-limiter.js';
import { logger } from './logger.js';

const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const BASE_URL = 'https://api.instantly.ai/api/v2';

/**
 * Check if Instantly API is configured.
 */
export function isConfigured() {
  return Boolean(INSTANTLY_API_KEY);
}

/**
 * Rate-limited fetch wrapper for Instantly API v2.
 * Retries once on 429 (rate limit) with Retry-After header.
 */
async function instantlyFetch(path, options = {}) {
  await instantlyLimiter.acquire();

  const url = `${BASE_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${INSTANTLY_API_KEY}`,
    ...options.headers,
  };

  let res = await fetch(url, { ...options, headers });

  // Single retry on 429
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
    logger.warn('Instantly rate limited, retrying', { path, retryAfter });
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    await instantlyLimiter.acquire();
    res = await fetch(url, { ...options, headers });
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Instantly API ${res.status}: ${errText}`);
  }

  return res.json();
}

/**
 * Create a single lead in a campaign.
 * POST /leads — v2 API accepts one lead per request.
 *
 * @param {string} campaignId - Campaign UUID
 * @param {object} lead - Lead object with email, first_name, last_name, company_name, custom_variables
 * @returns {object} - API response
 */
export async function createLead(campaignId, lead) {
  return instantlyFetch('/leads', {
    method: 'POST',
    body: JSON.stringify({
      email: lead.email,
      campaign: campaignId,
      first_name: lead.first_name || '',
      last_name: lead.last_name || '',
      company_name: lead.company_name || '',
      custom_variables: lead.custom_variables || {},
    }),
  });
}

/**
 * List all campaigns.
 * GET /campaigns
 */
export async function listCampaigns() {
  return instantlyFetch('/campaigns');
}

/**
 * Get a single campaign by ID.
 * GET /campaigns/:id
 */
export async function getCampaignById(id) {
  return instantlyFetch(`/campaigns/${id}`);
}

/**
 * List email accounts.
 * GET /account
 */
export async function listAccounts(limit = 100, skip = 0) {
  return instantlyFetch(`/account?limit=${limit}&skip=${skip}`);
}

/**
 * Get warmup analytics for email accounts.
 * POST /account/getwarmupanalytics
 */
export async function getWarmupAnalytics(emails) {
  return instantlyFetch('/account/getwarmupanalytics', {
    method: 'POST',
    body: JSON.stringify({ emails }),
  });
}

/**
 * Get daily account analytics.
 * GET /account/analytics/daily
 */
export async function getDailyAnalytics(startDate) {
  const params = startDate ? `?start_date=${startDate}` : '';
  return instantlyFetch(`/account/analytics/daily${params}`);
}

/**
 * Get pre-warmed domain list.
 * GET /dfyemailaccountorder/prewarmedupdomainslist
 */
export async function getPrewarmedDomains() {
  return instantlyFetch('/dfyemailaccountorder/prewarmedupdomainslist');
}
