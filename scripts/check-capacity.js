#!/usr/bin/env node

/**
 * Instantly Inbox Capacity Dashboard
 *
 * Usage:
 *   INSTANTLY_API_KEY=xxx node scripts/check-capacity.js [--target 5000]
 *
 * Exit codes:
 *   0 — capacity sufficient
 *   1 — capacity deficit
 */

import { isConfigured } from '../services/instantly.js';
import { checkCapacity, formatCapacityReport } from '../services/instantly-capacity.js';

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const target = targetIdx >= 0 ? parseInt(args[targetIdx + 1], 10) : 5000;

if (!isConfigured()) {
  console.error('Error: INSTANTLY_API_KEY environment variable is required.');
  console.error('Usage: INSTANTLY_API_KEY=xxx node scripts/check-capacity.js [--target 5000]');
  process.exit(1);
}

console.log(`Checking capacity for target: ${target} emails/day...`);

try {
  const report = await checkCapacity(target);
  console.log(formatCapacityReport(report));
  process.exit(report.isCapacitySufficient ? 0 : 1);
} catch (err) {
  console.error('Capacity check failed:', err.message);
  process.exit(1);
}
