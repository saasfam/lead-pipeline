import { test } from 'node:test';
import assert from 'node:assert/strict';

const SAVED_ENV = {
  GOOGLE_KG_API_KEY: process.env.GOOGLE_KG_API_KEY,
  GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY,
};

function clearGoogleEnv() {
  delete process.env.GOOGLE_KG_API_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY;
}

function restoreGoogleEnv() {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('layer4 returns skip object when GOOGLE_KG_API_KEY is missing', async () => {
  clearGoogleEnv();
  try {
    const mod = await import('../nationwide/layers/layer4-knowledge-graph.js');
    const result = await mod.run({ sample: 0, dryRun: true }, {});
    assert.ok(result);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /GOOGLE_KG_API_KEY/);
  } finally {
    restoreGoogleEnv();
  }
});

test('layer7 returns skip object when GOOGLE_PLACES_API_KEY is missing', async () => {
  clearGoogleEnv();
  try {
    const mod = await import('../nationwide/layers/layer7-google-places.js');
    const result = await mod.run({ maxPlaces: 0 }, {});
    assert.ok(result);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /GOOGLE_PLACES_API_KEY/);
  } finally {
    restoreGoogleEnv();
  }
});

test('layer7 returns cost-gate skip when key present but --max-places is 0', async () => {
  clearGoogleEnv();
  process.env.GOOGLE_PLACES_API_KEY = 'test-key-not-used';
  try {
    const mod = await import('../nationwide/layers/layer7-google-places.js');
    const result = await mod.run({ maxPlaces: 0 }, {});
    assert.ok(result);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /max-places/);
  } finally {
    restoreGoogleEnv();
  }
});
