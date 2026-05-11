import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalsFromApollo } from '../enrichment/signals-from-apollo.js';

test('signalsFromApollo passes through Apollo fields cleanly', () => {
  const out = signalsFromApollo({
    companyName: 'Acme',
    companyIndustry: 'logistics',
    companyEmployees: 75,
    companyFounded: 2012,
    companyDescription: 'Acme operates regional 3PL services across the Southeast.',
    latestFundingStage: 'Series A',
    latestFundingDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    latestFundingAmount: '$8M',
    companyKeywords: ['fulfillment', 'last-mile'],
  });

  assert.equal(out.properCompanyName, 'Acme');
  assert.equal(out.industry, 'logistics');
  assert.match(out.recentFunding, /\$8M/);
  assert.match(out.growthSignal, /75-person team/);
  assert.match(out.personalizedHook, /3PL services/);
  // Apollo people-search doesn't include news/hiring, so those stay 'None found'
  assert.equal(out.hiringSignal, 'None found');
  assert.equal(out.recentNews, 'None found');
});

test('signalsFromApollo suppresses stale funding (>18 months old)', () => {
  const out = signalsFromApollo({
    companyName: 'Acme',
    latestFundingStage: 'Series A',
    latestFundingDate: '2019-01-01',
    latestFundingAmount: '$8M',
  });
  assert.equal(out.recentFunding, 'None found');
});

test('signalsFromApollo uses founding year as a hook fallback', () => {
  const out = signalsFromApollo({
    companyName: 'Acme',
    companyFounded: new Date().getFullYear() - 12,
  });
  assert.match(out.personalizedHook, /Acme — 12 years in business/);
});

test('signalsFromApollo handles empty input gracefully', () => {
  const out = signalsFromApollo({});
  assert.equal(out.industry, '');
  assert.equal(out.recentFunding, 'None found');
  assert.equal(out.growthSignal, 'None found');
  assert.equal(out.personalizedHook, '');
});

test('signalsFromApollo prefers Apollo description over founding-year hook', () => {
  const description = 'Independent insurance agency serving five states since 1998.';
  const out = signalsFromApollo({
    companyName: 'Acme',
    companyFounded: 1998,
    companyDescription: description,
  });
  assert.equal(out.personalizedHook, description);
});

test('signalsFromApollo includes keywords in growth signal when employees missing', () => {
  const out = signalsFromApollo({
    companyName: 'Acme',
    companyKeywords: ['cybersecurity', 'cloud-migration', 'msp'],
  });
  assert.match(out.growthSignal, /cybersecurity/);
});
