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

/**
 * Create an Instantly campaign.
 *
 * Returns the created campaign object. We pass the campaign body as-is so
 * callers can shape it (sequence steps, schedule, tracking domain, etc.).
 * Created campaigns default to draft (status 0) — Instantly requires an
 * explicit launch call to start sending.
 *
 * @param {object} campaignBody - Campaign payload
 * @returns {object}
 */
export async function createCampaign(campaignBody) {
  return instantlyFetch('/campaigns', {
    method: 'POST',
    body: JSON.stringify(campaignBody),
  });
}

/**
 * Update a campaign by ID (PATCH-style merge on Instantly's end).
 */
export async function updateCampaign(campaignId, patch) {
  return instantlyFetch(`/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/**
 * Look up a campaign by exact name. Used to keep ensureCampaignForVertical()
 * idempotent across runs.
 *
 * @param {string} name
 * @returns {object|null}
 */
export async function findCampaignByName(name) {
  let skip = 0;
  const limit = 100;
  // Instantly's /campaigns is paginated. Scan up to 1000 campaigns before
  // giving up — anyone with more campaigns than that should pass an ID.
  for (let page = 0; page < 10; page++) {
    const batch = await instantlyFetch(`/campaigns?limit=${limit}&skip=${skip}`);
    const items = Array.isArray(batch) ? batch : batch.items || batch.data || [];
    if (items.length === 0) return null;
    const hit = items.find((c) => (c.name || c.campaign_name) === name);
    if (hit) return hit;
    if (items.length < limit) return null;
    skip += limit;
  }
  return null;
}

/**
 * Assign email accounts to a campaign. Instantly v2 exposes this via the
 * campaign accounts collection; the exact shape is documented inconsistently
 * across the public docs, so we try the documented path first and fall back
 * to a PATCH-on-campaign with the email_list field, which is the v1-style
 * shape that most v2 deploys still accept.
 */
export async function assignAccountsToCampaign(campaignId, emails) {
  if (!Array.isArray(emails) || emails.length === 0) return { assigned: 0 };

  // Preferred path: PATCH /campaigns/:id with email_list. This is the field
  // surfaced in the campaign object itself, so updating it is the most
  // portable approach across API revisions.
  try {
    const res = await updateCampaign(campaignId, { email_list: emails });
    return { assigned: emails.length, response: res };
  } catch (err) {
    logger.warn('PATCH email_list failed, attempting POST /campaigns/:id/accounts', {
      campaignId,
      error: err.message,
    });
  }

  // Fallback: POST /campaigns/:id/accounts { emails: [...] }
  const res = await instantlyFetch(`/campaigns/${campaignId}/accounts`, {
    method: 'POST',
    body: JSON.stringify({ emails }),
  });
  return { assigned: emails.length, response: res };
}

/**
 * Order DFY (done-for-you) prewarmed mailboxes.
 *
 * The Instantly endpoint is documented as POST /dfyemailaccountorder with a
 * payload listing the prewarmed domains and the number of accounts per
 * domain. We never call this without an explicit safety gate — see
 * services/inbox-orderer.js for the wrapper.
 *
 * @param {object} orderBody - { items: [{ domain, num_accounts }], ... }
 * @returns {object}
 */
export async function orderDfyMailboxes(orderBody) {
  return instantlyFetch('/dfyemailaccountorder', {
    method: 'POST',
    body: JSON.stringify(orderBody),
  });
}
