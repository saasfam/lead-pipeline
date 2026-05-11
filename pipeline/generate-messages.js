import { searchCompanySignals } from '../enrichment/perplexity-signals.js';
import { generateSequence } from '../enrichment/openai-messages.js';
import { assignVariety } from '../config/message-variety.js';
import { landingPageFor } from '../config/verticals.js';
import { logger } from '../services/logger.js';

const DEFAULT_MAX_CONTACTS = 1000;
const DEFAULT_CONCURRENCY = 5;

/**
 * Per-orchestrator step: turn verified contacts into Instantly-ready leads
 * by attaching Perplexity-sourced signals and a 4-step OpenAI sequence.
 *
 * Without this step, contacts arrive at instantly-sync.js without
 * messageFlag === 'ready' and the whole upload step is a no-op.
 *
 * @param {Array<object>} contacts
 * @param {object} vertical            - From getVertical(verticalKey)
 * @param {string} verticalKey
 * @param {object} options
 * @param {number} options.maxContacts - Hard cap (default 1000, env MESSAGES_MAX_PER_VERTICAL)
 * @param {number} options.concurrency - Parallel OpenAI calls (default 5)
 * @returns {{ leads: Array<object>, stats: { generated, failed, skipped } }}
 */
export async function generateMessagesForContacts(contacts, vertical, verticalKey, options = {}) {
  const maxContacts =
    options.maxContacts
    ?? parseInt(process.env.MESSAGES_MAX_PER_VERTICAL || String(DEFAULT_MAX_CONTACTS), 10);
  const concurrency =
    options.concurrency
    ?? parseInt(process.env.MESSAGES_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10);

  if (process.env.MESSAGES_ENABLED === 'false') {
    logger.info('Message generation disabled by MESSAGES_ENABLED=false');
    return { leads: contacts, stats: { generated: 0, failed: 0, skipped: contacts.length } };
  }

  // Cap upfront so cost/time stay predictable. Take the leads with verified
  // emails first since they're the only ones we'd actually mail anyway.
  const verified = contacts.filter((c) => c.email && c.emailStatus !== 'invalid');
  const sorted = [...verified].sort((a, b) => {
    const ea = (a.emailStatus === 'verified') ? 0 : 1;
    const eb = (b.emailStatus === 'verified') ? 0 : 1;
    return ea - eb;
  });
  const work = sorted.slice(0, maxContacts);
  const carriedThrough = sorted.slice(maxContacts);
  const skippedUnverified = contacts.length - verified.length;

  logger.info('Message generation starting', {
    contacts: contacts.length,
    verified: verified.length,
    toGenerate: work.length,
    cap: maxContacts,
  });

  // Group contacts by domain so we fetch Perplexity signals once per company.
  const byDomain = new Map();
  for (const c of work) {
    const d = c.companyDomain || '';
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(c);
  }

  // Step 1: Perplexity signals per unique domain (parallelized).
  const signalsByDomain = new Map();
  const domains = [...byDomain.keys()];
  for (let i = 0; i < domains.length; i += concurrency) {
    const batch = domains.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (domain) => {
        const sample = byDomain.get(domain)[0];
        try {
          const signals = await searchCompanySignals(domain, sample.companyName || '');
          signalsByDomain.set(domain, signals);
        } catch (err) {
          logger.warn('Perplexity signals failed', { domain, error: err.message });
          signalsByDomain.set(domain, {});
        }
      })
    );
    if ((i + batch.length) % 25 === 0 || i + batch.length === domains.length) {
      logger.info('Signals progress', { processed: i + batch.length, total: domains.length });
    }
  }

  // Step 2: Generate the 4-step sequence per contact.
  const landingPage = landingPageFor(verticalKey);
  const ready = [];
  let generated = 0;
  let failed = 0;

  for (let i = 0; i < work.length; i += concurrency) {
    const batch = work.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (contact, batchIdx) => {
        const idx = i + batchIdx;
        const signals = signalsByDomain.get(contact.companyDomain) || {};

        const enriched = {
          ...contact,
          verticalKey,
          verticalLabel: vertical.label,
          landingPage,
          personalizedHook: signals.personalizedHook || contact.personalizedHook || '',
          companyIndustry: signals.industry || contact.companyIndustry || '',
        };

        const variety = assignVariety(enriched, idx, work.length);

        try {
          const seq = await generateSequence(enriched, signals, variety);
          if (seq.message) {
            ready.push({
              ...enriched,
              personalizedMessage: seq.message,
              sequenceStep2: seq.sequenceStep2,
              sequenceStep3: seq.sequenceStep3,
              sequenceStep4: seq.sequenceStep4,
              messageFlag: seq.flags?.some((f) => f === 'missing-api-key' || f === 'api-error')
                ? 'failed'
                : 'ready',
              messageFlags: seq.flags,
              messageStructure: seq.messageStructure,
            });
            generated++;
          } else {
            ready.push({ ...enriched, messageFlag: 'failed' });
            failed++;
          }
        } catch (err) {
          logger.error('Sequence generation threw', {
            email: contact.email,
            error: err.message,
          });
          ready.push({ ...enriched, messageFlag: 'failed' });
          failed++;
        }
      })
    );

    if ((i + batch.length) % 50 === 0 || i + batch.length === work.length) {
      logger.info('Sequence progress', {
        processed: i + batch.length,
        total: work.length,
        generated,
        failed,
      });
    }
  }

  // Pass non-worked leads through unchanged (so CSV export still includes
  // them with messageFlag undefined; instantly-sync will filter them out).
  const allLeads = [...ready, ...carriedThrough];

  logger.info('Message generation complete', {
    generated,
    failed,
    capped: carriedThrough.length,
    skippedUnverified,
  });

  return {
    leads: allLeads,
    stats: {
      generated,
      failed,
      skipped: carriedThrough.length + skippedUnverified,
    },
  };
}
