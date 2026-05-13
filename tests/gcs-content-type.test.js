import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentTypeFor } from '../export/gcs-upload.js';

test('contentTypeFor detects CSV', () => {
  assert.equal(contentTypeFor('exports/dental.csv'), 'text/csv');
  assert.equal(contentTypeFor('/abs/path/file.CSV'), 'text/csv');
});

test('contentTypeFor detects SQLite variants', () => {
  assert.equal(contentTypeFor('output/nationwide.db'), 'application/x-sqlite3');
  assert.equal(contentTypeFor('test.sqlite'), 'application/x-sqlite3');
  assert.equal(contentTypeFor('test.sqlite3'), 'application/x-sqlite3');
});

test('contentTypeFor detects JSON', () => {
  assert.equal(contentTypeFor('payload.json'), 'application/json');
});

test('contentTypeFor falls back to octet-stream for unknown extensions', () => {
  assert.equal(contentTypeFor('mystery.bin'), 'application/octet-stream');
  assert.equal(contentTypeFor('no-extension'), 'application/octet-stream');
});
