# lead-pipeline

Multi-vertical lead generation pipeline for Anyreach outbound. End-to-end
flow per vertical: scrape directories (Google Maps, Yelp, Clutch) → enrich
via Apollo and website extraction → fetch Perplexity signals → generate
4-step personalized email sequences with OpenAI → provision a draft
Instantly campaign with sequence templates + warmed accounts → optionally
order DFY mailboxes to close the capacity deficit → upload leads to that
campaign with per-vertical landing-page CTAs.

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
GCS_BUCKET=anyreach-lead-pipeline
GOOGLE_APPLICATION_CREDENTIALS_JSON=...  # full service-account key JSON (Railway) — falls back to ADC locally
SLACK_WEBHOOK_URL=...

# Email verification provider (pluggable — Apollo verify is ~$0.04/email,
# MillionVerifier is ~$0.005/email, so swapping cuts a 220K-lead run by ~$7,700)
EMAIL_VERIFY_PROVIDER=apollo                     # apollo (default) | millionverifier
MILLIONVERIFIER_API_KEY=                         # required when EMAIL_VERIFY_PROVIDER=millionverifier
MILLIONVERIFIER_INCLUDE_CATCHALL=false           # set true to accept catch_all results as deliverable (higher bounce risk)

# People search provider (Apollo ~$0.04/contact, Hunter ~$0.01/domain).
# "auto" routes SMB verticals to hunter-then-apollo waterfall and keeps
# mid-market verticals on Apollo. Saves ~$2K on a full 220K-lead run.
PEOPLE_SEARCH_PROVIDER=apollo                    # apollo | hunter | hunter-then-apollo | auto
HUNTER_API_KEY=                                  # required for any non-apollo value

# Signals provider — replaces Perplexity (~$0.005/req) with Apollo org fields
# + a website scrape (~$0.001 per domain via existing website-extractor).
# Saves ~$550 on a full 220K-lead run and removes the Perplexity dep.
SIGNALS_PROVIDER=apollo-website                  # apollo-website (default) | apollo-only | perplexity

# Nationwide pipeline (nationwide/layers/*) — optional Google enrichment.
# If either key is absent the corresponding layer logs a structured
# feature_disabled warning and skips (the run still succeeds without it).
GOOGLE_KG_API_KEY=                               # nationwide layer 4 — Google Knowledge Graph entity lookups
GOOGLE_PLACES_API_KEY=                           # nationwide layer 7 — Google Places business details

# Optional — pipeline behavior knobs
INSTANTLY_CAMPAIGN_ID=...                        # override per-vertical campaign provisioning with a single fixed ID
INSTANTLY_TARGET_DAILY_VOLUME_PER_VERTICAL=500   # used to size warmed-account assignment and inbox order plans (per vertical)
INSTANTLY_TARGET_DAILY_VOLUME=5000               # used by /provision-inboxes when no body is provided
MESSAGES_MAX_PER_VERTICAL=1000                   # hard cap on OpenAI sequence generations per vertical run
MESSAGES_CONCURRENCY=5                           # parallel Perplexity + OpenAI calls
MESSAGES_ENABLED=true                            # set to "false" to skip the message-generation step
LANDING_PAGE_BASE=https://anyreach.ai            # change to staging URL for testing

# Inbox auto-ordering (gated; safe by default)
INSTANTLY_AUTO_ORDER=false                       # MUST be "true" to actually submit DFY mailbox orders
INSTANTLY_MAX_MAILBOXES_PER_RUN=0                # hard per-run cap on DFY mailbox orders; 0 = plan-only

# ATTIO_API_KEY=...   # optional, integration is currently a stub
```

The two safety gates `INSTANTLY_AUTO_ORDER` and `INSTANTLY_MAX_MAILBOXES_PER_RUN`
must both be set before any DFY mailbox order leaves the process. The default
configuration is plan-only — the pipeline computes a deficit, logs a plan, posts
it to Slack, but does NOT submit the order until you opt in.

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
| `POST` | `/provision-inboxes` | `{ targetDailyVolume? }` | Check Instantly capacity + plan a DFY mailbox order. Submits only when `INSTANTLY_AUTO_ORDER=true` AND `INSTANTLY_MAX_MAILBOXES_PER_RUN > 0`. |
| `POST` | `/provision-campaign` | `{ vertical }` | Idempotently create the per-vertical Instantly draft campaign |
| `GET`  | `/verticals` | — | Configured verticals with their landing-page URLs |
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
1.  Scrape directories (Google Maps + Yelp/Clutch where configured)
2.  In-vertical dedup (by domain, fallback to normalized name)
2b. Cross-vertical dedup by name (skip businesses already claimed)
3.  Resolve domains
3b. Cross-vertical dedup by domain (catches name-spelling variants)
4.  Apollo people search (decision-maker titles per vertical config)
5.  Verify emails (Apollo)
5c. Generate 4-step OpenAI sequences (Perplexity signals + per-vertical landing page in CTA)
6.  Generate Instantly + PhantomBuster CSVs
7.  Upload to GCS (falls back to local if GCS unavailable)
8.  Provision inboxes + per-vertical draft campaign + upload leads:
    - Check Instantly capacity vs target volume; plan a DFY mailbox order
    - Submit the order only if INSTANTLY_AUTO_ORDER=true AND a per-run cap is set
    - Idempotently create the "Anyreach - {Vertical} - YYYY-MM" draft campaign
    - Attach up to ceil(target / 30) warmed accounts
    - Upload ready leads to that campaign (Richard launches manually after review)
9.  Slack notification (includes capacity report + campaign info)
```

### Per-vertical landing pages

Every vertical maps to a landing-page URL under `LANDING_PAGE_BASE` (default
`https://anyreach.ai`). The slug for each vertical is defined in
`config/verticals.js` (`LANDING_SLUGS`). The CTA pool in
`config/message-variety.js` contains `[lander]` placeholders; the generator
substitutes the URL at prompt-time AND `ensureLanderUrl()` re-attaches the URL
deterministically after generation as defense-in-depth against the LLM dropping
it. The same URL is exposed as the `landing_page` custom variable on the
Instantly lead so it's available in any campaign-level template.

### Inbox provisioning (DFY mailboxes)

`services/inbox-orderer.js` checks Instantly's warmed-account capacity against
a target daily volume, then computes an order plan against
`/dfyemailaccountorder/prewarmedupdomainslist`. Plans are always logged and
Slack-able; the actual order POST is gated behind two env vars
(`INSTANTLY_AUTO_ORDER=true` AND `INSTANTLY_MAX_MAILBOXES_PER_RUN > 0`) and
has a hard internal ceiling of 500 mailboxes per run regardless of env config.

### Pluggable people search

`enrichment/people-search.js` dispatches between Apollo (the original) and
Hunter.io. Hunter is cheaper (~$0.01/domain vs Apollo's ~$0.04/contact)
but has weaker title disambiguation at senior/executive levels, so it's
not a drop-in for every vertical.

| Provider | When to use |
|---|---|
| `apollo` (default) | Unchanged behavior. Best title accuracy. |
| `hunter` | Pure cost play — Hunter for everything. Risk: 20-30% coverage hit on mid-market titles. |
| `hunter-then-apollo` | Per-domain waterfall. Try Hunter; fall back to Apollo when Hunter returns <2 contacts. |
| `auto` | SMB verticals → `hunter-then-apollo`, mid-market verticals → `apollo`. This is the recommended setting for cost-efficient full-target runs. Routing list lives in `HUNTER_SAFE_VERTICALS` inside `enrichment/people-search.js`. |

Each returned contact is tagged with `peopleSearchProvider` so you can A/B
reply rates between Hunter-sourced and Apollo-sourced cohorts after a run.

### Pluggable signals (Perplexity replacement)

`enrichment/signals.js` decouples message-generation signals from any single
provider. The default `apollo-website` mode synthesizes the Perplexity-shaped
output from Apollo's org-level enrichment fields (which `apollo-people-search.js`
now captures and propagates) plus a single website scrape via the existing
`website-extractor.js` (gpt-4o-mini). Total cost ~$0.001/domain vs
Perplexity's ~$0.005.

| Provider | Behavior |
|---|---|
| `apollo-website` (default) | Apollo fields + LLM extraction of company description and specialties from the website. |
| `apollo-only` | Apollo fields only — no website scrape. Cheapest. Hooks degrade when Apollo `short_description` is empty. |
| `perplexity` | Legacy path. Kept for A/B comparison; not used by default. |

### Pluggable email verification

`enrichment/email-verify.js` dispatches to a provider chosen by
`EMAIL_VERIFY_PROVIDER`. The orchestrator always calls this abstraction;
swapping providers is an env-var change, not a code change.

| Provider | Cost / verify | Notes |
|---|---|---|
| `apollo` (default) | ~$0.04 | Uses existing Apollo `email_verification/verify` endpoint. Same behavior as before this change. |
| `millionverifier` | ~$0.005 | ~8× cheaper. Requires `MILLIONVERIFIER_API_KEY`. Maps `ok` → valid, `disposable` → invalid, `catch_all` → unknown (set `MILLIONVERIFIER_INCLUDE_CATCHALL=true` to accept catch-all as deliverable). |

For a full 220K-lead run, swapping to MillionVerifier cuts ~$7,700 from the
audit budget without changing any code paths downstream — the verifier
attaches `emailVerifyProvider` to each lead for retrospective A/B analysis.

### Per-vertical Instantly campaigns

`export/instantly-campaign.js` creates one `Anyreach - {Label} - YYYY-MM` draft
campaign per vertical-month. The campaign body references the per-lead custom
variables (`{{personalized_message}}`, `{{sequence_step_2}}`, etc.) so the same
campaign template renders unique copy per lead. Status is left at draft;
Instantly only sends after a manual Launch in the UI.

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

51 cases via `node:test` covering the cross-vertical dedup ledger, the
job tracker, the per-vertical landing-page helpers, the inbox-order planner,
and the per-vertical campaign body builder. Tests force SQLite `:memory:`
via `configureLedger` and `configureJobTracker` so they don't touch
`output/*.db` and don't require a running Postgres even if `DATABASE_URL`
is set. The new tests use pure helpers (no Instantly API calls).

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
  hospital, contact center). The other 19 are configured but unrun — the
  orchestrator + `/scrape-vertical` now handles them end-to-end (message
  generation included).
- **Per-vertical landers may not all exist yet.** `LANDING_SLUGS` maps every
  vertical to a URL under `anyreach.ai/`; if a landing page hasn't shipped
  for a given vertical the CTAs still point at the URL (will 404 until
  marketing publishes it). Override per-environment with `LANDING_PAGE_BASE`.
- **Campaigns ship in draft state.** Auto-launch is intentionally not wired —
  Richard reviews each campaign in the Instantly UI and clicks Launch.
- **DFY inbox orders require explicit opt-in.** Default behavior is
  plan-only; setting `INSTANTLY_AUTO_ORDER=true` and a non-zero
  `INSTANTLY_MAX_MAILBOXES_PER_RUN` is required to actually charge for
  mailboxes. The internal hard cap is 500/run regardless.
- **Nationwide pipeline is dental-only** — Layers 1 and 7 hard-code dental
  taxonomy. Generalization is a known follow-up.
- **Attio CRM sync is a stub** (`export/attio-sync.js`).
- **No retry/resume** for failed scrapes — a vertical run that crashes
  loses uncommitted progress.
