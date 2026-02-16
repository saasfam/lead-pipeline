import { logger } from '../services/logger.js';

const ATTIO_API_KEY = process.env.ATTIO_API_KEY;
const ATTIO_BASE_URL = 'https://api.attio.com/v2';

/**
 * Sync contacts to Attio CRM (Phase 4).
 * Placeholder implementation — will be completed when Attio integration is needed.
 *
 * @param {Array<object>} contacts - Enriched contacts
 * @param {string} vertical - Vertical key
 */
export async function syncToAttio(contacts, vertical) {
  if (!ATTIO_API_KEY) {
    logger.info('ATTIO_API_KEY not set, skipping Attio sync');
    return { synced: 0 };
  }

  logger.info('Attio sync starting', { contacts: contacts.length, vertical });

  let synced = 0;

  for (const contact of contacts) {
    try {
      const res = await fetch(`${ATTIO_BASE_URL}/objects/people/records`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ATTIO_API_KEY}`,
        },
        body: JSON.stringify({
          data: {
            values: {
              email_addresses: [{ email_address: contact.email }],
              name: [{ first_name: contact.firstName, last_name: contact.lastName }],
              job_title: [{ value: contact.title }],
            },
          },
        }),
      });

      if (res.ok) synced++;
    } catch (err) {
      logger.error('Attio sync error', { email: contact.email, error: err.message });
    }
  }

  logger.info('Attio sync complete', { synced, total: contacts.length });
  return { synced };
}
