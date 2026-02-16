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
