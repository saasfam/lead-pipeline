import { Storage } from '@google-cloud/storage';
import { createReadStream } from 'fs';
import { basename } from 'path';
import { logger } from '../services/logger.js';

const BUCKET_NAME = process.env.GCS_BUCKET || 'anyreach-lead-pipeline';

let storage = null;

export function parseCredentialsEnv(raw) {
  if (!raw) return null;
  return JSON.parse(raw.replace(/^﻿/, '').trim());
}

function getStorage() {
  if (!storage) {
    const credentials = parseCredentialsEnv(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    if (credentials) {
      storage = new Storage({ projectId: credentials.project_id, credentials });
    } else {
      storage = new Storage();
    }
  }
  return storage;
}

/**
 * Upload a file to GCS.
 *
 * @param {string} localPath - Local file path
 * @param {string} gcsFolder - Folder within the bucket (e.g., "exports/2026-02-16")
 * @returns {string} - GCS URI (gs://bucket/path)
 */
export async function uploadToGCS(localPath, gcsFolder = null) {
  const gcs = getStorage();
  const bucket = gcs.bucket(BUCKET_NAME);

  const date = new Date().toISOString().slice(0, 10);
  const folder = gcsFolder || `exports/${date}`;
  const fileName = basename(localPath);
  const destination = `${folder}/${fileName}`;

  try {
    await bucket.upload(localPath, {
      destination,
      metadata: {
        contentType: 'text/csv',
      },
    });

    const gcsUri = `gs://${BUCKET_NAME}/${destination}`;
    logger.info('Uploaded to GCS', { localPath, gcsUri });
    return gcsUri;
  } catch (err) {
    logger.error('GCS upload failed', { localPath, error: err.message });
    throw err;
  }
}

/**
 * Upload multiple files to GCS.
 *
 * @param {Array<string>} filePaths - Local file paths
 * @returns {Array<string>} - GCS URIs
 */
export async function uploadMultipleToGCS(filePaths) {
  const uris = [];
  for (const filePath of filePaths) {
    if (filePath) {
      const uri = await uploadToGCS(filePath);
      uris.push(uri);
    }
  }
  return uris;
}
