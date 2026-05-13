/**
 * Layer 1: NPI Registry
 *
 * Downloads and stream-parses the NPPES full data file from CMS.
 * Filters by dental taxonomy codes (1223*), batch-inserts into SQLite.
 * Cross-references with cities CSV for priority tier assignment.
 *
 * Source: https://download.cms.gov/nppes/NPI_Files.html
 * The full CSV is ~7GB — we stream-parse it to avoid memory issues.
 */

import { createReadStream, existsSync, readdirSync } from 'fs';
import { parse } from 'csv-parse';
import { bulkInsertPractices, dedupPractices, normalizeName, getDb } from '../store.js';
import { isDentalTaxonomy, getSpecialtyLabel } from '../utils/npi-taxonomy.js';
import { Progress } from '../utils/progress.js';
import { CITIES } from '../../config/cities.js';

// NPI CSV column names (NPPES full replacement file)
const COL = {
  NPI: 'NPI',
  ENTITY_TYPE: 'Entity Type Code',
  LAST_NAME: 'Provider Last Name (Legal Name)',
  FIRST_NAME: 'Provider First Name',
  CREDENTIAL: 'Provider Credential Text',
  ORG_NAME: 'Provider Organization Name (Legal Business Name)',
  OTHER_ORG_NAME: 'Provider Other Organization Name',
  ADDRESS_1: 'Provider First Line Business Practice Location Address',
  ADDRESS_2: 'Provider Second Line Business Practice Location Address',
  CITY: 'Provider Business Practice Location Address City Name',
  STATE: 'Provider Business Practice Location Address State Name',
  ZIP: 'Provider Business Practice Location Address Postal Code',
  PHONE: 'Provider Business Practice Location Address Telephone Number',
  TAXONOMY_1: 'Healthcare Provider Taxonomy Code_1',
  TAXONOMY_2: 'Healthcare Provider Taxonomy Code_2',
  TAXONOMY_3: 'Healthcare Provider Taxonomy Code_3',
  DEACTIVATION: 'NPI Deactivation Date',
};

// Build a set of priority cities for tier assignment
const TIER_A_CITIES = new Set();
const TIER_B_CITIES = new Set();

// Top 20 cities = Tier A, rest of top 50 = Tier B
CITIES.forEach((c, i) => {
  const key = `${c.name.toLowerCase()}|${c.state.toLowerCase()}`;
  if (i < 20) TIER_A_CITIES.add(key);
  else TIER_B_CITIES.add(key);
});

function assignTier(city, state) {
  const key = `${(city || '').toLowerCase()}|${(state || '').toLowerCase()}`;
  if (TIER_A_CITIES.has(key)) return 'A';
  if (TIER_B_CITIES.has(key)) return 'B';
  return 'C';
}

/**
 * Find the NPI data file path.
 * Checks: NPI_DATA_PATH env var → output/npidata*.csv → common locations
 */
function findNpiFile() {
  if (process.env.NPI_DATA_PATH && existsSync(process.env.NPI_DATA_PATH)) {
    return process.env.NPI_DATA_PATH;
  }

  const candidates = [
    './output/npidata.csv',
    './output/npidata_pfile.csv',
    './npidata_pfile.csv',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Look for any file matching npidata*.csv in output/
  try {
    const files = readdirSync('./output');
    const match = files.find((f) => f.toLowerCase().startsWith('npidata') && f.endsWith('.csv'));
    if (match) return `./output/${match}`;
  } catch { /* ignore */ }

  return null;
}

/**
 * Stream-parse the NPI CSV and extract dental providers.
 */
async function streamParseNPI(filePath, opts, filters) {
  const stateFilter = filters.states && filters.states.length > 0
    ? new Set(filters.states.map((s) => s.toUpperCase()))
    : null;

  return new Promise((resolve, reject) => {
    const batch = [];
    let totalRows = 0;
    let dentalRows = 0;
    let filteredOut = 0;
    let deactivated = 0;

    // Estimate total lines for progress (NPI file has ~7.8M rows)
    const estimatedTotal = stateFilter ? 400_000 : 7_800_000;
    const progress = new Progress('NPI Parse', estimatedTotal);

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    const inputStream = createReadStream(filePath, { encoding: 'utf-8' });

    parser.on('data', (row) => {
      totalRows++;
      if (totalRows % 10_000 === 0) progress.tick(10_000);

      // Skip deactivated NPIs
      if (row[COL.DEACTIVATION]) {
        deactivated++;
        return;
      }

      // Check if any taxonomy code is dental
      const tax1 = row[COL.TAXONOMY_1] || '';
      const tax2 = row[COL.TAXONOMY_2] || '';
      const tax3 = row[COL.TAXONOMY_3] || '';

      const dentalTax = [tax1, tax2, tax3].find(isDentalTaxonomy);
      if (!dentalTax) return;

      const state = (row[COL.STATE] || '').toUpperCase();

      // Apply state filter
      if (stateFilter && !stateFilter.has(state)) {
        filteredOut++;
        return;
      }

      dentalRows++;

      // Determine practice name
      const entityType = row[COL.ENTITY_TYPE]; // 1 = individual, 2 = organization
      const orgName = (row[COL.ORG_NAME] || '').trim();
      const otherOrgName = (row[COL.OTHER_ORG_NAME] || '').trim();
      const firstName = (row[COL.FIRST_NAME] || '').trim();
      const lastName = (row[COL.LAST_NAME] || '').trim();
      const credential = (row[COL.CREDENTIAL] || '').trim();

      let practiceName;
      if (entityType === '2' && orgName) {
        practiceName = orgName;
      } else if (otherOrgName) {
        practiceName = otherOrgName;
      } else {
        // Individual provider — use their name as practice name
        practiceName = `${firstName} ${lastName}${credential ? `, ${credential}` : ''}`.trim();
      }

      const city = (row[COL.CITY] || '').trim();
      const zip = (row[COL.ZIP] || '').trim().slice(0, 5);

      batch.push({
        npi: row[COL.NPI],
        name: practiceName,
        name_normalized: normalizeName(practiceName),
        first_name: firstName || null,
        last_name: lastName || null,
        credential: credential || null,
        specialty: getSpecialtyLabel(dentalTax),
        taxonomy_code: dentalTax,
        address_line1: (row[COL.ADDRESS_1] || '').trim() || null,
        address_line2: (row[COL.ADDRESS_2] || '').trim() || null,
        city: city || null,
        state: state || null,
        zip: zip || null,
        phone: formatPhone(row[COL.PHONE]) || null,
        priority_tier: assignTier(city, state),
      });

      // Flush batch when it reaches 5,000
      if (batch.length >= 5_000) {
        const toInsert = batch.splice(0);
        if (!opts.dryRun) {
          bulkInsertPractices(toInsert);
        }
      }
    });

    parser.on('end', () => {
      // Flush remaining batch
      if (batch.length > 0 && !opts.dryRun) {
        bulkInsertPractices(batch);
      }
      progress.done();
      resolve({ totalRows, dentalRows, filteredOut, deactivated });
    });

    parser.on('error', reject);
    inputStream.on('error', reject);

    inputStream.pipe(parser);
  });
}

function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw.trim() || null;
}

/**
 * Main entry point for Layer 1.
 */
export async function run(opts, filters) {
  console.log('  Layer 1: NPI Registry — Loading dental providers\n');

  const npiPath = findNpiFile();

  if (!npiPath) {
    console.error('  ERROR: NPI data file not found.');
    console.error('  Download from: https://download.cms.gov/nppes/NPI_Files.html');
    console.error('  Place the CSV in ./output/ or set NPI_DATA_PATH in .env');
    return;
  }

  console.log(`  NPI file: ${npiPath}`);
  if (filters.states) console.log(`  State filter: ${filters.states.join(', ')}`);

  const stats = await streamParseNPI(npiPath, opts, filters);

  console.log(`\n  NPI Parse Results:`);
  console.log(`    Total rows scanned:    ${stats.totalRows.toLocaleString()}`);
  console.log(`    Dental providers:      ${stats.dentalRows.toLocaleString()}`);
  console.log(`    Filtered out (state):  ${stats.filteredOut.toLocaleString()}`);
  console.log(`    Deactivated (skipped): ${stats.deactivated.toLocaleString()}`);

  // Dedup pass
  if (!opts.dryRun) {
    const dupsRemoved = dedupPractices();
    if (dupsRemoved > 0) {
      console.log(`    Duplicates removed:    ${dupsRemoved.toLocaleString()}`);
    }

    // Report final count
    const db = getDb();
    const where = filters.states && filters.states.length
      ? `WHERE state IN (${filters.states.map((s) => `'${s}'`).join(',')})`
      : '';
    const count = db.prepare(`SELECT COUNT(*) as n FROM practices ${where}`).get().n;
    console.log(`    Final practice count:  ${count.toLocaleString()}`);
  }
}
