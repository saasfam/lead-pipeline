import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getLedgerDb,
  closeLedgerDb,
  buildDedupKey,
  filterCrossVertical,
  recordBusinesses,
  lookupBusiness,
  getDedupStats,
  resetLedger,
  normalizeName,
} from '../enrichment/cross-vertical-dedup.js';

// A fresh in-memory ledger before every test keeps tests isolated and
// avoids touching ./output/dedup-ledger.db on disk. Defined as a function
// so we can call it from each describe — top-level beforeEach hooks in
// node:test don't always cascade to nested describe blocks reliably.
function setupFreshLedger() {
  beforeEach(() => {
    closeLedgerDb();
    getLedgerDb(':memory:');
    resetLedger();
  });

  afterEach(() => {
    closeLedgerDb();
  });
}

describe('normalizeName', () => {
  setupFreshLedger();
  it('lowercases and strips non-alphanumerics', () => {
    assert.equal(normalizeName('Acme Corp, Inc.'), 'acmecorpinc');
  });

  it('returns null for empty or symbol-only names', () => {
    assert.equal(normalizeName(''), null);
    assert.equal(normalizeName('   '), null);
    assert.equal(normalizeName('!!!'), null);
    assert.equal(normalizeName(null), null);
    assert.equal(normalizeName(undefined), null);
  });

  it('truncates to 50 characters to bound the key', () => {
    const long = 'a'.repeat(80);
    assert.equal(normalizeName(long).length, 50);
  });
});

describe('buildDedupKey', () => {
  setupFreshLedger();
  it('prefers domain over name', () => {
    const k = buildDedupKey({ name: 'Acme', domain: 'Acme.com' });
    assert.equal(k.key, 'domain:acme.com');
    assert.equal(k.keyType, 'domain');
  });

  it('falls back to normalized name when no domain', () => {
    const k = buildDedupKey({ name: 'Acme Corp' });
    assert.equal(k.key, 'name:acmecorp');
    assert.equal(k.keyType, 'name');
  });

  it('returns null when neither domain nor name yields a key', () => {
    assert.equal(buildDedupKey({}), null);
    assert.equal(buildDedupKey({ name: '!!!' }), null);
  });
});

describe('filterCrossVertical', () => {
  setupFreshLedger();
  it('returns first-seen businesses as fresh', () => {
    const businesses = [
      { name: 'Acme Corp', domain: 'acme.com' },
      { name: 'Globex', domain: 'globex.com' },
    ];
    const result = filterCrossVertical(businesses, 'msp');
    assert.equal(result.fresh.length, 2);
    assert.equal(result.duplicates.length, 0);
  });

  it('flags repeat businesses across verticals as duplicates', () => {
    filterCrossVertical([{ name: 'Acme', domain: 'acme.com' }], 'msp');
    const second = filterCrossVertical([{ name: 'Acme', domain: 'acme.com' }], 'saas');
    assert.equal(second.fresh.length, 0);
    assert.equal(second.duplicates.length, 1);
    assert.equal(second.duplicates[0].firstVertical, 'msp');
    assert.equal(second.duplicates[0].keyType, 'domain');
  });

  it('treats domain-key match as the same business even when name differs', () => {
    filterCrossVertical([{ name: 'Acme Corporation', domain: 'acme.com' }], 'msp');
    const second = filterCrossVertical(
      [{ name: 'ACME, Inc.', domain: 'acme.com' }],
      'technology'
    );
    assert.equal(second.duplicates.length, 1);
    assert.equal(second.fresh.length, 0);
  });

  it('treats name-key match as the same business when neither has a domain', () => {
    filterCrossVertical([{ name: 'Acme Corp' }], 'msp');
    const second = filterCrossVertical([{ name: 'Acme Corp' }], 'saas');
    assert.equal(second.duplicates.length, 1);
    assert.equal(second.duplicates[0].keyType, 'name');
  });

  it('passes through businesses with no usable key as skipped (not fresh, not duplicate)', () => {
    const result = filterCrossVertical([{}, { name: '!!!' }], 'msp');
    assert.equal(result.fresh.length, 0);
    assert.equal(result.duplicates.length, 0);
    assert.equal(result.skipped.length, 2);
  });

  it('does not write to the ledger when commit=false (dry-run)', () => {
    filterCrossVertical([{ name: 'Acme', domain: 'acme.com' }], 'msp', { commit: false });
    // Second call from a different vertical should still see it as fresh
    // because nothing was written.
    const second = filterCrossVertical([{ name: 'Acme', domain: 'acme.com' }], 'saas');
    assert.equal(second.fresh.length, 1);
    assert.equal(second.duplicates.length, 0);
  });

  it('claims the first-writer-wins under repeated calls in the same vertical', () => {
    const first = filterCrossVertical([{ name: 'Acme', domain: 'acme.com' }], 'msp');
    const second = filterCrossVertical([{ name: 'Acme', domain: 'acme.com' }], 'msp');
    assert.equal(first.fresh.length, 1);
    assert.equal(second.fresh.length, 0);
    assert.equal(second.duplicates[0].firstVertical, 'msp');
  });

  it('throws when verticalKey is missing', () => {
    assert.throws(() => filterCrossVertical([], null));
    assert.throws(() => filterCrossVertical([], ''));
  });
});

describe('recordBusinesses', () => {
  setupFreshLedger();
  it('inserts new and reports already-claimed counts', () => {
    const result = recordBusinesses(
      [
        { name: 'Acme', domain: 'acme.com' },
        { name: 'Globex', domain: 'globex.com' },
      ],
      'msp'
    );
    assert.equal(result.inserted, 2);
    assert.equal(result.alreadyClaimed, 0);
    assert.equal(result.skipped, 0);

    const replay = recordBusinesses(
      [
        { name: 'Acme', domain: 'acme.com' },
        { name: 'Initech', domain: 'initech.com' },
      ],
      'saas'
    );
    assert.equal(replay.inserted, 1);
    assert.equal(replay.alreadyClaimed, 1);
  });

  it('counts unkeyed businesses as skipped', () => {
    const result = recordBusinesses([{}, { name: '' }], 'msp');
    assert.equal(result.skipped, 2);
    assert.equal(result.inserted, 0);
  });
});

describe('lookupBusiness', () => {
  setupFreshLedger();
  it('returns the ledger row for a previously seen business', () => {
    recordBusinesses([{ name: 'Acme', domain: 'acme.com' }], 'msp');
    const row = lookupBusiness({ domain: 'acme.com' });
    assert.ok(row);
    assert.equal(row.first_vertical, 'msp');
    assert.equal(row.key_type, 'domain');
  });

  it('returns null for an unseen business', () => {
    assert.equal(lookupBusiness({ domain: 'unseen.com' }), null);
    assert.equal(lookupBusiness({}), null);
  });
});

describe('getDedupStats', () => {
  setupFreshLedger();
  it('reports total, by-vertical, and by-key-type counts', () => {
    recordBusinesses(
      [
        { name: 'Acme', domain: 'acme.com' },
        { name: 'Globex', domain: 'globex.com' },
        { name: 'Initech (no domain)' },
      ],
      'msp'
    );
    recordBusinesses([{ name: 'Hooli', domain: 'hooli.com' }], 'saas');

    const stats = getDedupStats();
    assert.equal(stats.total, 4);
    assert.equal(stats.byVertical.msp, 3);
    assert.equal(stats.byVertical.saas, 1);
    assert.equal(stats.byKeyType.domain, 3);
    assert.equal(stats.byKeyType.name, 1);
  });

  it('scopes counts to a single vertical when requested', () => {
    recordBusinesses([{ domain: 'a.com' }, { domain: 'b.com' }], 'msp');
    recordBusinesses([{ domain: 'c.com' }], 'saas');
    const stats = getDedupStats('msp');
    assert.equal(stats.total, 2);
    assert.equal(stats.byVertical, undefined);
  });
});

describe('resetLedger', () => {
  setupFreshLedger();
  it('clears all entries', () => {
    recordBusinesses([{ domain: 'a.com' }, { domain: 'b.com' }], 'msp');
    resetLedger();
    assert.equal(getDedupStats().total, 0);
  });
});
