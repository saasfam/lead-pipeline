/**
 * Quick sample: pull 10 enriched decision-maker leads per vertical from Apollo.
 *
 * Two-step flow:
 *   1. /mixed_people/api_search  → get person IDs (free, no credits)
 *   2. /people/bulk_match        → enrich IDs to get emails, phones, LinkedIn, company data
 *
 * Usage: APOLLO_API_KEY=xxx node scripts/sample-leads.js
 */

import { VERTICALS } from '../config/verticals.js';
import { writeFileSync } from 'fs';

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
if (!APOLLO_API_KEY) {
  console.error('Missing APOLLO_API_KEY env var');
  process.exit(1);
}

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const PER_VERTICAL = 10;
const RATE_DELAY_MS = 1500;

/** Step 1: Search for person IDs matching vertical criteria */
async function searchPeopleIds(verticalKey, config) {
  const res = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': APOLLO_API_KEY,
    },
    body: JSON.stringify({
      person_titles: config.apolloTitles,
      q_organization_keyword_tags: config.apolloIndustries,
      organization_num_employees_ranges: config.apolloSizes,
      person_locations: ['United States'],
      page: 1,
      per_page: PER_VERTICAL,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`  [${verticalKey}] Search error ${res.status}: ${err.slice(0, 200)}`);
    return [];
  }

  const data = await res.json();
  return (data.people || []).map((p) => p.id).filter(Boolean);
}

/** Step 2: Bulk enrich person IDs to get full contact + company data */
async function bulkEnrich(personIds) {
  if (personIds.length === 0) return [];

  const res = await fetch(`${APOLLO_BASE}/people/bulk_match`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': APOLLO_API_KEY,
    },
    body: JSON.stringify({
      details: personIds.map((id) => ({ id })),
      reveal_personal_emails: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`  Enrich error ${res.status}: ${err.slice(0, 200)}`);
    return [];
  }

  const data = await res.json();
  return data.matches || [];
}

/** Map enriched Apollo person into a flat lead row */
function mapToLead(p, verticalKey, verticalLabel) {
  const org = p.organization || {};
  return {
    vertical: verticalKey,
    verticalLabel,
    firstName: p.first_name || '',
    lastName: p.last_name || '',
    email: p.email || '',
    emailStatus: p.email_status || '',
    title: p.title || '',
    headline: p.headline || '',
    seniority: p.seniority || '',
    linkedinUrl: p.linkedin_url || '',
    personalPhone: p.phone_numbers?.[0]?.sanitized_number || '',
    city: p.city || '',
    state: p.state || '',
    country: p.country || '',
    companyName: org.name || '',
    companyDomain: org.primary_domain || org.website_url || '',
    companyWebsite: org.website_url || '',
    companyLinkedin: org.linkedin_url || '',
    companyPhone: org.phone || '',
    companyCity: org.city || '',
    companyState: org.state || '',
    companyIndustry: org.industry || '',
    companySubIndustry: org.sub_industry || '',
    companyEmployees: org.estimated_num_employees || '',
    companyRevenue: org.annual_revenue_printed || '',
    companyFounded: org.founded_year || '',
    companyDescription: (org.short_description || '').replace(/[\n\r,]/g, ' ').slice(0, 300),
    apolloId: p.id || '',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const allLeads = [];
  const verticalKeys = Object.keys(VERTICALS);

  console.log(`Pulling ${PER_VERTICAL} enriched leads from each of ${verticalKeys.length} verticals...\n`);

  for (const key of verticalKeys) {
    const config = VERTICALS[key];
    process.stdout.write(`  ${config.label.padEnd(25)} `);

    // Step 1: Get IDs
    const ids = await searchPeopleIds(key, config);
    if (ids.length === 0) {
      console.log('0 contacts (search returned nothing)');
      await sleep(RATE_DELAY_MS);
      continue;
    }

    await sleep(RATE_DELAY_MS);

    // Step 2: Enrich
    const enriched = await bulkEnrich(ids);
    const leads = enriched.map((p) => mapToLead(p, key, config.label));
    allLeads.push(...leads);

    const withEmail = leads.filter((l) => l.email).length;
    const withPhone = leads.filter((l) => l.personalPhone).length;
    console.log(`${leads.length} contacts (${withEmail} email, ${withPhone} phone)`);

    await sleep(RATE_DELAY_MS);
  }

  if (allLeads.length === 0) {
    console.log('\nNo leads found. Check your Apollo API key and quota.');
    process.exit(1);
  }

  // Build CSV
  const headers = Object.keys(allLeads[0]);
  const csvRows = [
    headers.join(','),
    ...allLeads.map((row) =>
      headers
        .map((h) => {
          const val = String(row[h] ?? '').replace(/"/g, '""');
          return val.includes(',') || val.includes('"') || val.includes('\n')
            ? `"${val}"`
            : val;
        })
        .join(',')
    ),
  ];

  const outPath = `output/sample-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  writeFileSync(outPath, csvRows.join('\n'), 'utf-8');

  // Summary
  const withEmail = allLeads.filter((l) => l.email).length;
  const withPhone = allLeads.filter((l) => l.personalPhone).length;
  const withLinkedin = allLeads.filter((l) => l.linkedinUrl).length;

  console.log(`\n--- Summary ---`);
  console.log(`Total leads:      ${allLeads.length}`);
  console.log(`With email:       ${withEmail} (${((withEmail / allLeads.length) * 100).toFixed(0)}%)`);
  console.log(`With phone:       ${withPhone} (${((withPhone / allLeads.length) * 100).toFixed(0)}%)`);
  console.log(`With LinkedIn:    ${withLinkedin} (${((withLinkedin / allLeads.length) * 100).toFixed(0)}%)`);
  console.log(`\nCSV saved to: ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
