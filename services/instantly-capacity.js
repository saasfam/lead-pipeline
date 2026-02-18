import { listAccounts, getWarmupAnalytics } from './instantly.js';
import { logger } from './logger.js';

const EMAILS_PER_ACCOUNT_PER_DAY = 30; // Safe daily limit per warmed account
const WARMUP_READY_THRESHOLD = 80;     // Warmup score to count as "warmed"

/**
 * Check inbox capacity against a target daily volume.
 *
 * @param {number} targetDailyVolume - Target emails per day (default 5000)
 * @returns {object} - Capacity report
 */
export async function checkCapacity(targetDailyVolume = 5000) {
  logger.info('Checking Instantly inbox capacity', { targetDailyVolume });

  // Paginate through all accounts
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

  const totalAccounts = allAccounts.length;
  if (totalAccounts === 0) {
    return {
      totalAccounts: 0,
      warmedAccounts: 0,
      warmingAccounts: 0,
      coldAccounts: 0,
      dailyCapacity: 0,
      deficit: targetDailyVolume,
      deficitAccounts: Math.ceil(targetDailyVolume / EMAILS_PER_ACCOUNT_PER_DAY),
      isCapacitySufficient: false,
      recommendation: 'No email accounts found. Add and warm up accounts in Instantly.',
      accountsNeedingAttention: [],
    };
  }

  // Fetch warmup analytics in batches of 50
  const emails = allAccounts.map((a) => a.email || a.email_account || '').filter(Boolean);
  let warmupData = {};

  for (let i = 0; i < emails.length; i += 50) {
    const batch = emails.slice(i, i + 50);
    try {
      const analytics = await getWarmupAnalytics(batch);
      // Merge results — API may return object keyed by email or array
      if (Array.isArray(analytics)) {
        for (const entry of analytics) {
          if (entry.email) warmupData[entry.email] = entry;
        }
      } else if (analytics && typeof analytics === 'object') {
        Object.assign(warmupData, analytics);
      }
    } catch (err) {
      logger.warn('Warmup analytics batch failed', { error: err.message, batch: batch.length });
    }
  }

  // Classify accounts
  let warmedAccounts = 0;
  let warmingAccounts = 0;
  let coldAccounts = 0;
  const accountsNeedingAttention = [];

  for (const email of emails) {
    const data = warmupData[email] || {};
    const score = data.warmup_score ?? data.score ?? 0;

    if (score >= WARMUP_READY_THRESHOLD) {
      warmedAccounts++;
    } else if (score > 0) {
      warmingAccounts++;
      accountsNeedingAttention.push({ email, score, status: 'warming' });
    } else {
      coldAccounts++;
      accountsNeedingAttention.push({ email, score, status: 'cold' });
    }
  }

  const dailyCapacity = warmedAccounts * EMAILS_PER_ACCOUNT_PER_DAY;
  const deficit = Math.max(0, targetDailyVolume - dailyCapacity);
  const deficitAccounts = deficit > 0 ? Math.ceil(deficit / EMAILS_PER_ACCOUNT_PER_DAY) : 0;
  const isCapacitySufficient = deficit === 0;

  let recommendation;
  if (isCapacitySufficient) {
    const buffer = ((dailyCapacity / targetDailyVolume - 1) * 100).toFixed(0);
    recommendation = `Capacity sufficient with ${buffer}% buffer.`;
  } else {
    recommendation = `Need ${deficitAccounts} more warmed accounts to reach ${targetDailyVolume}/day target.`;
    if (warmingAccounts > 0) {
      recommendation += ` ${warmingAccounts} accounts are currently warming up.`;
    }
  }

  const report = {
    totalAccounts,
    warmedAccounts,
    warmingAccounts,
    coldAccounts,
    dailyCapacity,
    deficit,
    deficitAccounts,
    isCapacitySufficient,
    recommendation,
    accountsNeedingAttention: accountsNeedingAttention.slice(0, 20), // Limit to top 20
  };

  logger.info('Capacity check complete', {
    totalAccounts,
    warmedAccounts,
    dailyCapacity,
    deficit,
  });

  return report;
}

/**
 * Format capacity report for console output.
 */
export function formatCapacityReport(report) {
  const lines = [
    '',
    '═'.repeat(50),
    '  INSTANTLY INBOX CAPACITY',
    '═'.repeat(50),
    `  Total accounts:     ${report.totalAccounts}`,
    `  Warmed (score≥80):  ${report.warmedAccounts}`,
    `  Warming:            ${report.warmingAccounts}`,
    `  Cold:               ${report.coldAccounts}`,
    '',
    `  Daily capacity:     ${report.dailyCapacity} emails/day`,
    `  Deficit:            ${report.deficit > 0 ? report.deficit + ' emails/day' : 'None'}`,
    `  Deficit accounts:   ${report.deficitAccounts > 0 ? report.deficitAccounts + ' needed' : 'None'}`,
    '',
    `  Status: ${report.isCapacitySufficient ? 'SUFFICIENT' : 'INSUFFICIENT'}`,
    `  ${report.recommendation}`,
    '═'.repeat(50),
  ];

  if (report.accountsNeedingAttention.length > 0) {
    lines.push('', '  Accounts needing attention:');
    for (const a of report.accountsNeedingAttention.slice(0, 10)) {
      lines.push(`    ${a.email} — score: ${a.score}, status: ${a.status}`);
    }
    if (report.accountsNeedingAttention.length > 10) {
      lines.push(`    ... and ${report.accountsNeedingAttention.length - 10} more`);
    }
  }

  return lines.join('\n');
}

/**
 * Format capacity report as Slack Block Kit blocks.
 */
export function formatCapacitySlackBlocks(report) {
  const statusEmoji = report.isCapacitySufficient ? ':white_check_mark:' : ':warning:';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${statusEmoji} Inbox Capacity Report` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Total Accounts:*\n${report.totalAccounts}` },
        { type: 'mrkdwn', text: `*Warmed (≥80):*\n${report.warmedAccounts}` },
        { type: 'mrkdwn', text: `*Warming:*\n${report.warmingAccounts}` },
        { type: 'mrkdwn', text: `*Cold:*\n${report.coldAccounts}` },
        { type: 'mrkdwn', text: `*Daily Capacity:*\n${report.dailyCapacity}/day` },
        { type: 'mrkdwn', text: `*Deficit:*\n${report.deficit > 0 ? report.deficit + '/day' : 'None'}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: report.recommendation },
    },
  ];

  return blocks;
}
