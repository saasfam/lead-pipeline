#!/usr/bin/env node

/**
 * Process Phase 1 CSV — Clean, Verify, Enrich, Classify, Generate Messages
 *
 * Usage:
 *   APOLLO_API_KEY=xxx PERPLEXITY_API_KEY=pplx-... OPENAI_API_KEY=sk-... \
 *     node scripts/process-phase1.js Phase1_All_Enriched_Emails_List.csv [options]
 *
 * Options:
 *   --sample N       Run a sample of N random business contacts through all phases
 *   --start-phase N  Restart from phase N (skips earlier phases if output exists)
 *   --force          Re-run phases even if output CSV already exists
 *
 * Phases:
 *   0: Clean & filter (remove personal emails, dedup)
 *   1: Email verification (Apollo API)
 *   2: Perplexity signal enrichment + company name cleanup
 *   3: Vertical classification (local)
 *   4: Message generation (OpenAI GPT-4o-mini)
 *   5: Export & QA summary (local)
 *   6: Instantly upload (optional, requires INSTANTLY_API_KEY)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { isPersonalDomain } from '../enrichment/domain-resolver.js';
import { enrichViaBulkMatch } from '../enrichment/apollo-verify.js';
import { searchCompanySignals } from '../enrichment/perplexity-signals.js';
import { reclassifyVertical } from '../config/vertical-kpis.js';
import { assignVariety } from '../config/message-variety.js';
import {
  generateSequence,
  generateFallbackHook,
} from '../enrichment/openai-messages.js';
import { logger } from '../services/logger.js';

// ── CLI parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const inputFile = args.find((a) => !a.startsWith('--'));

if (!inputFile) {
  console.error('Usage: node scripts/process-phase1.js <input.csv> [--sample N] [--start-phase N] [--force]');
  process.exit(1);
}

const sampleArg = args.indexOf('--sample');
const sampleSize = sampleArg >= 0 ? parseInt(args[sampleArg + 1], 10) : 0;

const startPhaseArg = args.indexOf('--start-phase');
const startPhase = startPhaseArg >= 0 ? parseInt(args[startPhaseArg + 1], 10) : 0;

const forceFlag = args.includes('--force');

const campaignIdArg = args.indexOf('--campaign-id');
const campaignIdFlag = campaignIdArg >= 0 ? args[campaignIdArg + 1] : null;

const date = new Date().toISOString().slice(0, 10);
const prefix = sampleSize > 0 ? `sample-${sampleSize}` : 'phase';

// Output files
const OUTPUT_DIR = './output';
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const PHASE0_FILE = `${OUTPUT_DIR}/${prefix}0-cleaned-${date}.csv`;
const PHASE1_FILE = `${OUTPUT_DIR}/${prefix}1-verified-${date}.csv`;
const PHASE2_FILE = `${OUTPUT_DIR}/${prefix}2-signals-${date}.csv`;
const PHASE3_FILE = `${OUTPUT_DIR}/${prefix}3-classified-${date}.csv`;
const PHASE4_FINAL = `${OUTPUT_DIR}/${prefix}4-final-${date}.csv`;
const PHASE4_REVIEW = `${OUTPUT_DIR}/${prefix}4-needs-review-${date}.csv`;

// Cache files
const VERIFY_CACHE = `${OUTPUT_DIR}/.verify-cache-${date}.json`;
const SIGNAL_CACHE = `${OUTPUT_DIR}/.signal-cache-p1-${date}.json`;
const MESSAGE_CACHE = `${OUTPUT_DIR}/.message-cache-p1-${date}.json`;

// ── Generic / garbage company names to skip ─────────────────────────────────
const BAD_COMPANY_NAMES = new Set([
  '', 'n/a', 'na', 'none', 'unknown', 'company', 'operations', 'test',
  'self-employed', 'self employed', 'freelance', 'freelancer', 'consultant',
]);

function shouldRunPhase(phase, outputFile) {
  if (phase < startPhase) return false;
  if (forceFlag) return true;
  if (existsSync(outputFile)) {
    console.log(`  Phase ${phase}: Output exists (${outputFile}), skipping. Use --force to re-run.`);
    return false;
  }
  return true;
}

function loadCsv(file) {
  const raw = readFileSync(file, 'utf-8');
  return parse(raw, { columns: true, skip_empty_lines: true, bom: true });
}

function writeCsv(file, data) {
  const csv = stringify(data, { header: true });
  writeFileSync(file, csv);
}

function pickRandomSample(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 0: Clean & Filter
// ═══════════════════════════════════════════════════════════════════════════════

function phase0(leads) {
  console.log('\n' + '='.repeat(60));
  console.log('  PHASE 0: Clean & Filter');
  console.log('='.repeat(60));

  const before = leads.length;

  // Normalize emails and extract domains
  for (const lead of leads) {
    lead._email = (lead.Email || lead.email || '').trim().toLowerCase();
    const parts = lead._email.split('@');
    lead._domain = parts.length === 2 ? parts[1] : '';
  }

  // Remove personal email contacts
  let personalRemoved = 0;
  const domainCounts = {};
  const filtered = leads.filter((lead) => {
    if (!lead._email || !lead._domain) return false;
    if (isPersonalDomain(lead._domain)) {
      const root = lead._domain.split('.')[0];
      domainCounts[root] = (domainCounts[root] || 0) + 1;
      personalRemoved++;
      return false;
    }
    return true;
  });

  // Dedup by lowercase email
  const seen = new Set();
  let dupsRemoved = 0;
  const deduped = filtered.filter((lead) => {
    if (seen.has(lead._email)) {
      dupsRemoved++;
      return false;
    }
    seen.add(lead._email);
    return true;
  });

  // Map to standardized column names for downstream pipeline
  const cleaned = deduped.map((lead) => ({
    email: lead._email,
    firstName: lead['First Name'] || lead.firstName || '',
    lastName: lead['Last Name'] || lead.lastName || '',
    title: lead['Job Title'] || lead.title || '',
    companyName: lead.Company || lead.companyName || '',
    companyDomain: lead.Domain || lead.companyDomain || lead._domain,
    industry: lead.Industry || lead.industry || '',
    companyARR: lead['Company ARR'] || lead.companyARR || '',
    employeeRange: lead['Employee Range'] || lead.employeeRange || '',
    linkedinUrl: lead.LinkedIn || lead.linkedinUrl || '',
    contactConfidence: lead['Contact Confidence Rate'] || lead.contactConfidence || '',
    emailValid: lead['Valid (Y/N)'] || '',
    actualPerson: lead['Actual Person (Y/N)'] || '',
    roleEmail: lead['Role Email (Y/N)'] || '',
  }));

  // Summary
  console.log(`  Input rows:        ${before}`);
  console.log(`  Personal removed:  ${personalRemoved}`);
  if (Object.keys(domainCounts).length > 0) {
    const top = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  Top personal:      ${top.map(([d, c]) => `${d} (${c})`).join(', ')}`);
  }
  console.log(`  Duplicates:        ${dupsRemoved}`);
  console.log(`  Output rows:       ${cleaned.length}`);

  return cleaned;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: Apollo Enrichment (bulk_match — title, industry, linkedin, org)
// ═══════════════════════════════════════════════════════════════════════════════

async function phase1(leads) {
  console.log('\n' + '='.repeat(60));
  console.log('  PHASE 1: Apollo Enrichment (people/bulk_match)');
  console.log('='.repeat(60));

  if (!process.env.APOLLO_API_KEY) {
    console.log('  WARNING: APOLLO_API_KEY not set — skipping Apollo enrichment');
    return leads.map((l) => ({ ...l, emailStatus: 'unknown' }));
  }

  const batches = Math.ceil(leads.length / 10);
  console.log(`  Contacts to enrich: ${leads.length}`);
  console.log(`  Estimated batches:  ${batches} (~${Math.ceil(batches / 40)} min at 40/min)`);

  let lastLogTime = Date.now();
  const enriched = await enrichViaBulkMatch(leads, {
    cacheFile: VERIFY_CACHE,
    cacheBatchSize: 100,
    onProgress({ processed, total }) {
      const now = Date.now();
      if (now - lastLogTime > 30_000) {
        const pct = ((processed / total) * 100).toFixed(1);
        console.log(`  Progress: ${processed}/${total} (${pct}%)`);
        lastLogTime = now;
      }
    },
  });

  // Merge Apollo fields into lead columns (prefer Apollo data over empty CSV fields)
  for (const lead of enriched) {
    if (lead.apolloTitle && !lead.title) lead.title = lead.apolloTitle;
    if (lead.apolloLinkedin && !lead.linkedinUrl) lead.linkedinUrl = lead.apolloLinkedin;
    if (lead.apolloOrgName && (!lead.companyName || lead.companyName === lead.companyDomain?.split('.')[0])) {
      lead.companyName = lead.apolloOrgName;
    }
    if (lead.apolloOrgIndustry && !lead.industry) lead.industry = lead.apolloOrgIndustry;
    if (lead.apolloOrgEmployees && !lead.employeeRange) lead.employeeRange = String(lead.apolloOrgEmployees);
  }

  const matched = enriched.filter((c) => c.emailStatus === 'matched').length;
  const notFound = enriched.filter((c) => c.emailStatus === 'not-found').length;
  const withTitle = enriched.filter((c) => c.title).length;

  console.log(`  Matched:    ${matched}`);
  console.log(`  Not found:  ${notFound}`);
  console.log(`  Unknown:    ${enriched.length - matched - notFound}`);
  console.log(`  With title: ${withTitle}`);

  return enriched;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: Perplexity Signal Enrichment + Company Name Cleanup
// ═══════════════════════════════════════════════════════════════════════════════

async function phase2(leads) {
  console.log('\n' + '='.repeat(60));
  console.log('  PHASE 2: Perplexity Signal Enrichment');
  console.log('='.repeat(60));

  if (!process.env.PERPLEXITY_API_KEY) {
    console.log('  WARNING: PERPLEXITY_API_KEY not set — skipping signals');
    return leads;
  }

  // Deduplicate by companyDomain
  const domainMap = new Map();
  for (const lead of leads) {
    const domain = (lead.companyDomain || '').trim().toLowerCase();
    if (domain && !domainMap.has(domain)) {
      domainMap.set(domain, lead.companyName || domain);
    }
  }

  const uniqueDomains = [...domainMap.entries()];
  console.log(`  Unique domains: ${uniqueDomains.length}`);
  console.log(`  Estimated time: ~${Math.ceil(uniqueDomains.length / 3600)} hours at 1/sec`);

  // Load signal cache
  let signalCache = {};
  if (existsSync(SIGNAL_CACHE)) {
    try {
      signalCache = JSON.parse(readFileSync(SIGNAL_CACHE, 'utf-8'));
      console.log(`  Cache loaded: ${Object.keys(signalCache).length} domains cached`);
    } catch { signalCache = {}; }
  }

  let processed = 0;
  const cachedCount = Object.keys(signalCache).length;

  for (const [domain, companyName] of uniqueDomains) {
    if (signalCache[domain]) continue;

    processed++;
    if (processed % 50 === 0 || processed === 1) {
      console.log(`  Researching: ${processed + cachedCount}/${uniqueDomains.length} — ${domain}`);
    }

    const signals = await searchCompanySignals(domain, companyName);
    signalCache[domain] = signals;

    // Save cache every 10 companies
    if (processed % 10 === 0) {
      writeFileSync(SIGNAL_CACHE, JSON.stringify(signalCache, null, 2));
    }
  }

  // Final cache save
  writeFileSync(SIGNAL_CACHE, JSON.stringify(signalCache, null, 2));

  // Merge signals back into leads
  const enriched = leads.map((lead) => {
    const domain = (lead.companyDomain || '').trim().toLowerCase();
    const signals = signalCache[domain] || {};
    return {
      ...lead,
      properCompanyName: signals.properCompanyName || lead.companyName || '',
      industry: signals.industry || lead.industry || '',
      recentFunding: signals.recentFunding || 'None found',
      hiringSignal: signals.hiringSignal || 'None found',
      recentNews: signals.recentNews || 'None found',
      growthSignal: signals.growthSignal || 'None found',
      personalizedHook: signals.personalizedHook || '',
    };
  });

  // Use properCompanyName as primary company name for downstream
  for (const lead of enriched) {
    if (lead.properCompanyName && lead.properCompanyName !== lead.companyName) {
      lead.companyName = lead.properCompanyName;
    }
  }

  const withSignals = Object.values(signalCache).filter(
    (s) => s.personalizedHook && s.personalizedHook !== ''
  ).length;

  console.log(`  New domains researched: ${processed}`);
  console.log(`  Domains with signals:   ${withSignals}/${uniqueDomains.length}`);

  return enriched;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: Vertical Classification (local, no API)
// ═══════════════════════════════════════════════════════════════════════════════

function phase3(leads) {
  console.log('\n' + '='.repeat(60));
  console.log('  PHASE 3: Vertical Classification');
  console.log('='.repeat(60));

  const verticalCounts = {};
  let classified = 0;
  let noFit = 0;

  for (const lead of leads) {
    // Use Perplexity-returned industry as primary signal
    const result = reclassifyVertical(
      lead.industry || '',           // companyIndustry
      '',                            // companySubIndustry (empty for this dataset)
      '',                            // companyDescription (empty for this dataset)
      lead.title || ''               // title
    );

    lead.vertical = result.verticalKey;
    lead.verticalLabel = result.verticalLabel;
    lead.verticalConfidence = result.confidence;

    if (result.confidence === 'none') {
      noFit++;
    } else {
      classified++;
      verticalCounts[result.verticalKey] = (verticalCounts[result.verticalKey] || 0) + 1;
    }
  }

  // Print distribution
  const sorted = Object.entries(verticalCounts).sort((a, b) => b[1] - a[1]);
  console.log(`  Classified:     ${classified}`);
  console.log(`  No vertical fit: ${noFit}`);
  console.log(`  Distribution:`);
  for (const [v, count] of sorted.slice(0, 10)) {
    const pct = ((count / leads.length) * 100).toFixed(1);
    console.log(`    ${v.padEnd(25)} ${String(count).padStart(6)}  (${pct}%)`);
  }
  if (sorted.length > 10) {
    console.log(`    ... and ${sorted.length - 10} more verticals`);
  }

  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4: Message Generation (OpenAI GPT-4o-mini)
// ═══════════════════════════════════════════════════════════════════════════════

async function phase4(leads) {
  console.log('\n' + '='.repeat(60));
  console.log('  PHASE 4: Message Generation');
  console.log('='.repeat(60));

  if (!process.env.OPENAI_API_KEY) {
    console.log('  WARNING: OPENAI_API_KEY not set — skipping message generation');
    return leads;
  }

  // Pre-validate
  let skipNoEmail = 0;
  let skipBadData = 0;
  let skipNoVertical = 0;

  for (const lead of leads) {
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

    // Check for bankruptcy/closure signals (avoid false positives like "closed a deal")
    const signals = [lead.recentNews, lead.growthSignal].join(' ').toLowerCase();
    if (/\b(closed down|shut down|shuttered|bankrupt|dissolved|went under|ceased operations)\b/.test(signals)) {
      lead._messageFlag = 'skip-bad-data';
      skipBadData++;
      continue;
    }

    if (lead.verticalConfidence === 'none' || !lead.vertical) {
      lead._messageFlag = 'skip-no-vertical-fit';
      skipNoVertical++;
      continue;
    }
  }

  console.log(`  Pre-validation:`);
  console.log(`    skip-no-email:       ${skipNoEmail}`);
  console.log(`    skip-bad-data:       ${skipBadData}`);
  console.log(`    skip-no-vertical-fit:${skipNoVertical}`);

  // Valid leads for message generation
  const validLeads = leads.filter((l) => !l._messageFlag);
  console.log(`  Leads for messages:    ${validLeads.length}`);

  // Enrich hooks
  let hooksEnriched = 0;
  for (const lead of validLeads) {
    const hook = lead.personalizedHook || '';
    if (!hook || hook === 'None found' || hook.length < 10) {
      lead.personalizedHook = generateFallbackHook({
        companyName: lead.companyName,
        companyEmployees: lead.employeeRange || '',
        companyRevenue: lead.companyARR || '',
        companyFounded: '',
        title: lead.title || '',
        verticalLabel: lead.verticalLabel || '',
      });
      hooksEnriched++;
    }
  }
  console.log(`  Hooks enriched:        ${hooksEnriched}`);

  // Assign variety
  validLeads.forEach((lead, i) => {
    const variety = assignVariety(lead, i, validLeads.length);
    lead._variety = variety;
    lead._assignedCta = variety.cta;
    lead._assignedOpener = variety.openerType;
    lead.messageStructure = String(variety.structure.id);
  });

  // Load message cache
  let messageCache = {};
  if (!forceFlag && existsSync(MESSAGE_CACHE)) {
    try {
      messageCache = JSON.parse(readFileSync(MESSAGE_CACHE, 'utf-8'));
      console.log(`  Message cache loaded: ${Object.keys(messageCache).length}`);
    } catch { messageCache = {}; }
  }

  // Generate messages
  let generated = 0;
  let cached = 0;
  let apiErrors = 0;
  const totalValid = validLeads.length;

  for (const lead of validLeads) {
    const cacheKey = lead.email;
    if (!cacheKey) continue;

    const cachedEntry = messageCache[cacheKey];
    if (!forceFlag && cachedEntry && typeof cachedEntry === 'object' && cachedEntry.message && cachedEntry.sequenceStep2) {
      lead.personalizedMessage = cachedEntry.message;
      lead.sequenceStep2 = cachedEntry.sequenceStep2 || '';
      lead.sequenceStep3 = cachedEntry.sequenceStep3 || '';
      lead.sequenceStep4 = cachedEntry.sequenceStep4 || '';
      lead._postFlags = cachedEntry.flags || [];
      lead.messageStructure = String(cachedEntry.messageStructure || lead.messageStructure || '');
      cached++;
      continue;
    }

    generated++;
    if (generated % 50 === 0 || generated === 1) {
      console.log(`  Generating: ${cached + generated}/${totalValid} — ${lead.companyName}`);
    }

    const signalData = {
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
      companyEmployees: lead.employeeRange || '',
      companyIndustry: lead.industry || '',
      companyFounded: '',
    };

    const result = await generateSequence(contact, signalData, lead._variety);

    lead.personalizedMessage = result.message;
    lead.sequenceStep2 = result.sequenceStep2;
    lead.sequenceStep3 = result.sequenceStep3;
    lead.sequenceStep4 = result.sequenceStep4;
    lead._postFlags = result.flags;
    lead.messageStructure = String(result.messageStructure);

    if (result.flags.includes('api-error')) apiErrors++;

    messageCache[cacheKey] = {
      message: result.message,
      sequenceStep2: result.sequenceStep2,
      sequenceStep3: result.sequenceStep3,
      sequenceStep4: result.sequenceStep4,
      flags: result.flags,
      messageStructure: result.messageStructure,
    };

    // Save cache every 10 leads
    if (generated % 10 === 0) {
      writeFileSync(MESSAGE_CACHE, JSON.stringify(messageCache, null, 2));
    }
  }

  // Final cache save
  writeFileSync(MESSAGE_CACHE, JSON.stringify(messageCache, null, 2));

  console.log(`  Generated (new): ${generated}`);
  console.log(`  From cache:      ${cached}`);
  console.log(`  API errors:      ${apiErrors}`);

  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5: Export & QA Summary
// ═══════════════════════════════════════════════════════════════════════════════

function phase5(leads, outputFile, reviewFile) {
  console.log('\n' + '='.repeat(60));
  console.log('  PHASE 5: Export & QA Summary');
  console.log('='.repeat(60));

  // Post-validate: set message flags
  const qa = {
    iNoticed: 0, bannedPhrases: 0, noCompanyName: 0,
    grammarIssue: 0, over550: 0, under100: 0, markdown: 0, needsReview: 0,
  };
  const structureCounts = { 1: 0, 2: 0, 3: 0 };
  let totalReady = 0;
  let totalChars = 0;
  let brandMentions = 0;
  let withStep2 = 0, withStep3 = 0, withStep4 = 0;
  let sequenceStepIssues = 0;

  for (const lead of leads) {
    if (lead._messageFlag && lead._messageFlag.startsWith('skip-')) continue;

    const msg = lead.personalizedMessage || '';
    if (!msg) {
      if (!lead._messageFlag) lead._messageFlag = 'skip-bad-data';
      continue;
    }

    totalReady++;
    totalChars += msg.length;

    const sid = parseInt(lead.messageStructure, 10) || 0;
    if (structureCounts[sid] !== undefined) structureCounts[sid]++;
    if (/\banyreach\b/i.test(msg)) brandMentions++;

    // Track sequence step fill rates
    if (lead.sequenceStep2) withStep2++;
    if (lead.sequenceStep3) withStep3++;
    if (lead.sequenceStep4) withStep4++;

    const flags = lead._postFlags || [];

    // Only step 1 flags (unprefixed) determine messageFlag
    const step1Flags = flags.filter((f) => !f.includes(':'));
    const stepNFlags = flags.filter((f) => f.includes(':'));
    if (stepNFlags.length > 0) sequenceStepIssues++;

    if (/\bI noticed\b/i.test(msg)) qa.iNoticed++;
    if (/\*\*/.test(msg)) qa.markdown++;
    if (step1Flags.includes('had-banned-phrase')) qa.bannedPhrases++;
    if (step1Flags.includes('no-company-name')) qa.noCompanyName++;
    if (step1Flags.includes('grammar-issue')) qa.grammarIssue++;
    if (step1Flags.includes('over-550-chars')) qa.over550++;
    if (step1Flags.includes('under-100-chars')) qa.under100++;

    if (step1Flags.length > 0) {
      if (!lead._messageFlag) lead._messageFlag = 'needs-review';
      qa.needsReview++;
    }

    if (!lead._messageFlag) lead._messageFlag = 'ready';
  }

  // Build clean output rows (strip internal fields)
  const finalLeads = leads.map((lead) => {
    const messageFlag = lead._messageFlag || (lead.personalizedMessage ? 'ready' : 'skip-bad-data');
    const row = {};
    for (const [k, v] of Object.entries(lead)) {
      if (!k.startsWith('_')) row[k] = v;
    }
    row.personalizedMessage = lead.personalizedMessage || '';
    row.sequenceStep2 = lead.sequenceStep2 || '';
    row.sequenceStep3 = lead.sequenceStep3 || '';
    row.sequenceStep4 = lead.sequenceStep4 || '';
    row.messageFlag = messageFlag;
    row.messageStructure = lead.messageStructure || '';
    return row;
  });

  // Sort: ready first, then needs-review, then skips
  const flagOrder = { ready: 0, 'needs-review': 1 };
  finalLeads.sort((a, b) => {
    const aOrder = flagOrder[a.messageFlag] ?? 2;
    const bOrder = flagOrder[b.messageFlag] ?? 2;
    return aOrder - bOrder;
  });

  writeCsv(outputFile, finalLeads);

  // Write needs-review CSV
  const reviewLeads = finalLeads.filter(
    (l) => l.messageFlag === 'needs-review' || l.messageFlag === 'skip-no-vertical-fit'
  );
  if (reviewLeads.length > 0) {
    writeCsv(reviewFile, reviewLeads);
  }

  // Count by flag
  const flagBreakdown = {};
  for (const lead of finalLeads) {
    flagBreakdown[lead.messageFlag] = (flagBreakdown[lead.messageFlag] || 0) + 1;
  }

  // Print QA summary
  console.log(`\n  RESULTS`);
  console.log(`  Total leads:       ${leads.length}`);
  console.log(`  With messages:     ${totalReady}`);
  console.log(`  Avg chars:         ${totalReady > 0 ? Math.round(totalChars / totalReady) : 0}`);
  console.log(`  Brand mentions:    ${totalReady > 0 ? ((brandMentions / totalReady) * 100).toFixed(1) : 0}%`);

  console.log(`\n  FLAG BREAKDOWN`);
  for (const [flag, count] of Object.entries(flagBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${flag.padEnd(25)} ${count}`);
  }

  console.log(`\n  QUALITY CHECKS`);
  console.log(`    "I noticed" openers: ${qa.iNoticed}`);
  console.log(`    Banned phrases:      ${qa.bannedPhrases}`);
  console.log(`    Markdown found:      ${qa.markdown}`);
  console.log(`    No company name:     ${qa.noCompanyName}`);
  console.log(`    Grammar issues:      ${qa.grammarIssue}`);
  console.log(`    Over 550 chars:      ${qa.over550}`);
  console.log(`    Under 100 chars:     ${qa.under100}`);
  console.log(`    Needs review:        ${qa.needsReview}`);

  console.log(`\n  SEQUENCE FILL RATES`);
  console.log(`    Step 2 (value-add):     ${withStep2}/${totalReady}`);
  console.log(`    Step 3 (case study):    ${withStep3}/${totalReady}`);
  console.log(`    Step 4 (breakup):       ${withStep4}/${totalReady}`);
  console.log(`    Steps with issues:      ${sequenceStepIssues}`);

  console.log(`\n  VARIETY DISTRIBUTION`);
  console.log(`    Structure 1 (hook-pain-solution):   ${structureCounts[1]}`);
  console.log(`    Structure 2 (pain-proof-offer):     ${structureCounts[2]}`);
  console.log(`    Structure 3 (observation-question):  ${structureCounts[3]}`);

  console.log(`\n  OUTPUT`);
  console.log(`    Final:        ${outputFile}`);
  if (reviewLeads.length > 0) {
    console.log(`    Needs review: ${reviewFile} (${reviewLeads.length} leads)`);
  }
  console.log('='.repeat(60) + '\n');

  return finalLeads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  PHASE 1 CSV PROCESSOR');
  console.log('='.repeat(60));
  console.log(`  Input:       ${inputFile}`);
  console.log(`  Sample:      ${sampleSize > 0 ? sampleSize : 'full run'}`);
  console.log(`  Start phase: ${startPhase}`);
  console.log(`  Force:       ${forceFlag}`);
  console.log(`  Date:        ${date}`);

  // ── Phase 0 ──
  let leads;
  if (shouldRunPhase(0, PHASE0_FILE)) {
    const rawLeads = loadCsv(inputFile);
    console.log(`  Raw input rows: ${rawLeads.length}`);
    leads = phase0(rawLeads);

    if (sampleSize > 0) {
      leads = pickRandomSample(leads, sampleSize);
      console.log(`  Sampled ${leads.length} contacts for test run`);
    }

    writeCsv(PHASE0_FILE, leads);
    console.log(`  Saved: ${PHASE0_FILE}`);
  } else {
    leads = loadCsv(PHASE0_FILE);
    if (sampleSize > 0 && leads.length > sampleSize) {
      leads = pickRandomSample(leads, sampleSize);
    }
    console.log(`  Loaded phase 0 output: ${leads.length} contacts`);
  }

  // ── Phase 1: Email Verification ──
  if (shouldRunPhase(1, PHASE1_FILE)) {
    leads = await phase1(leads);
    writeCsv(PHASE1_FILE, leads);
    console.log(`  Saved: ${PHASE1_FILE}`);
  } else {
    leads = loadCsv(PHASE1_FILE);
    console.log(`  Loaded phase 1 output: ${leads.length} contacts`);
  }

  // ── Phase 2: Perplexity Signals ──
  if (shouldRunPhase(2, PHASE2_FILE)) {
    leads = await phase2(leads);
    writeCsv(PHASE2_FILE, leads);
    console.log(`  Saved: ${PHASE2_FILE}`);
  } else {
    leads = loadCsv(PHASE2_FILE);
    console.log(`  Loaded phase 2 output: ${leads.length} contacts`);
  }

  // ── Phase 3: Vertical Classification ──
  if (shouldRunPhase(3, PHASE3_FILE)) {
    leads = phase3(leads);
    writeCsv(PHASE3_FILE, leads);
    console.log(`  Saved: ${PHASE3_FILE}`);
  } else {
    leads = loadCsv(PHASE3_FILE);
    console.log(`  Loaded phase 3 output: ${leads.length} contacts`);
  }

  // ── Phase 4: Message Generation ──
  if (shouldRunPhase(4, PHASE4_FINAL)) {
    leads = await phase4(leads);
  } else {
    leads = loadCsv(PHASE4_FINAL);
    console.log(`  Loaded phase 4 output: ${leads.length} contacts`);
  }

  // ── Phase 5: Export & QA (always runs) ──
  const finalLeads = phase5(leads, PHASE4_FINAL, PHASE4_REVIEW);

  // ── Phase 6: Instantly Upload (optional) ──
  if (process.env.INSTANTLY_API_KEY && startPhase <= 6) {
    console.log('\n' + '='.repeat(60));
    console.log('  PHASE 6: Instantly Upload');
    console.log('='.repeat(60));

    try {
      const { checkCapacity, formatCapacityReport } = await import('../services/instantly-capacity.js');
      const { syncLeadsToInstantly } = await import('../export/instantly-sync.js');

      // Capacity pre-check (warning only)
      try {
        const capacity = await checkCapacity();
        if (!capacity.isCapacitySufficient) {
          console.log(formatCapacityReport(capacity));
          console.log('  WARNING: Proceeding with upload despite capacity deficit.');
        } else {
          console.log(`  Capacity OK: ${capacity.dailyCapacity}/day (${capacity.warmedAccounts} warmed accounts)`);
        }
      } catch (err) {
        console.log(`  Capacity check failed: ${err.message} (continuing anyway)`);
      }

      // Upload ready leads
      const result = await syncLeadsToInstantly(finalLeads, {
        campaignId: campaignIdFlag,
        force: forceFlag,
      });

      console.log(`\n  INSTANTLY UPLOAD RESULTS`);
      console.log(`    Campaign:   ${result.campaignName || 'N/A'}`);
      console.log(`    Uploaded:   ${result.uploaded}`);
      console.log(`    Cached:     ${result.cached}`);
      console.log(`    Skipped:    ${result.skipped} (not ready)`);
      console.log(`    Failed:     ${result.failed}`);
      if (result.errors && result.errors.length > 0) {
        for (const e of result.errors) {
          console.log(`    Error: ${e.email} — ${e.error}`);
        }
      }
      console.log('='.repeat(60));
    } catch (err) {
      console.log(`  Instantly upload failed: ${err.message}`);
      console.log('  CSVs are still available in output/');
      console.log('='.repeat(60));
    }
  } else if (!process.env.INSTANTLY_API_KEY && startPhase <= 6) {
    console.log('\n  Phase 6: Skipped (INSTANTLY_API_KEY not set)');
  }

  console.log('\nDone!');
}

main().catch((err) => {
  logger.error('Pipeline failed', { error: err.message, stack: err.stack });
  console.error('Pipeline failed:', err.message);
  process.exit(1);
});
