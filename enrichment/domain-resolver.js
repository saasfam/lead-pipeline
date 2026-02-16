import { logger } from '../services/logger.js';

/**
 * Extract domain from a URL string.
 */
export function extractDomain(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Resolve domains for scraped businesses.
 * If website is available, extract domain. Otherwise, try Google search heuristic.
 *
 * @param {Array<object>} businesses - Scraped business objects
 * @returns {Array<object>} - Businesses with `domain` field added
 */
export async function resolveDomains(businesses) {
  const results = [];

  for (const biz of businesses) {
    let domain = extractDomain(biz.website);

    // Skip generic domains
    if (domain && isGenericDomain(domain)) {
      domain = null;
    }

    results.push({ ...biz, domain });
  }

  const withDomain = results.filter((b) => b.domain).length;
  logger.info('Domain resolution complete', {
    total: results.length,
    withDomain,
    withoutDomain: results.length - withDomain,
  });

  return results;
}

/**
 * Check if a domain is too generic to be useful (social media, directories, etc.)
 */
function isGenericDomain(domain) {
  const genericDomains = [
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
    'linkedin.com', 'youtube.com', 'tiktok.com',
    'yelp.com', 'google.com', 'maps.google.com',
    'yellowpages.com', 'bbb.org', 'angi.com',
    'thumbtack.com', 'homeadvisor.com', 'nextdoor.com',
  ];
  return genericDomains.some((g) => domain === g || domain.endsWith(`.${g}`));
}
