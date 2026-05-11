import { apolloLimiter } from '../pipeline/rate-limiter.js';
import { logger } from '../services/logger.js';

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

/**
 * Search Apollo for decision-maker contacts at a specific domain.
 *
 * @param {string} domain - Company domain
 * @param {object} verticalConfig - Vertical config with apolloTitles, apolloSizes, etc.
 * @returns {Array<object>} - Array of contact objects
 */
export async function searchPeopleByDomain(domain, verticalConfig) {
  await apolloLimiter.acquire();

  try {
    const res = await fetch(`${APOLLO_BASE_URL}/mixed_people/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': APOLLO_API_KEY,
      },
      body: JSON.stringify({
        q_organization_domains: domain,
        person_titles: verticalConfig.apolloTitles,
        organization_num_employees_ranges: verticalConfig.apolloSizes,
        page: 1,
        per_page: 10,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error('Apollo people search failed', {
        domain,
        status: res.status,
        error: errText,
      });
      return [];
    }

    const data = await res.json();
    const people = data.people || [];

    return people.map((p) => {
      const org = p.organization || {};
      return {
        firstName: p.first_name || '',
        lastName: p.last_name || '',
        email: p.email || null,
        title: p.title || '',
        linkedinUrl: p.linkedin_url || null,
        phone: p.phone_numbers?.[0]?.sanitized_number || null,
        companyName: org.name || '',
        companyDomain: domain,
        apolloId: p.id,
        // Org-level enrichment we used to throw away. The signals layer can
        // now compose recentFunding / growthSignal directly from these
        // fields without needing a separate Perplexity call.
        companyIndustry: org.industry || '',
        companyEmployees: org.estimated_num_employees ?? null,
        companyFounded: org.founded_year ?? null,
        companyRevenue: org.organization_revenue_printed || org.annual_revenue_printed || '',
        companyLinkedin: org.linkedin_url || '',
        companyDescription: org.short_description || '',
        latestFundingStage: org.latest_funding_stage || '',
        latestFundingDate: org.latest_funding_round_date || '',
        latestFundingAmount: org.total_funding_printed || '',
        companyKeywords: Array.isArray(org.keywords) ? org.keywords.slice(0, 10) : [],
      };
    });
  } catch (err) {
    logger.error('Apollo people search error', {
      domain,
      error: err.message,
    });
    return [];
  }
}

/**
 * Batch enrich: search Apollo for contacts across many domains.
 *
 * @param {Array<object>} businesses - Businesses with `domain` field
 * @param {object} verticalConfig - Vertical config
 * @returns {Array<object>} - All found contacts
 */
export async function batchPeopleSearch(businesses, verticalConfig) {
  const uniqueDomains = [...new Set(businesses.map((b) => b.domain).filter(Boolean))];

  logger.info('Starting batch Apollo people search', {
    domains: uniqueDomains.length,
  });

  const allContacts = [];

  for (const domain of uniqueDomains) {
    const contacts = await searchPeopleByDomain(domain, verticalConfig);
    allContacts.push(...contacts);

    if (allContacts.length % 100 === 0) {
      logger.info('Apollo search progress', {
        processed: uniqueDomains.indexOf(domain) + 1,
        total: uniqueDomains.length,
        contacts: allContacts.length,
      });
    }
  }

  logger.info('Batch Apollo people search complete', {
    domains: uniqueDomains.length,
    contacts: allContacts.length,
  });

  return allContacts;
}
