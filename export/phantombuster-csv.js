import { stringify } from 'csv-stringify/sync';
import { writeFileSync, mkdirSync } from 'fs';
import { logger } from '../services/logger.js';

const PB_COLUMNS = [
  'profileUrl',
  'firstName',
  'lastName',
  'companyName',
  'vertical',
];

/**
 * Generate a PhantomBuster-compatible CSV from enriched contacts.
 * Only includes contacts with LinkedIn profile URLs.
 *
 * @param {Array<object>} contacts - Enriched contact objects
 * @param {string} vertical - Vertical key
 * @param {string} outputDir - Output directory path
 * @returns {string|null} - Path to CSV, or null if no LinkedIn profiles found
 */
export function generatePhantomBusterCSV(contacts, vertical, outputDir = './output') {
  const withLinkedIn = contacts.filter((c) => c.linkedinUrl);

  if (withLinkedIn.length === 0) {
    logger.info('No LinkedIn profiles for PhantomBuster CSV', { vertical });
    return null;
  }

  mkdirSync(outputDir, { recursive: true });

  const rows = withLinkedIn.map((c) => ({
    profileUrl: c.linkedinUrl,
    firstName: c.firstName,
    lastName: c.lastName,
    companyName: c.companyName,
    vertical,
  }));

  const csv = stringify(rows, {
    header: true,
    columns: PB_COLUMNS,
  });

  const date = new Date().toISOString().slice(0, 10);
  const filePath = `${outputDir}/${date}-${vertical}-phantombuster.csv`;
  writeFileSync(filePath, csv);

  logger.info('PhantomBuster CSV generated', {
    vertical,
    rows: rows.length,
    path: filePath,
  });

  return filePath;
}
