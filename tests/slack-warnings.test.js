import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWarnings } from '../services/slack.js';

test('formatWarnings returns empty array for no warnings', () => {
  assert.deepEqual(formatWarnings([]), []);
  assert.deepEqual(formatWarnings(undefined), []);
  assert.deepEqual(formatWarnings(null), []);
});

test('formatWarnings emits a divider + section block with all entries', () => {
  const warnings = [
    { code: 'gcs_upload_failed', message: 'GCS upload failed, CSVs saved locally', error: 'bucket not found' },
    { code: 'instantly_not_configured', message: 'Instantly upload skipped: INSTANTLY_API_KEY not set' },
  ];
  const blocks = formatWarnings(warnings);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'divider');
  assert.equal(blocks[1].type, 'section');
  const text = blocks[1].text.text;
  assert.match(text, /Run Warnings \(2\)/);
  assert.match(text, /gcs_upload_failed/);
  assert.match(text, /bucket not found/);
  assert.match(text, /instantly_not_configured/);
});

test('formatWarnings header pluralization shows the count', () => {
  const single = formatWarnings([{ code: 'x', message: 'm' }]);
  assert.match(single[1].text.text, /Run Warnings \(1\)/);

  const triple = formatWarnings([
    { code: 'a', message: 'a' },
    { code: 'b', message: 'b' },
    { code: 'c', message: 'c' },
  ]);
  assert.match(triple[1].text.text, /Run Warnings \(3\)/);
});
