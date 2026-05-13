/**
 * Layer 5: Website Enrichment
 *
 * For practices with a domain but not yet scraped, use existing modules:
 *   - website-scraper.js → scrapeDomain() → HTML text, emails, phones
 *   - website-extractor.js → extractFromWebsite() → staff, description, specialties
 *
 * Inserts extracted staff as contacts, updates practice with web data.
 * Cost: ~$8 for ~80K calls to GPT-4o-mini.
 */

import { practicesNeedingScrape, updatePracticeWebData, insertContacts, getDb } from '../store.js';
import { scrapeDomain } from '../../enrichment/website-scraper.js';
import { extractFromWebsite } from '../../enrichment/website-extractor.js';
import { Progress } from '../utils/progress.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse a full name into first/last components.
 */
function parseName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  const parts = fullName.trim().split(/\s+/);

  // Remove common prefixes
  if (parts[0] && /^(dr\.?|doctor)$/i.test(parts[0])) parts.shift();

  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };

  // Last part is last name, first part is first name (skip middle/credentials)
  return {
    firstName: parts[0],
    lastName: parts[parts.length - 1].replace(/,?\s*(dds|dmd|ms|phd)$/i, '').trim() || parts[parts.length - 1],
  };
}

/**
 * Process a single practice: scrape website, extract data, insert contacts.
 */
async function processPractice(practice) {
  const domain = practice.domain;

  // Step 1: Scrape the website
  const scrapeResult = await scrapeDomain(domain);
  if (scrapeResult.error && scrapeResult.pagesScraped === 0) {
    // Mark as scraped (failed) to avoid retrying
    updatePracticeWebData(practice.id, {});
    return { staffCount: 0, error: scrapeResult.error };
  }

  // Step 2: Extract structured data with GPT-4o-mini
  const text = scrapeResult.pageTexts?.[0] || '';
  const extracted = await extractFromWebsite(text, domain, 'dental clinic');

  // Step 3: Update practice record
  updatePracticeWebData(practice.id, {
    companyDesc: extracted.companyDescription,
    specialtiesCsv: extracted.specialties?.join(', ') || null,
    yearFounded: extracted.yearFounded,
    locationCount: extracted.locationCount,
  });

  // Step 4: Insert staff as contacts
  const contacts = [];

  // Staff from GPT extraction
  for (const person of extracted.staff || []) {
    const { firstName, lastName } = parseName(person.name);
    contacts.push({
      firstName,
      lastName,
      fullName: person.name,
      title: person.title,
      email: person.email || null,
      emailSource: person.email ? 'website' : null,
      phone: person.phone || null,
    });
  }

  // If no staff found, create a contact from the practice's provider info
  if (contacts.length === 0 && practice.first_name && practice.last_name) {
    contacts.push({
      firstName: practice.first_name,
      lastName: practice.last_name,
      fullName: `${practice.first_name} ${practice.last_name}`,
      title: practice.credential || 'DDS',
      email: null,
      emailSource: null,
      phone: null,
    });
  }

  // Add emails found by scraper that weren't already on staff
  const staffEmails = new Set(contacts.map((c) => c.email).filter(Boolean));
  for (const email of scrapeResult.emails || []) {
    if (!staffEmails.has(email)) {
      // Try to associate with first contact without email
      const unmatched = contacts.find((c) => !c.email);
      if (unmatched) {
        unmatched.email = email;
        unmatched.emailSource = 'website-scrape';
      }
    }
  }

  if (contacts.length > 0) {
    insertContacts(practice.id, contacts);
  }

  return { staffCount: contacts.length, error: null };
}

export async function run(opts, filters) {
  console.log('  Layer 5: Website Enrichment — Scrape + GPT-4o-mini extraction\n');

  const practices = practicesNeedingScrape(filters, opts.sample || 0);
  console.log(`  Practices needing scrape: ${practices.length.toLocaleString()}`);

  if (practices.length === 0) {
    console.log('  Nothing to do — all practices with domains are scraped.');
    return;
  }

  if (opts.dryRun) {
    console.log('\n  DRY RUN — Would scrape:');
    for (const p of practices.slice(0, 5)) {
      console.log(`    ${p.domain} (${p.name})`);
    }
    return;
  }

  const progress = new Progress('Web Enrich', practices.length);
  let totalStaff = 0;
  let errors = 0;

  // Process with limited concurrency (rate-limited by extractorLimiter in website-extractor)
  const concurrency = Math.min(opts.concurrency || 5, 10);

  for (let i = 0; i < practices.length; i += concurrency) {
    const batch = practices.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((p) => processPractice(p))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        totalStaff += result.value.staffCount;
        if (result.value.error) errors++;
      } else {
        errors++;
      }
    }

    progress.tick(batch.length);
  }

  console.log(`\n  Results:`);
  console.log(`    Scraped:        ${practices.length.toLocaleString()}`);
  console.log(`    Staff found:    ${totalStaff.toLocaleString()}`);
  console.log(`    Scrape errors:  ${errors}`);
}
