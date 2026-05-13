/**
 * Layer 2: Domain Guessing
 *
 * For practices missing a domain, generate ~15 candidate domains from
 * the practice name, batch DNS-resolve all candidates in parallel,
 * then HTTP-validate only those that resolve.
 *
 * Expected hit rate: ~40-80%.
 */

import { practicesMissingDomain, updatePracticeDomain } from '../store.js';
import { generateCandidates, validateCandidates } from '../utils/domain-candidates.js';
import { Progress } from '../utils/progress.js';

// Default concurrency: 50 practices at a time
// Each practice batch-DNS-resolves ~15 candidates in parallel, then sequentially
// HTTP-checks only the resolved ones. This is much faster than serial validation.
const DEFAULT_CONCURRENCY = 50;

/**
 * Process a single practice: generate candidates, batch-validate, update DB.
 * Returns true if a domain was found.
 */
async function processPractice(practice) {
  const candidates = generateCandidates(
    practice.name,
    practice.first_name,
    practice.last_name,
    practice.city
  );

  if (candidates.length === 0) return false;

  const validDomain = await validateCandidates(candidates);
  if (validDomain) {
    updatePracticeDomain(practice.id, validDomain, 'domain-guess');
    return true;
  }

  return false;
}

/**
 * Worker pool — maintains N concurrent workers at all times.
 * Fast completions immediately start the next practice (no batch stalling).
 */
async function processPool(practices, concurrency, progress) {
  let found = 0;
  let index = 0;

  async function worker() {
    while (index < practices.length) {
      const i = index++;
      const practice = practices[i];
      try {
        const hit = await processPractice(practice);
        if (hit) found++;
      } catch { /* skip */ }
      progress.tick();
    }
  }

  // Launch N workers
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, practices.length); w++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return found;
}

export async function run(opts, filters) {
  console.log('  Layer 2: Domain Guessing — Generate & validate candidate domains\n');

  const practices = practicesMissingDomain(filters, opts.sample || 0);
  console.log(`  Practices missing domain: ${practices.length.toLocaleString()}`);

  if (practices.length === 0) {
    console.log('  Nothing to do — all practices have domains.');
    return;
  }

  if (opts.dryRun) {
    // Show sample candidates for first 3 practices
    console.log('\n  DRY RUN — Sample candidates:');
    for (const p of practices.slice(0, 3)) {
      const cands = generateCandidates(p.name, p.first_name, p.last_name, p.city);
      console.log(`    ${p.name} (${p.city}, ${p.state}):`);
      cands.slice(0, 5).forEach((c) => console.log(`      ${c}`));
    }
    return;
  }

  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  console.log(`  Concurrency: ${concurrency} practices in parallel\n`);

  const progress = new Progress('Domain Guess', practices.length);
  const found = await processPool(practices, concurrency, progress);

  const hitRate = practices.length > 0 ? ((found / practices.length) * 100).toFixed(1) : '0';
  console.log(`\n  Results:`);
  console.log(`    Checked:    ${practices.length.toLocaleString()}`);
  console.log(`    Found:      ${found.toLocaleString()}`);
  console.log(`    Hit rate:   ${hitRate}%`);
}
