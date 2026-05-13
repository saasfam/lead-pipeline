/**
 * CLI argument parser for nationwide pipeline.
 *
 * Supports:
 *   --layer N | --layer N-M   Run specific layer(s)
 *   --all                     Run all layers (1-9)
 *   --status                  Print gap stats
 *   --export                  Export CSV at current state
 *   --state CA,TX             Filter by state(s)
 *   --tier A,B                Filter by priority tier(s)
 *   --sample N                Limit processing to N records
 *   --max-places N            Cap Google Places API calls
 *   --concurrency N           Parallel workers (default: 10)
 *   --dry-run                 Parse/validate only, no writes
 *   --force                   Ignore caches, reprocess everything
 *   --db PATH                 Custom database path
 */

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    layers: [],
    all: false,
    status: false,
    export: false,
    states: [],
    tiers: [],
    sample: 0,
    maxPlaces: 0,
    concurrency: 10,
    dryRun: false,
    force: false,
    dbPath: './output/nationwide.db',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--layer': {
        if (!next) throw new Error('--layer requires a value (e.g., --layer 1 or --layer 2-5)');
        const match = next.match(/^(\d+)(?:-(\d+))?$/);
        if (!match) throw new Error(`Invalid --layer value: "${next}". Use a number or range (e.g., 1 or 2-5)`);
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : start;
        if (start < 1 || end > 9 || start > end) {
          throw new Error(`Layer range ${start}-${end} is invalid. Layers are 1-9.`);
        }
        for (let l = start; l <= end; l++) opts.layers.push(l);
        i++;
        break;
      }
      case '--all':
        opts.all = true;
        opts.layers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
        break;
      case '--status':
        opts.status = true;
        break;
      case '--export':
        opts.export = true;
        break;
      case '--state':
        if (!next) throw new Error('--state requires a value (e.g., --state CA,TX)');
        opts.states = next.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
        i++;
        break;
      case '--tier':
        if (!next) throw new Error('--tier requires a value (e.g., --tier A,B)');
        opts.tiers = next.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
        i++;
        break;
      case '--sample':
        if (!next) throw new Error('--sample requires a number');
        opts.sample = parseInt(next, 10);
        if (isNaN(opts.sample) || opts.sample < 1) throw new Error('--sample must be a positive integer');
        i++;
        break;
      case '--max-places':
        if (!next) throw new Error('--max-places requires a number');
        opts.maxPlaces = parseInt(next, 10);
        if (isNaN(opts.maxPlaces) || opts.maxPlaces < 0) throw new Error('--max-places must be >= 0');
        i++;
        break;
      case '--concurrency':
        if (!next) throw new Error('--concurrency requires a number');
        opts.concurrency = parseInt(next, 10);
        if (isNaN(opts.concurrency) || opts.concurrency < 1) throw new Error('--concurrency must be >= 1');
        i++;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--db':
        if (!next) throw new Error('--db requires a path');
        opts.dbPath = next;
        i++;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }

  // Validate: at least one action required
  if (!opts.status && !opts.export && opts.layers.length === 0) {
    throw new Error('Specify --layer, --all, --status, or --export');
  }

  return opts;
}

/** Build filters object for store queries from CLI options. */
export function buildFilters(opts) {
  const filters = {};
  if (opts.states.length > 0) filters.states = opts.states;
  if (opts.tiers.length > 0) filters.tiers = opts.tiers;
  return filters;
}
