/**
 * HTTP scrapers for healthcare directories.
 * Each function takes a provider record and returns a website URL or null.
 *
 * - Healthgrades: lookup by NPI (best hit rate)
 * - Zocdoc: search by name + city
 * - ADA Find-a-Dentist: search by ZIP + last name
 *
 * All use simple HTTP fetch + HTML parsing (no browser needed).
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 10_000;

/**
 * Healthgrades — lookup by NPI number.
 * URL pattern: https://www.healthgrades.com/providers/NPI_NUMBER
 * The profile page usually contains a "Visit Website" link.
 *
 * @param {{ npi: string }} provider
 * @returns {Promise<string|null>} - Website URL or null
 */
export async function scrapeHealthgrades(provider) {
  if (!provider.npi) return null;

  try {
    // Healthgrades has a direct NPI lookup endpoint
    const url = `https://www.healthgrades.com/dentist/dr-profile-${provider.npi}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: 'follow',
    });

    if (!res.ok) return null;

    const html = await res.text();

    // Look for website link in the profile
    // Common patterns: href containing the practice website
    const websitePatterns = [
      /href=["']([^"']*?)["'][^>]*>(?:[^<]*?)(?:Visit\s+Website|Official\s+Website|Practice\s+Website)/i,
      /data-website=["']([^"']+)["']/i,
      /"website"\s*:\s*"([^"]+)"/i,
      /href=["'](https?:\/\/(?!(?:www\.)?healthgrades)[^"']+)["'][^>]*class=["'][^"']*website/i,
    ];

    for (const pattern of websitePatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const website = cleanUrl(match[1]);
        if (website && !isDirectoryDomain(website)) return website;
      }
    }

    // Fallback: look for external links that look like practice websites
    const extLinks = extractExternalLinks(html, 'healthgrades.com');
    for (const link of extLinks) {
      if (looksLikePracticeWebsite(link)) return link;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Zocdoc — search by dentist name + city.
 *
 * @param {{ first_name: string, last_name: string, city: string, state: string }} provider
 * @returns {Promise<string|null>}
 */
export async function scrapeZocdoc(provider) {
  if (!provider.last_name || !provider.city) return null;

  try {
    const name = `${provider.first_name || ''} ${provider.last_name}`.trim();
    const location = `${provider.city}, ${provider.state || ''}`.trim();
    const searchUrl = `https://www.zocdoc.com/search?address=${encodeURIComponent(location)}&name=${encodeURIComponent(name)}&type=dentist`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: 'follow',
    });

    if (!res.ok) return null;

    const html = await res.text();

    // Look for the provider's profile link, then scrape that for website
    const profilePattern = /href=["'](\/dentist\/[^"']+)["']/i;
    const profileMatch = html.match(profilePattern);
    if (!profileMatch) return null;

    const profileUrl = `https://www.zocdoc.com${profileMatch[1]}`;
    const profileRes = await fetch(profileUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: 'follow',
    });

    if (!profileRes.ok) return null;

    const profileHtml = await profileRes.text();

    // Extract website from profile
    const websitePatterns = [
      /"website"\s*:\s*"([^"]+)"/i,
      /href=["'](https?:\/\/(?!(?:www\.)?zocdoc)[^"']+)["'][^>]*>(?:[^<]*?)website/i,
    ];

    for (const pattern of websitePatterns) {
      const match = profileHtml.match(pattern);
      if (match && match[1]) {
        const website = cleanUrl(match[1]);
        if (website && !isDirectoryDomain(website)) return website;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * ADA Find-a-Dentist — search by ZIP code + last name.
 *
 * @param {{ last_name: string, zip: string }} provider
 * @returns {Promise<string|null>}
 */
export async function scrapeADA(provider) {
  if (!provider.last_name || !provider.zip) return null;

  try {
    const zip = (provider.zip || '').slice(0, 5);
    if (!/^\d{5}$/.test(zip)) return null;

    const searchUrl = `https://findadentist.ada.org/search-results?address=${zip}&name=${encodeURIComponent(provider.last_name)}`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: 'follow',
    });

    if (!res.ok) return null;

    const html = await res.text();

    // ADA search results may contain website links
    const websitePatterns = [
      /href=["'](https?:\/\/(?!findadentist\.ada\.org)[^"']+)["'][^>]*class=["'][^"']*website/i,
      /"website"\s*:\s*"([^"]+)"/i,
      /"url"\s*:\s*"(https?:\/\/(?!findadentist\.ada\.org)[^"]+)"/i,
    ];

    for (const pattern of websitePatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const website = cleanUrl(match[1]);
        if (website && !isDirectoryDomain(website)) return website;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DIRECTORY_DOMAINS = [
  'healthgrades.com', 'zocdoc.com', 'ada.org', 'yelp.com',
  'google.com', 'facebook.com', 'instagram.com', 'twitter.com',
  'linkedin.com', 'youtube.com', 'maps.google.com', 'yellowpages.com',
  'webmd.com', 'vitals.com', 'npidb.org', 'npino.com',
];

function isDirectoryDomain(url) {
  try {
    const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    return DIRECTORY_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return true;
  }
}

function cleanUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function extractExternalLinks(html, excludeDomain) {
  const links = [];
  const regex = /href=["'](https?:\/\/[^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const host = new URL(match[1]).hostname.replace(/^www\./, '');
      if (!host.includes(excludeDomain) && !isDirectoryDomain(match[1])) {
        links.push(host);
      }
    } catch { /* skip invalid URLs */ }
  }
  return [...new Set(links)];
}

function looksLikePracticeWebsite(domain) {
  const lower = domain.toLowerCase();
  const dentalKeywords = ['dental', 'dentist', 'dds', 'dmd', 'smile', 'tooth', 'teeth', 'oral', 'ortho'];
  return dentalKeywords.some((kw) => lower.includes(kw)) || lower.endsWith('.dental') || lower.endsWith('.dentist');
}
