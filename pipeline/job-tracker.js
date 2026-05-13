/**
 * Job tracker (Postgres + SQLite, dual-driver).
 *
 * Records every pipeline run with its lifecycle status, stats, errors, and
 * output file URIs. Persistent so that job history survives server
 * restarts on Railway / Cloud Run (the previous in-memory Map lost
 * everything on redeploy).
 *
 * Backend selection mirrors the cross-vertical dedup ledger:
 *   - DATABASE_URL set → Postgres
 *   - otherwise → SQLite at ./output/jobs.db
 *
 * All functions are async. Tests force SQLite ':memory:' via
 * configureJobTracker() so they don't require a running Postgres.
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../services/logger.js';

const DEFAULT_SQLITE_PATH = './output/jobs.db';

let _driver = null;
let _initPromise = null;

/**
 * Override which backend the tracker uses. Pass { sqlitePath: ':memory:' }
 * in tests to bypass DATABASE_URL detection. Closes any existing driver
 * first so subsequent calls re-initialize cleanly.
 */
export async function configureJobTracker({ sqlitePath = null, pgUrl = null } = {}) {
  await closeJobTracker();
  if (sqlitePath) {
    _driver = { type: 'sqlite', dbPath: sqlitePath };
  } else if (pgUrl) {
    _driver = { type: 'pg', pgUrl };
  } else {
    _driver = null; // Re-detect from env on next access
  }
}

/** Open (or reuse) the job tracker driver. Idempotent and lazy. */
export async function getJobTracker() {
  if (_driver?.sqlite || _driver?.pool) return _driver;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    if (!_driver) {
      const pgUrl = process.env.DATABASE_URL;
      _driver = pgUrl
        ? { type: 'pg', pgUrl }
        : { type: 'sqlite', dbPath: DEFAULT_SQLITE_PATH };
    }

    if (_driver.type === 'sqlite') {
      const dbPath = _driver.dbPath;
      if (dbPath !== ':memory:') {
        const dir = dirname(dbPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      }
      const sqlite = new Database(dbPath);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('synchronous = NORMAL');
      sqlite.exec(SQLITE_SCHEMA);
      _driver.sqlite = sqlite;
    } else {
      const pool = new pg.Pool({
        connectionString: _driver.pgUrl,
        ssl: _driver.pgUrl.includes('sslmode=disable')
          ? false
          : { rejectUnauthorized: false },
      });
      const client = await pool.connect();
      try {
        await client.query(PG_SCHEMA);
      } finally {
        client.release();
      }
      _driver.pool = pool;
    }
    return _driver;
  })();

  try {
    return await _initPromise;
  } finally {
    _initPromise = null;
  }
}

/** Close the tracker driver. Used by tests and graceful shutdown. */
export async function closeJobTracker() {
  if (!_driver) return;
  try {
    if (_driver.sqlite) _driver.sqlite.close();
    if (_driver.pool) await _driver.pool.end();
  } finally {
    _driver = null;
  }
}

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    params        TEXT,
    status        TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    completed_at  TEXT,
    stats         TEXT,
    errors        TEXT,
    output_files  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_started ON jobs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_type    ON jobs(type);
`;

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    params        JSONB,
    status        TEXT NOT NULL,
    started_at    TIMESTAMPTZ NOT NULL,
    completed_at  TIMESTAMPTZ,
    stats         JSONB,
    errors        JSONB,
    output_files  JSONB
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_started ON jobs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_type    ON jobs(type);
`;

// ── Row marshalling ──────────────────────────────────────────────────────

const DEFAULT_STATS = { scraped: 0, enriched: 0, verified: 0, exported: 0, warnings: [] };

function rowToJob(row, driverType) {
  if (!row) return null;
  // Postgres returns Date objects + parsed JSONB; SQLite returns strings + raw JSON text.
  const parse = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }
    return v;
  };
  return {
    id: row.id,
    type: row.type,
    params: parse(row.params) ?? {},
    status: row.status,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    completedAt:
      row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : row.completed_at || null,
    stats: parse(row.stats) ?? { ...DEFAULT_STATS },
    errors: parse(row.errors) ?? [],
    outputFiles: parse(row.output_files) ?? [],
  };
}

function serialize(driverType, value) {
  if (driverType === 'sqlite') return value == null ? null : JSON.stringify(value);
  // Postgres pg driver auto-stringifies objects passed to JSONB columns.
  return value ?? null;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Create a new job row. Returns the full job object.
 *
 * @param {string} type   - 'vertical' | 'all' | string
 * @param {object} params - Arbitrary parameters captured for audit.
 */
export async function createJob(type, params = {}) {
  const driver = await getJobTracker();
  const id = randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const stats = { ...DEFAULT_STATS };
  const errors = [];
  const outputFiles = [];

  if (driver.type === 'sqlite') {
    driver.sqlite
      .prepare(
        `INSERT INTO jobs (id, type, params, status, started_at, stats, errors, output_files)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`
      )
      .run(
        id,
        type,
        serialize('sqlite', params),
        startedAt,
        serialize('sqlite', stats),
        serialize('sqlite', errors),
        serialize('sqlite', outputFiles)
      );
  } else {
    await driver.pool.query(
      `INSERT INTO jobs (id, type, params, status, started_at, stats, errors, output_files)
       VALUES ($1, $2, $3, 'running', $4, $5, $6, $7)`,
      [id, type, params, startedAt, stats, errors, outputFiles]
    );
  }

  return {
    id,
    type,
    params,
    status: 'running',
    startedAt,
    completedAt: null,
    stats,
    errors,
    outputFiles,
  };
}

/** Fetch a job by ID, or null if not found. */
export async function getJob(id) {
  const driver = await getJobTracker();
  if (driver.type === 'sqlite') {
    const row = driver.sqlite.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
    return rowToJob(row, 'sqlite');
  }
  const res = await driver.pool.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return rowToJob(res.rows[0], 'pg');
}

/**
 * Apply a partial update to a job. Accepts the same shape that the old
 * in-memory tracker did: `{ status, stats, errors, outputFiles, completedAt }`.
 * Unknown fields are ignored.
 */
export async function updateJob(id, updates = {}) {
  const driver = await getJobTracker();
  const fields = [];
  const sqliteParams = [];
  const pgParams = [];

  const push = (col, val) => {
    fields.push(col);
    sqliteParams.push(val);
    pgParams.push(val);
  };

  if (updates.status !== undefined) push('status', updates.status);
  if (updates.completedAt !== undefined) push('completed_at', updates.completedAt);
  if (updates.stats !== undefined) {
    fields.push('stats');
    sqliteParams.push(serialize('sqlite', updates.stats));
    pgParams.push(updates.stats);
  }
  if (updates.errors !== undefined) {
    fields.push('errors');
    sqliteParams.push(serialize('sqlite', updates.errors));
    pgParams.push(updates.errors);
  }
  if (updates.outputFiles !== undefined) {
    fields.push('output_files');
    sqliteParams.push(serialize('sqlite', updates.outputFiles));
    pgParams.push(updates.outputFiles);
  }

  if (fields.length === 0) return getJob(id);

  if (driver.type === 'sqlite') {
    const setSql = fields.map((f) => `${f} = ?`).join(', ');
    driver.sqlite
      .prepare(`UPDATE jobs SET ${setSql} WHERE id = ?`)
      .run(...sqliteParams, id);
  } else {
    const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    await driver.pool.query(
      `UPDATE jobs SET ${setSql} WHERE id = $${fields.length + 1}`,
      [...pgParams, id]
    );
  }
  return getJob(id);
}

/** Mark a job as completed, replacing stats and recording outputFiles. */
export async function completeJob(id, stats, outputFiles = []) {
  return updateJob(id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    stats: stats ?? { ...DEFAULT_STATS },
    outputFiles,
  });
}

/** Mark a job as failed and append the error message. */
export async function failJob(id, error) {
  const job = await getJob(id);
  if (!job) return null;
  const errors = [...(job.errors ?? []), error];
  return updateJob(id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    errors,
  });
}

/** List all jobs, newest first. Optional limit. */
export async function listJobs({ limit = 100 } = {}) {
  const driver = await getJobTracker();
  if (driver.type === 'sqlite') {
    const rows = driver.sqlite
      .prepare(`SELECT * FROM jobs ORDER BY started_at DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => rowToJob(r, 'sqlite'));
  }
  const res = await driver.pool.query(
    `SELECT * FROM jobs ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows.map((r) => rowToJob(r, 'pg'));
}

/** Wipe all jobs. Tests and operational reset only. */
export async function resetJobs() {
  const driver = await getJobTracker();
  if (driver.type === 'sqlite') {
    driver.sqlite.exec(`DELETE FROM jobs;`);
  } else {
    await driver.pool.query(`TRUNCATE TABLE jobs;`);
  }
}
