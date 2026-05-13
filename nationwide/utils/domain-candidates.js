/**
 * Generate candidate domain names from a dental practice name and provider name.
 *
 * Strategy: produce ~15 plausible domains, batch DNS-resolve all candidates,
 * then HTTP-check only the ones that resolve.
 */

import { promises as dns } from 'dns';

const TLDS = ['.com', '.dental', '.dentist', '.net'];

const STOP_WORDS = new Set([
  'the', 'and', 'of', 'for', 'in', 'at', 'a', 'an', 'inc', 'llc', 'ltd',
  'pllc', 'pc', 'pa', 'dds', 'dmd', 'dr', 'dental', 'dentistry', 'office',
  'practice', 'group', 'associates', 'clinic', 'center', 'centre', 'family',
]);

const PARKED_INDICATORS = [
  'parked', 'godaddy', 'this domain', 'buy this', 'domain for sale',
  'hugedomains', 'sedoparking', 'afternic', 'dan.com',
];

const HTTP_TIMEOUT = 3_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; LeadPipeline/1.0)';

/**
 * Normalize a practice name into a slug (lowercase, alpha only).
 */
function slugify(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate candidate domains from a practice name + optional provider name.
 *
 * @param {string} practiceName - e.g. "Bright Smile Dental Center"
 * @param {string} [firstName] - Provider first name
 * @param {string} [lastName] - Provider last name
 * @param {string} [city] - City for geo-based candidates
 * @returns {string[]} - Candidate domain names to check
 */
export function generateCandidates(practiceName, firstName, lastName, city) {
  const candidates = new Set();
  const slug = slugify(practiceName);
  const words = slug.split(' ').filter((w) => w.length > 0);

  // Remove stop words for core slug
  const coreWords = words.filter((w) => !STOP_WORDS.has(w));
  const core = coreWords.join('');
  const coreDash = coreWords.join('-');

  // 1. Full slug variations
  if (core.length >= 3 && core.length <= 60) {
    for (const tld of TLDS) {
      candidates.add(`${core}${tld}`);
    }
    if (coreDash !== core) {
      candidates.add(`${coreDash}.com`);
    }
  }

  // 2. With "dental" suffix if not already present
  if (!core.includes('dental')) {
    candidates.add(`${core}dental.com`);
    if (coreWords.length <= 3) {
      candidates.add(`${core}dentistry.com`);
    }
  }

  // 3. Abbreviated (first letters of each word + dental)
  if (coreWords.length >= 2) {
    const initials = coreWords.map((w) => w[0]).join('');
    if (initials.length >= 2) {
      candidates.add(`${initials}dental.com`);
    }
  }

  // 4. Provider name variations
  if (firstName && lastName) {
    const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
    const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
    if (f && l) {
      candidates.add(`dr${f}${l}.com`);
      candidates.add(`${l}dental.com`);
      candidates.add(`dr${l}dds.com`);
      candidates.add(`dr${l}.com`);
      candidates.add(`${f}${l}dds.com`);
    }
  }

  // 5. City-based variations
  if (city && coreWords.length > 0) {
    const citySlug = slugify(city).replace(/\s/g, '');
    if (citySlug.length >= 3) {
      candidates.add(`${citySlug}dental.com`);
      candidates.add(`${citySlug}dentist.com`);
      // Combine first meaningful word + city
      const firstWord = coreWords[0];
      if (firstWord !== citySlug) {
        candidates.add(`${firstWord}${citySlug}.com`);
      }
    }
  }

  // Filter out obviously bad candidates
  return [...candidates].filter((d) => {
    const name = d.split('.')[0];
    return name.length >= 3 && name.length <= 63;
  });
}

/**
 * DNS resolve a domain — check for A or AAAA records.
 * Returns true if the domain resolves to at least one IP.
 */
export async function dnsResolves(domain) {
  try {
    const hostname = domain.replace(/^https?:\/\//, '');
    const results = await dns.resolve4(hostname);
    return results.length > 0;
  } catch {
    try {
      const results = await dns.resolve6(domain);
      return results.length > 0;
    } catch {
      return false;
    }
  }
}

/**
 * HTTP check — single GET with truncated body read for parked detection.
 * Returns { ok, redirectedTo } or { ok: false }.
 */
export async function httpCheck(domain) {
  // Try https first, fall back to http only if https fails
  for (const proto of ['https', 'http']) {
    const url = `${proto}://${domain}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(HTTP_TIMEOUT),
        redirect: 'follow',
      });

      if (!res.ok) continue;

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        // Still counts as a real site if it responds OK
        const finalHost = new URL(res.url).hostname.replace(/^www\./, '');
        const origHost = domain.replace(/^www\./, '');
        return { ok: true, redirectedTo: finalHost !== origHost ? finalHost : null };
      }

      // Read only first 5KB to check for parked indicators
      const reader = res.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      const MAX_BYTES = 5_000;

      while (totalBytes < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.length;
      }
      reader.cancel().catch(() => {});

      const textBuf = Buffer.concat(chunks).toString('utf-8').toLowerCase();

      // Check if parked
      const isParked = PARKED_INDICATORS.some((ind) => textBuf.includes(ind));
      if (isParked) continue;

      // Check for redirect to different domain
      const finalHost = new URL(res.url).hostname.replace(/^www\./, '');
      const origHost = domain.replace(/^www\./, '');

      return {
        ok: true,
        redirectedTo: finalHost !== origHost ? finalHost : null,
      };
    } catch {
      continue;
    }
  }

  return { ok: false, redirectedTo: null };
}

/**
 * Validate candidates for a single practice: batch DNS all candidates,
 * then HTTP-check resolved ones in parallel batches of 5, return first hit.
 * Returns the first validated domain or null.
 */
export async function validateCandidates(candidates) {
  if (candidates.length === 0) return null;

  // Phase 1: Batch DNS resolve all candidates in parallel
  const dnsResults = await Promise.all(
    candidates.map(async (domain) => ({
      domain,
      resolves: await dnsResolves(domain),
    }))
  );

  // Preserve candidate order (higher priority first)
  const resolved = dnsResults.filter((r) => r.resolves).map((r) => r.domain);
  if (resolved.length === 0) return null;

  // Phase 2: HTTP check resolved candidates in parallel batches of 5
  // Race within each batch — return first valid hit
  const HTTP_BATCH = 5;
  for (let i = 0; i < resolved.length; i += HTTP_BATCH) {
    const batch = resolved.slice(i, i + HTTP_BATCH);
    const results = await Promise.all(
      batch.map(async (domain) => {
        const http = await httpCheck(domain);
        return http.ok ? (http.redirectedTo || domain) : null;
      })
    );

    // Return first non-null result (preserving candidate priority order)
    const hit = results.find((r) => r !== null);
    if (hit) return hit;
  }

  return null;
}

/**
 * Validate a single candidate domain: DNS check → HTTP check.
 * Returns the validated domain or null.
 */
export async function validateDomain(domain) {
  const hasRecords = await dnsResolves(domain);
  if (!hasRecords) return null;

  const http = await httpCheck(domain);
  if (!http.ok) return null;

  // If it redirected to another domain, return that instead
  return http.redirectedTo || domain;
}
