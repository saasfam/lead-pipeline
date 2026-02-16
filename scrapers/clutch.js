import { createSession, randomDelay } from './browserbase-client.js';
import { logger } from '../services/logger.js';

/**
 * Category slugs for Clutch.co scraping.
 */
const CLUTCH_CATEGORIES = {
  bpo: 'business-process-outsourcing',
  msp: 'it-managed-services',
  contactcenter: 'call-centers',
  recruiting: 'staffing',
  agencies: 'digital-marketing',
};

/**
 * Scrape Clutch.co for B2B service companies.
 *
 * @param {string} verticalKey - Vertical key from verticals.js
 * @param {number} maxPages - Max pages to scrape (15 results per page)
 * @returns {Array<object>}
 */
export async function scrapeClutch(verticalKey, maxPages = 10) {
  const category = CLUTCH_CATEGORIES[verticalKey];
  if (!category) {
    logger.warn('No Clutch category for vertical', { vertical: verticalKey });
    return [];
  }

  const allBusinesses = [];
  const { page, close } = await createSession();

  try {
    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const url = pageNum === 0
        ? `https://clutch.co/bpo/${category}`
        : `https://clutch.co/bpo/${category}?page=${pageNum}`;

      logger.info('Scraping Clutch page', { vertical: verticalKey, page: pageNum + 1 });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const businesses = await page.evaluate(() => {
        const results = [];
        const cards = document.querySelectorAll('.provider-row, [data-content="provider"]');

        for (const card of cards) {
          const nameEl = card.querySelector('h3 a, .company_info a');
          const name = nameEl?.textContent?.trim() || '';
          if (!name) continue;

          const websiteEl = card.querySelector('a[class*="website"]');
          const website = websiteEl?.href || null;

          const locationEl = card.querySelector('.locality');
          const location = locationEl?.textContent?.trim() || null;

          const sizeEl = card.querySelector('[data-content="employees"], .company_info span');
          const sizeText = sizeEl?.textContent?.trim() || '';
          const sizeMatch = sizeText.match(/(\d+[\s-]+\d+|\d+\+?)\s*employees?/i);
          const employeeCount = sizeMatch ? sizeMatch[1] : null;

          const ratingEl = card.querySelector('.rating');
          const ratingText = ratingEl?.textContent?.trim() || '';
          const ratingMatch = ratingText.match(/([\d.]+)/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

          const clutchUrl = nameEl?.href || null;

          results.push({
            name,
            website,
            location,
            employeeCount,
            rating,
            clutchUrl,
            phone: null,
          });
        }

        return results;
      });

      if (businesses.length === 0) break;

      allBusinesses.push(
        ...businesses.map((b) => ({
          ...b,
          source: 'clutch',
          vertical: verticalKey,
        }))
      );

      await randomDelay(3000, 6000);
    }
  } catch (err) {
    logger.error('Clutch scrape failed', {
      vertical: verticalKey,
      error: err.message,
    });
  } finally {
    await close();
  }

  logger.info('Clutch scrape complete', {
    vertical: verticalKey,
    count: allBusinesses.length,
  });

  return allBusinesses;
}
