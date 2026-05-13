import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  configureJobTracker,
  closeJobTracker,
  createJob,
  getJob,
  updateJob,
  completeJob,
  failJob,
  listJobs,
  resetJobs,
} from '../pipeline/job-tracker.js';

// Force SQLite ':memory:' for tests so the suite is isolated, doesn't
// touch ./output/jobs.db on disk, and doesn't require a running Postgres
// even if DATABASE_URL is set in the environment.
function setupFreshTracker() {
  beforeEach(async () => {
    await configureJobTracker({ sqlitePath: ':memory:' });
    await resetJobs();
  });

  afterEach(async () => {
    await closeJobTracker();
  });
}

describe('createJob', () => {
  setupFreshTracker();

  it('creates a running job with default stats', async () => {
    const job = await createJob('vertical', { vertical: 'msp' });
    assert.equal(job.type, 'vertical');
    assert.equal(job.status, 'running');
    assert.equal(job.completedAt, null);
    assert.deepEqual(job.params, { vertical: 'msp' });
    assert.deepEqual(job.errors, []);
    assert.deepEqual(job.outputFiles, []);
    assert.equal(job.stats.scraped, 0);
    assert.match(job.id, /^[0-9a-f]{8}$/);
    assert.match(job.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('persists the job so getJob returns it', async () => {
    const created = await createJob('all', { verticals: ['msp', 'saas'] });
    const fetched = await getJob(created.id);
    assert.deepEqual(fetched.params, { verticals: ['msp', 'saas'] });
    assert.equal(fetched.id, created.id);
  });
});

describe('getJob', () => {
  setupFreshTracker();

  it('returns null for an unknown id', async () => {
    assert.equal(await getJob('deadbeef'), null);
  });
});

describe('updateJob', () => {
  setupFreshTracker();

  it('merges partial updates without losing other fields', async () => {
    const job = await createJob('vertical', { vertical: 'msp' });
    const updated = await updateJob(job.id, { stats: { scraped: 100 } });
    assert.equal(updated.stats.scraped, 100);
    assert.equal(updated.status, 'running'); // untouched
    assert.deepEqual(updated.params, { vertical: 'msp' }); // untouched

    const second = await updateJob(job.id, { status: 'paused' });
    assert.equal(second.status, 'paused');
    assert.equal(second.stats.scraped, 100); // preserved
  });

  it('returns the current row when no fields are provided', async () => {
    const job = await createJob('vertical', { vertical: 'msp' });
    const same = await updateJob(job.id, {});
    assert.equal(same.id, job.id);
    assert.equal(same.status, 'running');
  });
});

describe('completeJob', () => {
  setupFreshTracker();

  it('marks the job completed, sets completedAt, and stores outputFiles', async () => {
    const job = await createJob('vertical', { vertical: 'dental' });
    const stats = { scraped: 100, enriched: 80, verified: 60, exported: 60 };
    const completed = await completeJob(job.id, stats, ['gs://bucket/dental.csv']);
    assert.equal(completed.status, 'completed');
    assert.match(completed.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(completed.stats, stats);
    assert.deepEqual(completed.outputFiles, ['gs://bucket/dental.csv']);
  });

  it('falls back to default stats when none are provided', async () => {
    const job = await createJob('vertical', {});
    const completed = await completeJob(job.id, null, []);
    assert.equal(completed.stats.scraped, 0);
  });
});

describe('failJob', () => {
  setupFreshTracker();

  it('marks the job failed and appends the error message', async () => {
    const job = await createJob('vertical', { vertical: 'msp' });
    const failed = await failJob(job.id, 'Apollo rate limit');
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.errors, ['Apollo rate limit']);
    assert.match(failed.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends rather than replacing existing errors', async () => {
    const job = await createJob('vertical', {});
    await updateJob(job.id, { errors: ['initial scrape warning'] });
    const failed = await failJob(job.id, 'final crash');
    assert.deepEqual(failed.errors, ['initial scrape warning', 'final crash']);
  });

  it('returns null for an unknown job id', async () => {
    assert.equal(await failJob('deadbeef', 'x'), null);
  });

  it('coerces a non-array errors payload back to [] (defensive)', async () => {
    // Regression: a JSONB column on Postgres can end up holding `{}`
    // (empty object) when the pg driver mis-coerces a JS array. After
    // that, failJob's spread `[...(job.errors ?? []), msg]` would crash
    // with "(...) is not iterable". rowToJob now normalises to [].
    const job = await createJob('vertical', {});
    await updateJob(job.id, { errors: {} });
    const fetched = await getJob(job.id);
    assert.deepEqual(fetched.errors, []);

    const failed = await failJob(job.id, 'after malformed state');
    assert.deepEqual(failed.errors, ['after malformed state']);
  });
});

describe('listJobs', () => {
  setupFreshTracker();

  it('returns jobs newest first', async () => {
    const j1 = await createJob('vertical', { vertical: 'msp' });
    // Force a millisecond gap so the started_at strings sort correctly.
    await new Promise((r) => setTimeout(r, 5));
    const j2 = await createJob('vertical', { vertical: 'saas' });

    const list = await listJobs();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, j2.id);
    assert.equal(list[1].id, j1.id);
  });

  it('respects the limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await createJob('vertical', { i });
      await new Promise((r) => setTimeout(r, 2));
    }
    const list = await listJobs({ limit: 2 });
    assert.equal(list.length, 2);
  });

  it('returns an empty array when there are no jobs', async () => {
    const list = await listJobs();
    assert.deepEqual(list, []);
  });
});

describe('resetJobs', () => {
  setupFreshTracker();

  it('removes all jobs', async () => {
    await createJob('vertical', { vertical: 'msp' });
    await createJob('vertical', { vertical: 'saas' });
    await resetJobs();
    assert.deepEqual(await listJobs(), []);
  });
});
