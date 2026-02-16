import { createSession, randomDelay, autoScroll } from './browserbase-client.js';
import { logger } from '../services/logger.js';

/**
 * Scrape Google Maps for businesses matching a query in a city.
 *
 * @param {string} query - Search term (e.g., "dentist")
 * @param {object} city - City object { name, state, searchSuffix }
 * @returns {Array<object>} - Array of business objects
 */
export async function scrapeGoogleMaps(query, city) {
  const searchTerm = `${query} in ${city.searchSuffix}`;
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;

  logger.info('Starting Google Maps scrape', { query, city: city.name, url: mapsUrl });

  const { page, close } = await createSession();

  try {
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Scroll the results panel to load more results
    const resultsPanel = page.locator('div[role="feed"]');
    const panelExists = await resultsPanel.count();

    if (panelExists > 0) {
      await scrollResultsPanel(page, resultsPanel);
    }

    // Extract all visible business listings
    const businesses = await extractListings(page, city);

    logger.info('Google Maps scrape complete', {
      query,
      city: city.name,
      count: businesses.length,
    });

    return businesses;
  } catch (err) {
    logger.error('Google Maps scrape failed', {
      query,
      city: city.name,
      error: err.message,
    });
    return [];
  } finally {
    await close();
  }
}

/**
 * Scroll the Google Maps results feed panel to load all results.
 */
async function scrollResultsPanel(page, panel) {
  let previousCount = 0;
  let scrollAttempts = 0;
  const maxScrolls = 15;

  while (scrollAttempts < maxScrolls) {
    const currentCount = await page.locator('div[role="feed"] > div > div > a').count();

    // Check if "end of results" indicator appeared
    const endOfList = await page.locator('span.HlvSq').count();
    if (endOfList > 0) break;

    if (currentCount === previousCount) {
      scrollAttempts++;
      if (scrollAttempts >= 3) break; // No new results after 3 attempts
    } else {
      scrollAttempts = 0;
    }
    previousCount = currentCount;

    await panel.evaluate((el) => el.scrollTop = el.scrollHeight);
    await page.waitForTimeout(2000);
  }
}

/**
 * Extract business data from Google Maps listings.
 */
async function extractListings(page, city) {
  const listings = await page.evaluate(() => {
    const results = [];
    // Each listing is an anchor inside the feed
    const items = document.querySelectorAll('div[role="feed"] > div > div > a');

    for (const item of items) {
      const ariaLabel = item.getAttribute('aria-label') || '';
      if (!ariaLabel) continue;

      // The parent container has additional info
      const container = item.closest('div > div');
      const allText = container ? container.textContent : '';

      // Extract rating from aria-label pattern "X stars"
      const ratingMatch = allText.match(/([\d.]+)\s*stars?/i);
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

      // Extract phone — US phone pattern
      const phoneMatch = allText.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      const phone = phoneMatch ? phoneMatch[0] : null;

      // Extract website from sibling elements (if visible)
      const websiteEl = container?.querySelector('a[data-value="Website"]');
      const website = websiteEl ? websiteEl.href : null;

      // Try to extract address
      const addressMatch = allText.match(/\d+\s+[\w\s]+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct|Pkwy|Pl|Cir)[.,]?\s+[\w\s]+,?\s*[A-Z]{2}/i);
      const address = addressMatch ? addressMatch[0].trim() : null;

      results.push({
        name: ariaLabel,
        phone,
        website,
        rating,
        address,
        rawText: allText.slice(0, 500), // Keep some raw text for debugging
      });
    }

    return results;
  });

  // Enrich with city/state info
  return listings.map((b) => ({
    ...b,
    city: city.name,
    state: city.state,
    source: 'google-maps',
  }));
}

/**
 * Scrape Google Maps for a vertical across multiple cities.
 *
 * @param {object} vertical - Vertical config from verticals.js
 * @param {Array} cities - Array of city objects
 * @returns {Array<object>} - All scraped businesses
 */
export async function scrapeVerticalGoogleMaps(vertical, cities) {
  const allBusinesses = [];

  for (const query of vertical.searchQueries) {
    for (const city of cities) {
      const businesses = await scrapeGoogleMaps(query, city);
      allBusinesses.push(...businesses);

      // Delay between searches
      await randomDelay(3000, 6000);

      logger.info('Running total', {
        query,
        city: city.name,
        batch: businesses.length,
        total: allBusinesses.length,
      });
    }
  }

  return allBusinesses;
}
