import { randomUUID } from 'crypto';

const jobs = new Map();

export function createJob(type, params) {
  const id = randomUUID().slice(0, 8);
  const job = {
    id,
    type,
    params,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    stats: { scraped: 0, enriched: 0, verified: 0, exported: 0 },
    errors: [],
    outputFiles: [],
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, updates);
  return job;
}

export function completeJob(id, stats, outputFiles = []) {
  return updateJob(id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    stats,
    outputFiles,
  });
}

export function failJob(id, error) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'failed';
  job.completedAt = new Date().toISOString();
  job.errors.push(error);
  return job;
}

export function listJobs() {
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.startedAt) - new Date(a.startedAt)
  );
}
