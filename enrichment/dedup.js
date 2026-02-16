import { logger } from '../services/logger.js';

/**
 * Deduplicate businesses by domain and name similarity.
 *
 * @param {Array<object>} businesses - Business objects with `domain` and `name`
 * @returns {Array<object>} - Deduplicated businesses
 */
export function dedupBusinesses(businesses) {
  const seen = new Map(); // domain → first business
  const results = [];

  for (const biz of businesses) {
    const key = biz.domain || normalizeName(biz.name);
    if (!key) {
      results.push(biz);
      continue;
    }

    if (!seen.has(key)) {
      seen.set(key, biz);
      results.push(biz);
    }
    // If duplicate, skip (keep first occurrence)
  }

  const removed = businesses.length - results.length;
  if (removed > 0) {
    logger.info('Dedup businesses', {
      before: businesses.length,
      after: results.length,
      removed,
    });
  }

  return results;
}

/**
 * Deduplicate contacts by email.
 *
 * @param {Array<object>} contacts - Contact objects with `email`
 * @returns {Array<object>} - Deduplicated contacts
 */
export function dedupContacts(contacts) {
  const seen = new Set();
  const results = [];

  for (const contact of contacts) {
    const email = contact.email?.toLowerCase();
    if (!email) continue;

    if (!seen.has(email)) {
      seen.add(email);
      results.push(contact);
    }
  }

  const removed = contacts.length - results.length;
  if (removed > 0) {
    logger.info('Dedup contacts', {
      before: contacts.length,
      after: results.length,
      removed,
    });
  }

  return results;
}

/**
 * Normalize a business name for dedup comparison.
 */
function normalizeName(name) {
  if (!name) return null;
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 50);
}
