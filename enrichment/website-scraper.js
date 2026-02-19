import { logger } from '../services/logger.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 10_000;

// Subpage paths to look for (ordered by priority)
const SUBPAGE_PATTERNS = [
  '/about', '/about-us', '/about-us/', '/about/',
  '/team', '/our-team', '/meet-the-team', '/staff', '/doctors', '/providers',
  '/team/', '/our-team/', '/meet-the-team/', '/staff/', '/doctors/', '/providers/',
  '/contact', '/contact-us', '/contact/', '/contact-us/',
];

// Regex patterns
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;

// Domains to ignore in email extraction
const JUNK_EMAIL_DOMAINS = [
  'example.com', 'sentry.io', 'wixpress.com', 'wordpress.com',
  'squarespace.com', 'googleapis.com', 'googleusercontent.com',
  'w3.org', 'schema.org', 'gravatar.com',
];

/**
 * Fetch a URL with timeout and desktop User-Agent.
 * Returns { html, ok } or { html: '', ok: false } on error.
 */
async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) return { html: '', ok: false, status: res.status };
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return { html: '', ok: false, status: res.status };
    const html = await res.text();
    return { html, ok: true, status: res.status };
  } catch (err) {
    return { html: '', ok: false, status: 0, error: err.message };
  }
}

/**
 * Strip HTML tags and collapse whitespace to get readable text.
 */
function htmlToText(html) {
  return html
    // Remove script/style/noscript blocks
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Replace block-level tags with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

/**
 * Discover subpage URLs from homepage HTML.
 * Looks for links matching known patterns (/about, /team, /contact, etc.).
 * Returns up to 3 unique URLs.
 */
function discoverSubpages(html, baseUrl) {
  const found = new Set();
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  // Match all href attributes
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    let fullUrl;

    try {
      if (href.startsWith('http')) {
        fullUrl = new URL(href);
      } else if (href.startsWith('/')) {
        fullUrl = new URL(href, origin);
      } else {
        continue;
      }
    } catch {
      continue;
    }

    // Must be same origin
    if (fullUrl.origin !== origin) continue;

    const pathname = fullUrl.pathname.toLowerCase();
    for (const pattern of SUBPAGE_PATTERNS) {
      if (pathname === pattern || pathname === pattern.replace(/\/$/, '')) {
        found.add(fullUrl.href);
        break;
      }
    }
  }

  // Return up to 3, prioritized by pattern order
  const sorted = [...found].sort((a, b) => {
    const pathA = new URL(a).pathname.toLowerCase();
    const pathB = new URL(b).pathname.toLowerCase();
    const idxA = SUBPAGE_PATTERNS.findIndex((p) => pathA === p || pathA === p.replace(/\/$/, ''));
    const idxB = SUBPAGE_PATTERNS.findIndex((p) => pathB === p || pathB === p.replace(/\/$/, ''));
    return idxA - idxB;
  });

  return sorted.slice(0, 3);
}

/**
 * Extract emails from HTML (both mailto: links and inline patterns).
 * Filters out junk/image/tracking emails.
 */
function extractEmails(html) {
  const emails = new Set();

  // 1. mailto: links
  const mailtoRegex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let match;
  while ((match = mailtoRegex.exec(html)) !== null) {
    emails.add(match[1].toLowerCase());
  }

  // 2. Regex on text content (strip tags first to avoid matching attribute values)
  const text = htmlToText(html);
  const textMatches = text.match(EMAIL_REGEX) || [];
  for (const email of textMatches) {
    emails.add(email.toLowerCase());
  }

  // Filter out junk
  return [...emails].filter((email) => {
    const domain = email.split('@')[1];
    if (!domain) return false;
    if (JUNK_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
    // Filter image file extensions mistakenly matched
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(email)) return false;
    return true;
  });
}

/**
 * Extract US phone numbers from HTML text.
 */
function extractPhones(html) {
  const text = htmlToText(html);
  const matches = text.match(PHONE_REGEX) || [];
  // Deduplicate by normalized form (digits only)
  const seen = new Set();
  return matches.filter((phone) => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) return false;
    if (seen.has(digits)) return false;
    seen.add(digits);
    return true;
  });
}

/**
 * Scrape a single domain: fetch homepage + up to 3 subpages.
 *
 * @param {string} domain - e.g. "smiledentalclinic.com"
 * @returns {{ emails: string[], phones: string[], pageTexts: string[], pagesScraped: number, error?: string }}
 */
export async function scrapeDomain(domain) {
  const baseUrl = `https://${domain}`;
  const result = {
    emails: [],
    phones: [],
    pageTexts: [],
    pagesScraped: 0,
    error: null,
  };

  // 1. Fetch homepage
  const homepage = await fetchPage(baseUrl);
  if (!homepage.ok) {
    // Try http:// fallback
    const httpFallback = await fetchPage(`http://${domain}`);
    if (!httpFallback.ok) {
      result.error = `Failed to fetch: status=${homepage.status} ${homepage.error || ''}`;
      return result;
    }
    homepage.html = httpFallback.html;
  }

  result.pagesScraped = 1;
  const allHtml = [homepage.html];

  // 2. Discover and fetch subpages
  const subpageUrls = discoverSubpages(homepage.html, baseUrl);

  for (const url of subpageUrls) {
    const page = await fetchPage(url);
    if (page.ok && page.html.length > 500) {
      allHtml.push(page.html);
      result.pagesScraped++;
    }
  }

  // 3. Extract emails and phones from ALL pages combined
  const combinedHtml = allHtml.join('\n');
  result.emails = extractEmails(combinedHtml);
  result.phones = extractPhones(combinedHtml);

  // 4. Convert to text for GPT extraction (truncate to ~15k chars to stay within token limits)
  const MAX_TEXT_LENGTH = 15_000;
  let combinedText = '';
  for (const html of allHtml) {
    const text = htmlToText(html);
    combinedText += text + '\n---\n';
    if (combinedText.length > MAX_TEXT_LENGTH) break;
  }
  result.pageTexts = [combinedText.slice(0, MAX_TEXT_LENGTH)];

  logger.debug('Domain scraped', {
    domain,
    pagesScraped: result.pagesScraped,
    emails: result.emails.length,
    phones: result.phones.length,
    textLength: result.pageTexts[0].length,
  });

  return result;
}
