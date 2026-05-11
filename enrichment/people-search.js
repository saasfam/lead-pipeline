import { batchPeopleSearch as apolloBatchPeopleSearch } from './apollo-people-search.js';
import {
  batchPeopleSearch as hunterBatchPeopleSearch,
  searchPeopleByDomain as hunterSearchByDomain,
  isConfigured as hunterConfigured,
} from './people-search/hunter.js';
import { searchPeopleByDomain as apolloSearchByDomain } from './apollo-people-search.js';
import { logger } from '../services/logger.js';

/**
 * Verticals where Hunter coverage matches Apollo well enough that Hunter
 * can be the primary. SMB verticals with simpler decision-maker titles
 * (Owner / Principal / GM) are where Hunter is competitive. Mid-market
 * verticals lean on Apollo's title-disambiguation, so they stay Apollo-first.
 *
 * Source for the split: audit document section 4, vertical MRR mix.
 */
const HUNTER_SAFE_VERTICALS = new Set([
  'dental',
  'automotive',
  'propertymanagement',
  'realestate',
  'recruiting',
  'homeservices',
  'restaurants',
  'agencies',
  'msp',
  'ecommerce',
  'insurance',
  'travel',
  'retail',
]);

const MIN_HUNTER_HITS_TO_SKIP_APOLLO = 2;

/**
 * Provider-agnostic batch people search. Decides which provider to run
 * based on PEOPLE_SEARCH_PROVIDER (global) and the vertical's tier
 * (auto, when global is "auto"):
 *
 *   "apollo" (default)            → existing Apollo path, unchanged
 *   "hunter"                      → Hunter only
 *   "hunter-then-apollo"          → waterfall: Hunter first per domain;
 *                                   Apollo fallback when fewer than 2 hits
 *   "auto" (recommended for runs) → "hunter-then-apollo" on SMB verticals,
 *                                   "apollo" on mid-market verticals
 *
 * @param {Array<object>} businesses
 * @param {object} verticalConfig - Pass through to providers
 * @param {string} [verticalKey]   - Used only by "auto" routing
 */
export async function batchPeopleSearch(businesses, verticalConfig, verticalKey) {
  const provider = resolveProvider(verticalKey);

  if (provider === 'hunter') {
    if (!hunterConfigured()) {
      throw new Error('PEOPLE_SEARCH_PROVIDER=hunter but HUNTER_API_KEY is unset');
    }
    return hunterBatchPeopleSearch(businesses, verticalConfig);
  }

  if (provider === 'hunter-then-apollo') {
    if (!hunterConfigured()) {
      logger.warn('hunter-then-apollo requested but HUNTER_API_KEY unset; falling back to apollo');
      return apolloBatchPeopleSearch(businesses, verticalConfig);
    }
    return waterfallHunterThenApollo(businesses, verticalConfig);
  }

  // Default: Apollo
  return apolloBatchPeopleSearch(businesses, verticalConfig);
}

export function resolveProvider(verticalKey) {
  const raw = (process.env.PEOPLE_SEARCH_PROVIDER || 'apollo').toLowerCase();

  if (raw === 'auto') {
    if (verticalKey && HUNTER_SAFE_VERTICALS.has(verticalKey)) {
      return 'hunter-then-apollo';
    }
    return 'apollo';
  }

  return raw;
}

/**
 * Per-domain waterfall: try Hunter, accept the result if it found at least
 * MIN_HUNTER_HITS_TO_SKIP_APOLLO contacts; otherwise fall back to Apollo
 * for that same domain. Cost-optimal because Hunter is ~$0.01/search vs
 * Apollo's ~$0.04 per matched contact.
 */
async function waterfallHunterThenApollo(businesses, verticalConfig) {
  const uniqueDomains = [...new Set(businesses.map((b) => b.domain).filter(Boolean))];
  logger.info('Starting hunter-then-apollo waterfall', { domains: uniqueDomains.length });

  const all = [];
  let hunterHits = 0;
  let apolloFallbacks = 0;

  for (const domain of uniqueDomains) {
    const hunterContacts = await hunterSearchByDomain(domain, verticalConfig);
    if (hunterContacts.length >= MIN_HUNTER_HITS_TO_SKIP_APOLLO) {
      all.push(...hunterContacts);
      hunterHits++;
      continue;
    }

    // Apollo fallback. Tag the cohort for retrospective analysis.
    const apolloContacts = await apolloSearchByDomain(domain, verticalConfig);
    const tagged = apolloContacts.map((c) => ({ ...c, peopleSearchProvider: 'apollo' }));
    all.push(...tagged);
    apolloFallbacks++;
  }

  logger.info('Waterfall complete', {
    domains: uniqueDomains.length,
    hunterDomains: hunterHits,
    apolloFallbacks,
    contacts: all.length,
  });
  return all;
}
