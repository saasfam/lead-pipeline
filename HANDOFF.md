# lead-pipeline — Handoff

> **You are taking this over from Richard.** This is the narrative + day-one runbook. The `README.md` next to it is reference material. Read this top-to-bottom once, then keep it open while you work the first day.
>
> No secrets are committed in this doc. Section 5 tells you which env vars you need; **get the actual values from Richard out-of-band** (he has them in `env-vars.yaml` locally, and they're already set on the Railway service).

---

## 1. TL;DR

`lead-pipeline` is a Node.js / Express service that scrapes business directories (Google Maps, Yelp, Clutch via BrowserBase), enriches the results with Apollo, Perplexity, and direct website extraction, generates personalized email sequences with OpenAI, and ships the leads to Instantly.ai. Twenty-two verticals are configured at 10K leads/each; only three (`dental`, `hospital`, `contactcenter`) have actually produced output.

The service is deployed to Railway with a Postgres database backing the cross-vertical dedup ledger and the job tracker. Both pieces of state survive redeploys. Tests pass (35 cases). The next-priority work is running the other 19 verticals and adding retry/resume for failed scrapes — see Section 10.

**Day one:** clone, `npm install`, `npm test` (35 pass), `npm run dev`, hit `http://localhost:8080/health`, then `curl https://lead-pipeline-production-1c21.up.railway.app/jobs` to see what's running in production.

---

## 2. What was built (May 9 2026 session)

Five concrete pieces, in order:

| Commit  | What changed | Why |
|---------|--------------|-----|
| `a9ce561` | Cross-vertical dedup ledger (initial SQLite) | Same business was getting hit from MSP, SaaS, and technology runs as if it were three different leads. Needed a persistent first-writer-wins ledger. |
| `0044c6c` | README + `railway.toml` | Project had zero documentation. Railway config so we could deploy with `railway up`. |
| `89c6f72` | Dedup ledger → dual-driver Postgres + SQLite | Railway filesystem is ephemeral; SQLite-only state would reset on every redeploy. Postgres when `DATABASE_URL` is set, SQLite for local dev. |
| `a430713` | Job tracker → dual-driver Postgres + SQLite | The job tracker was an in-memory `Map`. Every restart wiped job history. Same dual-driver pattern as the dedup ledger. |
| `eea16cf` | README sync | Documented `/dedup-stats` endpoint, Postgres-backed `/jobs`, and bumped test count to 35. |

Plus a new `HANDOFF.md` (this file).

---

## 3. Repos and external resources

| Resource | Value |
|----------|-------|
| **GitHub** | `anyreachai/lead-pipeline` — `master` is the live branch (originally created at `saasfam/lead-pipeline`, duplicated to the org on 2026-05-10; `saasfam` copy is now stale) |
| **Local clone** | `C:\Users\Lin Richard\lead-pipeline\` |
| **Railway project** | `lead-pipeline` · id `6178dd87-797d-4af8-8edb-0a165521c3d6` · workspace `saasfam's Projects` |
| **Railway app service** | `lead-pipeline` · id `f177131d-dbbe-4e40-a4d4-c934023bb56b` |
| **Production URL** | `https://lead-pipeline-production-1c21.up.railway.app` |
| **Postgres service** | `Postgres` · id `de6d16b3-545b-477d-a0af-cd7bfdfd627f` · wired into the app via `DATABASE_URL=${{Postgres.DATABASE_URL}}` |
| **Region** | EU West (change in Railway dashboard if US is preferred) |
| **GCS bucket** | `anyreach-lead-pipeline` (CSVs uploaded here from step 7 of the per-vertical pipeline) |
| **Sister project** | `anyreach-outbound-engine` ported 15 modules from this repo. New generalized work goes there, not here. |

---

## 4. Architecture

### Per-vertical pipeline

`pipeline/orchestrator.js`, called from `index.js` REST handlers.

```
POST /scrape-vertical {vertical, cities?}
  └─ runVerticalPipeline()
       1.  scrape ─────────── scrapers/google-maps.js, scrapers/yelp.js, scrapers/clutch.js
                              (dispatched by scrapers/scraper-registry.js)
       2.  in-vertical dedup ── enrichment/dedup.js (in-memory, by domain or normalized name)
       2b. cross-vertical dedup by NAME ── enrichment/cross-vertical-dedup.js
                              (Postgres if DATABASE_URL else SQLite)
       3.  resolve domains ── enrichment/domain-resolver.js
       3b. cross-vertical dedup by DOMAIN ── same module
       4.  Apollo people search ── enrichment/apollo-people-search.js
                              (per-vertical title filters from config/verticals.js)
       5.  verify emails ── enrichment/apollo-verify.js
       6.  generate CSVs ── export/instantly-csv.js, export/phantombuster-csv.js
       7.  upload to GCS ── export/gcs-upload.js (bucket: anyreach-lead-pipeline)
       8.  sync to Instantly ── export/instantly-sync.js, services/instantly.js
       9.  Slack notify ── services/slack.js
       └─ persisted via pipeline/job-tracker.js (Postgres or SQLite)
```

### Nationwide pipeline (dental-only)

A separate flow for high-volume dental ingest from the NPI registry.

```
node scripts/run-nationwide.js --layer N [--state CA --tier A --sample 100]
  └─ nationwide/cli.js → nationwide/runner.js
       L1 nationwide/layers/layer1-npi.js          NPI registry ingest (taxonomy 1223*)
       L2                  layer2-domain-guess.js   name → guessed domain
       L3                  layer3-directories.js    yelp/healthgrades/etc.
       L4                  layer4-knowledge-graph.js Google KG
       L5                  layer5-website-enrichment.js fetch + extract
       L6                  layer6-email-guess.js    pattern guesses
       L7                  layer7-google-places.js  Places API enrichment (dental-specific)
       L8                  layer8-sequences.js      OpenAI sequences
       L9                  layer9-export.js         Instantly CSV
       └─ all stored in nationwide/store.js → output/nationwide.db (SQLite, ~63MB)
```

L1 hard-codes the dental taxonomy `1223*`; L7 has dental-specific Places logic. Generalizing to other verticals is on the open list.

### Persistent state — the dual-driver pattern

This is the one thing in the codebase you should internalize before touching anything.

Two modules use it: `enrichment/cross-vertical-dedup.js` and `pipeline/job-tracker.js`. They behave identically:

- **Backend selection** happens on first call:
  - `DATABASE_URL` set → Postgres (Railway, Cloud Run with Cloud SQL)
  - else → SQLite at `output/dedup-ledger.db` and `output/jobs.db`
- All exported functions are `async`. Tests force SQLite `:memory:` via `configureLedger({ sqlitePath: ':memory:' })` and `configureJobTracker({ sqlitePath: ':memory:' })`.
- Result: `npm test` works without any DB. Railway production uses Postgres automatically. Local dev uses SQLite without configuration.

Tables both use `INSERT … ON CONFLICT DO NOTHING` (Postgres) and `INSERT OR IGNORE` (SQLite) so concurrent writers can't double-claim a key.

---

## 5. Day-one setup

```bash
git clone git@github.com:anyreachai/lead-pipeline.git
cd lead-pipeline
npm install
# If your local Node isn't 20.x, fix the better-sqlite3 native bindings:
npm rebuild better-sqlite3
```

Create `.env` at the repo root with the keys below. `.env` is gitignored. **Get the actual values from Richard** — they live in `env-vars.yaml` on his local machine (also gitignored) and on the Railway service. Three ways to obtain them:

- Ask Richard for `env-vars.yaml` directly (fastest).
- `railway variables list --service lead-pipeline` once you're added to the Railway workspace (`saasfam's Projects`).
- For each variable, `railway variables list --kv` will print `KEY=value` pairs you can paste straight into `.env`.

Required variables (template):

```dotenv
BROWSERBASE_API_KEY=<from env-vars.yaml>
BROWSERBASE_PROJECT_ID=<from env-vars.yaml>
APOLLO_API_KEY=<from env-vars.yaml>
PERPLEXITY_API_KEY=<from env-vars.yaml>
OPENAI_API_KEY=<from env-vars.yaml>
INSTANTLY_API_KEY=<from env-vars.yaml>
GCS_BUCKET=anyreach-lead-pipeline
# env-vars.yaml has a placeholder for Slack — get the real webhook from
# Richard before running anything that posts to Slack:
SLACK_WEBHOOK_URL=<get from Richard>

# Optional — only if you want the Instantly upload step to actually push.
# Pull the campaign ID from app.instantly.ai for the campaign you're targeting.
INSTANTLY_CAMPAIGN_ID=

# Optional — Attio integration is currently a stub. Skip unless you fill
# in export/attio-sync.js.
# ATTIO_API_KEY=

# Optional — leave unset to use local SQLite. Set to a Postgres URL to
# match production behavior locally.
# DATABASE_URL=postgres://...
```

If you prefer the Cloud Run format, `env-vars.yaml` is the same shape — `gcloud run deploy --env-vars-file env-vars.yaml` works directly.

Then verify:

```bash
npm test                                    # 35 cases pass
npm run dev                                 # Express on :8080, watch mode
curl http://localhost:8080/health           # {"status":"ok",...}
curl http://localhost:8080/dedup-stats      # {"backend":"sqlite",...} locally
```

If you set `DATABASE_URL` and re-curl `/dedup-stats`, `backend` flips to `"pg"`.

---

## 6. How to run things

| What | Command |
|------|---------|
| Trigger one vertical (REST) | `curl -X POST http://localhost:8080/scrape-vertical -H 'Content-Type: application/json' -d '{"vertical":"dental","cities":["Austin"]}'` → returns `202`, runs in background |
| Run all 22 verticals | `curl -X POST http://localhost:8080/scrape-all` |
| Apollo for specific domains | `curl -X POST http://localhost:8080/enrich-domains -H 'Content-Type: application/json' -d '{"domains":["acme.com"],"vertical":"msp"}'` |
| Dental nationwide layer | `node scripts/run-nationwide.js --layer 2 --state CA --sample 100` (see `nationwide/cli.js` for full flag set) |
| Re-enrich existing leads | `node scripts/enrich-signals.js`, `enrich-websites.js`, `enrich-emails.js` |
| Generate sequences | `node scripts/generate-messages.js`, `generate-vertical-sequences.js` |

One-off scripts in `scripts/` often hard-code paths or options — read each before running.

---

## 7. Operational endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/health` | Liveness probe (Railway healthcheck) |
| POST | `/scrape-vertical` | Run pipeline for one vertical (async, 202) |
| POST | `/scrape-all` | Run all 22 verticals sequentially |
| POST | `/enrich-domains` | Apollo people search for a list of domains |
| GET  | `/jobs` | Newest-first job list, Postgres-backed |
| GET  | `/status/:jobId` | One job's full state |
| GET  | `/dedup-stats?vertical=msp` | Cross-vertical dedup ledger stats: `{backend, total, byKeyType, byVertical}` |

`/jobs` and `/dedup-stats` lazily create their backing tables on first hit. After a fresh deploy they'll work immediately even if no pipeline has run yet.

---

## 8. Deployment

### Railway (current production)

```bash
railway up                                  # deploy from current dir
railway status                              # confirm Online
railway logs --lines 100                    # tail logs
railway variables list                      # see env vars
railway variables set KEY=value             # set/update an env var
```

`railway.toml` reuses the Dockerfile. Healthcheck is `/health`. After deploy, sanity-check with:

```bash
curl https://lead-pipeline-production-1c21.up.railway.app/health
curl https://lead-pipeline-production-1c21.up.railway.app/dedup-stats
# expect "backend":"pg"
```

### Cloud Run (alternative)

The repo also has Cloud Run plumbing:

```bash
gcloud run deploy lead-pipeline \
  --source . \
  --region us-central1 \
  --env-vars-file env-vars.yaml \
  --memory 2Gi \
  --timeout 3600
```

Same `Dockerfile` (`node:20-slim`), so the image is identical.

---

## 9. Tests

```bash
npm test
```

35 cases via `node:test`:
- `tests/cross-vertical-dedup.test.js` — 21 cases on the dual-driver dedup ledger
- `tests/job-tracker.test.js` — 14 cases on the dual-driver job tracker

Both suites force SQLite `:memory:` via the `configure*({sqlitePath:':memory:'})` API, so tests don't require Postgres. To add tests for a new module that follows the same pattern, copy the `setupFreshLedger` / `setupFreshTracker` helper.

---

## 10. What's still open (prioritized)

1. **First end-to-end run on a fresh vertical** — `dental`, `hospital`, `contactcenter` have produced output via the old scripts. The new orchestrator path (message generation + per-vertical campaign + inbox provisioning) has tests but has not yet been run against a live vertical. Suggested smoke test: `POST /scrape-vertical {"vertical":"msp","cities":["Austin"]}` with `MESSAGES_MAX_PER_VERTICAL=20` and `INSTANTLY_AUTO_ORDER=false` — confirms scrape → enrich → Perplexity → OpenAI sequence → draft campaign creation → lead upload all the way through without spending on mailboxes.
2. **Set the inbox-order budget knobs.** `INSTANTLY_AUTO_ORDER` and `INSTANTLY_MAX_MAILBOXES_PER_RUN` default to plan-only. Set them once Richard is comfortable that the order plans look right (visible in `/provision-inboxes` response and orchestrator job stats).
3. **Verify per-vertical landing pages exist.** `LANDING_SLUGS` in `config/verticals.js` maps every vertical to `anyreach.ai/<slug>`. Marketing may not have shipped all 22 yet. `GET /verticals` returns the current mapping; ping for each URL and either ship the page or update the slug.
4. **Retry/resume for failed scrapes** — *medium.* Failures currently log-and-skip. A vertical run that crashes loses uncommitted progress.
5. **Generalize the nationwide pipeline beyond dental** — *medium.* L1 (NPI taxonomy) and L7 (Google Places) need to read the vertical from a parameter rather than the hard-coded `1223*`.
6. **Attio CRM sync** — *low–medium.* `export/attio-sync.js` is a placeholder; the env-vars file marks it `# Phase 4`.
7. **Volume on `/app/output`** — *low.* Railway filesystem is ephemeral; cache files reset on redeploy. Lower priority because dedup ledger and jobs are now in Postgres, and CSVs go to GCS.

## 10b. New since May 9 handoff (2026-05-11)

Per-vertical end-to-end is now wired in the orchestrator:

| File | Purpose |
|------|---------|
| `pipeline/generate-messages.js` | New orchestrator step — Perplexity signals per unique domain + OpenAI 4-step sequence per contact. Attaches `personalizedMessage`, `sequenceStep2/3/4`, `messageFlag='ready'`. Without this step the orchestrator silently uploaded zero leads because `instantly-sync.js` filters on `messageFlag === 'ready'`. |
| `export/instantly-campaign.js` | `ensureCampaignForVertical()` — idempotent per-vertical draft campaign. Reuses existing campaign by name (`Anyreach - {Label} - YYYY-MM`), else creates + attaches warmed accounts. |
| `services/inbox-orderer.js` | `planInboxOrder()` (pure) + `provisionInboxes()`. Gated by `INSTANTLY_AUTO_ORDER` and `INSTANTLY_MAX_MAILBOXES_PER_RUN`. |
| `enrichment/lander-url.js` | Tiny utility that re-attaches the landing URL after LLM generation. Separate from `openai-messages.js` so tests can pull it in without `OPENAI_API_KEY`. |
| `config/verticals.js` | New `LANDING_SLUGS` map + `landingPageFor(key)` + `landingHost()`. Driven by `LANDING_PAGE_BASE` env. |
| New endpoints in `index.js` | `POST /provision-inboxes`, `POST /provision-campaign`, `GET /verticals`. |
| New env vars | `LANDING_PAGE_BASE`, `INSTANTLY_TARGET_DAILY_VOLUME`, `INSTANTLY_TARGET_DAILY_VOLUME_PER_VERTICAL`, `INSTANTLY_AUTO_ORDER`, `INSTANTLY_MAX_MAILBOXES_PER_RUN`, `MESSAGES_MAX_PER_VERTICAL`, `MESSAGES_CONCURRENCY`, `MESSAGES_ENABLED`. |
| New tests | 16 cases across `tests/landing-page.test.js`, `tests/inbox-orderer.test.js`, `tests/instantly-campaign.test.js`. Total now 51, all passing. |

## 10c. Pluggable email verification (2026-05-11, follow-up)

Apollo email verify is ~$0.04/email; on the 220K-lead audit that's $8,800
(64% of API spend). MillionVerifier offers the same SMTP-level check at
~$0.005/email — same accuracy on independent benchmarks, 8× cheaper.

The swap is an env-var change, not a code change:

- `enrichment/email-verify.js` — provider-agnostic wrapper. Orchestrator
  now imports from here (`pipeline/orchestrator.js`).
- `enrichment/verifiers/millionverifier.js` — MillionVerifier v3 client
  with result-code mapping + 50/s rate limiter.
- `EMAIL_VERIFY_PROVIDER=apollo` (default, behavior unchanged).
- `EMAIL_VERIFY_PROVIDER=millionverifier` + `MILLIONVERIFIER_API_KEY=...`
  to swap. Failure to set the key throws (no silent fallback).
- `MILLIONVERIFIER_INCLUDE_CATCHALL=true` to treat catch-all servers as
  deliverable (higher bounce risk).

11 new tests cover result-code mapping, provider dispatch, network failure,
and the catch-all opt-in. Total 64, all passing.

---

## 11. Gotchas

- **`better-sqlite3` native module mismatch.** After a Node version change you'll see `NODE_MODULE_VERSION` errors. Fix: `npm rebuild better-sqlite3`.
- **`env-vars.yaml` and `.env` are gitignored — keep it that way.** Both contain real production keys. If you ever need to share them, do it out-of-band (1Password, encrypted DM), never via the repo, public chat, or screenshots.
- **Railway filesystem is ephemeral.** SQLite writes to `output/` on the deployed service reset on redeploy. Postgres is durable; GCS is durable; everything else in `output/` is throwaway.
- **The repo had ~12 modified files and ~14 untracked files** in the working tree at the start of this session that weren't part of the deploy work. They're still uncommitted at the time of this handoff (look at `git status`). They are someone's prior in-progress work — don't bundle them into your commits. Use specific `git add <path>` and check `git diff --cached` before committing.
- **`package.json` includes `xlsx`** as a dep that came from prior work. Keep it unless you confirm nothing reads `.xlsx` (the `Hospital Information Spreadsheet_JAN2025.xlsx` in the working tree suggests it's used).
- **Job tracker is async now.** Every call site in `pipeline/orchestrator.js` and `index.js` was updated. If you add new code that touches the tracker, remember to `await`.

---

## 12. Where Claude session context lives

If you're using Claude Code on this repo:

- `C:\Users\Lin Richard\.claude\projects\C--Users-Lin-Richard\memory\lead-pipeline.md` — current state of the project (Railway URL, IDs, dual-driver pattern, deploy date).
- `C:\Users\Lin Richard\.claude\projects\C--Users-Lin-Richard\memory\MEMORY.md` — index that points at the lead-pipeline entry.

Starting a Claude session in this repo: just open it; the auto-memory system loads the index automatically. If you want it to use a specific note, mention "see lead-pipeline.md memory" in your first message.

---

## Verification — the new owner should be able to do all of this on day one

1. `git clone`, `npm install`, `npm rebuild better-sqlite3` if needed.
2. Paste the `.env` block from Section 5.
3. `npm test` → 35 cases pass.
4. `npm run dev` → server boots, `/health` returns 200.
5. `curl …/dedup-stats` → `{"backend":"sqlite",…}` locally.
6. `curl https://lead-pipeline-production-1c21.up.railway.app/dedup-stats` → `{"backend":"pg",…}`.
7. `railway status` → Online, EU West.
8. `git log --oneline -5` matches the table in Section 2.
