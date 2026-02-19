#!/usr/bin/env node

/**
 * Email Generation Script — Generate best-guess emails for dental clinic staff.
 *
 * For clinics where we found staff names but no emails on the website,
 * checks DNS MX records to confirm the domain can receive email,
 * then generates the most likely email pattern based on the mail provider.
 *
 * Usage:
 *   node --env-file=.env scripts/enrich-emails.js [options]
 *
 * Options:
 *   --sample N        Process N domains only
 *   --skip-generic    Skip generic email guesses (info@, office@)
 *   --skip-staff      Skip staff-based email guesses
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { stringify } from 'csv-stringify/sync';
import { parse } from 'csv-parse/sync';
import { processDomain } from '../enrichment/email-guesser.js';
import { logger } from '../services/logger.js';

// ── CLI parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

const sampleSize = getArg('--sample') ? parseInt(getArg('--sample'), 10) : 0;
const skipGeneric = args.includes('--skip-generic');
const skipStaff = args.includes('--skip-staff');

const date = new Date().toISOString().slice(0, 10);
const OUTPUT_DIR = './output';
const WEBSITE_CACHE = `${OUTPUT_DIR}/.website-enrichment-cache.json`;
const INPUT_CSV = `${OUTPUT_DIR}/dentist-enriched-${date}.csv`;
const OUTPUT_CSV = `${OUTPUT_DIR}/dentist-enriched-${date}.csv`; // overwrite in place

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadJSON(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function splitName(fullName) {
  if (!fullName) return { firstName: '', lastName: '' };
  const cleaned = fullName
    .replace(/^Dr\.?\s+/i, '')
    .replace(/,?\s*\b(DDS|DMD|PhD|MD|DO|MS|MBA|FAGD|FICOI|FAACD|Jr|Sr|III|II|IV)\b\.?/gi, '')
    .trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  EMAIL GENERATION (MX + Best-Guess Patterns)');
  console.log('='.repeat(60));
  console.log(`  Date:         ${date}`);
  console.log(`  Sample:       ${sampleSize || 'all'}`);
  console.log(`  Skip staff:   ${skipStaff}`);
  console.log(`  Skip generic: ${skipGeneric}`);

  // ── Step 1: Load data ─────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log('  STEP 1: Identify Domains Needing Emails');
  console.log('='.repeat(60));

  const websiteCache = loadJSON(WEBSITE_CACHE);

  if (Object.keys(websiteCache).length === 0) {
    console.error('  ERROR: No website enrichment cache found. Run enrich-websites.js first.');
    process.exit(1);
  }

  // Build work list: domains with staff names but no scraped emails
  const domainWork = new Map(); // domain → { staff: [...], hasScrapedEmails }

  for (const [domain, data] of Object.entries(websiteCache)) {
    if (data.error) continue;

    const hasScrapedEmails = data.emails?.length > 0;
    if (hasScrapedEmails) continue; // already have emails

    const staff = [];
    if (!skipStaff && data.staff?.length > 0) {
      for (const person of data.staff) {
        const { firstName, lastName } = splitName(person.name);
        if (!firstName || firstName.length < 2) continue;

        // Use last word of multi-word last names for pattern generation
        const lastNamePart = lastName.split(/\s+/).pop() || '';
        staff.push({
          firstName,
          lastName: lastNamePart,
          fullName: person.name,
          title: person.title || '',
        });
      }
    }

    // Only include if there's something to do
    if (staff.length > 0 || !skipGeneric) {
      domainWork.set(domain, { staff });
    }
  }

  let domains = [...domainWork.keys()];

  // Apply sample
  if (sampleSize > 0 && sampleSize < domains.length) {
    for (let i = domains.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [domains[i], domains[j]] = [domains[j], domains[i]];
    }
    domains = domains.slice(0, sampleSize);
  }

  const totalStaff = domains.reduce((s, d) => s + (domainWork.get(d)?.staff.length || 0), 0);
  console.log(`  Domains to process:  ${domains.length}`);
  console.log(`  Staff to generate:   ${totalStaff}`);

  // ── Step 2: MX Check + Generate Emails ────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log('  STEP 2: MX Check + Generate Emails');
  console.log('='.repeat(60));

  const results = []; // { domain, provider, hasMX, staff, genericEmail }
  let hasMX = 0;
  let noMX = 0;
  let staffEmailsGenerated = 0;
  let genericEmailsGenerated = 0;
  const providerCounts = {};
  const startTime = Date.now();

  // Process in batches of 10 (DNS lookups are fast)
  const BATCH_SIZE = 10;

  for (let i = 0; i < domains.length; i += BATCH_SIZE) {
    const batch = domains.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (domain) => {
        const work = domainWork.get(domain);
        return processDomain(domain, work.staff, { includeGeneric: !skipGeneric });
      })
    );

    for (const result of batchResults) {
      results.push(result);
      if (result.hasMX) {
        hasMX++;
        providerCounts[result.provider] = (providerCounts[result.provider] || 0) + 1;
        staffEmailsGenerated += result.staff.length;
        if (result.genericEmail) genericEmailsGenerated++;
      } else {
        noMX++;
      }
    }

    // Progress every 50 domains
    const processed = Math.min(i + BATCH_SIZE, domains.length);
    if (processed % 50 === 0 || processed === domains.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(
        `  [${processed}/${domains.length}] ${elapsed}s | MX: ${hasMX} yes, ${noMX} no | emails: ${staffEmailsGenerated} staff, ${genericEmailsGenerated} generic`
      );
    }
  }

  console.log('\n  MX Providers:');
  for (const [provider, count] of Object.entries(providerCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${provider}: ${count}`);
  }

  // ── Step 3: Update CSV ────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log('  STEP 3: Update Enriched CSV');
  console.log('='.repeat(60));

  const csvContent = readFileSync(INPUT_CSV, 'utf-8');
  const existingRows = parse(csvContent, { columns: true, skip_empty_lines: true });

  // Build lookup: domain → result
  const resultMap = new Map();
  for (const r of results) {
    if (r.hasMX) resultMap.set(r.domain, r);
  }

  // Pass 1: Fill in emails for existing rows that have firstName but no email
  let rowsUpdated = 0;
  for (const row of existingRows) {
    if (row.email) continue; // already has email
    const domain = row.companyDomain;
    const result = resultMap.get(domain);
    if (!result) continue;

    // Find matching staff by firstName
    const match = result.staff.find(
      (s) => s.firstName.toLowerCase() === (row.firstName || '').toLowerCase()
    );
    if (match?.email) {
      row.email = match.email;
      row.source = row.source === 'website-scrape' ? 'website-scrape+guess' : row.source;
      rowsUpdated++;
    }
  }

  // Pass 2: Add generic email rows for domains that still have zero email rows
  const domainsWithEmail = new Set();
  for (const row of existingRows) {
    if (row.email && row.companyDomain) domainsWithEmail.add(row.companyDomain);
  }

  let genericRowsAdded = 0;
  const newRows = [...existingRows];

  if (!skipGeneric) {
    for (const result of results) {
      if (!result.hasMX || !result.genericEmail) continue;
      if (domainsWithEmail.has(result.domain)) continue;

      const bizData = websiteCache[result.domain] || {};
      newRows.push({
        firstName: '',
        lastName: '',
        email: result.genericEmail,
        title: '',
        phone: bizData.phones?.[0] || '',
        companyName: '',
        companyDomain: result.domain,
        website: `https://${result.domain}`,
        city: '',
        state: '',
        address: '',
        rating: '',
        reviewCount: '',
        companyDescription: bizData.companyDescription || '',
        specialties: (bizData.specialties || []).join('; '),
        yearFounded: bizData.yearFounded || '',
        locationCount: bizData.locationCount || '',
        source: 'generic-guess',
      });
      genericRowsAdded++;
    }
  }

  // Write CSV
  const csv = stringify(newRows, { header: true });
  writeFileSync(OUTPUT_CSV, csv);

  // ── Stats ───────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Count how many rows now have emails
  const totalWithEmail = newRows.filter((r) => r.email).length;
  const totalRows = newRows.length;

  console.log('\n' + '='.repeat(60));
  console.log('  RESULTS');
  console.log('='.repeat(60));
  console.log(`  Domains checked:         ${domains.length}`);
  console.log(`  Domains with MX:         ${hasMX} (${((hasMX / domains.length) * 100).toFixed(1)}%)`);
  console.log(`  Domains without MX:      ${noMX}`);
  console.log(`  ---`);
  console.log(`  Staff emails generated:  ${staffEmailsGenerated}`);
  console.log(`  Generic emails added:    ${genericRowsAdded}`);
  console.log(`  Existing rows updated:   ${rowsUpdated}`);
  console.log(`  ---`);
  console.log(`  Total CSV rows:          ${totalRows}`);
  console.log(`  Rows with email:         ${totalWithEmail} (${((totalWithEmail / totalRows) * 100).toFixed(1)}%)`);
  console.log(`  Time elapsed:            ${elapsed}s`);
  console.log(`  Output:                  ${OUTPUT_CSV}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  logger.error('Email generation failed', { error: err.message, stack: err.stack });
  console.error('Failed:', err.message);
  process.exit(1);
});
