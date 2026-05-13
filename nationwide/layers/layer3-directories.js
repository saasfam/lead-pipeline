/**
 * Layer 3: Healthcare Directory Scraping
 *
 * For practices still missing a domain after Layer 2, try:
 *   1. Healthgrades (by NPI — best hit rate)
 *   2. Zocdoc (by name + city)
 *   3. ADA Find-a-Dentist (by ZIP + last name)
 *
 * Stops per practice as soon as a website is found.
 * Rate limit: 2 req/sec per directory.
 */

import { practicesMissingDomain, updatePracticeDomain } from '../store.js';
import { scrapeHealthgrades, scrapeZocdoc, scrapeADA } from '../utils/directory-scrapers.js';
import { Progress } from '../utils/progress.js';

const RATE_DELAY_MS = 500; // 2 req/sec

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Try each directory in order for a single practice.
 * Returns { source, domain } or null.
 */
async function lookupPractice(practice) {
  // 1. Healthgrades (by NPI)
  const hgResult = await scrapeHealthgrades(practice);
  if (hgResult) return { source: 'healthgrades', domain: hgResult };
  await sleep(RATE_DELAY_MS);

  // 2. Zocdoc (by name + city)
  const zdResult = await scrapeZocdoc(practice);
  if (zdResult) return { source: 'zocdoc', domain: zdResult };
  await sleep(RATE_DELAY_MS);

  // 3. ADA (by ZIP + last name)
  const adaResult = await scrapeADA(practice);
  if (adaResult) return { source: 'ada', domain: adaResult };

  return null;
}

export async function run(opts, filters) {
  console.log('  Layer 3: Directory Scraping — Healthgrades / Zocdoc / ADA\n');

  const practices = practicesMissingDomain(filters, opts.sample || 0);
  console.log(`  Practices missing domain: ${practices.length.toLocaleString()}`);

  if (practices.length === 0) {
    console.log('  Nothing to do — all practices have domains.');
    return;
  }

  if (opts.dryRun) {
    console.log('\n  DRY RUN — Would scrape directories for:');
    for (const p of practices.slice(0, 5)) {
      console.log(`    NPI ${p.npi}: ${p.name} (${p.city}, ${p.state})`);
    }
    return;
  }

  const progress = new Progress('Directories', practices.length);
  let found = 0;
  const sourceCounts = { healthgrades: 0, zocdoc: 0, ada: 0 };

  // Process sequentially (rate limiting per directory)
  // But we can run 2 concurrent lookups since each has internal delays
  const concurrency = Math.min(opts.concurrency || 2, 4);

  for (let i = 0; i < practices.length; i += concurrency) {
    const batch = practices.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((p) => lookupPractice(p))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled' && result.value) {
        const { source, domain } = result.value;
        updatePracticeDomain(batch[j].id, domain, source);
        found++;
        sourceCounts[source]++;
      }
    }

    progress.tick(batch.length);
    await sleep(RATE_DELAY_MS);
  }

  const hitRate = practices.length > 0 ? ((found / practices.length) * 100).toFixed(1) : '0';
  console.log(`\n  Results:`);
  console.log(`    Checked:       ${practices.length.toLocaleString()}`);
  console.log(`    Found:         ${found.toLocaleString()} (${hitRate}%)`);
  console.log(`    Healthgrades:  ${sourceCounts.healthgrades}`);
  console.log(`    Zocdoc:        ${sourceCounts.zocdoc}`);
  console.log(`    ADA:           ${sourceCounts.ada}`);
}
