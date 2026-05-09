/**
 * Cross-vertical dedup ledger.
 *
 * Persistent SQLite store that records every business that has been seen
 * by any vertical run, keyed by domain (preferred) or normalized name. Each
 * subsequent run for any vertical can filter out businesses already claimed
 * by an earlier vertical, preventing the same company from receiving
 * outreach as if it were three different leads (e.g. an IT services firm
 * showing up in MSP, SaaS, and technology).
 *
 * Two-pass usage from the orchestrator:
 *   1. After in-vertical dedup — filter by normalized name (cheap)
 *   2. After domain resolution — filter by domain (catches more dupes that
 *      had different name spellings across directories)
 *
 * The ledger is keyed by the FIRST vertical that claimed a business; later
 * verticals are reported back as duplicates with that vertical's identity
 * so callers can decide whether to skip, reroute, or audit.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../services/logger.js';

const DEFAULT_DB_PATH = './output/dedup-ledger.db';

let _db = null;
let _dbPath = null;

/**
 * Open (or create) the dedup ledger DB. Singleton per path.
 *
 * @param {string} [dbPath] - Override DB path; ":memory:" for tests.
 * @returns {Database.Database}
 */
export function getLedgerDb(dbPath = DEFAULT_DB_PATH) {
  if (_db && _dbPath === dbPath) return _db;
  if (_db) {
    _db.close();
    _db = null;
  }

  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _dbPath = dbPath;

  migrate(_db);
  return _db;
}

/** Close the ledger DB. Used by tests and graceful shutdown. */
export function closeLedgerDb() {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

function migrate(db) {
  db.exec(`
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
  `);
}

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

/**
 * Filter a list of businesses against the cross-vertical ledger.
 * Records the fresh ones atomically so that two parallel runs don't both
 * claim the same business as "new" — INSERT OR IGNORE on the unique key
 * makes the first writer win.
 *
 * Businesses with no usable key (no domain AND no name) pass through as
 * fresh, since we have no way to tell whether they're a dupe.
 *
 * @param {Array<object>} businesses
 * @param {string} verticalKey - The vertical attempting to claim them.
 * @param {object} [options]
 * @param {boolean} [options.commit=true] - When false, returns dedup
 *   decisions without writing to the ledger (useful for dry-runs).
 * @returns {{
 *   fresh: Array<object>,
 *   duplicates: Array<{ business: object, firstVertical: string, firstSeen: string, keyType: string }>,
 *   skipped: Array<object>
 * }}
 */
export function filterCrossVertical(businesses, verticalKey, options = {}) {
  const { commit = true } = options;
  if (!verticalKey) throw new Error('filterCrossVertical: verticalKey is required');

  const db = getLedgerDb();

  const fresh = [];
  const duplicates = [];
  const skipped = [];

  const lookup = db.prepare(
    `SELECT first_vertical, first_seen, key_type FROM business_ledger WHERE dedup_key = ?`
  );
  const insert = db.prepare(`
    INSERT OR IGNORE INTO business_ledger
      (dedup_key, key_type, business_name, domain, first_vertical)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((batch) => {
    for (const biz of batch) {
      const k = buildDedupKey(biz);
      if (!k) {
        skipped.push(biz);
        continue;
      }

      if (commit) {
        const info = insert.run(k.key, k.keyType, biz.name || null, biz.domain || null, verticalKey);
        if (info.changes > 0) {
          fresh.push(biz);
        } else {
          const existing = lookup.get(k.key);
          duplicates.push({
            business: biz,
            firstVertical: existing.first_vertical,
            firstSeen: existing.first_seen,
            keyType: existing.key_type,
          });
        }
      } else {
        const existing = lookup.get(k.key);
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
  });

  tx(businesses);

  if (duplicates.length > 0 || skipped.length > 0) {
    logger.info('Cross-vertical dedup', {
      vertical: verticalKey,
      input: businesses.length,
      fresh: fresh.length,
      duplicates: duplicates.length,
      skipped: skipped.length,
      committed: commit,
    });
  }

  return { fresh, duplicates, skipped };
}

/**
 * Record a batch of businesses as belonging to a vertical without filtering.
 * Use when you've already accepted the businesses and just want to mark them
 * claimed (e.g. backfilling from earlier exports).
 *
 * @returns {{ inserted: number, alreadyClaimed: number, skipped: number }}
 */
export function recordBusinesses(businesses, verticalKey) {
  if (!verticalKey) throw new Error('recordBusinesses: verticalKey is required');
  const db = getLedgerDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO business_ledger
      (dedup_key, key_type, business_name, domain, first_vertical)
    VALUES (?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let alreadyClaimed = 0;
  let skipped = 0;

  const tx = db.transaction((batch) => {
    for (const biz of batch) {
      const k = buildDedupKey(biz);
      if (!k) {
        skipped++;
        continue;
      }
      const info = insert.run(k.key, k.keyType, biz.name || null, biz.domain || null, verticalKey);
      if (info.changes > 0) inserted++;
      else alreadyClaimed++;
    }
  });
  tx(businesses);

  return { inserted, alreadyClaimed, skipped };
}

/**
 * Return a row from the ledger for a given business, or null if not present.
 */
export function lookupBusiness(business) {
  const k = buildDedupKey(business);
  if (!k) return null;
  const db = getLedgerDb();
  const row = db
    .prepare(
      `SELECT dedup_key, key_type, business_name, domain, first_vertical, first_seen
       FROM business_ledger WHERE dedup_key = ?`
    )
    .get(k.key);
  return row || null;
}

/**
 * Counts of ledger contents, optionally scoped to a vertical.
 */
export function getDedupStats(verticalKey = null) {
  const db = getLedgerDb();
  const params = verticalKey ? [verticalKey] : [];
  const where = verticalKey ? 'WHERE first_vertical = ?' : '';

  const total = db.prepare(`SELECT COUNT(*) as n FROM business_ledger ${where}`).get(...params).n;
  const byKeyType = db
    .prepare(
      `SELECT key_type, COUNT(*) as n FROM business_ledger ${where} GROUP BY key_type`
    )
    .all(...params);

  const stats = { total, byKeyType: {} };
  for (const row of byKeyType) stats.byKeyType[row.key_type] = row.n;

  if (!verticalKey) {
    stats.byVertical = {};
    const rows = db
      .prepare(`SELECT first_vertical, COUNT(*) as n FROM business_ledger GROUP BY first_vertical`)
      .all();
    for (const row of rows) stats.byVertical[row.first_vertical] = row.n;
  }

  return stats;
}

/**
 * Wipe all ledger entries. Tests and operational reset only.
 */
export function resetLedger() {
  const db = getLedgerDb();
  db.exec(`DELETE FROM business_ledger;`);
}
