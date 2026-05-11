import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landingPageFor, landingHost } from '../config/verticals.js';
import { ensureLanderUrl } from '../enrichment/lander-url.js';

test('landingPageFor returns anyreach.ai/<slug> for known verticals', () => {
  assert.equal(landingPageFor('dental'), 'https://anyreach.ai/dental');
  assert.equal(landingPageFor('propertymanagement'), 'https://anyreach.ai/property-management');
  assert.equal(landingPageFor('contactcenter'), 'https://anyreach.ai/contact-center');
  assert.equal(landingPageFor('realestate'), 'https://anyreach.ai/real-estate');
  assert.equal(landingPageFor('homeservices'), 'https://anyreach.ai/home-services');
});

test('landingPageFor falls back to the base URL for unknown verticals', () => {
  assert.equal(landingPageFor('not-a-vertical'), 'https://anyreach.ai');
  assert.equal(landingPageFor(null), 'https://anyreach.ai');
  assert.equal(landingPageFor(undefined), 'https://anyreach.ai');
});

test('landingHost returns the host without scheme', () => {
  assert.equal(landingHost(), 'anyreach.ai');
});

test('ensureLanderUrl appends URL if missing', () => {
  const result = ensureLanderUrl('Some message body.', 'https://anyreach.ai/dental');
  assert.match(result, /anyreach\.ai\/dental$/);
});

test('ensureLanderUrl skips append when URL already present', () => {
  const text = 'Some message. anyreach.ai/dental';
  const result = ensureLanderUrl(text, 'https://anyreach.ai/dental');
  // Should NOT double-append
  const matches = result.match(/anyreach\.ai\/dental/g) || [];
  assert.equal(matches.length, 1);
});

test('ensureLanderUrl handles empty inputs gracefully', () => {
  assert.equal(ensureLanderUrl('', 'https://anyreach.ai/dental'), '');
  assert.equal(ensureLanderUrl('text', ''), 'text');
  assert.equal(ensureLanderUrl(null, 'https://anyreach.ai/dental'), null);
});
