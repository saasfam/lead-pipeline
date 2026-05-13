/**
 * Layer 6: Email Guessing
 *
 * For contacts missing email whose practice has a domain:
 *   - MX lookup to verify domain receives email
 *   - Smart email pattern guessing (provider-aware)
 *   - Uses existing email-guesser.js module
 *
 * Cost: $0 (DNS lookups only).
 */

import { contactsMissingEmail, updateContactEmail } from '../store.js';
import { processDomain, checkMX, detectProvider, smartGuess } from '../../enrichment/email-guesser.js';
import { Progress } from '../utils/progress.js';

// Cache MX results per domain to avoid repeated lookups
const domainMxCache = new Map();

/**
 * Get MX info for a domain (cached).
 */
async function getDomainMx(domain) {
  if (domainMxCache.has(domain)) return domainMxCache.get(domain);

  const mxHosts = await checkMX(domain);
  const hasMX = mxHosts && mxHosts.length > 0;
  const provider = detectProvider(mxHosts);

  const result = { hasMX, provider };
  domainMxCache.set(domain, result);
  return result;
}

/**
 * Process a single contact: guess their email based on name + domain.
 */
async function processContact(contact) {
  const domain = contact.domain;
  if (!domain) return false;

  const { hasMX, provider } = await getDomainMx(domain);
  if (!hasMX) return false;

  const firstName = contact.first_name;
  const lastName = contact.last_name;

  if (!firstName) return false;

  const { primary, alternate } = smartGuess(firstName, lastName, domain, provider);

  if (primary) {
    updateContactEmail(contact.id, primary, 'email-guess', alternate);
    return true;
  }

  return false;
}

export async function run(opts, filters) {
  console.log('  Layer 6: Email Guessing — MX validation + pattern matching\n');

  const contacts = contactsMissingEmail(filters, opts.sample || 0);
  console.log(`  Contacts missing email: ${contacts.length.toLocaleString()}`);

  if (contacts.length === 0) {
    console.log('  Nothing to do — all contacts have emails.');
    return;
  }

  if (opts.dryRun) {
    console.log('\n  DRY RUN — Would guess emails for:');
    for (const c of contacts.slice(0, 5)) {
      console.log(`    ${c.first_name} ${c.last_name} @ ${c.domain}`);
    }
    return;
  }

  const progress = new Progress('Email Guess', contacts.length);
  let found = 0;
  let noMX = 0;
  let noName = 0;

  // Group contacts by domain for efficient MX caching
  const byDomain = new Map();
  for (const contact of contacts) {
    const domain = contact.domain;
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(contact);
  }

  console.log(`  Unique domains: ${byDomain.size.toLocaleString()}`);

  // Process domain by domain
  const concurrency = Math.min(opts.concurrency || 20, 50);
  const domains = [...byDomain.entries()];

  for (let i = 0; i < domains.length; i += concurrency) {
    const batch = domains.slice(i, i + concurrency);

    await Promise.allSettled(
      batch.map(async ([domain, domainContacts]) => {
        const { hasMX, provider } = await getDomainMx(domain);

        for (const contact of domainContacts) {
          if (!hasMX) {
            noMX++;
            progress.tick();
            continue;
          }

          if (!contact.first_name) {
            noName++;
            progress.tick();
            continue;
          }

          const { primary, alternate } = smartGuess(
            contact.first_name,
            contact.last_name,
            domain,
            provider
          );

          if (primary) {
            updateContactEmail(contact.id, primary, 'email-guess', alternate);
            found++;
          }

          progress.tick();
        }
      })
    );
  }

  const hitRate = contacts.length > 0 ? ((found / contacts.length) * 100).toFixed(1) : '0';
  console.log(`\n  Results:`);
  console.log(`    Processed:   ${contacts.length.toLocaleString()}`);
  console.log(`    Emails set:  ${found.toLocaleString()} (${hitRate}%)`);
  console.log(`    No MX:       ${noMX}`);
  console.log(`    No name:     ${noName}`);
}
