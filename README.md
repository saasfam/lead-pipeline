# lead-pipeline

Multi-vertical lead generation pipeline for Anyreach outbound. Scrapes
business directories (Google Maps, Yelp, Clutch), enriches via Apollo and
website extraction, generates personalized email sequences with OpenAI,
and exports to Instantly.ai for cold outreach.

22 verticals are configured (Contact Center, Dental, Automotive, Logistics,
Property Management, Real Estate, Healthcare, Recruiting, Home Services,
Restaurants, Agencies, MSP, SaaS, Technology, eCommerce, Communications,
Financial, Education, Energy, Insurance, Travel, Retail) with a 10K-leads
target each.

A separate **9-layer nationwide pipeline** under `nationwide/` does deeper
ingestion using the NPI registry. It currently targets dental practices
only (Layer 1 filters by dental taxonomy `1223*`); generalizing it to
other verticals is a known follow-up.

## Setup

```bash
npm install
```

Native modules are recompiled against your local Node version. If you see
a `NODE_MODULE_VERSION` error from `better-sqlite3`, run:

```bash
npm rebuild better-sqlite3
```

Required Node version: 20+ (Dockerfile pins `node:20-slim`).

### Environment variables

Copy `.env.example` (if present) or create `.env` with:

```
BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...
APOLLO_API_KEY=...
PERPLEXITY_API_KEY=...
OPENAI_API_KEY=...
INSTANTLY_API_KEY=...
INSTANTLY_CAMPAIGN_ID=...
GCS_BUCKET=anyreach-lead-pipeline
SLACK_WEBHOOK_URL=...
# ATTIO_API_KEY=...   # optional, integration is currently a stub
```

`env-vars.yaml` is the Cloud Run-formatted version (gitignored).

## Running

### Server (REST API)

```bash
npm start            # production
npm run dev          # auto-restart on changes
```

Default port: `8080` (override with `PORT`).

### Endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET`  | `/health` | — | Liveness probe |
| `POST` | `/scrape-vertical` | `{ vertical, cities? }` | Run the full pipeline for one vertical (returns `202`, run async) |
| `POST` | `/scrape-all` | `{ cities? }` | Run all 22 verticals sequentially |
| `POST` | `/enrich-domains` | `{ domains[], vertical }` | Apollo people search for a list of domains |
| `GET`  | `/status/:jobId` | — | Inspect a job |
| `GET`  | `/jobs` | — | List all jobs (newest first, Postgres-backed) |
| `GET`  | `/dedup-stats?vertical=` | — | Cross-vertical dedup ledger stats; reports backend, total, byKeyType, byVertical |

### Scripts

Useful one-off scripts in `scripts/`:

- `run-vertical-scrape.js` — scrape a single vertical from CLI
- `run-all-verticals.js` — sweep all 22
- `run-nationwide.js` — drive the 9-layer dental nationwide pipeline
- `enrich-signals.js` / `enrich-websites.js` / `enrich-emails.js` — re-run individual enrichment steps on existing CSVs
- `generate-messages.js` / `generate-vertical-sequences.js` — regenerate email sequences

## Pipeline flow (per vertical)

```
1. Scrape directories (Google Maps + Yelp/Clutch where configured)
2. In-vertical dedup (by domain, fallback to normalized name)
2b. Cross-vertical dedup by name (skip businesses already claimed)
3. Resolve domains
3b. Cross-vertical dedup by domain (catches name-spelling variants)
4. Apollo people search (decision-maker titles per vertical config)
5. Verify emails (Apollo)
6. Generate Instantly + PhantomBuster CSVs
7. Upload to GCS (falls back to local if GCS unavailable)
8. Sync to Instantly.ai (with capacity check)
9. Slack notification
```

### Cross-vertical dedup

`enrichment/cross-vertical-dedup.js` is a dual-driver ledger keyed on
`domain:` (preferred) or `name:` (fallback). Every business that any
vertical claims first is recorded; later runs across other verticals
filter against it so the same company isn't pursued from MSP, SaaS, and
technology campaigns as if it were three different leads.

- **Postgres** when `DATABASE_URL` is set (Railway, Cloud SQL on Cloud
  Run, etc.) — state persists across redeploys.
- **SQLite** at `output/dedup-ledger.db` when no `DATABASE_URL` — for
  local scripts and dev.

The orchestrator runs two passes — once before domain resolution
(name-based, cheap) and once after (domain-based, catches cross-directory
spelling variants). Job stats expose `crossVerticalDupesByName` and
`crossVerticalDupesByDomain` for monitoring.

### Job tracker

`pipeline/job-tracker.js` uses the same dual-driver pattern. Postgres
when `DATABASE_URL` is set, SQLite at `output/jobs.db` otherwise. Job
history survives server restarts on Railway / Cloud Run.

## Data outputs

Generated under `./output/` (gitignored):

- `<date>-<vertical>-instantly.csv` — Instantly-formatted leads with sequences
- `<date>-<vertical>-phantombuster.csv` — PhantomBuster-formatted lead lists
- `nationwide.db` — SQLite store for the 9-layer nationwide pipeline
- `dedup-ledger.db` — cross-vertical dedup ledger
- Cache files (`.<vertical>-*-cache.json`) for resumability

## Tests

```bash
npm test
```

35 cases via `node:test` covering the cross-vertical dedup ledger and
the job tracker. Tests force SQLite `:memory:` via `configureLedger`
and `configureJobTracker` so they don't touch `output/*.db` and don't
require a running Postgres even if `DATABASE_URL` is set.

## Deployment

### Cloud Run

The `Dockerfile` and `env-vars.yaml` are set up for Cloud Run:

```bash
gcloud run deploy lead-pipeline \
  --source . \
  --region us-central1 \
  --env-vars-file env-vars.yaml \
  --memory 2Gi \
  --timeout 3600
```

### Railway

A `railway.toml` is included for one-command Railway deploy:

```bash
railway up
```

Set environment variables via `railway variables set KEY=value` or in
the Railway dashboard. The same Dockerfile is reused for both targets.

## Project structure

```
config/         vertical configs, target cities, message variety, KPIs
scrapers/       BrowserBase clients for Google Maps, Yelp, Clutch
enrichment/     Apollo, Perplexity, website scraping/extraction, dedup,
                cross-vertical dedup ledger, email guesser
export/         Instantly + PhantomBuster CSV generators, GCS upload,
                Instantly + Attio sync
services/       Instantly client, Slack notifier, structured logger
pipeline/       orchestrator, in-memory job tracker
nationwide/     9-layer dental-only pipeline (NPI ingest → export)
scripts/        one-off and batch scripts
tests/          node:test suites
```

## Known limitations

- **Only 3 of 22 verticals** have actually produced output to date (dental,
  hospital, contact center). The other 19 are configured but unrun.
- **Nationwide pipeline is dental-only** — Layers 1 and 7 hard-code dental
  taxonomy. Generalization is a known follow-up.
- **Attio CRM sync is a stub** (`export/attio-sync.js`).
- **Job tracker is now Postgres-backed** when `DATABASE_URL` is set (was
  in-memory; restart-survival is fixed).
- **No retry/resume** for failed scrapes — a vertical run that crashes
  loses uncommitted progress.
