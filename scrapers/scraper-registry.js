import { scrapeVerticalGoogleMaps } from './google-maps.js';
import { scrapeYelp } from './yelp.js';
import { scrapeClutch } from './clutch.js';
import { logger } from '../services/logger.js';

/**
 * Run all configured scrapers for a vertical.
 *
 * @param {object} vertical - Vertical config (from verticals.js)
 * @param {string} verticalKey - Vertical key
 * @param {Array} cities - Array of city objects
 * @returns {Array<object>} - Combined results from all scrapers
 */
export async function runScrapersForVertical(vertical, verticalKey, cities) {
  const allResults = [];

  for (const scraper of vertical.directories) {
    logger.info('Running scraper', { scraper, vertical: verticalKey });

    try {
      let results = [];

      switch (scraper) {
        case 'google-maps':
          results = await scrapeVerticalGoogleMaps(vertical, cities);
          break;

        case 'yelp':
          // Yelp: run first search query across all cities
          for (const city of cities) {
            const yelpResults = await scrapeYelp(vertical.searchQueries[0], city);
            results.push(...yelpResults);
          }
          break;

        case 'clutch':
          results = await scrapeClutch(verticalKey);
          break;

        default:
          logger.warn('Unknown scraper', { scraper });
      }

      logger.info('Scraper complete', {
        scraper,
        vertical: verticalKey,
        count: results.length,
      });

      allResults.push(...results);
    } catch (err) {
      logger.error('Scraper failed', {
        scraper,
        vertical: verticalKey,
        error: err.message,
      });
    }
  }

  return allResults;
}
