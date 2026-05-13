/**
 * SQLite master record store for nationwide dental pipeline.
 *
 * 3 tables: practices, contacts, sequences
 * Uses WAL mode for concurrent reads + fast writes.
 * Batch inserts via transactions for NPI bulk load.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const DEFAULT_DB_PATH = './output/nationwide.db';

let _db = null;

/** Open (or create) the database, returning the singleton instance. */
export function getDb(dbPath = DEFAULT_DB_PATH) {
  if (_db) return _db;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  migrate(_db);
  return _db;
}

/** Close the database cleanly. */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── Schema migration ────────────────────────────────────────────────────────

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS practices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      npi             TEXT UNIQUE,
      name            TEXT NOT NULL,
      name_normalized TEXT NOT NULL,
      first_name      TEXT,
      last_name       TEXT,
      credential      TEXT,
      specialty       TEXT,
      taxonomy_code   TEXT,
      address_line1   TEXT,
      address_line2   TEXT,
      city            TEXT,
      state           TEXT,
      zip             TEXT,
      phone           TEXT,
      domain          TEXT,
      domain_source   TEXT,
      website_scraped INTEGER DEFAULT 0,
      company_desc    TEXT,
      specialties_csv TEXT,
      year_founded    INTEGER,
      location_count  INTEGER,
      priority_tier   TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_practices_state ON practices(state);
    CREATE INDEX IF NOT EXISTS idx_practices_domain ON practices(domain);
    CREATE INDEX IF NOT EXISTS idx_practices_tier ON practices(priority_tier);
    CREATE INDEX IF NOT EXISTS idx_practices_name_norm ON practices(name_normalized, city, state);

    CREATE TABLE IF NOT EXISTS contacts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      practice_id     INTEGER NOT NULL REFERENCES practices(id),
      first_name      TEXT,
      last_name       TEXT,
      full_name       TEXT,
      title           TEXT,
      email           TEXT,
      email_source    TEXT,
      alternate_email TEXT,
      phone           TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_practice ON contacts(practice_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

    CREATE TABLE IF NOT EXISTS sequences (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id      INTEGER NOT NULL REFERENCES contacts(id),
      step1           TEXT,
      step2           TEXT,
      step3           TEXT,
      step4           TEXT,
      hook            TEXT,
      structure_id    INTEGER,
      opener_type     TEXT,
      flags_csv       TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sequences_contact ON sequences(contact_id);
  `);
}

// ── Practice CRUD ───────────────────────────────────────────────────────────

/** Normalize a practice name for dedup: lowercase, strip punctuation, collapse whitespace. */
export function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bulk-insert practices in a single transaction.
 * Skips rows whose NPI already exists (INSERT OR IGNORE).
 *
 * @param {Array<object>} rows - Array of practice objects
 * @returns {{ inserted: number, skipped: number }}
 */
export function bulkInsertPractices(rows) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO practices
      (npi, name, name_normalized, first_name, last_name, credential, specialty,
       taxonomy_code, address_line1, address_line2, city, state, zip, phone, priority_tier)
    VALUES
      (@npi, @name, @name_normalized, @first_name, @last_name, @credential, @specialty,
       @taxonomy_code, @address_line1, @address_line2, @city, @state, @zip, @phone, @priority_tier)
  `);

  let inserted = 0;
  let skipped = 0;

  const tx = db.transaction((batch) => {
    for (const row of batch) {
      const info = stmt.run(row);
      if (info.changes > 0) inserted++;
      else skipped++;
    }
  });

  // Process in chunks of 5,000 within transactions
  const CHUNK = 5_000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    tx(rows.slice(i, i + CHUNK));
  }

  return { inserted, skipped };
}

/** Update a practice's domain + source. */
export function updatePracticeDomain(practiceId, domain, source) {
  const db = getDb();
  db.prepare(`
    UPDATE practices SET domain = ?, domain_source = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(domain, source, practiceId);
}

/** Mark a practice as website-scraped and store extracted data. */
export function updatePracticeWebData(practiceId, { companyDesc, specialtiesCsv, yearFounded, locationCount }) {
  const db = getDb();
  db.prepare(`
    UPDATE practices SET
      website_scraped = 1,
      company_desc    = ?,
      specialties_csv = ?,
      year_founded    = ?,
      location_count  = ?,
      updated_at      = datetime('now')
    WHERE id = ?
  `).run(companyDesc || null, specialtiesCsv || null, yearFounded || null, locationCount || null, practiceId);
}

// ── Contact CRUD ────────────────────────────────────────────────────────────

/**
 * Insert contacts for a practice. Returns array of inserted contact IDs.
 */
export function insertContacts(practiceId, contacts) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO contacts (practice_id, first_name, last_name, full_name, title, email, email_source, alternate_email, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const ids = [];
  const tx = db.transaction(() => {
    for (const c of contacts) {
      const info = stmt.run(
        practiceId,
        c.firstName || c.first_name || null,
        c.lastName || c.last_name || null,
        c.fullName || c.full_name || null,
        c.title || null,
        c.email || null,
        c.emailSource || c.email_source || null,
        c.alternateEmail || c.alternate_email || null,
        c.phone || null
      );
      ids.push(info.lastInsertRowid);
    }
  });
  tx();
  return ids;
}

/** Update a contact's email fields. */
export function updateContactEmail(contactId, email, source, alternateEmail) {
  const db = getDb();
  db.prepare(`
    UPDATE contacts SET email = ?, email_source = ?, alternate_email = ?
    WHERE id = ?
  `).run(email, source, alternateEmail || null, contactId);
}

// ── Sequence CRUD ───────────────────────────────────────────────────────────

export function insertSequence(contactId, { step1, step2, step3, step4, hook, structureId, openerType, flagsCsv }) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO sequences (contact_id, step1, step2, step3, step4, hook, structure_id, opener_type, flags_csv)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(contactId, step1, step2, step3, step4, hook || null, structureId || null, openerType || null, flagsCsv || null);
}

// ── Gap queries (used by runner + --status) ─────────────────────────────────

export function gapStats(filters = {}) {
  const db = getDb();
  const where = buildWhereClause(filters);

  const total = db.prepare(`SELECT COUNT(*) as n FROM practices p ${where.sql}`).get(where.params).n;
  const withDomain = db.prepare(`SELECT COUNT(*) as n FROM practices p ${where.sql} ${where.sql ? 'AND' : 'WHERE'} p.domain IS NOT NULL`).get(where.params).n;
  const scraped = db.prepare(`SELECT COUNT(*) as n FROM practices p ${where.sql} ${where.sql ? 'AND' : 'WHERE'} p.website_scraped = 1`).get(where.params).n;

  const totalContacts = db.prepare(`
    SELECT COUNT(*) as n FROM contacts c
    JOIN practices p ON c.practice_id = p.id
    ${where.sql}
  `).get(where.params).n;

  const contactsWithEmail = db.prepare(`
    SELECT COUNT(*) as n FROM contacts c
    JOIN practices p ON c.practice_id = p.id
    ${where.sql} ${where.sql ? 'AND' : 'WHERE'} c.email IS NOT NULL
  `).get(where.params).n;

  const contactsWithSequence = db.prepare(`
    SELECT COUNT(*) as n FROM sequences s
    JOIN contacts c ON s.contact_id = c.id
    JOIN practices p ON c.practice_id = p.id
    ${where.sql}
  `).get(where.params).n;

  return {
    practices: { total, withDomain, withoutDomain: total - withDomain, scraped },
    contacts: { total: totalContacts, withEmail: contactsWithEmail, withoutEmail: totalContacts - contactsWithEmail, withSequence: contactsWithSequence },
  };
}

/** Fetch practices missing a domain (targets for layers 2-4). */
export function practicesMissingDomain(filters = {}, limit = 0) {
  const db = getDb();
  const where = buildWhereClause(filters, 'p.domain IS NULL');
  const limitSql = limit > 0 ? `LIMIT ${limit}` : '';
  return db.prepare(`SELECT p.* FROM practices p ${where.sql} ${limitSql}`).all(where.params);
}

/** Fetch practices with domain but not yet scraped (target for layer 5). */
export function practicesNeedingScrape(filters = {}, limit = 0) {
  const db = getDb();
  const where = buildWhereClause(filters, 'p.domain IS NOT NULL AND p.website_scraped = 0');
  const limitSql = limit > 0 ? `LIMIT ${limit}` : '';
  return db.prepare(`SELECT p.* FROM practices p ${where.sql} ${limitSql}`).all(where.params);
}

/** Fetch contacts missing email whose practice has a domain (target for layer 6). */
export function contactsMissingEmail(filters = {}, limit = 0) {
  const db = getDb();
  const where = buildWhereClause(filters);
  const extraWhere = `c.email IS NULL AND p.domain IS NOT NULL`;
  const combined = where.sql
    ? `${where.sql} AND ${extraWhere}`
    : `WHERE ${extraWhere}`;
  const limitSql = limit > 0 ? `LIMIT ${limit}` : '';
  return db.prepare(`
    SELECT c.*, p.domain, p.name as practice_name, p.city, p.state
    FROM contacts c
    JOIN practices p ON c.practice_id = p.id
    ${combined} ${limitSql}
  `).all(where.params);
}

/** Fetch contacts with email but no sequence row (target for layer 8). */
export function contactsNeedingSequence(filters = {}, limit = 0) {
  const db = getDb();
  const where = buildWhereClause(filters);
  const extraWhere = `c.email IS NOT NULL AND s.id IS NULL`;
  const combined = where.sql
    ? `${where.sql} AND ${extraWhere}`
    : `WHERE ${extraWhere}`;
  const limitSql = limit > 0 ? `LIMIT ${limit}` : '';
  return db.prepare(`
    SELECT c.*, p.domain, p.name as practice_name, p.company_desc,
           p.specialties_csv, p.year_founded, p.city, p.state, p.priority_tier
    FROM contacts c
    JOIN practices p ON c.practice_id = p.id
    LEFT JOIN sequences s ON s.contact_id = c.id
    ${combined} ${limitSql}
  `).all(where.params);
}

/** Fetch all contacts with email + sequence for export. */
export function contactsForExport(filters = {}) {
  const db = getDb();
  const where = buildWhereClause(filters);
  const extraWhere = `c.email IS NOT NULL AND s.id IS NOT NULL`;
  const combined = where.sql
    ? `${where.sql} AND ${extraWhere}`
    : `WHERE ${extraWhere}`;
  return db.prepare(`
    SELECT c.id as contact_id, c.first_name, c.last_name, c.full_name, c.title,
           c.email, c.alternate_email, c.phone as contact_phone,
           p.name as company_name, p.domain, p.city, p.state, p.phone as practice_phone,
           p.company_desc, p.specialties_csv, p.year_founded, p.priority_tier,
           s.step1, s.step2, s.step3, s.step4, s.hook, s.structure_id, s.opener_type, s.flags_csv
    FROM contacts c
    JOIN practices p ON c.practice_id = p.id
    JOIN sequences s ON s.contact_id = c.id
    ${combined}
    ORDER BY p.state, p.city, p.name
  `).all(where.params);
}

// ── Dedup pass ──────────────────────────────────────────────────────────────

/**
 * Remove duplicate practices by (name_normalized, city, state).
 * Keeps the row with the lowest ID (first inserted). Returns count removed.
 */
export function dedupPractices() {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM practices
    WHERE id NOT IN (
      SELECT MIN(id) FROM practices
      GROUP BY name_normalized, city, state
    )
  `).run();
  return result.changes;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function buildWhereClause(filters = {}, extraCondition = '') {
  const conditions = [];
  const params = {};

  if (filters.states && filters.states.length > 0) {
    const placeholders = filters.states.map((_, i) => `@state_${i}`);
    conditions.push(`p.state IN (${placeholders.join(',')})`);
    filters.states.forEach((s, i) => { params[`state_${i}`] = s.toUpperCase(); });
  }

  if (filters.tiers && filters.tiers.length > 0) {
    const placeholders = filters.tiers.map((_, i) => `@tier_${i}`);
    conditions.push(`p.priority_tier IN (${placeholders.join(',')})`);
    filters.tiers.forEach((t, i) => { params[`tier_${i}`] = t.toUpperCase(); });
  }

  if (extraCondition) conditions.push(extraCondition);

  // For single-table queries, alias practices as p
  const sql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { sql, params };
}
