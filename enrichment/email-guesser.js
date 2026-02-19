import { promises as dns } from 'dns';
import { logger } from '../services/logger.js';

// Cache MX lookups per domain (avoid repeated DNS queries)
const mxCache = new Map();

/**
 * Generate candidate email addresses from a person's name + company domain.
 * Returns most common patterns first (ordered by likelihood for small businesses).
 *
 * @param {string} firstName - e.g. "Neha"
 * @param {string} lastName - e.g. "Dhand"
 * @param {string} domain - e.g. "dentistsofelkgrove.com"
 * @returns {string[]} - Candidate emails, most common patterns first
 */
export function generateCandidates(firstName, lastName, domain) {
  if (!firstName || !domain) return [];

  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName ? lastName.toLowerCase().replace(/[^a-z]/g, '') : '';

  if (!f) return [];

  const candidates = [];

  if (l) {
    candidates.push(
      `${f}@${domain}`,           // neha@domain.com         — most common for small biz
      `${f}.${l}@${domain}`,      // neha.dhand@domain.com   — second most common
      `${f[0]}${l}@${domain}`,    // ndhand@domain.com
      `${f}${l[0]}@${domain}`,    // nehad@domain.com
      `${f}${l}@${domain}`,       // nehadhand@domain.com
      `${f}_${l}@${domain}`,      // neha_dhand@domain.com
      `${l}@${domain}`,           // dhand@domain.com
    );
  } else {
    candidates.push(`${f}@${domain}`);
  }

  return candidates;
}

/**
 * Pick the best-guess email from candidates.
 * For dental offices, `firstname@domain` is by far the most common,
 * followed by `first.last@domain`.
 */
export function bestGuess(firstName, lastName, domain) {
  const candidates = generateCandidates(firstName, lastName, domain);
  return candidates[0] || null; // firstname@domain
}

/**
 * Generate generic/role email candidates for a domain.
 */
export function generateGenericCandidates(domain) {
  return [
    `info@${domain}`,
    `office@${domain}`,
    `frontdesk@${domain}`,
    `contact@${domain}`,
  ];
}

/**
 * Check if a domain has MX records (can receive email).
 * Returns the MX hosts if found, null otherwise.
 */
export async function checkMX(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);

  try {
    const records = await dns.resolveMx(domain);
    const sorted = records
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.toLowerCase());
    mxCache.set(domain, sorted);
    return sorted;
  } catch {
    mxCache.set(domain, null);
    return null;
  }
}

/**
 * Detect the email provider from MX records.
 * Helps pick better patterns (Google Workspace is very common for dental offices).
 */
export function detectProvider(mxHosts) {
  if (!mxHosts || mxHosts.length === 0) return 'none';
  const first = mxHosts[0];
  if (first.includes('google') || first.includes('gmail')) return 'google';
  if (first.includes('outlook') || first.includes('microsoft')) return 'microsoft';
  if (first.includes('zoho')) return 'zoho';
  if (first.includes('secureserver') || first.includes('godaddy')) return 'godaddy';
  if (first.includes('emailsrvr') || first.includes('rackspace')) return 'rackspace';
  if (first.includes('mxroute')) return 'mxroute';
  return 'other';
}

/**
 * Generate the best email guesses for a staff member, given the domain's MX provider.
 * Returns up to 2 best guesses (primary + alternate).
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} domain
 * @param {string} provider - MX provider from detectProvider()
 * @returns {{ primary: string, alternate: string | null }}
 */
export function smartGuess(firstName, lastName, domain, provider) {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName ? lastName.toLowerCase().replace(/[^a-z]/g, '') : '';

  if (!f || !domain) return { primary: null, alternate: null };

  // Google Workspace / Microsoft 365 → first.last is most common
  if (l && (provider === 'google' || provider === 'microsoft')) {
    return {
      primary: `${f}.${l}@${domain}`,
      alternate: `${f}@${domain}`,
    };
  }

  // GoDaddy / small providers → firstname is most common
  if (l) {
    return {
      primary: `${f}@${domain}`,
      alternate: `${f}.${l}@${domain}`,
    };
  }

  return { primary: `${f}@${domain}`, alternate: null };
}

/**
 * Process a single domain: check MX, generate best-guess emails for all staff.
 *
 * @param {string} domain
 * @param {Array<{firstName: string, lastName: string, fullName: string, title: string}>} staff
 * @returns {{ domain, provider, hasMX, staff: Array<{...staff, email, alternateEmail}>, genericEmail }}
 */
export async function processDomain(domain, staff, { includeGeneric = true } = {}) {
  const mxHosts = await checkMX(domain);
  const hasMX = mxHosts && mxHosts.length > 0;
  const provider = detectProvider(mxHosts);

  const result = {
    domain,
    provider,
    hasMX,
    staff: [],
    genericEmail: null,
  };

  if (!hasMX) return result;

  // Generate emails for each staff member
  for (const person of staff) {
    const { primary, alternate } = smartGuess(
      person.firstName,
      person.lastName,
      domain,
      provider
    );

    result.staff.push({
      ...person,
      email: primary,
      alternateEmail: alternate,
    });
  }

  // Generic email
  if (includeGeneric) {
    // For Google Workspace → info@ is almost always set up
    result.genericEmail = `info@${domain}`;
  }

  logger.debug('Domain emails generated', {
    domain,
    provider,
    staffEmails: result.staff.length,
  });

  return result;
}
