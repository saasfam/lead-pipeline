/**
 * Layer orchestrator — runs layers in order, prints gap stats between layers.
 */

import { gapStats, closeDb } from './store.js';
import { buildFilters } from './cli.js';
import { logger } from '../services/logger.js';

// Layer imports (lazy-loaded to avoid loading unused modules)
const LAYER_MODULES = {
  1: () => import('./layers/layer1-npi.js'),
  2: () => import('./layers/layer2-domain-guess.js'),
  3: () => import('./layers/layer3-directories.js'),
  4: () => import('./layers/layer4-knowledge-graph.js'),
  5: () => import('./layers/layer5-website-enrichment.js'),
  6: () => import('./layers/layer6-email-guess.js'),
  7: () => import('./layers/layer7-google-places.js'),
  8: () => import('./layers/layer8-sequences.js'),
  9: () => import('./layers/layer9-export.js'),
};

/**
 * Run specified layers in order.
 * Each layer module exports: { run(opts, filters) }
 */
export async function runLayers(opts) {
  const filters = buildFilters(opts);

  console.log('\n' + '='.repeat(64));
  console.log('  NATIONWIDE DENTAL PIPELINE');
  console.log('='.repeat(64));

  if (opts.states.length) console.log(`  States:  ${opts.states.join(', ')}`);
  if (opts.tiers.length) console.log(`  Tiers:   ${opts.tiers.join(', ')}`);
  if (opts.sample) console.log(`  Sample:  ${opts.sample}`);
  if (opts.dryRun) console.log(`  Mode:    DRY RUN`);
  console.log('');

  const skipped = [];
  const failed = [];

  for (const layerNum of opts.layers) {
    const loader = LAYER_MODULES[layerNum];
    if (!loader) {
      console.error(`  Unknown layer: ${layerNum}`);
      continue;
    }

    console.log(`\n${'─'.repeat(64)}`);
    console.log(`  LAYER ${layerNum}`);
    console.log(`${'─'.repeat(64)}`);

    const mod = await loader();
    const startTime = Date.now();

    try {
      const result = await mod.run(opts, filters);
      if (result && result.skipped) {
        skipped.push({ layer: layerNum, reason: result.reason });
      }
    } catch (err) {
      console.error(`\n  Layer ${layerNum} FAILED: ${err.message}`);
      if (process.env.LOG_LEVEL === 'debug') console.error(err.stack);
      failed.push({ layer: layerNum, error: err.message });
      // Continue to next layer unless it's a fatal error
      if (err.fatal) throw err;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  Layer ${layerNum} completed in ${elapsed}s`);

    // Print gap stats after each layer (skip for export)
    if (layerNum !== 9) {
      printGapStats(filters);
    }
  }

  if (skipped.length || failed.length) {
    console.log('\n' + '─'.repeat(64));
    console.log('  RUN WARNINGS');
    console.log('─'.repeat(64));
    for (const s of skipped) {
      console.log(`  SKIPPED Layer ${s.layer}: ${s.reason}`);
    }
    for (const f of failed) {
      console.log(`  FAILED Layer ${f.layer}: ${f.error}`);
    }
    logger.warn('Nationwide run completed with warnings', {
      skipped_count: skipped.length,
      failed_count: failed.length,
      skipped,
      failed,
    });
  }

  console.log('\n' + '='.repeat(64));
  console.log('  PIPELINE COMPLETE');
  console.log('='.repeat(64) + '\n');

  return { skipped, failed };
}

/**
 * Print current gap statistics.
 */
export function printGapStats(filters = {}) {
  const stats = gapStats(filters);

  console.log('\n  ┌─────────────────────────────────────────────┐');
  console.log('  │             GAP STATISTICS                   │');
  console.log('  ├─────────────────────────────────────────────┤');

  console.log(`  │  Practices total:        ${String(stats.practices.total).padStart(8)} │`);
  console.log(`  │  With domain:            ${String(stats.practices.withDomain).padStart(8)} │`);
  console.log(`  │  Missing domain:         ${String(stats.practices.withoutDomain).padStart(8)} │`);
  console.log(`  │  Website scraped:        ${String(stats.practices.scraped).padStart(8)} │`);
  console.log('  ├─────────────────────────────────────────────┤');
  console.log(`  │  Contacts total:         ${String(stats.contacts.total).padStart(8)} │`);
  console.log(`  │  With email:             ${String(stats.contacts.withEmail).padStart(8)} │`);
  console.log(`  │  Missing email:          ${String(stats.contacts.withoutEmail).padStart(8)} │`);
  console.log(`  │  With sequence:          ${String(stats.contacts.withSequence).padStart(8)} │`);
  console.log('  └─────────────────────────────────────────────┘');

  // Coverage percentages
  if (stats.practices.total > 0) {
    const domainPct = ((stats.practices.withDomain / stats.practices.total) * 100).toFixed(1);
    const scrapePct = ((stats.practices.scraped / stats.practices.total) * 100).toFixed(1);
    console.log(`\n  Domain coverage: ${domainPct}% | Scraped: ${scrapePct}%`);
  }
  if (stats.contacts.total > 0) {
    const emailPct = ((stats.contacts.withEmail / stats.contacts.total) * 100).toFixed(1);
    const seqPct = ((stats.contacts.withSequence / stats.contacts.total) * 100).toFixed(1);
    console.log(`  Email coverage:  ${emailPct}% | Sequences: ${seqPct}%`);
  }
}

/** Print status only (--status flag). */
export function printStatus(opts) {
  const filters = buildFilters(opts);
  console.log('\n' + '='.repeat(64));
  console.log('  NATIONWIDE DENTAL PIPELINE — STATUS');
  console.log('='.repeat(64));
  if (opts.states.length) console.log(`  States: ${opts.states.join(', ')}`);
  if (opts.tiers.length) console.log(`  Tiers:  ${opts.tiers.join(', ')}`);
  printGapStats(filters);
  console.log('');
}
