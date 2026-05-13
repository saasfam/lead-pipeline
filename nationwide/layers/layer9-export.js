/**
 * Layer 9: Export — Instantly CSV
 *
 * Exports all contacts with email + sequence to a 16-column CSV
 * compatible with Instantly.ai import format.
 */

import { writeFileSync } from 'fs';
import { stringify } from 'csv-stringify/sync';
import { contactsForExport } from '../store.js';

const INSTANTLY_COLUMNS = [
  'email',
  'first_name',
  'last_name',
  'company_name',
  'title',
  'phone',
  'website',
  'vertical',
  'city',
  'state',
  'linkedin_url',
  'personalized_hook',
  'personalized_message',
  'sequence_step_2',
  'sequence_step_3',
  'sequence_step_4',
];

export async function run(opts, filters) {
  console.log('  Layer 9: Export — Instantly CSV\n');

  const rows = contactsForExport(filters);
  console.log(`  Contacts with email + sequence: ${rows.length.toLocaleString()}`);

  if (rows.length === 0) {
    console.log('  Nothing to export — run earlier layers first.');
    return;
  }

  // Map DB rows to Instantly columns
  const outputRows = rows.map((row) => ({
    email: row.email,
    first_name: row.first_name || '',
    last_name: row.last_name || '',
    company_name: row.company_name || '',
    title: row.title || '',
    phone: row.contact_phone || row.practice_phone || '',
    website: row.domain ? `https://${row.domain}` : '',
    vertical: 'dental',
    city: row.city || '',
    state: row.state || '',
    linkedin_url: '',
    personalized_hook: row.hook || '',
    personalized_message: row.step1 || '',
    sequence_step_2: row.step2 || '',
    sequence_step_3: row.step3 || '',
    sequence_step_4: row.step4 || '',
  }));

  // Deduplicate by email
  const seen = new Set();
  const deduped = outputRows.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const dupsRemoved = outputRows.length - deduped.length;
  if (dupsRemoved > 0) {
    console.log(`  Duplicates removed: ${dupsRemoved}`);
  }

  // Generate output filename with date
  const date = new Date().toISOString().split('T')[0];
  const stateTag = opts.states.length ? `-${opts.states.join('-')}` : '';
  const outputPath = `./output/${date}-dental-nationwide${stateTag}-instantly.csv`;

  const csv = stringify(deduped, { header: true, columns: INSTANTLY_COLUMNS });
  writeFileSync(outputPath, csv);

  // Stats
  const tierCounts = {};
  const stateCounts = {};
  for (const row of deduped) {
    const state = row.state || 'unknown';
    stateCounts[state] = (stateCounts[state] || 0) + 1;
  }

  // Show top 10 states
  const topStates = Object.entries(stateCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log(`\n  Export Summary:`);
  console.log(`    Total contacts:  ${deduped.length.toLocaleString()}`);
  console.log(`    Output file:     ${outputPath}`);
  console.log(`\n  Top states:`);
  for (const [state, count] of topStates) {
    console.log(`    ${state.padEnd(4)} ${count.toLocaleString()}`);
  }
}
