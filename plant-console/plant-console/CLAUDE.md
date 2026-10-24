# Plant Console — guide for Claude

Internal operations app for **Leader Meat Packing Corp.** (meat packing & distribution).
Owner/admin: Fikret. Many staff use it at the same time on PCs and iPad/Android tablets.

## Layout & deploy

- App files live in `plant-console/plant-console/`:
  - `server.js` — the whole backend (plain Node `http`, **no npm dependencies**, Node ≥ 18).
  - `index.html` — the whole frontend (one file, vanilla JS, ~20k lines). **Uses CRLF line endings — keep them** (Python edits: read bytes, convert, write back with `\r\n`).
  - `render.yaml` — Render blueprint (env vars documented inline).
- Deployed on **Render** from `main`; every commit to `main` redeploys. Live URL: `https://plant-console-app-cu5c.onrender.com`.
- Persistent disk at `DATA_DIR=/var/data` holds all data and tokens. Without it everything resets on deploy.
- Fikret usually deploys by **uploading changed files through the GitHub web UI** ("Update server.js" commits). If your session can't push, hand him the changed files and say exactly which ones to upload, then `git reset --hard origin/main` once he has.
- After a deploy, users need **Ctrl+Shift+R** (the app is a single page; switching tabs doesn't reload code). `BUILD-xxxx` in Settings is not bumped automatically — don't rely on it.
- Before shipping: `node --check server.js`, and syntax-check the inline `<script>` from `index.html` (extract it and `node --check`). For behavior, run the server locally with a mocked `https.request` (QuickBooks/Google) and drive it with Playwright (Chromium is preinstalled). Default local login: `admin@facility.com` / PIN `1234`.

## How Fikret works

- Directs in real time with **screenshots and screen recordings**. Diagnose and act; don't stall on clarifying questions.
- When a fix is based on a guess about his QuickBooks data and it doesn't work, stop guessing and **add a diagnostic** (e.g. the Checks tab "why?" panel) to see the real records.
- Plain-language explanations; he isn't a full-time developer.

## Architecture rules

- **Server-authoritative "dumb terminal"**: browsers poll `/api/data` (~1.5 s) and send targeted writes. All access to the main data file goes through `withDataLock` / `readSharedData` / `writeSharedData` / `updateSharedData`. Items + transactions live in a separate file with their own lock (`withItemsTxnLock`) because they're multi-MB.
- **Atomic writes** everywhere (write temp file → rename).
- **Shared report caches**: one terminal pulls from QuickBooks, POSTs the bundle to `/api/<report>-report-cache`, every other terminal loads it instantly. Version the bundle (`v:`) when the shape changes, and ignore older versions rather than misreading them.
- Auth: `requireAuth` / `requireAdmin` / `requirePerm(permId)` on every route. Sessions are persisted (12 h TTL). Login is rate-limited per email.
- Background: QuickBooks Customers/Vendors sync every 30 min, items every 5 min; QuickBooks webhook at `/api/qb-webhook` (HMAC verified).
- Memory is tight on the Render instance (past OOM crashes) — never load whole-history QuickBooks pulls into one response; page by 100 via `/api/qb/documents?entity=…&startposition=…&from=…&to=…` (entity allow-list in `server.js`).

### Data files in `DATA_DIR`
`plant-data.json` (main shared data), `items-transactions.json`, `sessions.json`, `*-report-cache.json` (collection, cashflow, checks, purchase), `qb-tokens.json`, `plaid-tokens.json`, `gdrive-backup.json`, `backups/` (local hourly snapshots, 5 kept).

## QuickBooks

- Real company: **"Leader Meat Packing Corp"** (`QB_REALM`). Ignore "Leader Meat Packing Corp (Legacy)" and "Leader Slaughterhouse LLC".
- `PaymentMethodRef` comes back as an **id only** — resolve names via the `PaymentMethod` entity.
- Undeposited Funds is found by **account type/subtype**, not by name.
- Voided deposits keep their lines at **$0** — ignore $0 deposits/lines.
- $0 Payments are credit applications, not money.

## Feature notes (non-obvious rules)

- **Checks tab** (Reports → Checks): three stages, all from QuickBooks, no manual marking.
  - *In Hand*: payment in Undeposited Funds (or a non-bank account like "Cash On Hand") and not on any deposit.
  - *Deposited*: linked by a Deposit line (`LinkedTxn` Payment), by the payment's own line (`LinkedTxn` Deposit), or matched to an unlinked deposit customer line (same customer, exact amount, ±10 days); or received straight into a **Bank** account.
  - *Cleared*: `/api/qb/cleared-status` reads the TransactionList report (`cleared=Cleared|Reconciled|Uncleared`). If that looks unreliable, falls back to "3+ business days after deposit", labeled "Est.".
  - Excludes cash/card/electronic payments, shared-ref batches, blank refs, $0 payments. Deposits are fetched from 45 days before the 90-day payment window.
  - Open question (Oct 2026): Hamza Grocery Ref #192 ($306.56, deposited 7/20) still showed In Hand — use the row's "why?" panel output to fix matching.
- **Off-site backups**: nightly ~2 AM ET gzipped snapshot to Google Drive folder "Plant Console Backups" (drive.file scope), 30 daily + 12 monthly kept. Settings → Backup & restore. Env: `GOOGLE_OAUTH_CLIENT_ID/SECRET`; redirect `/gdrive/callback`. Restore accepts `.json.gz`.
- **Orders**: Day → Driver → Customer grouping; entering a count of 0 auto-reschedules the line to the next business day (original line stays visible, highlighted). Product autocomplete sorts by most recently purchased and fits the visible window.
- **Driver mileage**: Geoapify truck routing (trucks can't use NJ parkways); box trucks, not semis.
- **Purchasing**: product rows straight from the QuickBooks Item catalog; EST. = 13-week trailing average; REALIZED from Bills.
- **Permissions**: matrix UI in Settings; tab access enforced per user.

## Ideas queued
- Pricing module: USDA Market News wholesale prices (automatic) + manually entered Restaurant Depot / Costco prices vs. our cost and sales price → suggested price per product (suggest only, never change QuickBooks).
- Move from JSON files to Postgres; lot traceability for recalls.
