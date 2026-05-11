import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createLead, listCampaigns, getCampaignById, isConfigured } from '../services/instantly.js';
import { landingPageFor } from '../config/verticals.js';
import { logger } from '../services/logger.js';

/**
 * Sync leads to Instantly campaign via API.
 * Uploads leads individually (v2 API requires one lead per POST).
 *
 * @param {Array<object>} leads - Enriched leads (from Phase 5 output)
 * @param {object} options
 * @param {string} options.campaignId - Campaign UUID (or auto-detect)
 * @param {boolean} options.force - Ignore cache
 * @returns {object} - Upload results
 */
export async function syncLeadsToInstantly(leads, options = {}) {
  if (!isConfigured()) {
    logger.info('INSTANTLY_API_KEY not set, skipping Instantly upload');
    return { uploaded: 0, skipped: 0, cached: 0, failed: 0, campaignId: null, campaignName: null, errors: [] };
  }

  // Filter to ready-only leads
  const readyLeads = leads.filter((l) => l.messageFlag === 'ready');
  const skipped = leads.length - readyLeads.length;

  logger.info('Instantly sync starting', {
    totalLeads: leads.length,
    readyLeads: readyLeads.length,
    skipped,
  });

  if (readyLeads.length === 0) {
    logger.info('No ready leads to upload');
    return { uploaded: 0, skipped, cached: 0, failed: 0, campaignId: null, campaignName: null, errors: [] };
  }

  // Resolve campaign
  const campaignId = await resolveCampaign(options.campaignId);
  let campaignName = campaignId;
  try {
    const campaign = await getCampaignById(campaignId);
    campaignName = campaign.name || campaign.campaign_name || campaignId;
  } catch {
    // Non-critical — use ID as name
  }

  logger.info('Target campaign resolved', { campaignId, campaignName });

  // Load upload cache
  const date = new Date().toISOString().slice(0, 10);
  const cacheFile = `./output/.instantly-upload-cache-${date}.json`;
  let uploadCache = {};
  if (!options.force && existsSync(cacheFile)) {
    try {
      uploadCache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      logger.info('Upload cache loaded', { cached: Object.keys(uploadCache).length });
    } catch { uploadCache = {}; }
  }

  // Filter out already-cached leads
  const toUpload = [];
  let cached = 0;
  for (const lead of readyLeads) {
    if (uploadCache[lead.email]) {
      cached++;
    } else {
      toUpload.push(lead);
    }
  }

  logger.info('Leads after cache filter', { toUpload: toUpload.length, cached });

  // Upload leads individually (v2 API: one POST per lead)
  let uploaded = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < toUpload.length; i++) {
    const lead = toUpload[i];
    const instantlyLead = mapLeadToInstantly(lead);

    try {
      await createLead(campaignId, instantlyLead);

      uploadCache[lead.email] = { uploadedAt: new Date().toISOString(), campaignId };
      uploaded++;

      if ((uploaded % 10 === 0) || uploaded === toUpload.length) {
        logger.info('Upload progress', { uploaded, total: toUpload.length, failed });
      }
    } catch (err) {
      failed++;
      errors.push({ email: lead.email, error: err.message });
      logger.error('Lead upload failed', { email: lead.email, error: err.message });
      // Continue — individual failures don't block others
    }

    // Save cache every 25 leads
    if ((i + 1) % 25 === 0 || i === toUpload.length - 1) {
      writeFileSync(cacheFile, JSON.stringify(uploadCache, null, 2));
    }
  }

  const result = { uploaded, skipped, cached, failed, campaignId, campaignName, errors };

  logger.info('Instantly sync complete', result);
  return result;
}

/**
 * Resolve which campaign to upload to.
 * Priority: env var > options > list active campaigns > error with listing.
 */
async function resolveCampaign(optionsCampaignId) {
  // 1. Env var
  const envId = process.env.INSTANTLY_CAMPAIGN_ID;
  if (envId) return envId;

  // 2. Options/flag
  if (optionsCampaignId) return optionsCampaignId;

  // 3. Auto-detect: list active campaigns
  let campaigns;
  try {
    campaigns = await listCampaigns();
  } catch (err) {
    throw new Error(`Cannot list campaigns: ${err.message}. Set INSTANTLY_CAMPAIGN_ID env var.`);
  }

  const items = Array.isArray(campaigns) ? campaigns : campaigns.items || campaigns.data || [];
  const active = items.filter((c) => c.status === 'active' || c.status === 1);

  if (active.length === 1) {
    return active[0].id || active[0].campaign_id;
  }

  // Multiple or none — error with helpful listing
  if (items.length === 0) {
    throw new Error('No campaigns found. Create a campaign in Instantly UI, then set INSTANTLY_CAMPAIGN_ID.');
  }

  const listing = items
    .slice(0, 10)
    .map((c) => `  ${c.id || c.campaign_id} — ${c.name || c.campaign_name} (${c.status})`)
    .join('\n');

  throw new Error(
    `Multiple campaigns found. Set INSTANTLY_CAMPAIGN_ID to one of:\n${listing}`
  );
}

/**
 * Map enriched lead to Instantly lead format.
 */
function mapLeadToInstantly(lead) {
  const verticalKey = lead.verticalKey || lead.vertical || '';
  return {
    email: lead.email,
    first_name: lead.firstName || '',
    last_name: lead.lastName || '',
    company_name: lead.companyName || '',
    custom_variables: {
      title: lead.title || '',
      vertical: lead.vertical || '',
      landing_page: lead.landingPage || landingPageFor(verticalKey),
      personalized_hook: lead.personalizedHook || '',
      personalized_message: lead.personalizedMessage || '',
      sequence_step_2: lead.sequenceStep2 || '',
      sequence_step_3: lead.sequenceStep3 || '',
      sequence_step_4: lead.sequenceStep4 || '',
      linkedin_url: lead.linkedinUrl || '',
      city: lead.city || '',
      state: lead.state || '',
      website: lead.companyDomain ? `https://${lead.companyDomain}` : '',
    },
  };
}
