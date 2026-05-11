import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider } from '../enrichment/people-search.js';
import { buildTitleFilter } from '../enrichment/people-search/hunter.js';

const originalProvider = process.env.PEOPLE_SEARCH_PROVIDER;

beforeEach(() => {
  delete process.env.PEOPLE_SEARCH_PROVIDER;
});

afterEach(() => {
  if (originalProvider) process.env.PEOPLE_SEARCH_PROVIDER = originalProvider;
  else delete process.env.PEOPLE_SEARCH_PROVIDER;
});

// ── Provider resolution ─────────────────────────────────────────────────────

test('resolveProvider defaults to apollo when env var unset', () => {
  assert.equal(resolveProvider('dental'), 'apollo');
  assert.equal(resolveProvider('saas'), 'apollo');
});

test('resolveProvider honors an explicit env var', () => {
  process.env.PEOPLE_SEARCH_PROVIDER = 'hunter';
  assert.equal(resolveProvider('dental'), 'hunter');
  assert.equal(resolveProvider('saas'), 'hunter');

  process.env.PEOPLE_SEARCH_PROVIDER = 'hunter-then-apollo';
  assert.equal(resolveProvider('dental'), 'hunter-then-apollo');
});

test('resolveProvider auto-routes SMB verticals to hunter-then-apollo', () => {
  process.env.PEOPLE_SEARCH_PROVIDER = 'auto';
  assert.equal(resolveProvider('dental'), 'hunter-then-apollo');
  assert.equal(resolveProvider('msp'), 'hunter-then-apollo');
  assert.equal(resolveProvider('homeservices'), 'hunter-then-apollo');
  assert.equal(resolveProvider('automotive'), 'hunter-then-apollo');
});

test('resolveProvider auto-routes mid-market verticals to apollo', () => {
  process.env.PEOPLE_SEARCH_PROVIDER = 'auto';
  assert.equal(resolveProvider('contactcenter'), 'apollo');
  assert.equal(resolveProvider('saas'), 'apollo');
  assert.equal(resolveProvider('financial'), 'apollo');
  assert.equal(resolveProvider('healthcare'), 'apollo');
});

test('resolveProvider auto-routes unknown verticals to apollo (safe default)', () => {
  process.env.PEOPLE_SEARCH_PROVIDER = 'auto';
  assert.equal(resolveProvider('unknown-vertical'), 'apollo');
  assert.equal(resolveProvider(null), 'apollo');
  assert.equal(resolveProvider(undefined), 'apollo');
});

// ── Hunter title filter ─────────────────────────────────────────────────────

test('buildTitleFilter returns null for empty title list (keeps everything)', () => {
  assert.equal(buildTitleFilter([]), null);
  assert.equal(buildTitleFilter(undefined), null);
});

test('buildTitleFilter matches case-insensitive substrings', () => {
  const filter = buildTitleFilter(['Practice Owner', 'Dentist']);
  assert.equal(filter('practice owner'), true);
  assert.equal(filter('Owner of Practice'), true);
  assert.equal(filter('Dentist'), true);
  assert.equal(filter('Receptionist'), false);
});

test('buildTitleFilter requires ALL keywords from a single Apollo title to match', () => {
  const filter = buildTitleFilter(['VP Operations']);
  // "VP of Operations" — both keywords present → match
  assert.equal(filter('VP of Operations'), true);
  // "Senior VP" — missing "operations" → no match
  assert.equal(filter('Senior VP'), false);
});

test('buildTitleFilter matches if ANY of the configured titles match', () => {
  const filter = buildTitleFilter(['Owner', 'CEO', 'President']);
  assert.equal(filter('Owner'), true);
  assert.equal(filter('CEO'), true);
  assert.equal(filter('President & Founder'), true);
  assert.equal(filter('Junior Analyst'), false);
});

test('buildTitleFilter strips short / common stopwords from Apollo titles', () => {
  // 'and', 'the', 'for' are stripped, but keywords are joined with AND
  // (all must match), not OR. So "Owner and CEO" matches "CEO and Owner"
  // because both 'owner' and 'ceo' keywords are present.
  const filter = buildTitleFilter(['Owner and CEO']);
  assert.equal(filter('CEO and Owner'), true);
  assert.equal(filter('Owner / CEO'), true);
  // Should NOT match a partial — "Owner" alone is missing 'ceo'.
  assert.equal(filter('Owner'), false);
});

test('buildTitleFilter handles missing incoming title', () => {
  const filter = buildTitleFilter(['Owner']);
  assert.equal(filter(''), false);
  assert.equal(filter(null), false);
  assert.equal(filter(undefined), false);
});
