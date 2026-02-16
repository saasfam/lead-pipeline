import { createSession, randomDelay } from './browserbase-client.js';
import { logger } from '../services/logger.js';

/**
 * Scrape Yelp search results for businesses.
 *
 * @param {string} query - Search term
 * @param {object} city - City object { name, state, searchSuffix }
 * @param {number} maxPages - Max result pages to scrape (10 results per page)
 * @returns {Array<object>}
 */
export async function scrapeYelp(query, city, maxPages = 5) {
  const allBusinesses = [];
  const { page, close } = await createSession();

  try {
    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const start = pageNum * 10;
      const url = `https://www.yelp.com/search?find_desc=${encodeURIComponent(query)}&find_loc=${encodeURIComponent(city.searchSuffix)}&start=${start}`;

      logger.info('Scraping Yelp page', { query, city: city.name, page: pageNum + 1 });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const businesses = await page.evaluate(() => {
        const results = [];
        // Yelp search result containers
        const cards = document.querySelectorAll('[data-testid="serp-ia-card"]');

        for (const card of cards) {
          const nameEl = card.querySelector('a[class*="css-"] span');
          const name = nameEl?.textContent?.trim() || '';
          if (!name) continue;

          const linkEl = card.querySelector('a[href*="/biz/"]');
          const yelpUrl = linkEl ? linkEl.href : null;

          const ratingEl = card.querySelector('[aria-label*="star rating"]');
          const ratingMatch = ratingEl?.getAttribute('aria-label')?.match(/([\d.]+)/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

          const phoneEl = card.querySelector('p[class*="css-"]');
          const allText = card.textContent || '';
          const phoneMatch = allText.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
          const phone = phoneMatch ? phoneMatch[0] : null;

          const addressParts = [];
          const addressEls = card.querySelectorAll('span[class*="css-"]');
          for (const el of addressEls) {
            const text = el.textContent.trim();
            if (text.match(/\d+\s+\w+/) && text.length < 100) {
              addressParts.push(text);
            }
          }

          results.push({
            name,
            phone,
            website: null, // Yelp doesn't show websites in search results
            rating,
            yelpUrl,
            address: addressParts[0] || null,
          });
        }

        return results;
      });

      if (businesses.length === 0) break; // No more results

      allBusinesses.push(
        ...businesses.map((b) => ({
          ...b,
          city: city.name,
          state: city.state,
          source: 'yelp',
        }))
      );

      await randomDelay(3000, 6000);
    }
  } catch (err) {
    logger.error('Yelp scrape failed', {
      query,
      city: city.name,
      error: err.message,
    });
  } finally {
    await close();
  }

  logger.info('Yelp scrape complete', {
    query,
    city: city.name,
    count: allBusinesses.length,
  });

  return allBusinesses;
}
