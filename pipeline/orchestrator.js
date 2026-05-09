import { getVertical, VERTICALS } from '../config/verticals.js';
import { getCities } from '../config/cities.js';
import { runScrapersForVertical } from '../scrapers/scraper-registry.js';
import { resolveDomains } from '../enrichment/domain-resolver.js';
import { batchPeopleSearch } from '../enrichment/apollo-people-search.js';
import { verifyEmails } from '../enrichment/apollo-verify.js';
import { dedupBusinesses, dedupContacts } from '../enrichment/dedup.js';
import { filterCrossVertical } from '../enrichment/cross-vertical-dedup.js';
import { generateInstantlyCSV } from '../export/instantly-csv.js';
import { generatePhantomBusterCSV } from '../export/phantombuster-csv.js';
import { uploadMultipleToGCS } from '../export/gcs-upload.js';
import { syncLeadsToInstantly } from '../export/instantly-sync.js';
import { isConfigured as instantlyConfigured } from '../services/instantly.js';
import { checkCapacity } from '../services/instantly-capacity.js';
import { createJob, completeJob, failJob, updateJob } from './job-tracker.js';
import { notifySlack, formatPipelineComplete, formatInstantlyUpload } from '../services/slack.js';
import { logger } from '../services/logger.js';

/**
 * Run the full pipeline for a single vertical.
 *
 * Flow: scrape → dedup → resolve domains → Apollo people search → verify emails → export CSVs
 *
 * @param {string} verticalKey - Vertical key (e.g., "dental")
 * @param {Array<string>|null} cityNames - Specific cities, or null for all 50
 * @returns {object} - Job result with stats
 */
export async function runVerticalPipeline(verticalKey, cityNames = null) {
  const vertical = getVertical(verticalKey);
  if (!vertical) throw new Error(`Unknown vertical: ${verticalKey}`);

  const cities = getCities(cityNames);
  const job = await createJob('vertical', { vertical: verticalKey, cities: cities.map((c) => c.name) });

  logger.info('Pipeline started', { jobId: job.id, vertical: verticalKey, cities: cities.length });

  try {
    // Step 1: Scrape
    logger.info('Step 1: Scraping businesses', { vertical: verticalKey });
    const rawBusinesses = await runScrapersForVertical(vertical, verticalKey, cities);
    job.stats.scraped = rawBusinesses.length;
    await updateJob(job.id, { stats: { ...job.stats } });

    // Step 2: Dedup businesses (within this vertical's scrape)
    logger.info('Step 2: Deduplicating businesses');
    const uniqueBusinesses = dedupBusinesses(rawBusinesses);

    // Step 2b: Cross-vertical dedup by normalized name (cheap, before
    // we spend domain-resolution API calls on already-claimed businesses).
    logger.info('Step 2b: Cross-vertical dedup (name)');
    const nameFilter = await filterCrossVertical(uniqueBusinesses, verticalKey);
    job.stats.crossVerticalDupesByName = nameFilter.duplicates.length;
    await updateJob(job.id, { stats: { ...job.stats } });

    // Step 3: Resolve domains
    logger.info('Step 3: Resolving domains');
    const withDomains = await resolveDomains(nameFilter.fresh);

    // Step 3b: Cross-vertical dedup by domain — catches dupes that had
    // different name spellings across directories. The first pass already
    // recorded name-keyed entries, but a domain-keyed entry is a stronger
    // claim, so we re-check post-domain.
    logger.info('Step 3b: Cross-vertical dedup (domain)');
    const domainFilter = await filterCrossVertical(withDomains, verticalKey);
    job.stats.crossVerticalDupesByDomain = domainFilter.duplicates.length;
    await updateJob(job.id, { stats: { ...job.stats } });

    const businessesWithDomains = domainFilter.fresh.filter((b) => b.domain);
    logger.info('Businesses with domains', {
      total: domainFilter.fresh.length,
      withDomain: businessesWithDomains.length,
    });

    // Step 4: Apollo people search
    logger.info('Step 4: Apollo people search');
    const contacts = await batchPeopleSearch(businessesWithDomains, vertical);
    const uniqueContacts = dedupContacts(contacts);
    job.stats.enriched = uniqueContacts.length;
    await updateJob(job.id, { stats: { ...job.stats } });

    // Step 5: Verify emails
    logger.info('Step 5: Verifying emails');
    const verifiedContacts = await verifyEmails(uniqueContacts);
    job.stats.verified = verifiedContacts.length;
    await updateJob(job.id, { stats: { ...job.stats } });

    // Step 6: Export CSVs
    logger.info('Step 6: Exporting CSVs');
    // Merge city/state from business data into contacts
    const domainToBiz = new Map();
    for (const biz of withDomains) {
      if (biz.domain && !domainToBiz.has(biz.domain)) {
        domainToBiz.set(biz.domain, biz);
      }
    }
    const enrichedContacts = verifiedContacts.map((c) => {
      const biz = domainToBiz.get(c.companyDomain) || {};
      return { ...c, city: biz.city || '', state: biz.state || '' };
    });

    const instantlyPath = generateInstantlyCSV(enrichedContacts, verticalKey);
    const pbPath = generatePhantomBusterCSV(enrichedContacts, verticalKey);
    job.stats.exported = enrichedContacts.length;

    // Step 7: Upload to GCS
    logger.info('Step 7: Uploading to GCS');
    const outputFiles = [instantlyPath, pbPath].filter(Boolean);
    let gcsUris = [];
    try {
      gcsUris = await uploadMultipleToGCS(outputFiles);
    } catch (err) {
      logger.warn('GCS upload failed, CSVs saved locally', { error: err.message });
      gcsUris = outputFiles; // Fall back to local paths
    }

    // Step 8: Upload to Instantly (non-blocking)
    let instantlyResult = null;
    let capacityReport = null;
    if (instantlyConfigured()) {
      try {
        // Capacity check (warning only)
        try {
          capacityReport = await checkCapacity();
          if (!capacityReport.isCapacitySufficient) {
            logger.warn('Instantly capacity insufficient', {
              dailyCapacity: capacityReport.dailyCapacity,
              deficit: capacityReport.deficit,
            });
          }
        } catch (err) {
          logger.warn('Instantly capacity check failed', { error: err.message });
        }

        // Upload leads
        instantlyResult = await syncLeadsToInstantly(enrichedContacts);
        job.stats.instantlyUploaded = instantlyResult.uploaded;
        job.stats.instantlyCached = instantlyResult.cached;
        job.stats.instantlyFailed = instantlyResult.failed;
        await updateJob(job.id, { stats: { ...job.stats } });
      } catch (err) {
        logger.warn('Instantly upload failed, CSVs still available', { error: err.message });
      }
    }

    // Step 9: Notify Slack
    const blocks = formatPipelineComplete(job.id, vertical.label, job.stats);
    if (instantlyResult) {
      blocks.push({ type: 'divider' });
      blocks.push(...formatInstantlyUpload(instantlyResult, capacityReport));
    }
    await notifySlack(`Lead pipeline complete: ${vertical.label}`, blocks);

    await completeJob(job.id, job.stats, gcsUris);

    logger.info('Pipeline complete', {
      jobId: job.id,
      vertical: verticalKey,
      stats: job.stats,
    });

    return job;
  } catch (err) {
    logger.error('Pipeline failed', {
      jobId: job.id,
      vertical: verticalKey,
      error: err.message,
    });
    await failJob(job.id, err.message);
    throw err;
  }
}

/**
 * Run the pipeline for all verticals.
 *
 * @param {Array<string>|null} cityNames - Specific cities, or null for all
 * @returns {object} - Job result
 */
export async function runAllVerticalsPipeline(cityNames = null) {
  const verticals = Object.entries(VERTICALS).map(([key, v]) => ({ key, ...v }));

  const job = await createJob('all', { verticals: verticals.map((v) => v.key) });

  logger.info('All-verticals pipeline started', { jobId: job.id, verticals: verticals.length });

  const results = [];

  for (const v of verticals) {
    try {
      const result = await runVerticalPipeline(v.key, cityNames);
      results.push(result);
    } catch (err) {
      logger.error('Vertical pipeline failed in tier run', {
        vertical: v.key,
        error: err.message,
      });
      job.errors.push(`${v.key}: ${err.message}`);
    }
  }

  // Aggregate stats
  const totalStats = results.reduce(
    (acc, r) => ({
      scraped: acc.scraped + r.stats.scraped,
      enriched: acc.enriched + r.stats.enriched,
      verified: acc.verified + r.stats.verified,
      exported: acc.exported + r.stats.exported,
    }),
    { scraped: 0, enriched: 0, verified: 0, exported: 0 }
  );

  await completeJob(job.id, totalStats);
  logger.info('All-verticals pipeline complete', { jobId: job.id, stats: totalStats });

  return job;
}
