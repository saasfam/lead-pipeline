import { getVertical, VERTICALS, landingPageFor } from '../config/verticals.js';
import { getCities } from '../config/cities.js';
import { runScrapersForVertical } from '../scrapers/scraper-registry.js';
import { resolveDomains } from '../enrichment/domain-resolver.js';
import { batchPeopleSearch } from '../enrichment/people-search.js';
import { verifyEmails } from '../enrichment/email-verify.js';
import { dedupBusinesses, dedupContacts } from '../enrichment/dedup.js';
import { filterCrossVertical } from '../enrichment/cross-vertical-dedup.js';
import { generateInstantlyCSV } from '../export/instantly-csv.js';
import { generatePhantomBusterCSV } from '../export/phantombuster-csv.js';
import { uploadMultipleToGCS } from '../export/gcs-upload.js';
import { syncLeadsToInstantly } from '../export/instantly-sync.js';
import { ensureCampaignForVertical } from '../export/instantly-campaign.js';
import { isConfigured as instantlyConfigured } from '../services/instantly.js';
import { provisionInboxes } from '../services/inbox-orderer.js';
import { generateMessagesForContacts } from './generate-messages.js';
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

    // Step 4: People search (Apollo by default, or Hunter waterfall when
    // PEOPLE_SEARCH_PROVIDER is set to hunter / hunter-then-apollo / auto).
    logger.info('Step 4: People search');
    const contacts = await batchPeopleSearch(businessesWithDomains, vertical, verticalKey);
    const uniqueContacts = dedupContacts(contacts);
    job.stats.enriched = uniqueContacts.length;
    await updateJob(job.id, { stats: { ...job.stats } });

    // Step 5: Verify emails
    logger.info('Step 5: Verifying emails');
    const verifiedContacts = await verifyEmails(uniqueContacts);
    job.stats.verified = verifiedContacts.length;
    await updateJob(job.id, { stats: { ...job.stats } });

    // Step 5b: Merge city/state from business data into contacts so the
    // message generator and CSV exporter both see them.
    const domainToBiz = new Map();
    for (const biz of withDomains) {
      if (biz.domain && !domainToBiz.has(biz.domain)) {
        domainToBiz.set(biz.domain, biz);
      }
    }
    const verifiedWithLocation = verifiedContacts.map((c) => {
      const biz = domainToBiz.get(c.companyDomain) || {};
      return {
        ...c,
        city: biz.city || '',
        state: biz.state || '',
        vertical: vertical.label,
        verticalKey,
        verticalLabel: vertical.label,
        landingPage: landingPageFor(verticalKey),
      };
    });

    // Step 5c: Generate personalized 4-step sequences. Without this step,
    // every lead ships with messageFlag != 'ready' and instantly-sync
    // filters it out — the previous orchestrator was silently dropping
    // every contact at the upload step.
    logger.info('Step 5c: Generating personalized sequences');
    const messageResult = await generateMessagesForContacts(
      verifiedWithLocation,
      vertical,
      verticalKey
    );
    const enrichedContacts = messageResult.leads;
    job.stats.messagesGenerated = messageResult.stats.generated;
    job.stats.messagesFailed = messageResult.stats.failed;
    job.stats.messagesSkipped = messageResult.stats.skipped;
    await updateJob(job.id, { stats: { ...job.stats } });

    // Step 6: Export CSVs
    logger.info('Step 6: Exporting CSVs');
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

    // Step 8: Provision inboxes + per-vertical campaign + upload leads.
    //
    // Per-vertical campaign: ensures one draft campaign per vertical per
    //   month in Instantly (idempotent by name). Campaigns stay in draft —
    //   Richard launches manually after review.
    // Inbox provisioning: if MESSAGES_MAX_PER_VERTICAL leads exceed warmed
    //   capacity, plan (and optionally order) DFY mailboxes. Order only
    //   when INSTANTLY_AUTO_ORDER=true AND a per-run cap is set.
    let instantlyResult = null;
    let capacityReport = null;
    let provisionResult = null;
    let campaignProvision = null;
    if (instantlyConfigured()) {
      // Capacity + maybe-order. Targets the per-vertical budget so we don't
      // over-order on small verticals.
      try {
        const target = parseInt(
          process.env.INSTANTLY_TARGET_DAILY_VOLUME_PER_VERTICAL
            || process.env.INSTANTLY_TARGET_DAILY_VOLUME
            || '500',
          10
        );
        provisionResult = await provisionInboxes({ targetDailyVolume: target });
        capacityReport = provisionResult.capacityReport;
        if (provisionResult.plan) {
          job.stats.inboxesNeeded = provisionResult.plan.mailboxesNeeded;
          job.stats.inboxesPlanned = provisionResult.plan.mailboxesPlanned;
          job.stats.inboxOrderSubmitted = !provisionResult.dryRun;
        }
      } catch (err) {
        logger.warn('Inbox provisioning failed (continuing)', { error: err.message });
      }

      // Create or reuse the per-vertical campaign (draft).
      try {
        campaignProvision = await ensureCampaignForVertical(verticalKey, {
          targetVolume: parseInt(
            process.env.INSTANTLY_TARGET_DAILY_VOLUME_PER_VERTICAL || '500',
            10
          ),
        });
        if (campaignProvision) {
          job.stats.campaignId = campaignProvision.campaignId;
          job.stats.campaignName = campaignProvision.campaignName;
          job.stats.campaignCreated = campaignProvision.created;
        }
      } catch (err) {
        logger.warn('Campaign provisioning failed (continuing with env-var fallback)', {
          error: err.message,
        });
      }

      // Upload leads to the per-vertical campaign. instantly-sync still
      // honors INSTANTLY_CAMPAIGN_ID as the env-var override; we pass the
      // provisioned ID explicitly to win when both are present.
      try {
        instantlyResult = await syncLeadsToInstantly(enrichedContacts, {
          campaignId: campaignProvision?.campaignId,
        });
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
