import { checkCapacity } from './instantly-capacity.js';
import { getPrewarmedDomains, orderDfyMailboxes, isConfigured } from './instantly.js';
import { logger } from './logger.js';

const DEFAULT_DAILY_PER_ACCOUNT = 30;
const ABSOLUTE_HARD_CAP = 500;

/**
 * Plan an inbox order to close the capacity deficit.
 *
 * Pure: takes capacity report + prewarmed domain list, returns a plan
 * (no API calls). Easy to test, easy to gate.
 *
 * @param {object} capacityReport - From services/instantly-capacity.checkCapacity()
 * @param {Array<object>} prewarmedDomains - From Instantly's prewarmed list
 * @param {object} options
 * @returns {object} plan
 */
export function planInboxOrder(capacityReport, prewarmedDomains, options = {}) {
  const dailyPerAccount = options.dailyPerAccount ?? DEFAULT_DAILY_PER_ACCOUNT;
  const maxMailboxes = Math.min(options.maxMailboxes ?? 0, ABSOLUTE_HARD_CAP);
  const mailboxesPerDomain = options.mailboxesPerDomain ?? 3;

  if (!capacityReport || capacityReport.deficit <= 0) {
    return {
      mailboxesNeeded: 0,
      mailboxesPlanned: 0,
      domains: [],
      items: [],
      reason: 'No capacity deficit — no order needed.',
    };
  }

  const mailboxesNeeded = Math.ceil(capacityReport.deficit / dailyPerAccount);

  if (maxMailboxes === 0) {
    return {
      mailboxesNeeded,
      mailboxesPlanned: 0,
      domains: [],
      items: [],
      reason:
        'INSTANTLY_MAX_MAILBOXES_PER_RUN is unset or 0 — plan-only mode. ' +
        `Need ${mailboxesNeeded} mailboxes. Set the env var to authorize ordering.`,
    };
  }

  const mailboxesPlanned = Math.min(mailboxesNeeded, maxMailboxes);

  // Drop domains we can't actually order against. Instantly's prewarmed list
  // is sometimes returned as a flat array of strings and sometimes as
  // objects with various shapes — normalize to { domain, available? }.
  const candidates = (prewarmedDomains || [])
    .map((d) => {
      if (typeof d === 'string') return { domain: d, available: null };
      return {
        domain: d.domain || d.name || '',
        available: d.available ?? d.in_stock ?? null,
      };
    })
    .filter((d) => d.domain);

  // Prefer domains explicitly marked available; fall back to all otherwise.
  const usable = candidates.some((d) => d.available)
    ? candidates.filter((d) => d.available)
    : candidates;

  if (usable.length === 0) {
    return {
      mailboxesNeeded,
      mailboxesPlanned: 0,
      domains: [],
      items: [],
      reason: 'No prewarmed domains available from Instantly. Add inventory or wait.',
    };
  }

  // Fan out across domains so we don't hammer one domain with the whole
  // order. Round-robin in chunks of mailboxesPerDomain until we've allocated
  // mailboxesPlanned. The 10000-iteration ceiling is a safety net against
  // pathological inputs; in practice we exit on `remaining === 0`.
  const items = [];
  let remaining = mailboxesPlanned;
  let i = 0;
  while (remaining > 0 && i < 10000) {
    const domain = usable[i % usable.length].domain;
    const take = Math.min(mailboxesPerDomain, remaining);
    const existing = items.find((it) => it.domain === domain);
    if (existing) {
      existing.num_accounts += take;
    } else {
      items.push({ domain, num_accounts: take });
    }
    remaining -= take;
    i++;
  }

  // Truth-source: the actual sum of items is what we'd order. If the loop
  // bailed early, mailboxesPlanned reflects reality (not the pre-loop intent).
  const allocated = items.reduce((s, it) => s + it.num_accounts, 0);

  return {
    mailboxesNeeded,
    mailboxesPlanned: allocated,
    domains: items.map((it) => it.domain),
    items,
    reason: allocated < mailboxesNeeded
      ? `Cap-limited: planned ${allocated} of ${mailboxesNeeded} needed.`
      : `Planned ${allocated} mailboxes to fully close deficit.`,
  };
}

/**
 * Provision inboxes end-to-end:
 *   1. checkCapacity against targetDailyVolume
 *   2. planInboxOrder using INSTANTLY_MAX_MAILBOXES_PER_RUN as the cap
 *   3. if INSTANTLY_AUTO_ORDER === 'true' AND plan has items, post the order
 *
 * Returns { capacityReport, plan, orderResult|null, dryRun }.
 */
export async function provisionInboxes(options = {}) {
  if (!isConfigured()) {
    logger.info('INSTANTLY_API_KEY not set, cannot provision inboxes');
    return { capacityReport: null, plan: null, orderResult: null, dryRun: true };
  }

  const targetDailyVolume = options.targetDailyVolume
    ?? parseInt(process.env.INSTANTLY_TARGET_DAILY_VOLUME || '5000', 10);
  const maxMailboxes = options.maxMailboxes
    ?? parseInt(process.env.INSTANTLY_MAX_MAILBOXES_PER_RUN || '0', 10);
  const autoOrder = options.autoOrder
    ?? (process.env.INSTANTLY_AUTO_ORDER === 'true');

  const capacityReport = await checkCapacity(targetDailyVolume);

  let prewarmedDomains = [];
  if (capacityReport.deficit > 0) {
    try {
      const res = await getPrewarmedDomains();
      prewarmedDomains = Array.isArray(res) ? res : res.items || res.data || res.domains || [];
    } catch (err) {
      logger.warn('Failed to fetch prewarmed domain list', { error: err.message });
    }
  }

  const plan = planInboxOrder(capacityReport, prewarmedDomains, { maxMailboxes });

  let orderResult = null;
  const dryRun = !autoOrder || plan.mailboxesPlanned === 0;

  if (!dryRun) {
    logger.info('Submitting DFY inbox order', {
      mailboxes: plan.mailboxesPlanned,
      domains: plan.domains.length,
    });
    try {
      orderResult = await orderDfyMailboxes({ items: plan.items });
      logger.info('DFY inbox order accepted', { mailboxes: plan.mailboxesPlanned });
    } catch (err) {
      logger.error('DFY inbox order failed', { error: err.message });
      orderResult = { error: err.message };
    }
  } else if (plan.mailboxesPlanned > 0) {
    logger.info('Inbox order plan ready (dry run — set INSTANTLY_AUTO_ORDER=true to submit)', {
      mailboxes: plan.mailboxesPlanned,
      domains: plan.domains.length,
    });
  }

  return { capacityReport, plan, orderResult, dryRun };
}
