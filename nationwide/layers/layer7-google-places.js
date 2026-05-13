/**
 * Layer 7: Google Places API (optional fallback)
 *
 * For practices STILL missing a website after layers 2-4.
 * Uses Google Places Text Search + Place Details.
 *
 * Cost: ~$0.049 per lookup ($32/1K text search + $17/1K details).
 * Capped by --max-places flag.
 */

import { practicesMissingDomain, updatePracticeDomain, normalizeName } from '../store.js';
import { Progress } from '../utils/progress.js';
import { logger } from '../../services/logger.js';

const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Search Google Places for a dental practice and extract its website.
 */
async function searchPlace(practice, apiKey) {
  const query = `${practice.name} dentist ${practice.city || ''} ${practice.state || ''}`.trim();

  try {
    const res = await fetch(TEXT_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.websiteUri,places.formattedAddress',
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: 3,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (res.status === 429) await sleep(5_000);
      return null;
    }

    const data = await res.json();
    const places = data.places || [];

    for (const place of places) {
      if (!place.websiteUri) continue;

      // Fuzzy name match
      const placeName = normalizeName(place.displayName?.text || '');
      const practiceName = normalizeName(practice.name);

      // Simple overlap check
      const placeWords = new Set(placeName.split(' ').filter((w) => w.length > 2));
      const practiceWords = new Set(practiceName.split(' ').filter((w) => w.length > 2));
      let overlap = 0;
      for (const w of practiceWords) {
        if (placeWords.has(w)) overlap++;
      }

      const matchPct = practiceWords.size > 0 ? overlap / practiceWords.size : 0;
      if (matchPct < 0.4) continue;

      // Extract domain from website URI
      try {
        const hostname = new URL(place.websiteUri).hostname.replace(/^www\./, '');
        // Skip social/directory sites
        const skip = ['facebook.com', 'yelp.com', 'google.com', 'instagram.com', 'linkedin.com'];
        if (skip.some((d) => hostname.includes(d))) continue;
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

export async function run(opts, filters) {
  console.log('  Layer 7: Google Places API — Fallback domain lookup\n');

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    logger.warn('Layer 7 skipped: GOOGLE_PLACES_API_KEY not set', {
      layer: 7,
      feature: 'google-places',
      env_var: 'GOOGLE_PLACES_API_KEY',
    });
    console.log('  SKIPPED: GOOGLE_PLACES_API_KEY not set — optional layer, get a key at https://console.cloud.google.com/apis/library/places-backend.googleapis.com');
    return { skipped: true, reason: 'GOOGLE_PLACES_API_KEY not set' };
  }

  const maxPlaces = opts.maxPlaces || 0;
  if (maxPlaces === 0) {
    logger.warn('Layer 7 skipped: --max-places not set', {
      layer: 7,
      feature: 'google-places',
      reason: 'max-places=0 (cost gate)',
    });
    console.log('  SKIPPED: --max-places not set. Cost: ~$0.049 per lookup. Use --max-places N to enable.');
    return { skipped: true, reason: '--max-places not set (cost gate)' };
  }

  let practices = practicesMissingDomain(filters, 0);
  console.log(`  Practices missing domain: ${practices.length.toLocaleString()}`);

  if (practices.length === 0) {
    console.log('  Nothing to do — all practices have domains.');
    return;
  }

  // Cap to --max-places
  if (practices.length > maxPlaces) {
    practices = practices.slice(0, maxPlaces);
    console.log(`  Capped to ${maxPlaces} lookups (~$${(maxPlaces * 0.049).toFixed(2)} estimated cost)`);
  }

  if (opts.dryRun) {
    const estCost = (practices.length * 0.049).toFixed(2);
    console.log(`\n  DRY RUN — Would query ${practices.length} places (~$${estCost})`);
    return;
  }

  const progress = new Progress('Places API', practices.length);
  let found = 0;

  // Process with moderate concurrency
  const concurrency = Math.min(opts.concurrency || 5, 10);

  for (let i = 0; i < practices.length; i += concurrency) {
    const batch = practices.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((p) => searchPlace(p, apiKey))
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled' && results[j].value) {
        updatePracticeDomain(batch[j].id, results[j].value, 'google-places');
        found++;
      }
    }

    progress.tick(batch.length);
    await sleep(200); // Gentle rate limiting
  }

  const hitRate = practices.length > 0 ? ((found / practices.length) * 100).toFixed(1) : '0';
  const cost = (practices.length * 0.049).toFixed(2);
  console.log(`\n  Results:`);
  console.log(`    Queried:    ${practices.length.toLocaleString()}`);
  console.log(`    Found:      ${found.toLocaleString()} (${hitRate}%)`);
  console.log(`    Est. cost:  $${cost}`);
}
