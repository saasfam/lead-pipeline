import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mapMillionVerifierResult } from '../enrichment/verifiers/millionverifier.js';
import { verifyEmails } from '../enrichment/email-verify.js';

// ── Pure result-code mapping ────────────────────────────────────────────────

test('MillionVerifier "ok" maps to valid', () => {
  assert.equal(mapMillionVerifierResult('ok'), 'valid');
  assert.equal(mapMillionVerifierResult('valid'), 'valid');
});

test('MillionVerifier "invalid" / "disposable" map to invalid', () => {
  assert.equal(mapMillionVerifierResult('invalid'), 'invalid');
  assert.equal(mapMillionVerifierResult('disposable'), 'invalid');
});

test('MillionVerifier "catch_all" defaults to unknown', () => {
  delete process.env.MILLIONVERIFIER_INCLUDE_CATCHALL;
  assert.equal(mapMillionVerifierResult('catch_all'), 'unknown');
});

test('MillionVerifier "catch_all" becomes valid with opt-in env var', () => {
  process.env.MILLIONVERIFIER_INCLUDE_CATCHALL = 'true';
  assert.equal(mapMillionVerifierResult('catch_all'), 'valid');
  delete process.env.MILLIONVERIFIER_INCLUDE_CATCHALL;
});

test('MillionVerifier "unknown" / "error" / null map to unknown', () => {
  assert.equal(mapMillionVerifierResult('unknown'), 'unknown');
  assert.equal(mapMillionVerifierResult('error'), 'unknown');
  assert.equal(mapMillionVerifierResult(''), 'unknown');
  assert.equal(mapMillionVerifierResult(null), 'unknown');
  assert.equal(mapMillionVerifierResult(undefined), 'unknown');
});

test('MillionVerifier mapping is case-insensitive', () => {
  assert.equal(mapMillionVerifierResult('OK'), 'valid');
  assert.equal(mapMillionVerifierResult('Invalid'), 'invalid');
});

// ── Provider dispatch ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const originalProvider = process.env.EMAIL_VERIFY_PROVIDER;
const originalKey = process.env.MILLIONVERIFIER_API_KEY;

beforeEach(() => {
  delete process.env.EMAIL_VERIFY_PROVIDER;
  delete process.env.MILLIONVERIFIER_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalProvider) process.env.EMAIL_VERIFY_PROVIDER = originalProvider;
  else delete process.env.EMAIL_VERIFY_PROVIDER;
  if (originalKey) process.env.MILLIONVERIFIER_API_KEY = originalKey;
  else delete process.env.MILLIONVERIFIER_API_KEY;
});

test('email-verify throws when millionverifier is selected without API key', async () => {
  process.env.EMAIL_VERIFY_PROVIDER = 'millionverifier';
  await assert.rejects(
    () => verifyEmails([{ email: 'a@b.com' }]),
    /MILLIONVERIFIER_API_KEY is unset/
  );
});

test('email-verify routes to millionverifier and filters to valid only', async () => {
  process.env.EMAIL_VERIFY_PROVIDER = 'millionverifier';
  process.env.MILLIONVERIFIER_API_KEY = 'test-key';

  // Mock fetch: return ok for one, invalid for one, unknown for one
  const responses = {
    'a@b.com': { result: 'ok' },
    'c@d.com': { result: 'invalid' },
    'e@f.com': { result: 'unknown' },
  };
  globalThis.fetch = async (url) => {
    const decoded = decodeURIComponent(url);
    const m = decoded.match(/email=([^&]+)/);
    const email = m ? m[1] : '';
    return {
      ok: true,
      json: async () => ({ email, ...responses[email] }),
    };
  };

  const result = await verifyEmails([
    { email: 'a@b.com', firstName: 'A' },
    { email: 'c@d.com', firstName: 'C' },
    { email: 'e@f.com', firstName: 'E' },
    { email: '', firstName: 'Empty' }, // should be filtered out (no email)
  ]);

  // Only the 'ok' one survives
  assert.equal(result.length, 1);
  assert.equal(result[0].email, 'a@b.com');
  assert.equal(result[0].emailStatus, 'valid');
  assert.equal(result[0].emailVerifyProvider, 'millionverifier');
  assert.equal(result[0].firstName, 'A');
});

test('email-verify handles fetch failures gracefully (treats as unknown, drops from valid)', async () => {
  process.env.EMAIL_VERIFY_PROVIDER = 'millionverifier';
  process.env.MILLIONVERIFIER_API_KEY = 'test-key';

  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  const result = await verifyEmails([{ email: 'a@b.com' }]);
  // Network failure → status 'unknown' → not in 'valid' filter
  assert.equal(result.length, 0);
});

test('email-verify with empty contacts returns empty', async () => {
  process.env.EMAIL_VERIFY_PROVIDER = 'millionverifier';
  process.env.MILLIONVERIFIER_API_KEY = 'test-key';
  globalThis.fetch = async () => assert.fail('fetch should not be called');
  const result = await verifyEmails([]);
  assert.deepEqual(result, []);
});

test('email-verify falls back to apollo for unknown provider', async () => {
  process.env.EMAIL_VERIFY_PROVIDER = 'not-a-real-provider';
  // We won't actually hit Apollo because APOLLO_API_KEY isn't set in this
  // test env; we just verify the unknown-provider branch doesn't throw a
  // "millionverifier" error. apollo-verify catches its own fetch errors and
  // returns 'unknown' which gets filtered out, so result should be [].
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'err' });
  const result = await verifyEmails([{ email: 'a@b.com' }]);
  assert.deepEqual(result, []);
});
