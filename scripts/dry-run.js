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

import { readFileSync } from 'fs';
import { VERTICALS, landingPageFor, landingHost, getVertical } from '../config/verticals.js';
import { CTA_POOL, assignVariety } from '../config/message-variety.js';
import { buildCampaignBody } from '../export/instantly-campaign.js';
import { generateInstantlyCSV } from '../export/instantly-csv.js';
import { generatePhantomBusterCSV } from '../export/phantombuster-csv.js';
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

// ── 7. Sample Instantly + PhantomBuster CSVs ────────────────────────────────
header(`7. SAMPLE CSV OUTPUT (./output/*-${focusVertical}-instantly.csv)`);
console.log(`
  Writing a sample CSV using fabricated leads — same shape the real
  pipeline writes after Step 5c (sequence generation) + Step 6 (export).
  No external API calls. Safe to delete after inspection.
`);

const sampleEnrichedLeads = [
  {
    email: 'sarah.chen@northbridgemsp.com',
    firstName: 'Sarah', lastName: 'Chen',
    companyName: 'Northbridge MSP', companyDomain: 'northbridgemsp.com',
    title: 'CEO', phone: '+1-555-0142',
    city: 'Austin', state: 'TX',
    linkedinUrl: 'https://linkedin.com/in/sarah-chen-msp',
    verticalKey: focusVertical, vertical: vertical.label,
    landingPage: url,
    personalizedHook: 'Northbridge MSP just opened a new SOC division',
    personalizedMessage: `Northbridge MSP's growth into managed SOC services puts you in front of the SLA-tracking challenge most MSPs hit at your size — every after-hours alert turns into either a missed callback or a tier-1 burning out at 2am. We built an AI voice agent that answers the inbound, qualifies severity, and pages the on-call only when it matters. Saw 40% fewer missed dispatches at a peer ${vertical.label} firm in their first month. Open to a 10-min call this week? Quick overview here: ${url}`,
    sequenceStep2: `Following up — the SLA-miss problem we discussed earlier compounds at quarter-end when ticket volume jumps. The AI agent handles the surge without needing to staff up. ROI piece if useful: ${url}`,
    sequenceStep3: `One more — a ${vertical.label} firm in the Pacific Northwest cut their after-hours dispatch cost by $11K/mo using the same setup. Happy to share the case study.`,
    sequenceStep4: `Last note from me — if after-hours coverage isn't a priority right now, totally get it. Door's open if it becomes one. ${url}`,
    messageFlag: 'ready',
  },
  {
    email: 'm.alvarez@cresttechpartners.com',
    firstName: 'Marcus', lastName: 'Alvarez',
    companyName: 'Cresttech Partners', companyDomain: 'cresttechpartners.com',
    title: 'President', phone: '+1-555-0298',
    city: 'Phoenix', state: 'AZ',
    linkedinUrl: 'https://linkedin.com/in/marcus-alvarez',
    verticalKey: focusVertical, vertical: vertical.label,
    landingPage: url,
    personalizedHook: 'Cresttech Partners hiring 3 NOC engineers per their LinkedIn',
    personalizedMessage: `Running President at a 75-person ${vertical.label} firm hiring NOC engineers means the question isn't whether you can grow the team — it's whether overhead keeps pace. Cresttech Partners is at the size where one missed inbound call costs more than a week of a tier-1 salary. Want me to send over a quick case study? Or skim it here: ${url}`,
    sequenceStep2: `The NOC hiring you're doing on LinkedIn — most MSPs we work with use the AI agent to keep human engineers focused on the tickets that need them, not the password resets.`,
    sequenceStep3: `A peer MSP in Phoenix handled a 3x call-volume spike during a vendor outage without a single dropped call. Their AI agent triaged, ours escalated only true Sev-1s.`,
    sequenceStep4: `Closing the loop. If managed voice ever comes up at Cresttech, I'm an email away. ${url}`,
    messageFlag: 'ready',
  },
  {
    email: 'j.patel@bluepeakit.com',
    firstName: 'Jaya', lastName: 'Patel',
    companyName: 'Bluepeak IT', companyDomain: 'bluepeakit.com',
    title: 'Managing Partner', phone: '',
    city: 'Denver', state: 'CO',
    linkedinUrl: 'https://linkedin.com/in/jaya-patel-it',
    verticalKey: focusVertical, vertical: vertical.label,
    landingPage: url,
    personalizedHook: '',
    personalizedMessage: `Bluepeak IT — quick observation. Your team's listed 24/7 response in the SLA, but 24/7 staffing is the most expensive way to deliver it. Curious how you're handling the after-hours queue — full third-shift, on-call rotation, or something else? ${url}`,
    sequenceStep2: `Earlier note — the 24/7 SLA question. Quick stat: MSPs at your size average $7K/mo on after-hours coverage. AI voice cuts that by ~60% on the dispatch piece.`,
    sequenceStep3: `Case in point — a Denver-area MSP cut after-hours OT spend from $14K to $5K/mo within 60 days. Different setup but transferable.`,
    sequenceStep4: `Last note. Happy to share more anytime. ${url}`,
    messageFlag: 'ready',
  },
  {
    email: 'd.kim@parallaxmanaged.com',
    firstName: 'David', lastName: 'Kim',
    companyName: 'Parallax Managed Services', companyDomain: 'parallaxmanaged.com',
    title: 'VP of Operations', phone: '+1-555-0734',
    city: 'Seattle', state: 'WA',
    linkedinUrl: 'https://linkedin.com/in/david-kim-msp',
    verticalKey: focusVertical, vertical: vertical.label,
    landingPage: url,
    personalizedHook: 'Parallax recently launched a co-managed IT offering',
    personalizedMessage: `Parallax Managed Services launching co-managed IT — that puts inbound complexity through the roof. Each new client adds two phone trees (theirs and yours) and the friction shows up at month 2, not month 1. Anyreach handles the routing layer so your team only sees calls that actually need them. Would a short demo make sense?`,
    sequenceStep2: `On the co-managed launch — the routing-friction problem peaks around month 2-3 when clients start testing your after-hours response. Heads-up.`,
    sequenceStep3: `A co-managed-focused MSP in Seattle ran the AI agent during their first 90 days post-launch — net dispatch time dropped from 9 minutes to under 2.`,
    sequenceStep4: `Wrapping up — let me know if Q3 is the right time to revisit. ${url}`,
    messageFlag: 'ready',
  },
];

const csvPath = generateInstantlyCSV(sampleEnrichedLeads, focusVertical);
const pbPath = generatePhantomBusterCSV(sampleEnrichedLeads, focusVertical);

console.log(`  Instantly CSV: ${csvPath}`);
console.log(`  PhantomBuster CSV: ${pbPath}`);
console.log();
console.log('  ── First lead, formatted from the CSV ───────────────────────────────');
const csvLines = readFileSync(csvPath, 'utf-8').split(/\r?\n/);
const headerCols = csvLines[0].split(',');
// csv-stringify quotes fields with commas, so we re-parse minimally here
function splitCsvRow(line) {
  const out = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
    else if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const firstRow = splitCsvRow(csvLines[1]);
for (let i = 0; i < headerCols.length; i++) {
  const val = firstRow[i] || '';
  const truncated = val.length > 100 ? val.slice(0, 100) + '…' : val;
  console.log(`    ${headerCols[i].padEnd(22)} ${truncated}`);
}
console.log();
console.log(`  Open the file directly to see all ${sampleEnrichedLeads.length} sample rows:`);
console.log(`    ${csvPath}`);

// ── 8. Summary ──────────────────────────────────────────────────────────────
header('8. WHAT A REAL RUN LOOKS LIKE');
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
