import { RateLimiter } from '../../pipeline/rate-limiter.js';
import { logger } from '../../services/logger.js';

const HUNTER_BASE_URL = 'https://api.hunter.io/v2';

// Hunter's documented limit is 15 req/s on paid plans. 10/s keeps headroom.
const hunterLimiter = new RateLimiter(10, 1_000);

const SENIORITY_RANK = { executive: 3, senior: 2, junior: 1 };

/**
 * Look up emails for a domain via Hunter's domain-search endpoint and map
 * them to the contact shape the orchestrator expects.
 *
 * Unlike Apollo's people-search which takes title filters, Hunter returns
 * everything it has and we filter post-hoc against `verticalConfig.apolloTitles`
 * (same title list — Apollo and Hunter use overlapping role taxonomies).
 *
 * Hunter responses include: emails[].value, first_name, last_name, position,
 * seniority, department, linkedin, phone_number, confidence. Org-level
 * data is sparse — `organization` field has name + country only.
 *
 * @param {string} domain
 * @param {object} verticalConfig - { apolloTitles, ... }
 * @returns {Promise<Array<object>>}
 */
export async function searchPeopleByDomain(domain, verticalConfig) {
  await hunterLimiter.acquire();

  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) {
    logger.error('HUNTER_API_KEY not set');
    return [];
  }

  const url = `${HUNTER_BASE_URL}/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(apiKey)}&limit=25&type=personal`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      logger.warn('Hunter domain-search non-2xx', {
        domain,
        status: res.status,
        body: text.slice(0, 200),
      });
      return [];
    }
    const data = await res.json();
    const emails = data?.data?.emails || [];
    const orgName = data?.data?.organization || '';

    const titleFilter = buildTitleFilter(verticalConfig.apolloTitles || []);

    const matches = emails
      .map((e) => ({
        firstName: e.first_name || '',
        lastName: e.last_name || '',
        email: e.value || null,
        title: e.position || '',
        linkedinUrl: e.linkedin || null,
        phone: e.phone_number || null,
        companyName: orgName,
        companyDomain: domain,
        apolloId: null,
        // Hunter doesn't expose Apollo-style org fields. The signals
        // generator handles missing fields gracefully.
        companyIndustry: '',
        companyEmployees: null,
        companyFounded: null,
        companyRevenue: '',
        companyLinkedin: '',
        companyDescription: '',
        latestFundingStage: '',
        latestFundingDate: '',
        latestFundingAmount: '',
        companyKeywords: [],
        // Tag so we can A/B reply rates between Hunter and Apollo cohorts.
        peopleSearchProvider: 'hunter',
        peopleSearchConfidence: typeof e.confidence === 'number' ? e.confidence : null,
        peopleSearchSeniority: e.seniority || null,
      }))
      .filter((c) => c.email)
      .filter((c) => !titleFilter || titleFilter(c.title))
      // Rank by Hunter confidence (high → low), then seniority. Cap at 10
      // so the downstream cost profile mirrors Apollo's per_page=10.
      .sort((a, b) => {
        const ca = a.peopleSearchConfidence ?? 0;
        const cb = b.peopleSearchConfidence ?? 0;
        if (cb !== ca) return cb - ca;
        const sa = SENIORITY_RANK[a.peopleSearchSeniority] || 0;
        const sb = SENIORITY_RANK[b.peopleSearchSeniority] || 0;
        return sb - sa;
      })
      .slice(0, 10);

    return matches;
  } catch (err) {
    logger.warn('Hunter domain-search failed', { domain, error: err.message });
    return [];
  }
}

/**
 * Build a case-insensitive substring matcher for the apolloTitles array.
 * Apollo's title filter does prefix matching server-side; we approximate
 * it client-side with substring containment.
 *
 * Returns null if no titles are configured (in which case we keep everything).
 */
export function buildTitleFilter(titles) {
  if (!Array.isArray(titles) || titles.length === 0) return null;
  // Pre-lowercase + split each Apollo title into keywords so "VP Operations"
  // matches "VP of Operations" too.
  const titleKeywords = titles
    .map((t) =>
      t
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2 && !['the', 'and', 'for'].includes(w))
    )
    .filter((arr) => arr.length > 0);

  return (incoming) => {
    if (!incoming) return false;
    const lower = incoming.toLowerCase();
    return titleKeywords.some((keywords) => keywords.every((k) => lower.includes(k)));
  };
}

/**
 * Batch wrapper — same signature as Apollo's batchPeopleSearch().
 */
export async function batchPeopleSearch(businesses, verticalConfig) {
  const uniqueDomains = [...new Set(businesses.map((b) => b.domain).filter(Boolean))];
  logger.info('Starting batch Hunter people search', { domains: uniqueDomains.length });

  const all = [];
  for (const domain of uniqueDomains) {
    const contacts = await searchPeopleByDomain(domain, verticalConfig);
    all.push(...contacts);
  }

  logger.info('Batch Hunter people search complete', {
    domains: uniqueDomains.length,
    contacts: all.length,
  });
  return all;
}

export function isConfigured() {
  return Boolean(process.env.HUNTER_API_KEY);
}
