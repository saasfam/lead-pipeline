#!/usr/bin/env node

/**
 * Dry run — exercises the pure helpers in the new end-to-end pipeline and
 * prints what each step would produce. No external API calls. No cost.
 *
 *   node scripts/dry-run.js                 # full demo
 *   node scripts/dry-run.js --vertical msp  # focus on one vertical
 *
 * Useful for sanity-checking landing-page slugs, campaign body shape, and
 * inbox-order math before turning on INSTANTLY_AUTO_ORDER.
 */

import { VERTICALS, landingPageFor, landingHost, getVertical } from '../config/verticals.js';
import { CTA_POOL, assignVariety } from '../config/message-variety.js';
import { buildCampaignBody } from '../export/instantly-campaign.js';
import { planInboxOrder } from '../services/inbox-orderer.js';
import { ensureLanderUrl } from '../enrichment/lander-url.js';

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}
const focusVertical = getArg('--vertical') || 'msp';

const line = (ch = '─', n = 78) => ch.repeat(n);
const header = (title) => {
  console.log('\n' + line('═'));
  console.log('  ' + title);
  console.log(line('═'));
};

// ── 1. Landing-page mapping ──────────────────────────────────────────────────
header('1. LANDING PAGE MAPPING (all 22 verticals)');
console.log(`  LANDING_PAGE_BASE = ${process.env.LANDING_PAGE_BASE || 'https://anyreach.ai'}`);
console.log(`  tracking_domain   = ${landingHost()}`);
console.log();
for (const [key, v] of Object.entries(VERTICALS)) {
  console.log(`  ${v.label.padEnd(22)} ${key.padEnd(20)} → ${landingPageFor(key)}`);
}

// ── 2. Sample CTA rendering for focus vertical ──────────────────────────────
header(`2. CTA POOL RENDERED FOR "${focusVertical.toUpperCase()}"`);
const vertical = getVertical(focusVertical);
if (!vertical) {
  console.error(`Unknown vertical: ${focusVertical}`);
  process.exit(1);
}
const url = landingPageFor(focusVertical);
console.log(`  Vertical: ${vertical.label}   URL: ${url}\n`);
for (const [i, cta] of CTA_POOL.entries()) {
  const rendered = cta.replace('[vertical]', vertical.label).replace('[lander]', url);
  console.log(`  [${i + 1}] ${rendered}`);
}

// ── 3. Sample variety assignment for 6 leads ────────────────────────────────
header(`3. VARIETY ASSIGNMENT (first 6 leads in batch, ${focusVertical})`);
const sampleLeads = Array.from({ length: 6 }, (_, i) => ({
  firstName: ['Alex', 'Jordan', 'Sam', 'Casey', 'Morgan', 'Riley'][i],
  lastName: 'Doe',
  companyName: `Demo${i + 1}`,
  recentNews: i % 3 === 0 ? 'Raised Series B in March' : 'None found',
  personalizedHook: i % 2 === 0 ? `Demo${i + 1} just expanded to a new market` : '',
}));
sampleLeads.forEach((lead, idx) => {
  const variety = assignVariety(lead, idx, sampleLeads.length);
  const rendered = variety.cta.replace('[vertical]', vertical.label).replace('[lander]', url);
  console.log(`  Lead ${idx + 1} — ${variety.structure.name}, opener=${variety.openerType}`);
  console.log(`    target chars: ${variety.targetChars.min}-${variety.targetChars.max}`);
  console.log(`    mentions Anyreach: ${variety.mentionBrand}`);
  console.log(`    rendered CTA: "${rendered}"`);
  console.log();
});

// ── 4. ensureLanderUrl defense pass ─────────────────────────────────────────
header('4. ensureLanderUrl POST-PROCESS PASS');
const llmOutputWithoutUrl = "Demo3's growth makes ops harder. We'd love to share what's working for similar teams. Open to a 10-min call?";
const llmOutputWithUrl = `Demo3's growth makes ops harder. Quick overview: ${url}`;
console.log('  Case A: LLM dropped the URL');
console.log(`    BEFORE: "${llmOutputWithoutUrl}"`);
console.log(`    AFTER:  "${ensureLanderUrl(llmOutputWithoutUrl, url)}"`);
console.log();
console.log('  Case B: LLM kept the URL (no double-append)');
console.log(`    BEFORE: "${llmOutputWithUrl}"`);
console.log(`    AFTER:  "${ensureLanderUrl(llmOutputWithUrl, url)}"`);

// ── 5. Per-vertical Instantly campaign body ─────────────────────────────────
header(`5. INSTANTLY CAMPAIGN BODY (POST /campaigns payload)`);
const month = new Date().toISOString().slice(0, 7);
const campaignName = `Anyreach - ${vertical.label} - ${month}`;
const body = buildCampaignBody({
  name: campaignName,
  verticalKey: focusVertical,
  verticalLabel: vertical.label,
  dailyLimit: 50,
});
console.log(JSON.stringify(body, null, 2));

// ── 6. Inbox-order plan under various scenarios ─────────────────────────────
header('6. INBOX-ORDER PLAN (planInboxOrder, pure)');

const scenarios = [
  {
    name: 'A. Sufficient capacity — no action',
    capacity: { totalAccounts: 200, warmedAccounts: 200, dailyCapacity: 6000, deficit: 0, isCapacitySufficient: true },
    prewarmed: [{ domain: 'leads-anyreach.com', available: true }],
    options: { maxMailboxes: 100 },
  },
  {
    name: 'B. Deficit but plan-only (INSTANTLY_MAX_MAILBOXES_PER_RUN unset)',
    capacity: { totalAccounts: 50, warmedAccounts: 50, dailyCapacity: 1500, deficit: 1500, isCapacitySufficient: false },
    prewarmed: [
      { domain: 'leads-anyreach.com', available: true },
      { domain: 'go-anyreach.com', available: true },
      { domain: 'mail-anyreach.com', available: true },
    ],
    options: {},
  },
  {
    name: 'C. Deficit + per-run cap of 30 — would order',
    capacity: { totalAccounts: 50, warmedAccounts: 50, dailyCapacity: 1500, deficit: 1500, isCapacitySufficient: false },
    prewarmed: [
      { domain: 'leads-anyreach.com', available: true },
      { domain: 'go-anyreach.com', available: true },
      { domain: 'mail-anyreach.com', available: true },
    ],
    options: { maxMailboxes: 30, mailboxesPerDomain: 10 },
  },
  {
    name: 'D. Huge deficit with high cap — hits internal hard cap of 500',
    capacity: { totalAccounts: 50, warmedAccounts: 50, dailyCapacity: 1500, deficit: 1_000_000, isCapacitySufficient: false },
    prewarmed: [{ domain: 'go.com', available: true }, { domain: 'mail.com', available: true }],
    options: { maxMailboxes: 99999 },
  },
];

for (const sc of scenarios) {
  console.log(`\n  ${sc.name}`);
  const plan = planInboxOrder(sc.capacity, sc.prewarmed, sc.options);
  console.log(`    needed:  ${plan.mailboxesNeeded}`);
  console.log(`    planned: ${plan.mailboxesPlanned}`);
  console.log(`    reason:  ${plan.reason}`);
  if (plan.items.length > 0) {
    console.log(`    items:   ${plan.items.map((it) => `${it.domain}=${it.num_accounts}`).join(', ')}`);
  }
}

// ── 7. Summary ──────────────────────────────────────────────────────────────
header('7. WHAT A REAL RUN LOOKS LIKE');
console.log(`
  POST /scrape-vertical {"vertical":"${focusVertical}","cities":["Austin"]}

  → orchestrator (pipeline/orchestrator.js)
      Step 1  scrape Google Maps (Browserbase)
      Step 2  in-vertical dedup
      Step 2b cross-vertical dedup by name
      Step 3  resolve domains
      Step 3b cross-vertical dedup by domain
      Step 4  Apollo people search (${vertical.apolloTitles.join(', ')})
      Step 5  Apollo email verify
      Step 5c Perplexity signals + OpenAI 4-step sequences  ← NEW
                cap: MESSAGES_MAX_PER_VERTICAL (default 1000)
                each message ends with "${url}"
      Step 6  CSVs to ./output/
      Step 7  upload CSVs to gs://anyreach-lead-pipeline
      Step 8  provision Instantly:
                check capacity, plan DFY order, optionally submit  ← NEW
                ensure draft campaign "${campaignName}"            ← NEW
                upload ready leads to that campaign                ← NEW
                (campaign stays DRAFT — launch is manual in UI)
      Step 9  Slack notification

  Smoke test (cheap):
      MESSAGES_MAX_PER_VERTICAL=20 INSTANTLY_AUTO_ORDER=false \\
      curl -X POST http://localhost:8080/scrape-vertical \\
        -H 'Content-Type: application/json' \\
        -d '{"vertical":"${focusVertical}","cities":["Austin"]}'
`);
