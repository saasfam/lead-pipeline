import { stringify } from 'csv-stringify/sync';
import { writeFileSync, mkdirSync } from 'fs';
import { logger } from '../services/logger.js';

const INSTANTLY_COLUMNS = [
  'email',
  'first_name',
  'last_name',
  'company_name',
  'title',
  'phone',
  'website',
  'vertical',
  'city',
  'state',
  'linkedin_url',
];

/**
 * Generate an Instantly-compatible CSV from enriched contacts.
 *
 * @param {Array<object>} contacts - Enriched contact objects
 * @param {string} vertical - Vertical key
 * @param {string} outputDir - Output directory path
 * @returns {string} - Path to the generated CSV
 */
export function generateInstantlyCSV(contacts, vertical, outputDir = './output') {
  mkdirSync(outputDir, { recursive: true });

  const rows = contacts.map((c) => ({
    email: c.email,
    first_name: c.firstName,
    last_name: c.lastName,
    company_name: c.companyName,
    title: c.title,
    phone: c.phone || '',
    website: c.companyDomain ? `https://${c.companyDomain}` : '',
    vertical,
    city: c.city || '',
    state: c.state || '',
    linkedin_url: c.linkedinUrl || '',
  }));

  const csv = stringify(rows, {
    header: true,
    columns: INSTANTLY_COLUMNS,
  });

  const date = new Date().toISOString().slice(0, 10);
  const filePath = `${outputDir}/${date}-${vertical}-instantly.csv`;
  writeFileSync(filePath, csv);

  logger.info('Instantly CSV generated', {
    vertical,
    rows: rows.length,
    path: filePath,
  });

  return filePath;
}
