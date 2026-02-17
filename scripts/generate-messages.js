#!/usr/bin/env node

/**
 * Generate personalized cold email messages for each contact.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/generate-messages.js [input.csv] [--force]
 *
 * Pipeline:
 *   1. Load CSV
 *   2. Pre-validate → skip leads with bad data
 *   3. Reclassify verticals → fix mismatches or skip
 *   4. Enrich hooks → fill empty personalizedHook fields
 *   5. Assign variety → deterministic structure/opener/CTA/brand per lead
 *   6. Generate messages → GPT-4o-mini calls (non-skipped only)
 *   7. Post-validate → quality checks, set needs-review flags
 *   8. Write output CSV (sorted: ready first)
 *   9. Write needs-review CSV
 *  10. Print QA summary
 *
 * --force  Skip the message cache and regenerate all messages.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import {
  generatePersonalizedMessage,
  detectVerticalMismatch,
  generateFallbackHook,
} from '../enrichment/openai-messages.js';
import { reclassifyVertical } from '../config/vertical-kpis.js';
import { assignVariety } from '../config/message-variety.js';
import { logger } from '../services/logger.js';

const args = process.argv.slice(2);
const forceFlag = args.includes('--force');
const inputArg = args.find((a) => !a.startsWith('--'));

const date = new Date().toISOString().slice(0, 10);
const INPUT_FILE = inputArg || `./output/sample-leads-with-signals-${date}.csv`;
const OUTPUT_FILE = `./output/sample-leads-final-${date}.csv`;
const CACHE_FILE = `./output/.message-cache-${date}.json`;
const REVIEW_FILE = `./output/needs-review-${date}.csv`;

// ── Generic / garbage company names to skip ──────────────────────────────────
const BAD_COMPANY_NAMES = new Set([
  '', 'n/a', 'na', 'none', 'unknown', 'company', 'operations', 'test',
  'self-employed', 'self employed', 'freelance', 'freelancer', 'consultant',
]);

// ── Phase 1: Pre-validation ──────────────────────────────────────────────────

function preValidate(leads) {
  let skipNoEmail = 0;
  let skipBadData = 0;

  for (const lead of leads) {
    if (lead._messageFlag) continue;

    if (!lead.email || !lead.email.includes('@')) {
      lead._messageFlag = 'skip-no-email';
      skipNoEmail++;
      continue;
    }

    const companyNorm = (lead.companyName || '').trim().toLowerCase();
    if (BAD_COMPANY_NAMES.has(companyNorm) || companyNorm.length < 2) {
      lead._messageFlag = 'skip-bad-data';
      skipBadData++;
      continue;
    }

    const signals = [lead.recentNews, lead.growthSignal].join(' ').toLowerCase();
    if (/\b(closed|shut down|shuttered|bankrupt|dissolved)\b/.test(signals)) {
      lead._messageFlag = 'skip-bad-data';
      skipBadData++;
      continue;
    }
  }

  logger.info('Pre-validation complete', { skipNoEmail, skipBadData });
  return { skipNoEmail, skipBadData };
}

// ── Phase 2: Vertical reclassification ───────────────────────────────────────

function reclassifyVerticals(leads) {
  let reclassified = 0;
  let skippedNoFit = 0;

  for (const lead of leads) {
    if (lead._messageFlag) continue;

    const isMismatch = detectVerticalMismatch(
      lead.vertical || '',
      lead.companyIndustry || lead.industry || ''
    );

    if (!isMismatch) continue;

    const result = reclassifyVertical(
      lead.companyIndustry || lead.industry || '',
      lead.companySubIndustry || '',
      lead.companyDescription || '',
      lead.title || ''
    );

    if (result.confidence === 'none') {
      lead._messageFlag = 'skip-no-vertical-fit';
      skippedNoFit++;
    } else {
      lead.vertical = result.verticalKey;
      lead.verticalLabel = result.verticalLabel;
      lead._reclassified = true;
      reclassified++;
    }
  }

  logger.info('Vertical reclassification complete', { reclassified, skippedNoFit });
  return { reclassified, skippedNoFit };
}

// ── Phase 3: Hook enrichment ─────────────────────────────────────────────────

function enrichHooks(leads) {
  let enriched = 0;

  for (const lead of leads) {
    if (lead._messageFlag) continue;

    const hook = lead.personalizedHook || '';
    const isBad = !hook || hook === 'None found' || hook.length < 10;

    if (isBad) {
      lead.personalizedHook = generateFallbackHook({
        companyName: lead.companyName,
        companyEmployees: lead.companyEmployees,
        companyRevenue: lead.companyRevenue,
        companyFounded: lead.companyFounded,
        title: lead.title,
        verticalLabel: lead.verticalLabel || '',
      });
      lead._hookEnriched = true;
      enriched++;
    }
  }

  logger.info('Hook enrichment complete', { enriched });
  return { enriched };
}

// ── Phase 7: Post-validation ─────────────────────────────────────────────────

function postValidate(leads) {
  const ctaCounts = {};
  const openerCounts = {};
  const structureCounts = { 1: 0, 2: 0, 3: 0 };

  let totalReady = 0;
  let totalChars = 0;
  let brandMentions = 0;

  const qa = {
    iNoticed: 0,
    bannedPhrases: 0,
    noCompanyName: 0,
    grammarIssue: 0,
    over550: 0,
    under100: 0,
    markdown: 0,
    needsReview: 0,
  };

  for (const lead of leads) {
    if (lead._messageFlag && lead._messageFlag.startsWith('skip-')) continue;

    const msg = lead.personalizedMessage || '';
    if (!msg) continue;

    totalReady++;
    totalChars += msg.length;

    const sid = parseInt(lead.messageStructure, 10) || 0;
    if (structureCounts[sid] !== undefined) structureCounts[sid]++;

    const cta = lead._assignedCta || 'unknown';
    ctaCounts[cta] = (ctaCounts[cta] || 0) + 1;

    const opener = lead._assignedOpener || 'unknown';
    openerCounts[opener] = (openerCounts[opener] || 0) + 1;

    if (/\banyreach\b/i.test(msg)) brandMentions++;

    const flags = lead._postFlags || [];

    if (/\bI noticed\b/i.test(msg)) { qa.iNoticed++; flags.push('i-noticed'); }
    if (/\*\*/.test(msg)) { qa.markdown++; flags.push('markdown'); }
    if (flags.includes('had-banned-phrase')) qa.bannedPhrases++;
    if (flags.includes('no-company-name')) qa.noCompanyName++;
    if (flags.includes('grammar-issue')) qa.grammarIssue++;
    if (flags.includes('over-550-chars')) qa.over550++;
    if (flags.includes('under-100-chars')) qa.under100++;

    if (flags.length > 0) {
      if (!lead._messageFlag) lead._messageFlag = 'needs-review';
      qa.needsReview++;
    }

    if (!lead._messageFlag) lead._messageFlag = 'ready';
  }

  const ctaWarnings = [];
  for (const [cta, count] of Object.entries(ctaCounts)) {
    const pct = totalReady > 0 ? (count / totalReady) * 100 : 0;
    if (pct > 20) ctaWarnings.push(`"${cta.slice(0, 30)}..." at ${pct.toFixed(1)}%`);
  }

  const openerWarnings = [];
  for (const [opener, count] of Object.entries(openerCounts)) {
    const pct = totalReady > 0 ? (count / totalReady) * 100 : 0;
    if (pct > 15) openerWarnings.push(`"${opener}" at ${pct.toFixed(1)}%`);
  }

  return {
    qa,
    totalReady,
    avgChars: totalReady > 0 ? Math.round(totalChars / totalReady) : 0,
    brandMentionPct: totalReady > 0 ? ((brandMentions / totalReady) * 100).toFixed(1) : '0',
    structureCounts,
    ctaWarnings,
    openerWarnings,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(INPUT_FILE)) {
    logger.error('Input file not found', { path: INPUT_FILE });
    process.exit(1);
  }

  const raw = readFileSync(INPUT_FILE, 'utf-8');
  const leads = parse(raw, { columns: true, skip_empty_lines: true });
  logger.info('Loaded leads', { count: leads.length, file: INPUT_FILE });

  // ── Phase 1: Pre-validate ──
  const preStats = preValidate(leads);

  // ── Phase 2: Reclassify verticals ──
  const reStats = reclassifyVerticals(leads);

  // ── Phase 3: Enrich hooks ──
  const hookStats = enrichHooks(leads);

  // ── Phase 4: Assign variety (only non-skipped) ──
  const validLeads = leads.filter((l) => !l._messageFlag);
  validLeads.forEach((lead, i) => {
    const variety = assignVariety(lead, i, validLeads.length);
    lead._variety = variety;
    lead._assignedCta = variety.cta;
    lead._assignedOpener = variety.openerType;
    lead.messageStructure = String(variety.structure.id);
  });

  logger.info('Variety assigned', { validLeads: validLeads.length });

  // ── Load cache ──
  let messageCache = {};
  if (!forceFlag && existsSync(CACHE_FILE)) {
    try {
      messageCache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      logger.info('Loaded message cache', { cached: Object.keys(messageCache).length });
    } catch {
      messageCache = {};
    }
  } else if (forceFlag) {
    logger.info('--force flag set, skipping cache');
  }

  // ── Phase 5: Generate messages ──
  let generated = 0;
  let cached = 0;
  let apiErrors = 0;

  for (const lead of validLeads) {
    const cacheKey = lead.email;
    if (!cacheKey) continue;

    const cachedEntry = messageCache[cacheKey];
    if (!forceFlag && cachedEntry && typeof cachedEntry === 'object' && cachedEntry.message) {
      lead.personalizedMessage = cachedEntry.message;
      lead._postFlags = cachedEntry.flags || [];
      lead.messageStructure = String(cachedEntry.messageStructure || lead.messageStructure || '');
      cached++;
      continue;
    }

    generated++;
    logger.info('Generating message', {
      contact: `${lead.firstName} ${lead.lastName}`,
      company: lead.companyName,
      progress: `${cached + generated}/${validLeads.length}`,
      structure: lead._variety.structure.name,
      opener: lead._variety.openerType,
    });

    const signals = {
      recentFunding: lead.recentFunding,
      hiringSignal: lead.hiringSignal,
      recentNews: lead.recentNews,
      growthSignal: lead.growthSignal,
      personalizedHook: lead.personalizedHook,
    };

    const contact = {
      firstName: lead.firstName,
      lastName: lead.lastName,
      title: lead.title,
      companyName: lead.companyName,
      companyDomain: lead.companyDomain,
      verticalLabel: lead.verticalLabel || '',
      verticalKey: lead.vertical || '',
      companyEmployees: lead.companyEmployees || '',
      companyIndustry: lead.companyIndustry || lead.industry || '',
      companyFounded: lead.companyFounded || '',
    };

    const result = await generatePersonalizedMessage(contact, signals, lead._variety);

    lead.personalizedMessage = result.message;
    lead._postFlags = result.flags;
    lead.messageStructure = String(result.messageStructure);

    if (result.flags.includes('api-error')) apiErrors++;

    messageCache[cacheKey] = {
      message: result.message,
      flags: result.flags,
      messageStructure: result.messageStructure,
    };

    if (generated % 10 === 0) {
      writeFileSync(CACHE_FILE, JSON.stringify(messageCache, null, 2));
      logger.info('Cache saved', { total: Object.keys(messageCache).length });
    }
  }

  writeFileSync(CACHE_FILE, JSON.stringify(messageCache, null, 2));

  // ── Phase 6: Post-validate ──
  const postStats = postValidate(leads);

  // ── Build output ──
  const finalLeads = leads.map((lead) => {
    const messageFlag = lead._messageFlag || (lead.personalizedMessage ? 'ready' : 'skip-bad-data');

    const row = {};
    for (const [k, v] of Object.entries(lead)) {
      if (!k.startsWith('_')) row[k] = v;
    }
    row.personalizedMessage = lead.personalizedMessage || '';
    row.messageFlag = messageFlag;
    row.messageStructure = lead.messageStructure || '';
    row.verticalMismatch = lead._reclassified ? 'RECLASSIFIED' : '';

    return row;
  });

  // Sort: ready first, then needs-review, then skips
  const flagOrder = { ready: 0, 'needs-review': 1 };
  finalLeads.sort((a, b) => {
    const aOrder = flagOrder[a.messageFlag] ?? 2;
    const bOrder = flagOrder[b.messageFlag] ?? 2;
    return aOrder - bOrder;
  });

  const csv = stringify(finalLeads, { header: true });
  writeFileSync(OUTPUT_FILE, csv);

  // Write needs-review CSV
  const reviewLeads = finalLeads.filter(
    (l) => l.messageFlag === 'needs-review' || l.messageFlag === 'skip-no-vertical-fit'
  );
  if (reviewLeads.length > 0) {
    const reviewCsv = stringify(reviewLeads, { header: true });
    writeFileSync(REVIEW_FILE, reviewCsv);
    logger.info('Flagged leads written', { count: reviewLeads.length, file: REVIEW_FILE });
  }

  // ── QA Summary ──
  const totalLeads = leads.length;
  const withMessages = finalLeads.filter((l) => l.personalizedMessage && l.personalizedMessage.length > 0).length;

  console.log('\n' + '='.repeat(60));
  console.log('  QA SUMMARY — Message Quality Overhaul (Round 2)');
  console.log('='.repeat(60));

  console.log(`\n  BATCH STATS`);
  console.log(`  Total leads:         ${totalLeads}`);
  console.log(`  With messages:       ${withMessages}`);
  console.log(`  Generated (new):     ${generated}`);
  console.log(`  From cache:          ${cached}`);
  console.log(`  API errors:          ${apiErrors}`);

  console.log(`\n  SKIP BREAKDOWN`);
  console.log(`  skip-no-email:       ${preStats.skipNoEmail}`);
  console.log(`  skip-bad-data:       ${preStats.skipBadData}`);
  console.log(`  skip-no-vertical-fit:${reStats.skippedNoFit}`);

  console.log(`\n  RECLASSIFICATION`);
  console.log(`  Verticals reclassified: ${reStats.reclassified}`);
  console.log(`  Hooks enriched:         ${hookStats.enriched}`);

  console.log(`\n  QUALITY CHECKS`);
  console.log(`  "I noticed" openers: ${postStats.qa.iNoticed}`);
  console.log(`  Banned phrases:      ${postStats.qa.bannedPhrases}`);
  console.log(`  Markdown found:      ${postStats.qa.markdown}`);
  console.log(`  No company name:     ${postStats.qa.noCompanyName}`);
  console.log(`  Grammar issues:      ${postStats.qa.grammarIssue}`);
  console.log(`  Over 550 chars:      ${postStats.qa.over550}`);
  console.log(`  Under 100 chars:     ${postStats.qa.under100}`);
  console.log(`  Needs review:        ${postStats.qa.needsReview}`);

  console.log(`\n  VARIETY DISTRIBUTION`);
  console.log(`  Structure 1 (hook-pain-solution):   ${postStats.structureCounts[1]}`);
  console.log(`  Structure 2 (pain-proof-offer):     ${postStats.structureCounts[2]}`);
  console.log(`  Structure 3 (observation-question):  ${postStats.structureCounts[3]}`);
  console.log(`  Avg chars:           ${postStats.avgChars}`);
  console.log(`  Brand mention %:     ${postStats.brandMentionPct}%`);

  if (postStats.ctaWarnings.length > 0) {
    console.log(`\n  CTA CONCENTRATION (>20%):`);
    postStats.ctaWarnings.forEach((w) => console.log(`    ${w}`));
  } else {
    console.log(`\n  CTA distribution OK (all <=20%)`);
  }

  if (postStats.openerWarnings.length > 0) {
    console.log(`  OPENER CONCENTRATION (>15%):`);
    postStats.openerWarnings.forEach((w) => console.log(`    ${w}`));
  } else {
    console.log(`  Opener distribution OK (all <=15%)`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`  Output: ${OUTPUT_FILE}`);
  if (reviewLeads.length > 0) {
    console.log(`  Needs review (${reviewLeads.length} leads): ${REVIEW_FILE}`);
  }
  console.log('='.repeat(60) + '\n');
}

main().catch((err) => {
  logger.error('Message generation failed', { error: err.message });
  process.exit(1);
});
