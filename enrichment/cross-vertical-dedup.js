/**
 * Cross-vertical dedup ledger (Postgres + SQLite, dual-driver).
 *
 * Persistent store that records every business that has been seen by any
 * vertical run, keyed by domain (preferred) or normalized name. Each
 * subsequent run for any vertical can filter out businesses already
 * claimed by an earlier vertical, preventing the same company from
 * receiving outreach as if it were three different leads (e.g. an IT
 * services firm showing up in MSP, SaaS, and technology).
 *
 * Backend selection:
 *   - If DATABASE_URL is set (Railway, Cloud Run with Cloud SQL, etc.),
 *     uses Postgres so cross-vertical state survives ephemeral
 *     filesystem redeploys.
 *   - Otherwise, falls back to local SQLite at ./output/dedup-ledger.db.
 *
 * All exported functions are async to accommodate both backends. Tests
 * force SQLite ':memory:' via configureLedger() regardless of env so they
 * stay isolated and don't require a running Postgres.
 *
 * Two-pass usage from the orchestrator:
 *   1. After in-vertical dedup — filter by normalized name (cheap)
 *   2. After domain resolution — filter by domain (catches more dupes
 *      that had different name spellings across directories)
 *
 * The ledger is keyed by the FIRST vertical that claimed a business; later
 * verticals are reported back as duplicates with that vertical's identity
 * so callers can decide whether to skip, reroute, or audit.
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../services/logger.js';

const DEFAULT_SQLITE_PATH = './output/dedup-ledger.db';

let _driver = null; // { type: 'sqlite' | 'pg', sqlite?: Database, pool?: pg.Pool, dbPath?, pgUrl? }
let _initPromise = null;

/**
 * Override which backend the ledger uses. Pass { sqlitePath: ':memory:' }
 * in tests to bypass DATABASE_URL detection. Closes any existing driver
 * first so subsequent calls re-initialize cleanly.
 */
export async function configureLedger({ sqlitePath = null, pgUrl = null } = {}) {
  await closeLedgerDb();
  if (sqlitePath) {
    _driver = { type: 'sqlite', dbPath: sqlitePath };
  } else if (pgUrl) {
    _driver = { type: 'pg', pgUrl };
  } else {
    _driver = null; // Re-detect from env on next access
  }
}

/**
 * Open (or reuse) the dedup ledger driver. Idempotent and lazy — first
 * call performs migrations.
 */
export async function getLedger() {
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
        // Railway Postgres requires SSL; the connection string usually
        // includes it, but be explicit so connections don't hang on the
        // wrong default for self-hosted Postgres without SSL.
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

/** Close the ledger driver. Used by tests and graceful shutdown. */
export async function closeLedgerDb() {
  if (!_driver) return;
  try {
    if (_driver.sqlite) _driver.sqlite.close();
    if (_driver.pool) await _driver.pool.end();
  } finally {
    _driver = null;
  }
}

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS business_ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key       TEXT NOT NULL UNIQUE,
    key_type        TEXT NOT NULL,
    business_name   TEXT,
    domain          TEXT,
    first_vertical  TEXT NOT NULL,
    first_seen      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_vertical ON business_ledger(first_vertical);
  CREATE INDEX IF NOT EXISTS idx_ledger_domain   ON business_ledger(domain);
  CREATE INDEX IF NOT EXISTS idx_ledger_seen     ON business_ledger(first_seen);
`;

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS business_ledger (
    id              BIGSERIAL PRIMARY KEY,
    dedup_key       TEXT NOT NULL UNIQUE,
    key_type        TEXT NOT NULL,
    business_name   TEXT,
    domain          TEXT,
    first_vertical  TEXT NOT NULL,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_vertical ON business_ledger(first_vertical);
  CREATE INDEX IF NOT EXISTS idx_ledger_domain   ON business_ledger(domain);
  CREATE INDEX IF NOT EXISTS idx_ledger_seen     ON business_ledger(first_seen);
`;

/**
 * Normalize a business name for dedup comparison.
 * Mirrors enrichment/dedup.js so name-based keys stay consistent.
 */
export function normalizeName(name) {
  if (!name) return null;
  const norm = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 50);
  return norm.length > 0 ? norm : null;
}

/**
 * Build a dedup key for a business. Prefers domain over name so that two
 * directories listing the same company under slightly different names still
 * collapse once we have the domain.
 *
 * @returns {{ key: string, keyType: 'domain' | 'name' } | null}
 */
export function buildDedupKey(business) {
  if (business?.domain) {
    const d = String(business.domain).trim().toLowerCase();
    if (d) return { key: `domain:${d}`, keyType: 'domain' };
  }
  const norm = normalizeName(business?.name);
  if (norm) return { key: `name:${norm}`, keyType: 'name' };
  return null;
}

// ── Driver-specific helpers ──────────────────────────────────────────────

/**
 * Insert a single ledger row. Returns the inserted-or-existing row plus a
 * `wasNew` flag. Both backends use ON CONFLICT semantics so this is safe
 * under concurrent writers.
 */
async function insertOrLookup(driver, key, keyType, name, domain, vertical) {
  if (driver.type === 'sqlite') {
    const insert = driver.sqlite.prepare(
      `INSERT OR IGNORE INTO business_ledger
         (dedup_key, key_type, business_name, domain, first_vertical)
       VALUES (?, ?, ?, ?, ?)`
    );
    const info = insert.run(key, keyType, name, domain, vertical);
    if (info.changes > 0) {
      return { wasNew: true };
    }
    const row = driver.sqlite
      .prepare(
        `SELECT first_vertical, first_seen, key_type FROM business_ledger WHERE dedup_key = ?`
      )
      .get(key);
    return {
      wasNew: false,
      firstVertical: row.first_vertical,
      firstSeen: row.first_seen,
      keyType: row.key_type,
    };
  }

  // Postgres: ON CONFLICT DO NOTHING returns no row when there's a conflict;
  // we fetch the existing row in that case.
  const ins = await driver.pool.query(
    `INSERT INTO business_ledger
       (dedup_key, key_type, business_name, domain, first_vertical)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [key, keyType, name, domain, vertical]
  );
  if (ins.rowCount > 0) {
    return { wasNew: true };
  }
  const sel = await driver.pool.query(
    `SELECT first_vertical, first_seen, key_type FROM business_ledger WHERE dedup_key = $1`,
    [key]
  );
  const row = sel.rows[0];
  return {
    wasNew: false,
    firstVertical: row.first_vertical,
    firstSeen:
      row.first_seen instanceof Date ? row.first_seen.toISOString() : row.first_seen,
    keyType: row.key_type,
  };
}

async function lookupByKey(driver, key) {
  if (driver.type === 'sqlite') {
    return (
      driver.sqlite
        .prepare(
          `SELECT dedup_key, key_type, business_name, domain, first_vertical, first_seen
           FROM business_ledger WHERE dedup_key = ?`
        )
        .get(key) || null
    );
  }
  const res = await driver.pool.query(
    `SELECT dedup_key, key_type, business_name, domain, first_vertical, first_seen
     FROM business_ledger WHERE dedup_key = $1`,
    [key]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    ...row,
    first_seen: row.first_seen instanceof Date ? row.first_seen.toISOString() : row.first_seen,
  };
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Filter a list of businesses against the cross-vertical ledger.
 * Records the fresh ones atomically so that two parallel runs don't both
 * claim the same business as "new" — ON CONFLICT DO NOTHING on the unique
 * key makes the first writer win.
 *
 * Businesses with no usable key (no domain AND no name) pass through as
 * skipped (neither fresh nor duplicate), since we have no way to tell
 * whether they're a dupe.
 *
 * @param {Array<object>} businesses
 * @param {string} verticalKey - The vertical attempting to claim them.
 * @param {object} [options]
 * @param {boolean} [options.commit=true] - When false, returns dedup
 *   decisions without writing to the ledger (useful for dry-runs).
 * @returns {Promise<{
 *   fresh: Array<object>,
 *   duplicates: Array<{ business: object, firstVertical: string, firstSeen: string, keyType: string }>,
 *   skipped: Array<object>
 * }>}
 */
export async function filterCrossVertical(businesses, verticalKey, options = {}) {
  const { commit = true } = options;
  if (!verticalKey) throw new Error('filterCrossVertical: verticalKey is required');
  const driver = await getLedger();

  const fresh = [];
  const duplicates = [];
  const skipped = [];

  for (const biz of businesses) {
    const k = buildDedupKey(biz);
    if (!k) {
      skipped.push(biz);
      continue;
    }

    if (commit) {
      const result = await insertOrLookup(
        driver,
        k.key,
        k.keyType,
        biz.name || null,
        biz.domain || null,
        verticalKey
      );
      if (result.wasNew) {
        fresh.push(biz);
      } else {
        duplicates.push({
          business: biz,
          firstVertical: result.firstVertical,
          firstSeen: result.firstSeen,
          keyType: result.keyType,
        });
      }
    } else {
      const existing = await lookupByKey(driver, k.key);
      if (existing) {
        duplicates.push({
          business: biz,
          firstVertical: existing.first_vertical,
          firstSeen: existing.first_seen,
          keyType: existing.key_type,
        });
      } else {
        fresh.push(biz);
      }
    }
  }

  if (duplicates.length > 0 || skipped.length > 0) {
    logger.info('Cross-vertical dedup', {
      vertical: verticalKey,
      input: businesses.length,
      fresh: fresh.length,
      duplicates: duplicates.length,
      skipped: skipped.length,
      committed: commit,
      backend: driver.type,
    });
  }

  return { fresh, duplicates, skipped };
}

/**
 * Record a batch of businesses as belonging to a vertical without filtering.
 * Use when you've already accepted the businesses and just want to mark them
 * claimed (e.g. backfilling from earlier exports).
 *
 * @returns {Promise<{ inserted: number, alreadyClaimed: number, skipped: number }>}
 */
export async function recordBusinesses(businesses, verticalKey) {
  if (!verticalKey) throw new Error('recordBusinesses: verticalKey is required');
  const driver = await getLedger();

  let inserted = 0;
  let alreadyClaimed = 0;
  let skipped = 0;

  for (const biz of businesses) {
    const k = buildDedupKey(biz);
    if (!k) {
      skipped++;
      continue;
    }
    const result = await insertOrLookup(
      driver,
      k.key,
      k.keyType,
      biz.name || null,
      biz.domain || null,
      verticalKey
    );
    if (result.wasNew) inserted++;
    else alreadyClaimed++;
  }

  return { inserted, alreadyClaimed, skipped };
}

/**
 * Return a row from the ledger for a given business, or null if not present.
 */
export async function lookupBusiness(business) {
  const k = buildDedupKey(business);
  if (!k) return null;
  const driver = await getLedger();
  return lookupByKey(driver, k.key);
}

/**
 * Counts of ledger contents, optionally scoped to a vertical.
 */
export async function getDedupStats(verticalKey = null) {
  const driver = await getLedger();
  const stats = { total: 0, byKeyType: {} };

  if (driver.type === 'sqlite') {
    const params = verticalKey ? [verticalKey] : [];
    const where = verticalKey ? 'WHERE first_vertical = ?' : '';
    stats.total = driver.sqlite
      .prepare(`SELECT COUNT(*) as n FROM business_ledger ${where}`)
      .get(...params).n;
    const byKeyType = driver.sqlite
      .prepare(
        `SELECT key_type, COUNT(*) as n FROM business_ledger ${where} GROUP BY key_type`
      )
      .all(...params);
    for (const row of byKeyType) stats.byKeyType[row.key_type] = row.n;
    if (!verticalKey) {
      stats.byVertical = {};
      const rows = driver.sqlite
        .prepare(
          `SELECT first_vertical, COUNT(*) as n FROM business_ledger GROUP BY first_vertical`
        )
        .all();
      for (const row of rows) stats.byVertical[row.first_vertical] = row.n;
    }
    return stats;
  }

  const params = verticalKey ? [verticalKey] : [];
  const where = verticalKey ? 'WHERE first_vertical = $1' : '';
  const totalRes = await driver.pool.query(
    `SELECT COUNT(*)::int as n FROM business_ledger ${where}`,
    params
  );
  stats.total = totalRes.rows[0].n;
  const byKeyTypeRes = await driver.pool.query(
    `SELECT key_type, COUNT(*)::int as n FROM business_ledger ${where} GROUP BY key_type`,
    params
  );
  for (const row of byKeyTypeRes.rows) stats.byKeyType[row.key_type] = row.n;
  if (!verticalKey) {
    stats.byVertical = {};
    const rows = await driver.pool.query(
      `SELECT first_vertical, COUNT(*)::int as n FROM business_ledger GROUP BY first_vertical`
    );
    for (const row of rows.rows) stats.byVertical[row.first_vertical] = row.n;
  }
  return stats;
}

/**
 * Wipe all ledger entries. Tests and operational reset only.
 */
export async function resetLedger() {
  const driver = await getLedger();
  if (driver.type === 'sqlite') {
    driver.sqlite.exec(`DELETE FROM business_ledger;`);
  } else {
    await driver.pool.query(`TRUNCATE TABLE business_ledger;`);
  }
}

/**
 * Backwards-compatibility shim for the previous sync API. Tests that
 * still call getLedgerDb(':memory:') get redirected to configureLedger.
 *
 * @deprecated use configureLedger() + getLedger() instead.
 */
export function getLedgerDb(dbPath = DEFAULT_SQLITE_PATH) {
  // Synchronous compatibility helper: reconfigure to SQLite at the given
  // path. Returns nothing useful — callers should switch to configureLedger.
  // Fire-and-forget; getLedger() will lazily initialize on next API call.
  configureLedger({ sqlitePath: dbPath });
}
