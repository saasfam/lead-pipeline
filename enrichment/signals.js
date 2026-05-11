import { searchCompanySignals } from './perplexity-signals.js';
import { signalsFromExtraction, signalsFromApollo } from './signals-from-extraction.js';
import { logger } from '../services/logger.js';

/**
 * Provider-agnostic company-signal lookup. Returns the same shape as
 * enrichment/perplexity-signals.searchCompanySignals(): an object with
 * properCompanyName, industry, recentFunding, hiringSignal, recentNews,
 * growthSignal, personalizedHook.
 *
 * Dispatched via SIGNALS_PROVIDER:
 *   - "apollo-website" (default) → reuse Apollo org fields + website scrape.
 *     Cheaper (~$0.001/domain via website-extractor) and removes the
 *     Perplexity dependency entirely. The contact MUST carry the Apollo
 *     org fields that apollo-people-search.js now attaches.
 *   - "apollo-only"            → no website scrape; uses only Apollo data.
 *     Cheapest path. Hook quality drops materially when Apollo's
 *     `short_description` is empty.
 *   - "perplexity"             → legacy path, kept for A/B comparison.
 *
 * @param {string} domain
 * @param {string} companyName
 * @param {object} [contact] - Apollo-enriched contact (carries org fields)
 * @param {string} [verticalLabel]
 */
export async function getSignals(domain, companyName, contact, verticalLabel) {
  const provider = (process.env.SIGNALS_PROVIDER || 'apollo-website').toLowerCase();

  if (provider === 'perplexity') {
    return searchCompanySignals(domain, companyName);
  }

  if (provider === 'apollo-only') {
    return signalsFromApollo(contact || { companyName, companyDomain: domain });
  }

  if (provider !== 'apollo-website') {
    logger.warn('Unknown SIGNALS_PROVIDER, falling back to apollo-website', { provider });
  }

  return signalsFromExtraction(
    contact || { companyName, companyDomain: domain },
    verticalLabel
  );
}
