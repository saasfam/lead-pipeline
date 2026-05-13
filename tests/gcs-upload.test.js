import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCredentialsEnv } from '../export/gcs-upload.js';

const SAMPLE = {
  type: 'service_account',
  project_id: 'anyreach-console',
  private_key_id: 'abc123',
  client_email: 'lead-pipeline-gcs@anyreach-console.iam.gserviceaccount.com',
};

test('parseCredentialsEnv returns null for empty input', () => {
  assert.equal(parseCredentialsEnv(undefined), null);
  assert.equal(parseCredentialsEnv(''), null);
});

test('parseCredentialsEnv parses a plain JSON string', () => {
  const parsed = parseCredentialsEnv(JSON.stringify(SAMPLE));
  assert.equal(parsed.project_id, 'anyreach-console');
  assert.equal(parsed.client_email, SAMPLE.client_email);
});

test('parseCredentialsEnv strips UTF-8 BOM before parsing', () => {
  const withBom = '﻿' + JSON.stringify(SAMPLE);
  const parsed = parseCredentialsEnv(withBom);
  assert.equal(parsed.project_id, 'anyreach-console');
});

test('parseCredentialsEnv trims surrounding whitespace', () => {
  const padded = '  \n' + JSON.stringify(SAMPLE) + '\n  ';
  const parsed = parseCredentialsEnv(padded);
  assert.equal(parsed.project_id, 'anyreach-console');
});
