#!/usr/bin/env node

/**
 * Enrich existing leads CSV with Perplexity-sourced company signals.
 *
 * Usage:
 *   PERPLEXITY_API_KEY=pplx-... node scripts/enrich-signals.js [input.csv]
 *
 * Defaults to output/sample-leads-2026-02-17.csv if no input file specified.
 * Outputs: output/sample-leads-with-signals-{date}.csv
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { searchCompanySignals } from '../enrichment/perplexity-signals.js';
import { logger } from '../services/logger.js';

const INPUT_FILE = process.argv[2] || './output/sample-leads-2026-02-17.csv';
const date = new Date().toISOString().slice(0, 10);
const OUTPUT_FILE = `./output/sample-leads-with-signals-${date}.csv`;

// Optional: resume from a partial run by caching results
const CACHE_FILE = `./output/.signal-cache-${date}.json`;

async function main() {
  if (!existsSync(INPUT_FILE)) {
    logger.error('Input file not found', { path: INPUT_FILE });
    process.exit(1);
  }

  // Read and parse input CSV
  const raw = readFileSync(INPUT_FILE, 'utf-8');
  const leads = parse(raw, { columns: true, skip_empty_lines: true });
  logger.info('Loaded leads', { count: leads.length, file: INPUT_FILE });

  // Deduplicate by companyDomain
  const domainMap = new Map();
  for (const lead of leads) {
    const domain = (lead.companyDomain || '').trim().toLowerCase();
    if (domain && !domainMap.has(domain)) {
      domainMap.set(domain, lead.companyName || domain);
    }
  }

  const uniqueDomains = [...domainMap.entries()];
  logger.info('Unique domains to research', { count: uniqueDomains.length });

  // Load cache if exists (for resuming partial runs)
  let signalCache = {};
  if (existsSync(CACHE_FILE)) {
    try {
      signalCache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      logger.info('Loaded signal cache', { cached: Object.keys(signalCache).length });
    } catch {
      signalCache = {};
    }
  }

  // Fetch signals for each unique domain
  let processed = 0;
  const skipped = Object.keys(signalCache).length;

  for (const [domain, companyName] of uniqueDomains) {
    if (signalCache[domain]) {
      continue; // Already cached from a previous run
    }

    processed++;
    logger.info('Researching company', {
      domain,
      companyName,
      progress: `${skipped + processed}/${uniqueDomains.length}`,
    });

    const signals = await searchCompanySignals(domain, companyName);
    signalCache[domain] = signals;

    // Save cache periodically (every 10 companies)
    if (processed % 10 === 0) {
      writeFileSync(CACHE_FILE, JSON.stringify(signalCache, null, 2));
      logger.info('Cache saved', { total: Object.keys(signalCache).length });
    }
  }

  // Final cache save
  writeFileSync(CACHE_FILE, JSON.stringify(signalCache, null, 2));

  // Merge signals back into leads
  const enrichedLeads = leads.map((lead) => {
    const domain = (lead.companyDomain || '').trim().toLowerCase();
    const signals = signalCache[domain] || {};
    return {
      ...lead,
      recentFunding: signals.recentFunding || 'None found',
      hiringSignal: signals.hiringSignal || 'None found',
      recentNews: signals.recentNews || 'None found',
      growthSignal: signals.growthSignal || 'None found',
      personalizedHook: signals.personalizedHook || '',
    };
  });

  // Write output CSV
  const csv = stringify(enrichedLeads, { header: true });
  writeFileSync(OUTPUT_FILE, csv);

  // Summary stats
  const withSignals = Object.values(signalCache).filter(
    (s) => s.personalizedHook && s.personalizedHook !== ''
  ).length;

  logger.info('Signal enrichment complete', {
    totalLeads: enrichedLeads.length,
    uniqueDomains: uniqueDomains.length,
    domainsWithSignals: withSignals,
    outputFile: OUTPUT_FILE,
  });

  console.log(`\nDone! Output: ${OUTPUT_FILE}`);
  console.log(`  ${enrichedLeads.length} leads enriched`);
  console.log(`  ${uniqueDomains.length} unique companies researched`);
  console.log(`  ${withSignals} companies had actionable signals`);
}

main().catch((err) => {
  logger.error('Enrichment script failed', { error: err.message });
  process.exit(1);
});
