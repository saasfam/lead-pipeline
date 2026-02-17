#!/usr/bin/env node

/**
 * Generate personalized ~100-word cold email messages for each contact.
 *
 * Usage:
 *   PERPLEXITY_API_KEY=pplx-... node scripts/generate-messages.js [input.csv]
 *
 * Reads the signal-enriched CSV and generates a per-contact message using
 * the contact's name/title + company signals. Outputs a new CSV with the
 * `personalizedMessage` column added.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { generatePersonalizedMessage } from '../enrichment/perplexity-signals.js';
import { logger } from '../services/logger.js';

const date = new Date().toISOString().slice(0, 10);
const INPUT_FILE = process.argv[2] || `./output/sample-leads-with-signals-${date}.csv`;
const OUTPUT_FILE = `./output/sample-leads-final-${date}.csv`;
const CACHE_FILE = `./output/.message-cache-${date}.json`;

async function main() {
  if (!existsSync(INPUT_FILE)) {
    logger.error('Input file not found', { path: INPUT_FILE });
    process.exit(1);
  }

  const raw = readFileSync(INPUT_FILE, 'utf-8');
  const leads = parse(raw, { columns: true, skip_empty_lines: true });
  logger.info('Loaded leads', { count: leads.length, file: INPUT_FILE });

  // Load cache (keyed by email since messages are per-contact)
  let messageCache = {};
  if (existsSync(CACHE_FILE)) {
    try {
      messageCache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      logger.info('Loaded message cache', { cached: Object.keys(messageCache).length });
    } catch {
      messageCache = {};
    }
  }

  let processed = 0;
  const skipped = Object.keys(messageCache).length;

  for (const lead of leads) {
    const cacheKey = lead.email;
    if (!cacheKey || messageCache[cacheKey]) continue;

    processed++;
    logger.info('Generating message', {
      contact: `${lead.firstName} ${lead.lastName}`,
      company: lead.companyName,
      progress: `${skipped + processed}/${leads.length}`,
    });

    const signals = {
      recentFunding: lead.recentFunding,
      hiringSignal: lead.hiringSignal,
      recentNews: lead.recentNews,
      growthSignal: lead.growthSignal,
    };

    const message = await generatePersonalizedMessage(
      {
        firstName: lead.firstName,
        lastName: lead.lastName,
        title: lead.title,
        companyName: lead.companyName,
        companyDomain: lead.companyDomain,
        verticalLabel: lead.verticalLabel || '',
        verticalKey: lead.vertical || '',
        companyEmployees: lead.companyEmployees || '',
      },
      signals
    );

    messageCache[cacheKey] = message;

    // Save cache every 10 contacts
    if (processed % 10 === 0) {
      writeFileSync(CACHE_FILE, JSON.stringify(messageCache, null, 2));
      logger.info('Cache saved', { total: Object.keys(messageCache).length });
    }
  }

  // Final cache save
  writeFileSync(CACHE_FILE, JSON.stringify(messageCache, null, 2));

  // Merge messages into leads
  const finalLeads = leads.map((lead) => ({
    ...lead,
    personalizedMessage: messageCache[lead.email] || '',
  }));

  const csv = stringify(finalLeads, { header: true });
  writeFileSync(OUTPUT_FILE, csv);

  const withMessages = Object.values(messageCache).filter((m) => m && m.length > 0).length;

  logger.info('Message generation complete', {
    totalLeads: finalLeads.length,
    messagesGenerated: withMessages,
    outputFile: OUTPUT_FILE,
  });

  console.log(`\nDone! Output: ${OUTPUT_FILE}`);
  console.log(`  ${finalLeads.length} leads`);
  console.log(`  ${withMessages} personalized messages generated`);
}

main().catch((err) => {
  logger.error('Message generation failed', { error: err.message });
  process.exit(1);
});
