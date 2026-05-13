/**
 * Layer 8: Sequence Generation
 *
 * For contacts with email but no sequence, generate 4-step cold email sequences
 * using the existing openai-messages.js + message-variety.js modules.
 *
 * Cost: ~$18 for ~50K calls to GPT-4o-mini.
 */

import { contactsNeedingSequence, insertSequence } from '../store.js';
import { generateSequence, generateFallbackHook } from '../../enrichment/openai-messages.js';
import { assignVariety } from '../../config/message-variety.js';
import { Progress } from '../utils/progress.js';

/**
 * Build a personalized hook from practice web data.
 */
function buildHook(contact) {
  const company = contact.practice_name || '';
  const specialties = (contact.specialties_csv || '').trim();
  const yearFounded = contact.year_founded;
  const description = (contact.company_desc || '').trim();

  if (specialties && yearFounded) {
    return `${company} specializes in ${specialties} — founded in ${yearFounded}`;
  }
  if (specialties) {
    return `${company} specializes in ${specialties}`;
  }
  if (description && description.length > 20) {
    const firstSentence = description.split(/[.!?]/)[0].trim();
    if (firstSentence.length > 15 && firstSentence.length < 200) {
      return firstSentence;
    }
  }

  return generateFallbackHook({
    companyName: company,
    companyEmployees: '',
    companyRevenue: '',
    companyFounded: yearFounded ? String(yearFounded) : '',
    title: contact.title || '',
    verticalLabel: 'Dental',
  });
}

/**
 * Map a DB contact row to the format expected by generateSequence().
 */
function mapContact(row, index, total) {
  const hook = buildHook(row);

  const contact = {
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    title: row.title || '',
    companyName: row.practice_name || '',
    companyDomain: row.domain || '',
    verticalLabel: 'Dental',
    verticalKey: 'dental',
    companyEmployees: '',
    companyIndustry: 'dental',
    companyFounded: row.year_founded ? String(row.year_founded) : '',
  };

  const signals = {
    personalizedHook: hook,
    recentNews: '',
    recentFunding: '',
    hiringSignal: '',
    growthSignal: '',
  };

  // Build lead-like object for assignVariety
  const leadLike = {
    personalizedHook: hook,
    companyFounded: contact.companyFounded,
    companyEmployees: '',
    recentNews: '',
    recentFunding: '',
    growthSignal: '',
    hiringSignal: '',
  };

  const variety = assignVariety(leadLike, index, total);

  return { contact, signals, variety, hook };
}

export async function run(opts, filters) {
  console.log('  Layer 8: Sequence Generation — 4-step cold email sequences\n');

  if (!process.env.OPENAI_API_KEY) {
    console.error('  ERROR: OPENAI_API_KEY not set in .env');
    return;
  }

  const contacts = contactsNeedingSequence(filters, opts.sample || 0);
  console.log(`  Contacts needing sequences: ${contacts.length.toLocaleString()}`);

  if (contacts.length === 0) {
    console.log('  Nothing to do — all contacts have sequences.');
    return;
  }

  if (opts.dryRun) {
    const estCost = (contacts.length * 0.00036).toFixed(2); // ~$0.36 per 1K @ gpt-4o-mini
    console.log(`\n  DRY RUN — Would generate ${contacts.length} sequences (~$${estCost})`);
    return;
  }

  const progress = new Progress('Sequences', contacts.length);
  let generated = 0;
  let errors = 0;
  let consecutiveRateLimits = 0;
  const MAX_CONSECUTIVE_RATE_LIMITS = 5;
  let stopped = false;

  // Rate limited at 5 req/s by openai-messages.js
  const concurrency = Math.min(opts.concurrency || 5, 10);

  for (let i = 0; i < contacts.length; i += concurrency) {
    if (stopped) break;

    const batch = contacts.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      batch.map(async (row, batchIdx) => {
        const globalIdx = i + batchIdx;
        const { contact, signals, variety, hook } = mapContact(row, globalIdx, contacts.length);

        const result = await generateSequence(contact, signals, variety);

        if (result.message && !result.flags.includes('api-error')) {
          insertSequence(row.id, {
            step1: result.message,
            step2: result.sequenceStep2,
            step3: result.sequenceStep3,
            step4: result.sequenceStep4,
            hook,
            structureId: result.messageStructure,
            openerType: variety.openerType,
            flagsCsv: result.flags.length ? result.flags.join(', ') : null,
          });
          return 'ok';
        }
        return 'error';
      })
    );

    let batchErrors = 0;
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value === 'ok') {
        generated++;
        consecutiveRateLimits = 0;
      } else {
        errors++;
        batchErrors++;
      }
    }

    // If entire batch failed, likely rate limited — back off or stop
    if (batchErrors === batch.length) {
      consecutiveRateLimits++;
      if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
        console.log(`\n  Rate limit detected (${MAX_CONSECUTIVE_RATE_LIMITS} consecutive failed batches).`);
        console.log(`  Stopping early — re-run later to continue from where we left off.`);
        stopped = true;
      } else {
        // Wait 15s before retrying
        console.log(`  Rate limited — waiting 15s before retry (${consecutiveRateLimits}/${MAX_CONSECUTIVE_RATE_LIMITS})...`);
        await new Promise((r) => setTimeout(r, 15_000));
      }
    } else {
      consecutiveRateLimits = 0;
    }

    progress.tick(batch.length);
  }

  const estCost = (generated * 0.00036).toFixed(2);
  console.log(`\n  Results:`);
  console.log(`    Generated:  ${generated.toLocaleString()}`);
  console.log(`    Errors:     ${errors}`);
  console.log(`    Est. cost:  ~$${estCost}`);
}
