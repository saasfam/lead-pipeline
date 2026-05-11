import {
  createCampaign,
  findCampaignByName,
  assignAccountsToCampaign,
  listAccounts,
  getWarmupAnalytics,
  isConfigured,
} from '../services/instantly.js';
import { landingPageFor, landingHost, getVertical } from '../config/verticals.js';
import { logger } from '../services/logger.js';

const WARMUP_READY_THRESHOLD = 80;

/**
 * Build the Instantly campaign body for a vertical.
 *
 * The sequence uses Instantly's custom_variables ({{personalized_message}},
 * {{sequence_step_2}}, etc.) so each lead's per-record body is rendered at
 * send time. This keeps the campaign body lightweight and per-lead
 * personalization is owned by lead-pipeline, not by Instantly's template UI.
 */
export function buildCampaignBody({ name, verticalKey, verticalLabel, dailyLimit = 50 }) {
  const landingUrl = landingPageFor(verticalKey);
  const trackingHost = landingHost();

  // Subject lines are intentionally generic-but-relevant. The body carries
  // the per-lead personalization; the subject is light so deliverability
  // stays high. Instantly will rotate subjects across the variants.
  const subjectVariants = [
    `Quick question about ${verticalLabel}`,
    `${verticalLabel} ops — 1 thing`,
    `Idea for ${verticalLabel} teams`,
  ];

  // Step delays in days. Mirrors the 4-step value ladder cadence the prompt
  // is tuned for in enrichment/openai-messages.js (init → +3 → +5 → +7).
  const steps = [
    {
      step: 1,
      delay: 0,
      variants: subjectVariants.map((subject) => ({
        subject,
        body: '{{personalized_message}}',
      })),
    },
    {
      step: 2,
      delay: 3,
      variants: [{ subject: `Re: ${subjectVariants[0]}`, body: '{{sequence_step_2}}' }],
    },
    {
      step: 3,
      delay: 5,
      variants: [{ subject: `Re: ${subjectVariants[0]}`, body: '{{sequence_step_3}}' }],
    },
    {
      step: 4,
      delay: 7,
      variants: [{ subject: `Last note — ${verticalLabel}`, body: '{{sequence_step_4}}' }],
    },
  ];

  return {
    name,
    // Drafted, not active. The orchestrator does not launch campaigns —
    // Richard reviews and clicks Launch in the Instantly UI.
    status: 0,
    daily_limit: dailyLimit,
    // Instantly tracks opens/clicks against this domain. We point it at the
    // same root the leads land on so the click links resolve cleanly.
    tracking_domain: trackingHost,
    open_tracking: true,
    link_tracking: true,
    text_only: false,
    schedule: {
      schedules: [
        {
          name: 'Default business hours',
          // Mon-Fri, 9am-5pm local.
          timing: { from: '09:00', to: '17:00' },
          days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false },
          timezone: 'America/New_York',
        },
      ],
    },
    sequences: [{ steps }],
    custom_metadata: {
      vertical: verticalKey,
      vertical_label: verticalLabel,
      landing_page: landingUrl,
      managed_by: 'lead-pipeline',
    },
  };
}

/**
 * Pick warmed Instantly accounts to assign to a vertical's campaign.
 *
 * Strategy: take up to `count` accounts whose warmup score is at or above
 * WARMUP_READY_THRESHOLD. Caller decides what `count` is — typically
 * ceil(targetDailyVolume / dailyPerAccount).
 */
export async function pickWarmedAccounts(count) {
  if (!count || count <= 0) return [];

  const allAccounts = [];
  let skip = 0;
  const limit = 100;
  while (true) {
    const batch = await listAccounts(limit, skip);
    const items = Array.isArray(batch) ? batch : batch.items || batch.data || [];
    if (items.length === 0) break;
    allAccounts.push(...items);
    if (items.length < limit) break;
    skip += limit;
  }

  const emails = allAccounts.map((a) => a.email || a.email_account || '').filter(Boolean);
  if (emails.length === 0) return [];

  // Fetch warmup analytics so we can rank — listAccounts alone doesn't
  // return scores in all API revisions.
  const warmupData = {};
  for (let i = 0; i < emails.length; i += 50) {
    const slice = emails.slice(i, i + 50);
    try {
      const analytics = await getWarmupAnalytics(slice);
      if (Array.isArray(analytics)) {
        for (const entry of analytics) {
          if (entry.email) warmupData[entry.email] = entry;
        }
      } else if (analytics && typeof analytics === 'object') {
        Object.assign(warmupData, analytics);
      }
    } catch (err) {
      logger.warn('Warmup analytics batch failed during account pick', {
        error: err.message,
      });
    }
  }

  const warmed = emails
    .map((email) => {
      const data = warmupData[email] || {};
      const score = data.warmup_score ?? data.score ?? 0;
      return { email, score };
    })
    .filter((a) => a.score >= WARMUP_READY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  return warmed.slice(0, count).map((a) => a.email);
}

/**
 * Idempotent per-vertical campaign provisioner.
 *
 * Finds the campaign named `Anyreach - {Label} - {YYYY-MM}` and returns it
 * if it exists. Otherwise creates it, assigns N warmed accounts, and returns
 * the newly-created campaign object.
 *
 * Status stays at draft regardless. Launch is a manual click in the
 * Instantly UI — see auto mode question 2 (user chose "stage as draft").
 *
 * @param {string} verticalKey
 * @param {object} options
 * @param {number} options.dailyLimit       - Per-account daily send cap inside Instantly
 * @param {number} options.targetVolume     - Target daily emails to drive account picker
 * @param {number} options.dailyPerAccount  - Safe per-account daily (default 30)
 * @returns {{ campaignId: string, campaignName: string, created: boolean, assignedAccounts: number }}
 */
export async function ensureCampaignForVertical(verticalKey, options = {}) {
  if (!isConfigured()) {
    logger.info('INSTANTLY_API_KEY not set, skipping campaign provisioning');
    return null;
  }

  const vertical = getVertical(verticalKey);
  if (!vertical) throw new Error(`Unknown vertical: ${verticalKey}`);

  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const name = `Anyreach - ${vertical.label} - ${month}`;

  const dailyLimit = options.dailyLimit ?? 50;
  const targetVolume = options.targetVolume ?? 500;
  const dailyPerAccount = options.dailyPerAccount ?? 30;

  // 1. Idempotency: return the existing campaign if present.
  const existing = await findCampaignByName(name);
  if (existing) {
    const campaignId = existing.id || existing.campaign_id;
    logger.info('Reusing existing campaign', { campaignId, name });
    return {
      campaignId,
      campaignName: name,
      created: false,
      assignedAccounts: Array.isArray(existing.email_list) ? existing.email_list.length : 0,
    };
  }

  // 2. Create campaign in draft.
  const body = buildCampaignBody({
    name,
    verticalKey,
    verticalLabel: vertical.label,
    dailyLimit,
  });
  const created = await createCampaign(body);
  const campaignId = created.id || created.campaign_id;
  logger.info('Campaign created (draft)', { campaignId, name });

  // 3. Assign warmed accounts. Best-effort: failure to assign does NOT fail
  // provisioning — the campaign still exists and a human can attach
  // accounts in the Instantly UI before launching.
  let assignedAccounts = 0;
  try {
    const needed = Math.ceil(targetVolume / dailyPerAccount);
    const accountEmails = await pickWarmedAccounts(needed);
    if (accountEmails.length > 0) {
      await assignAccountsToCampaign(campaignId, accountEmails);
      assignedAccounts = accountEmails.length;
      logger.info('Accounts assigned to campaign', { campaignId, assignedAccounts });
    } else {
      logger.warn('No warmed accounts available to assign', { campaignId });
    }
  } catch (err) {
    logger.warn('Account assignment failed (campaign still created)', {
      campaignId,
      error: err.message,
    });
  }

  return { campaignId, campaignName: name, created: true, assignedAccounts };
}
