import express from 'express';
import { runVerticalPipeline, runAllVerticalsPipeline } from './pipeline/orchestrator.js';
import { batchPeopleSearch } from './enrichment/apollo-people-search.js';
import { getVertical } from './config/verticals.js';
import { getJob, listJobs } from './pipeline/job-tracker.js';
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

  // Start pipeline in background (202 pattern)
  const jobPromise = runVerticalPipeline(vertical, cities || null);

  // Wait briefly to get the job ID from the tracker
  jobPromise.catch((err) => {
    logger.error('Background vertical pipeline failed', {
      vertical,
      error: err.message,
    });
  });

  // Return 202 immediately — job ID will be available from /status
  // We need a slight delay to let createJob() run
  setTimeout(() => {
    const jobs = listJobs();
    const latestJob = jobs.find(
      (j) => j.type === 'vertical' && j.params.vertical === vertical && j.status === 'running'
    );
    // Response may have already been sent; this is fire-and-forget logging
    if (latestJob) {
      logger.info('Job started', { jobId: latestJob.id });
    }
  }, 100);

  res.status(202).json({
    message: `Pipeline started for vertical: ${vertical}`,
    note: 'Use GET /status to check job progress. Jobs are listed at GET /jobs.',
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
app.get('/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// List all jobs
app.get('/jobs', (req, res) => {
  res.json(listJobs());
});

app.listen(PORT, () => {
  logger.info(`Lead pipeline server running on port ${PORT}`);
});
