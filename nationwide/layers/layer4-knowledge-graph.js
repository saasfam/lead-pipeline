/**
 * Layer 4: Google Knowledge Graph API
 *
 * Free tier: 100K requests/day.
 * For practices still missing a domain, query Google KG with
 * "practice_name city state dentist" and fuzzy-match the result.
 */

import { practicesMissingDomain, updatePracticeDomain, normalizeName } from '../store.js';
import { Progress } from '../utils/progress.js';
import { logger } from '../../services/logger.js';

const KG_API_URL = 'https://kgsearch.googleapis.com/v1/entities:search';
const RATE_LIMIT_PER_SEC = 50;
const RATE_DELAY_MS = Math.ceil(1000 / RATE_LIMIT_PER_SEC);

// Minimum name overlap to accept a KG result
const MIN_NAME_SIMILARITY = 0.6;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Query Google Knowledge Graph API for a dental practice.
 * Returns a website URL or null.
 */
async function queryKG(practice, apiKey) {
  const query = `${practice.name} ${practice.city || ''} ${practice.state || ''} dentist`.trim();

  const params = new URLSearchParams({
    query,
    key: apiKey,
    types: 'LocalBusiness',
    limit: '3',
  });

  try {
    const res = await fetch(`${KG_API_URL}?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (res.status === 429) {
        // Rate limited — back off
        await sleep(5_000);
        return null;
      }
      return null;
    }

    const data = await res.json();
    const items = data.itemListElement || [];

    for (const item of items) {
      const entity = item.result;
      if (!entity) continue;

      // Check name similarity
      const kgName = normalizeName(entity.name || '');
      const practiceName = normalizeName(practice.name);
      const similarity = nameSimilarity(practiceName, kgName);

      if (similarity < MIN_NAME_SIMILARITY) continue;

      // Extract website URL
      const website = entity.url || entity.detailedDescription?.url;
      if (!website) continue;

      // Extract domain from URL
      try {
        const hostname = new URL(website).hostname.replace(/^www\./, '');
        // Skip directory/social sites
        if (isDirectorySite(hostname)) continue;
        return hostname;
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Simple word-overlap similarity (Jaccard-like).
 * Returns a number between 0 and 1.
 */
function nameSimilarity(a, b) {
  const wordsA = new Set(a.split(' ').filter((w) => w.length > 1));
  const wordsB = new Set(b.split(' ').filter((w) => w.length > 1));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return overlap / union;
}

function isDirectorySite(hostname) {
  const dirs = [
    'google.com', 'facebook.com', 'yelp.com', 'healthgrades.com',
    'zocdoc.com', 'yellowpages.com', 'linkedin.com', 'twitter.com',
    'instagram.com', 'youtube.com', 'webmd.com', 'vitals.com',
    'wikipedia.org', 'ada.org',
  ];
  return dirs.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

export async function run(opts, filters) {
  console.log('  Layer 4: Google Knowledge Graph — Free tier lookup\n');

  const apiKey = process.env.GOOGLE_KG_API_KEY;
  if (!apiKey) {
    logger.warn('Layer 4 skipped: GOOGLE_KG_API_KEY not set', {
      layer: 4,
      feature: 'knowledge-graph',
      env_var: 'GOOGLE_KG_API_KEY',
    });
    console.log('  SKIPPED: GOOGLE_KG_API_KEY not set — get a free key at https://console.cloud.google.com/apis/library/kgsearch.googleapis.com');
    return { skipped: true, reason: 'GOOGLE_KG_API_KEY not set' };
  }

  const practices = practicesMissingDomain(filters, opts.sample || 0);
  console.log(`  Practices missing domain: ${practices.length.toLocaleString()}`);

  if (practices.length === 0) {
    console.log('  Nothing to do — all practices have domains.');
    return;
  }

  if (opts.dryRun) {
    console.log('\n  DRY RUN — Would query KG for:');
    for (const p of practices.slice(0, 5)) {
      console.log(`    "${p.name} ${p.city} ${p.state} dentist"`);
    }
    return;
  }

  const progress = new Progress('KG Lookup', practices.length);
  let found = 0;
  let errors = 0;

  // Process with rate limiting
  const concurrency = Math.min(opts.concurrency || 10, RATE_LIMIT_PER_SEC);

  for (let i = 0; i < practices.length; i += concurrency) {
    const batch = practices.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((p) => queryKG(p, apiKey))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled' && result.value) {
        updatePracticeDomain(batch[j].id, result.value, 'knowledge-graph');
        found++;
      } else if (result.status === 'rejected') {
        errors++;
      }
    }

    progress.tick(batch.length);
    await sleep(RATE_DELAY_MS * concurrency);
  }

  const hitRate = practices.length > 0 ? ((found / practices.length) * 100).toFixed(1) : '0';
  console.log(`\n  Results:`);
  console.log(`    Queried:    ${practices.length.toLocaleString()}`);
  console.log(`    Found:      ${found.toLocaleString()} (${hitRate}%)`);
  console.log(`    Errors:     ${errors}`);
}
