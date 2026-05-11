import express from 'express';
import { runVerticalPipeline, runAllVerticalsPipeline } from './pipeline/orchestrator.js';
import { batchPeopleSearch } from './enrichment/apollo-people-search.js';
import { getVertical, landingPageFor, VERTICALS } from './config/verticals.js';
import { getJob, listJobs } from './pipeline/job-tracker.js';
import { getDedupStats, getLedger } from './enrichment/cross-vertical-dedup.js';
import { provisionInboxes } from './services/inbox-orderer.js';
import { ensureCampaignForVertical } from './export/instantly-campaign.js';
import { logger } from './services/logger.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Scrape a single vertical
app.post('/scrape-vertical', (req, res) => {
  const { vertical, cities } = req.body;

  if (!vertical) {
    return res.status(400).json({ error: 'vertical is required' });
  }

  const verticalConfig = getVertical(vertical);
  if (!verticalConfig) {
    return res.status(400).json({ error: `Unknown vertical: ${vertical}` });
  }

  // Start pipeline in background (202 pattern). Errors are caught and
  // recorded on the job row by the orchestrator's failJob call; we still
  // log here so unhandled rejections never bubble to the process.
  runVerticalPipeline(vertical, cities || null).catch((err) => {
    logger.error('Background vertical pipeline failed', {
      vertical,
      error: err.message,
    });
  });

  res.status(202).json({
    message: `Pipeline started for vertical: ${vertical}`,
    note: 'Use GET /jobs to find the running job ID, then GET /status/:jobId for progress.',
  });
});

// Scrape all verticals
app.post('/scrape-all', (req, res) => {
  const { cities } = req.body;

  runAllVerticalsPipeline(cities || null).catch((err) => {
    logger.error('Background all-verticals pipeline failed', {
      error: err.message,
    });
  });

  res.status(202).json({
    message: 'Pipeline started for all 22 verticals',
    note: 'Use GET /jobs to check progress.',
  });
});

// Enrich specific domains via Apollo
app.post('/enrich-domains', async (req, res) => {
  const { domains, vertical } = req.body;

  if (!domains || !Array.isArray(domains) || domains.length === 0) {
    return res.status(400).json({ error: 'domains array is required' });
  }
  if (!vertical) {
    return res.status(400).json({ error: 'vertical is required for title filters' });
  }

  const verticalConfig = getVertical(vertical);
  if (!verticalConfig) {
    return res.status(400).json({ error: `Unknown vertical: ${vertical}` });
  }

  try {
    const businesses = domains.map((d) => ({ domain: d }));
    const contacts = await batchPeopleSearch(businesses, verticalConfig);
    res.json({ contacts, count: contacts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Job status
app.get('/status/:jobId', async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all jobs
app.get('/jobs', async (req, res) => {
  try {
    const jobs = await listJobs();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cross-vertical dedup stats. Read-only admin endpoint; also forces lazy
// ledger init so the backing table is created on demand without needing
// to run a full vertical pipeline first.
app.get('/dedup-stats', async (req, res) => {
  try {
    const driver = await getLedger();
    const stats = await getDedupStats(req.query.vertical || null);
    res.json({ backend: driver.type, ...stats });
  } catch (err) {
    logger.error('dedup-stats failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Inbox provisioning — checks Instantly capacity against a target volume,
// computes a DFY mailbox order plan, and (only when INSTANTLY_AUTO_ORDER=true
// AND INSTANTLY_MAX_MAILBOXES_PER_RUN > 0) submits the order. Safe to call
// repeatedly — read-only by default.
app.post('/provision-inboxes', async (req, res) => {
  try {
    const targetDailyVolume = req.body?.targetDailyVolume
      || parseInt(process.env.INSTANTLY_TARGET_DAILY_VOLUME || '5000', 10);
    const result = await provisionInboxes({ targetDailyVolume });
    res.json(result);
  } catch (err) {
    logger.error('Provision-inboxes failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Per-vertical campaign provisioning (idempotent). Useful for bringing a
// fresh Instantly campaign online without running the full scrape pipeline.
app.post('/provision-campaign', async (req, res) => {
  const { vertical } = req.body || {};
  if (!vertical) {
    return res.status(400).json({ error: 'vertical is required' });
  }
  if (!getVertical(vertical)) {
    return res.status(400).json({ error: `Unknown vertical: ${vertical}` });
  }
  try {
    const result = await ensureCampaignForVertical(vertical, {
      targetVolume: parseInt(
        process.env.INSTANTLY_TARGET_DAILY_VOLUME_PER_VERTICAL || '500',
        10
      ),
    });
    res.json(result);
  } catch (err) {
    logger.error('Provision-campaign failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// List configured verticals + their landing pages. Lets the front end (or
// Richard) sanity-check the landing-page mapping without reading the source.
app.get('/verticals', (req, res) => {
  const out = Object.entries(VERTICALS).map(([key, v]) => ({
    key,
    label: v.label,
    landingPage: landingPageFor(key),
    targetCount: v.targetCount,
    directories: v.directories,
  }));
  res.json(out);
});

app.listen(PORT, () => {
  logger.info(`Lead pipeline server running on port ${PORT}`);
});
