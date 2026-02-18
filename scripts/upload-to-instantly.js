/**
 * Standalone script: upload leads from a final CSV to Instantly.
 * Usage: INSTANTLY_API_KEY=xxx node scripts/upload-to-instantly.js <csv-path> <campaign-id>
 */
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { createLead, isConfigured } from '../services/instantly.js';

const [csvPath, campaignId] = process.argv.slice(2);

if (!csvPath || !campaignId) {
  console.error('Usage: node scripts/upload-to-instantly.js <csv-path> <campaign-id>');
  process.exit(1);
}

if (!isConfigured()) {
  console.error('INSTANTLY_API_KEY not set');
  process.exit(1);
}

const raw = readFileSync(csvPath, 'utf-8');
const rows = parse(raw, { columns: true, skip_empty_lines: true });

// Filter to ready leads only
const readyLeads = rows.filter((r) => r.messageFlag === 'ready');
console.log(`Total rows: ${rows.length}, Ready: ${readyLeads.length}`);

let uploaded = 0;
let failed = 0;

for (const row of readyLeads) {
  const lead = {
    email: row.email,
    first_name: row.firstName || '',
    last_name: row.lastName || '',
    company_name: row.companyName || row.properCompanyName || '',
    custom_variables: {
      title: row.title || '',
      vertical: row.vertical || '',
      personalized_hook: row.personalizedHook || '',
      personalized_message: row.personalizedMessage || '',
      sequence_step_2: row.sequenceStep2 || '',
      sequence_step_3: row.sequenceStep3 || '',
      sequence_step_4: row.sequenceStep4 || '',
      linkedin_url: row.linkedinUrl || '',
      city: row.city || '',
      state: row.state || '',
      website: row.companyDomain ? `https://${row.companyDomain}` : '',
    },
  };

  try {
    await createLead(campaignId, lead);
    uploaded++;
    process.stdout.write(`\r  Uploaded: ${uploaded}/${readyLeads.length} (failed: ${failed})`);
  } catch (err) {
    failed++;
    console.error(`\n  Failed: ${row.email} — ${err.message}`);
  }
}

console.log(`\n\nDone! Uploaded: ${uploaded}, Failed: ${failed}`);
