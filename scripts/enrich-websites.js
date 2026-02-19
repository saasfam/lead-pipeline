#!/usr/bin/env node

/**
 * Website Enrichment Script — Scrape dental clinic websites for contact data.
 *
 * Fetches homepage + subpages (/about, /team, /contact), extracts emails/phones
 * via regex, and uses GPT-4o-mini for structured staff/specialty extraction.
 *
 * Usage:
 *   node --env-file=.env scripts/enrich-websites.js [options]
 *
 * Options:
 *   --input <csv|cache>   Input source (default: "cache" = scrape cache + apollo cache)
 *   --csv <path>          Path to input CSV with 'domain' or 'website' column
 *   --sample N            Process N random domains only
 *   --skip-ai             Skip GPT extraction, only do regex email/phone
 *   --concurrency N       HTTP fetch concurrency (default: 5)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { extractDomain, isGenericDomain, isPersonalDomain } from '../enrichment/domain-resolver.js';
import { scrapeDomain } from '../enrichment/website-scraper.js';
import { extractFromWebsite } from '../enrichment/website-extractor.js';
import { logger } from '../services/logger.js';

// ── CLI parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

const inputMode = getArg('--input') || 'cache';
const csvPath = getArg('--csv');
const sampleSize = getArg('--sample') ? parseInt(getArg('--sample'), 10) : 0;
const skipAi = args.includes('--skip-ai');
const concurrency = getArg('--concurrency') ? parseInt(getArg('--concurrency'), 10) : 5;

const date = new Date().toISOString().slice(0, 10);
const OUTPUT_DIR = './output';
const CACHE_FILE = `${OUTPUT_DIR}/.website-enrichment-cache.json`;
const OUTPUT_CSV = `${OUTPUT_DIR}/dentist-enriched-${date}.csv`;

// ── Cache helpers ───────────────────────────────────────────────────────────

function loadCache(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Load domains from input sources ─────────────────────────────────────────

function loadDomainsFromCache() {
  const SCRAPE_CACHE = `${OUTPUT_DIR}/.dentist-scrape-cache.json`;
  const APOLLO_CACHE = `${OUTPUT_DIR}/.dentist-apollo-cache.json`;

  const domainBizMap = new Map(); // domain → business info

  // 1. Scrape cache — businesses with website URLs
  if (existsSync(SCRAPE_CACHE)) {
    const scrapeCache = JSON.parse(readFileSync(SCRAPE_CACHE, 'utf-8'));
    for (const key of Object.keys(scrapeCache)) {
      for (const biz of scrapeCache[key]) {
        const domain = extractDomain(biz.website);
        if (!domain || isGenericDomain(domain) || isPersonalDomain(domain)) continue;
        if (domainBizMap.has(domain)) continue;
        domainBizMap.set(domain, {
          name: biz.name || '',
          website: biz.website || '',
          phone: biz.phone || '',
          city: biz.city || '',
          state: biz.state || 'CA',
          address: biz.address || '',
          rating: biz.rating || '',
          reviewCount: biz.reviewCount || '',
        });
      }
    }
    console.log(`  Scrape cache: ${domainBizMap.size} unique domains with websites`);
  }

  // 2. Apollo cache — additional domains
  if (existsSync(APOLLO_CACHE)) {
    const apolloCache = JSON.parse(readFileSync(APOLLO_CACHE, 'utf-8'));
    let added = 0;
    for (const domain of Object.keys(apolloCache)) {
      if (domainBizMap.has(domain)) continue;
      if (isGenericDomain(domain) || isPersonalDomain(domain)) continue;
      domainBizMap.set(domain, {
        name: '',
        website: `https://${domain}`,
        phone: '',
        city: '',
        state: '',
        address: '',
        rating: '',
        reviewCount: '',
      });
      added++;
    }
    console.log(`  Apollo cache: +${added} domains (not in scrape cache)`);
  }

  return domainBizMap;
}

function loadDomainsFromCsv(path) {
  const content = readFileSync(path, 'utf-8');
  const records = parse(content, { columns: true, skip_empty_lines: true });
  const domainBizMap = new Map();

  for (const row of records) {
    const website = row.website || row.Website || row.companyDomain || '';
    const domain = row.domain || extractDomain(website);
    if (!domain || isGenericDomain(domain) || isPersonalDomain(domain)) continue;
    if (domainBizMap.has(domain)) continue;
    domainBizMap.set(domain, {
      name: row.name || row.companyName || '',
      website: website.startsWith('http') ? website : `https://${domain}`,
      phone: row.phone || '',
      city: row.city || '',
      state: row.state || '',
      address: row.address || '',
      rating: row.rating || '',
      reviewCount: row.reviewCount || '',
    });
  }

  return domainBizMap;
}

// ── Batch processing with concurrency ───────────────────────────────────────

async function processBatch(domains, fn, batchSize) {
  const results = [];
  for (let i = 0; i < domains.length; i += batchSize) {
    const batch = domains.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ── Split name into firstName / lastName ────────────────────────────────────

function splitName(fullName) {
  if (!fullName) return { firstName: '', lastName: '' };
  // Strip "Dr." prefix, then remove trailing credential suffixes
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
  console.log('  WEBSITE ENRICHMENT — Dental Clinics');
  console.log('='.repeat(60));
  console.log(`  Date:        ${date}`);
  console.log(`  Input:       ${inputMode}${csvPath ? ` (${csvPath})` : ''}`);
  console.log(`  Sample:      ${sampleSize || 'all'}`);
  console.log(`  Skip AI:     ${skipAi}`);
  console.log(`  Concurrency: ${concurrency}`);

  // ── Step 1: Load domains ────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log('  STEP 1: Load Domains');
  console.log('='.repeat(60));

  let domainBizMap;
  if (inputMode === 'csv' && csvPath) {
    domainBizMap = loadDomainsFromCsv(csvPath);
  } else {
    domainBizMap = loadDomainsFromCache();
  }

  console.log(`  Total unique domains: ${domainBizMap.size}`);

  // Apply sample
  let domains = [...domainBizMap.keys()];
  if (sampleSize > 0 && sampleSize < domains.length) {
    // Fisher-Yates shuffle, take first N
    for (let i = domains.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [domains[i], domains[j]] = [domains[j], domains[i]];
    }
    domains = domains.slice(0, sampleSize);
    console.log(`  Sampled: ${domains.length} domains`);
  }

  // ── Step 2: Load enrichment cache (resume support) ──────────────────────

  console.log('\n' + '='.repeat(60));
  console.log('  STEP 2: Scrape Websites');
  console.log('='.repeat(60));

  const cache = loadCache(CACHE_FILE);
  const cachedCount = domains.filter((d) => cache[d]).length;
  const toProcess = domains.filter((d) => !cache[d]);

  console.log(`  Already cached: ${cachedCount}`);
  console.log(`  To scrape:      ${toProcess.length}`);

  // ── Step 3: Scrape + extract ────────────────────────────────────────────

  let processed = 0;
  let errors = 0;
  const startTime = Date.now();

  // Process in batches of `concurrency`
  for (let i = 0; i < toProcess.length; i += concurrency) {
    const batch = toProcess.slice(i, i + concurrency);

    const results = await Promise.all(
      batch.map(async (domain) => {
        try {
          // Scrape website
          const scrapeResult = await scrapeDomain(domain);

          // GPT extraction (unless --skip-ai)
          let extraction = {
            staff: [],
            companyDescription: null,
            specialties: [],
            yearFounded: null,
            locationCount: null,
          };

          if (!skipAi && scrapeResult.pageTexts[0]?.length > 200) {
            extraction = await extractFromWebsite(scrapeResult.pageTexts[0], domain);
          }

          // Merge scrape-level emails/phones into staff records
          // (fill in emails for staff that GPT found without one)
          if (extraction.staff.length > 0 && scrapeResult.emails.length > 0) {
            const usedEmails = new Set(extraction.staff.map((s) => s.email).filter(Boolean));
            const availableEmails = scrapeResult.emails.filter((e) => !usedEmails.has(e));

            for (const person of extraction.staff) {
              if (!person.email && availableEmails.length > 0) {
                // Try to match by last name in email
                const { lastName } = splitName(person.name);
                if (lastName) {
                  const matched = availableEmails.find((e) =>
                    e.toLowerCase().includes(lastName.toLowerCase())
                  );
                  if (matched) {
                    person.email = matched;
                    availableEmails.splice(availableEmails.indexOf(matched), 1);
                  }
                }
              }
            }
          }

          return {
            domain,
            emails: scrapeResult.emails,
            phones: scrapeResult.phones,
            pagesScraped: scrapeResult.pagesScraped,
            error: scrapeResult.error,
            ...extraction,
          };
        } catch (err) {
          return {
            domain,
            emails: [],
            phones: [],
            pagesScraped: 0,
            error: err.message,
            staff: [],
            companyDescription: null,
            specialties: [],
            yearFounded: null,
            locationCount: null,
          };
        }
      })
    );

    // Save each result to cache
    for (const result of results) {
      cache[result.domain] = result;
      processed++;
      if (result.error) errors++;
    }

    // Save cache every batch
    saveCache(CACHE_FILE, cache);

    // Progress
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const total = toProcess.length;
    const pct = ((processed / total) * 100).toFixed(1);
    const emailsFound = results.filter((r) => r.emails.length > 0).length;
    const staffFound = results.filter((r) => r.staff.length > 0).length;
    console.log(
      `  [${processed}/${total}] ${pct}% | ${elapsed}s | batch: ${batch.length} scraped, ${emailsFound} w/emails, ${staffFound} w/staff`
    );
  }

  // ── Step 4: Build output rows ───────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log('  STEP 3: Build Output CSV');
  console.log('='.repeat(60));

  const csvRows = [];

  for (const domain of domains) {
    const enrichment = cache[domain];
    const biz = domainBizMap.get(domain) || {};

    if (!enrichment) continue;

    if (enrichment.staff && enrichment.staff.length > 0) {
      // One row per staff member
      for (const person of enrichment.staff) {
        const { firstName, lastName } = splitName(person.name);
        csvRows.push({
          firstName,
          lastName,
          email: person.email || '',
          title: person.title || '',
          phone: person.phone || enrichment.phones?.[0] || biz.phone || '',
          companyName: biz.name || '',
          companyDomain: domain,
          website: biz.website || `https://${domain}`,
          city: biz.city || '',
          state: biz.state || '',
          address: biz.address || '',
          rating: biz.rating || '',
          reviewCount: biz.reviewCount || '',
          companyDescription: enrichment.companyDescription || '',
          specialties: (enrichment.specialties || []).join('; '),
          yearFounded: enrichment.yearFounded || '',
          locationCount: enrichment.locationCount || '',
          source: 'website-scrape',
        });
      }
    } else if (enrichment.emails?.length > 0 || enrichment.phones?.length > 0) {
      // No staff found by GPT, but we have contact info — create one row per email
      const emails = enrichment.emails?.length > 0 ? enrichment.emails : [''];
      for (const email of emails) {
        csvRows.push({
          firstName: '',
          lastName: '',
          email,
          title: '',
          phone: enrichment.phones?.[0] || biz.phone || '',
          companyName: biz.name || '',
          companyDomain: domain,
          website: biz.website || `https://${domain}`,
          city: biz.city || '',
          state: biz.state || '',
          address: biz.address || '',
          rating: biz.rating || '',
          reviewCount: biz.reviewCount || '',
          companyDescription: enrichment.companyDescription || '',
          specialties: (enrichment.specialties || []).join('; '),
          yearFounded: enrichment.yearFounded || '',
          locationCount: enrichment.locationCount || '',
          source: 'website-scrape',
        });
      }
    } else {
      // No contact info at all — still create a business-level row
      csvRows.push({
        firstName: '',
        lastName: '',
        email: '',
        title: '',
        phone: enrichment.phones?.[0] || biz.phone || '',
        companyName: biz.name || '',
        companyDomain: domain,
        website: biz.website || `https://${domain}`,
        city: biz.city || '',
        state: biz.state || '',
        address: biz.address || '',
        rating: biz.rating || '',
        reviewCount: biz.reviewCount || '',
        companyDescription: enrichment.companyDescription || '',
        specialties: (enrichment.specialties || []).join('; '),
        yearFounded: enrichment.yearFounded || '',
        locationCount: enrichment.locationCount || '',
        source: 'website-scrape',
      });
    }
  }

  // ── Step 5: Export CSV ──────────────────────────────────────────────────

  const csv = stringify(csvRows, { header: true });
  writeFileSync(OUTPUT_CSV, csv);

  // ── Stats ───────────────────────────────────────────────────────────────

  const totalDomains = domains.length;
  const withEmails = domains.filter((d) => cache[d]?.emails?.length > 0).length;
  const withStaff = domains.filter((d) => cache[d]?.staff?.length > 0).length;
  const withDescription = domains.filter((d) => cache[d]?.companyDescription).length;
  const failedDomains = domains.filter((d) => cache[d]?.error).length;
  const totalStaff = domains.reduce((sum, d) => sum + (cache[d]?.staff?.length || 0), 0);
  const totalEmails = domains.reduce((sum, d) => sum + (cache[d]?.emails?.length || 0), 0);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(60));
  console.log('  RESULTS');
  console.log('='.repeat(60));
  console.log(`  Domains processed:  ${totalDomains}`);
  console.log(`  Domains w/ emails:  ${withEmails} (${((withEmails / totalDomains) * 100).toFixed(1)}%)`);
  console.log(`  Domains w/ staff:   ${withStaff} (${((withStaff / totalDomains) * 100).toFixed(1)}%)`);
  console.log(`  Domains w/ desc:    ${withDescription} (${((withDescription / totalDomains) * 100).toFixed(1)}%)`);
  console.log(`  Failed domains:     ${failedDomains}`);
  console.log(`  Total staff found:  ${totalStaff}`);
  console.log(`  Total emails found: ${totalEmails}`);
  console.log(`  CSV rows:           ${csvRows.length}`);
  console.log(`  Time elapsed:       ${elapsed}s`);
  console.log(`  Output:             ${OUTPUT_CSV}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  logger.error('Website enrichment failed', { error: err.message, stack: err.stack });
  console.error('Pipeline failed:', err.message);
  process.exit(1);
});
