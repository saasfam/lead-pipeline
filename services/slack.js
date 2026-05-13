import { logger } from './logger.js';

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

export async function notifySlack(text, blocks = null) {
  if (!WEBHOOK_URL) {
    logger.warn('SLACK_WEBHOOK_URL not set, skipping notification');
    return;
  }

  const body = { text };
  if (blocks) body.blocks = blocks;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.error('Slack notification failed', { status: res.status });
    }
  } catch (err) {
    logger.error('Slack notification error', { error: err.message });
  }
}

export function formatPipelineComplete(jobId, vertical, stats) {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Lead Pipeline Complete: ${vertical}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Job ID:*\n${jobId}` },
        { type: 'mrkdwn', text: `*Vertical:*\n${vertical}` },
        { type: 'mrkdwn', text: `*Businesses Scraped:*\n${stats.scraped}` },
        { type: 'mrkdwn', text: `*Contacts Enriched:*\n${stats.enriched}` },
        { type: 'mrkdwn', text: `*Emails Verified:*\n${stats.verified}` },
        { type: 'mrkdwn', text: `*CSVs Exported:*\n${stats.exported}` },
      ],
    },
  ];
}

/**
 * Format Instantly upload results + optional capacity warning as Slack Block Kit blocks.
 *
 * @param {object} uploadResult - From syncLeadsToInstantly()
 * @param {object|null} capacityReport - From checkCapacity() (optional)
 * @returns {Array<object>} - Slack blocks
 */
export function formatInstantlyUpload(uploadResult, capacityReport = null) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Instantly Lead Upload' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Campaign:*\n${uploadResult.campaignName || 'N/A'}` },
        { type: 'mrkdwn', text: `*Uploaded:*\n${uploadResult.uploaded}` },
        { type: 'mrkdwn', text: `*Cached (skipped):*\n${uploadResult.cached}` },
        { type: 'mrkdwn', text: `*Not ready (filtered):*\n${uploadResult.skipped}` },
        { type: 'mrkdwn', text: `*Failed:*\n${uploadResult.failed}` },
      ],
    },
  ];

  if (uploadResult.errors && uploadResult.errors.length > 0) {
    const errorLines = uploadResult.errors
      .slice(0, 5)
      .map((e) => `${e.email}: ${e.error}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Upload Errors:*\n${errorLines}` },
    });
  }

  if (capacityReport && !capacityReport.isCapacitySufficient) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *Capacity Warning:* ${capacityReport.recommendation}\nWarmed: ${capacityReport.warmedAccounts} | Daily capacity: ${capacityReport.dailyCapacity}/day | Deficit: ${capacityReport.deficit}/day`,
        },
      }
    );
  }

  return blocks;
}

/**
 * Format job.stats.warnings[] entries as Slack blocks. Used when the
 * pipeline finished but a swallowed-error path (GCS, Instantly, inbox
 * provisioning, campaign provisioning) fired. Returns an empty array if
 * there are no warnings so callers can spread the result unconditionally.
 *
 * @param {Array<{code: string, message: string}>} warnings
 * @returns {Array<object>} - Slack blocks (possibly empty)
 */
export function formatWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return [];

  const lines = warnings
    .map((w) => `• \`${w.code}\` — ${w.message}${w.error ? ` (${w.error})` : ''}`)
    .join('\n');

  return [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: *Run Warnings (${warnings.length})*\n${lines}`,
      },
    },
  ];
}
