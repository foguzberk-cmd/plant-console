const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const QB_REALM = process.env.QB_REALM || '';
const CLIENT_ID = process.env.QB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.QB_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.QB_REDIRECT_URI || 'https://plant-console-app.onrender.com/callback';
// From the Intuit Developer Portal's Webhooks page (a separate secret from
// CLIENT_ID/CLIENT_SECRET) — used to verify that an incoming webhook POST
// genuinely came from Intuit and wasn't forged by sending a fake "everything
// changed" payload at this endpoint. Webhooks simply won't work without this
// set, but the rest of the app (including the existing background sync) is
// unaffected if it's missing.
const QB_WEBHOOK_VERIFIER_TOKEN = process.env.QB_WEBHOOK_VERIFIER_TOKEN || '';

// Fail loudly rather than silently running with a broken QuickBooks integration.
// (Previously these had real credentials hardcoded as fallback defaults — that
// meant the secrets shipped in source control. They must now be set as
// environment variables in Render, never committed to the repo.)
if (!QB_REALM || !CLIENT_ID || !CLIENT_SECRET) {
  console.warn('WARNING: QB_REALM, QB_CLIENT_ID, and/or QB_CLIENT_SECRET are not set. ' +
    'Set them as environment variables in Render (Dashboard -> plant-console -> Environment). ' +
    'The app will still start, but QuickBooks features will not work until these are configured.');
}

// ===== SHARED DATA STORE (so logins & data work the same across browsers/devices) =====
// Everything the app used to keep ONLY in each browser's localStorage (items,
// transactions, storages, users) is now also persisted here as a single JSON
// file on the server, so every browser/device reads and writes the same data.
// NOTE: this is a simple single-file store — fine for a small team on one
// running instance, but it does NOT survive a fresh deploy unless DATA_DIR
// points at a Render persistent disk, and it is not safe for multiple
// server instances running at once (last write wins).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'plant-data.json');
// items + transactions live in their OWN file with their OWN lock,
// separate from everything else (orders, chat messages, users, etc. — see
// DATA_FILE above). Reasoning: these two are frequently multiple MB
// (hundreds of items, thousands of transaction/movement rows from years
// of synced Bills/Invoices), and JSON.stringify/parse of a multi-MB
// payload is a genuinely slow, SYNCHRONOUS operation that blocks Node's
// single thread — during that block, literally nothing else on the
// server can run. Confirmed live (Sep 2026): a Full Sync's push of the
// whole items+transactions array was blocking completely unrelated
// requests — an order save, chat message polling, everything — because
// they all shared one lock/file with items+transactions. Splitting them
// into their own file+lock means a huge items/transactions write can
// only ever block ANOTHER items/transactions operation, never an order
// save or anything else.
const ITEMS_TXN_FILE = path.join(DATA_DIR, 'items-transactions.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
// Separate file, not bundled into DATA_FILE — this can hold thousands of
// invoices/payments and shouldn't bloat every read/write of the main,
// far-more-frequently-touched shared data file.
const COLLECTION_CACHE_FILE = path.join(DATA_DIR, 'collection-report-cache.json');
// Same idea as COLLECTION_CACHE_FILE, for the Scheduled Payments (Cash Flow)
// tab's open-Bills/open-Invoices pull — previously this data was never
// persisted anywhere at all (in-memory only on whichever browser pulled
// it), so every other terminal had to redo the full slow pull itself, and
// even the SAME browser lost it on a page refresh.
const CASHFLOW_CACHE_FILE = path.join(DATA_DIR, 'cashflow-report-cache.json');
// Same idea, for the Checks tab's raw QuickBooks Payment pull — see the
// long comment on /api/checks-report-cache below for why this was missing.
const CHECKS_CACHE_FILE = path.join(DATA_DIR, 'checks-report-cache.json');
// Same idea, for the new Purchasing report tab's weekly Bill-pull-and-match
// results — see the long comment on /api/purchase-report-cache below.
const PURCHASE_CACHE_FILE = path.join(DATA_DIR, 'purchase-report-cache.json');
// Sessions used to be in-memory only, which meant ANY server restart —
// a crash, a redeploy, Render recycling the instance — silently logged
// every single person out at once, with no warning: the next request from
// their still-open tab would 401, because the token their browser was
// holding no longer matched anything in a freshly empty Map. Persisting to
// disk (same DATA_DIR the rest of the shared data already lives on) means a
// restart is invisible to whoever's already logged in.
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const DATA_DEFAULT = { storages: [], users: [], scaleLogs: [], labelAllowed: {}, savedReports: [], customers: [], customerAllowed: [], labelTemplates: {}, deletedScaleLogIds: [], cfScheduledDates: {}, deletedCfBillIds: [], deletedCfSplitIds: [], chatMessages: [], orders: [], deletedOrderIds: [], drivers: [], deletedDrivers: [],
  // Weekly Purchase Report (Reports → Purchasing): purchaseConfig holds the
  // admin-configured row/column definitions (which products, which vendor
  // columns, which weeks exist) — small, rarely-changed, keyed by id so it
  // merges the same way labelTemplates does. purchaseEstimates holds the
  // manually-typed EST. numbers, keyed [weekId][productId][vendorColId] —
  // REALIZED numbers are never stored here; they're computed fresh from
  // QuickBooks Bills on demand and only cached separately (see
  // PURCHASE_CACHE_FILE) since they're derived data, not source-of-truth.
  purchaseConfig: { products: {}, vendorCols: {}, weeks: {} },
  purchaseEstimates: {}
};

// ===== PIN HASHING =====
// PINs are hashed with scrypt before they ever touch disk. Any user record
// still carrying a plaintext `pin` (from before this change) is transparently
// upgraded to `pinHash` the next time that user logs in successfully.
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPin(pin, pinHash) {
  if (!pinHash || pinHash.indexOf(':') === -1) return false;
  const [salt, storedHash] = pinHash.split(':');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch (e) {
    return false;
  }
}

function defaultAdmin() {
  return {
    id: 'user_default',
    name: 'Administrator',
    email: 'admin@facility.com',
    role: 'admin',
    pinHash: hashPin('1234'),
    perms: {}
  };
}

async function ensureDataFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) await fs.promises.mkdir(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
      const seeded = Object.assign({}, DATA_DEFAULT, { users: [defaultAdmin()] });
      await fs.promises.writeFile(DATA_FILE, JSON.stringify(seeded, null, 2));
      console.log('No data file found — created one with a default admin (admin@facility.com / PIN 1234). Change this PIN immediately.');
    }
  } catch (e) {
    console.error('Could not prepare shared data file:', e.message);
  }
}

// ===== SERIALIZED ACCESS =====
// Async (non-blocking) file I/O fixed the earlier problem of one huge
// read/write freezing the whole server, but it opened a new one: multiple
// requests can now overlap on the SAME file. E.g. request A reads the file,
// request B reads + writes (adding a new user), then A finishes and writes
// back its now-stale copy — silently erasing B's new user. This queue makes
// every data-file operation wait its turn, so reads/writes are still
// non-blocking for the rest of the server, but never interleave with each
// other. All access to DATA_FILE must go through withDataLock().
let _dataLock = Promise.resolve();
function withDataLock(fn) {
  const run = _dataLock.then(fn, fn);
  _dataLock = run.then(() => {}, () => {}); // keep the chain alive even if fn throws
  return run;
}

// Internal, lock-free implementations. Only call these from inside
// withDataLock() — calling them directly risks the exact race described above.
async function _readSharedDataUnlocked() {
  await ensureDataFile();
  try {
    const raw = await fs.promises.readFile(DATA_FILE, 'utf8');
    const data = Object.assign({}, DATA_DEFAULT, JSON.parse(raw || '{}'));
    // labelAllowed used to be a flat array shared across all departments;
    // it's now an object keyed by department. If a pre-migration array is
    // still on disk, don't let it flow through as-is (every downstream
    // merge assumes an object) — clients already migrate their own local
    // copy on load and will push the correct per-department shape on their
    // next save, so it's safe to just reset this to empty in the meantime.
    if (Array.isArray(data.labelAllowed)) data.labelAllowed = {};
    // Defensive: never let the app get into a state where no user can log in.
    if (!Array.isArray(data.users) || data.users.length === 0) {
      data.users = [defaultAdmin()];
      await _writeSharedDataRawUnlocked(data);
      console.log('Users list was empty — re-seeded default admin (admin@facility.com / PIN 1234).');
    }
    return data;
  } catch (e) {
    console.error('Could not read shared data file:', e.message);
    return Object.assign({}, DATA_DEFAULT, { users: [defaultAdmin()] });
  }
}

async function _writeSharedDataRawUnlocked(data) {
  await ensureDataFile();
  // Write atomically: write the full contents to a temp file first, then
  // rename it over the real data file. A plain writeFile() to DATA_FILE
  // truncates it before the new bytes are written, so a crash/restart/OOM
  // kill mid-write (Render can do any of these) can leave a truncated or
  // corrupt JSON file — the next read would then fail to parse and fall
  // back to an empty default state in memory. rename() on the same
  // filesystem is a single atomic operation: the file on disk is always
  // either the old complete version or the new complete version, never a
  // partial one.
  const tmpFile = DATA_FILE + '.tmp-' + process.pid + '-' + Date.now();
  await fs.promises.writeFile(tmpFile, JSON.stringify(data, null, 2));
  await fs.promises.rename(tmpFile, DATA_FILE);
}

async function _writeSharedDataUnlocked(data) {
  // Strip plaintext pins on every write and migrate them to pinHash, so a
  // plaintext PIN never sits on disk even transiently.
  if (Array.isArray(data.users)) {
    data.users = data.users.map(u => {
      if (u && typeof u.pin === 'string' && u.pin.length) {
        const migrated = Object.assign({}, u, { pinHash: hashPin(u.pin) });
        delete migrated.pin;
        return migrated;
      }
      return u;
    });
  }
  await _writeSharedDataRawUnlocked(data);
}

// Public API — every caller elsewhere in this file goes through these.
function readSharedData() {
  return withDataLock(_readSharedDataUnlocked);
}
function writeSharedData(data) {
  // items/transactions live in their own file now (see ITEMS_TXN_FILE) —
  // split them out here rather than in every individual caller, so any
  // existing caller that still passes a full blob (a backup restore, for
  // instance, which legitimately has both) automatically routes each part
  // to the right place without needing its own update. This function is
  // only ever used for that kind of full-blob write (restores, mainly),
  // never the hot per-request sync path — so awaiting both writes here
  // (rather than firing the items/transactions one off unawaited) is the
  // right tradeoff: correctness (the caller's response means it's ALL
  // actually on disk) matters more than shaving a few ms on a rare call.
  return (async () => {
    if (data && (Array.isArray(data.items) || Array.isArray(data.transactions))) {
      await writeItemsTxnData({ items: data.items || [], transactions: data.transactions || [] });
      data = Object.assign({}, data);
      delete data.items;
      delete data.transactions;
    }
    await withDataLock(() => _writeSharedDataUnlocked(data));
    maybeAutoBackup(); // fire-and-forget is fine for this one — it's a courtesy snapshot, not part of what the caller needs to wait on
  })();
}
// Atomic "read, modify, write" as ONE queued step — use this whenever the
// write depends on first reading the current data (e.g. merging incoming
// sync data), so no other request's read/write can slip in between.
// The mutator returns { data, skipWrite, ...anything else the caller needs }.
// Set skipWrite:true when nothing actually changed (e.g. an ordinary login
// with no legacy PIN to migrate) to avoid a pointless disk write on every call.
function updateSharedData(mutator) {
  const p = withDataLock(async () => {
    const current = await _readSharedDataUnlocked();
    const result = await mutator(current);
    if (!result.skipWrite) {
      await _writeSharedDataUnlocked(result.data !== undefined ? result.data : current);
    }
    return result;
  });
  p.then(result => { if (!result.skipWrite) maybeAutoBackup(); }).catch(() => {});
  return p;
}

// ===== ITEMS + TRANSACTIONS (separate file/lock — see ITEMS_TXN_FILE above) =====
const ITEMS_TXN_DEFAULT = { items: [], transactions: [] };
let _itemsTxnLock = Promise.resolve();
function withItemsTxnLock(fn) {
  const run = _itemsTxnLock.then(fn, fn);
  _itemsTxnLock = run.then(() => {}, () => {});
  return run;
}
async function _readItemsTxnUnlocked() {
  try {
    const raw = await fs.promises.readFile(ITEMS_TXN_FILE, 'utf8');
    return Object.assign({}, ITEMS_TXN_DEFAULT, JSON.parse(raw || '{}'));
  } catch (e) {
    return Object.assign({}, ITEMS_TXN_DEFAULT); // no file yet (first run, or pre-migration) — same "start empty" behavior as the main store
  }
}
async function _writeItemsTxnUnlocked(data) {
  const dir = path.dirname(ITEMS_TXN_FILE);
  if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
  // Same atomic write-then-rename as the main data file, for the same
  // reason: a crash/restart mid-write should never leave a truncated file.
  const tmpFile = ITEMS_TXN_FILE + '.tmp-' + process.pid + '-' + Date.now();
  await fs.promises.writeFile(tmpFile, JSON.stringify(data));
  await fs.promises.rename(tmpFile, ITEMS_TXN_FILE);
}
function readItemsTxnData() {
  return withItemsTxnLock(_readItemsTxnUnlocked);
}
function writeItemsTxnData(data) {
  return withItemsTxnLock(() => _writeItemsTxnUnlocked(data));
}
// One-time migration: the very first read after this split ships, pull any
// items/transactions still sitting in the OLD combined file over to the new
// one, so existing installs don't just lose their whole item catalog. Runs
// at most once — after the first successful migration, the new file exists
// and this becomes a no-op forever after (nothing left to migrate).
let _itemsTxnMigrationChecked = false;
async function migrateItemsTxnIfNeeded() {
  if (_itemsTxnMigrationChecked) return;
  _itemsTxnMigrationChecked = true;
  try {
    if (fs.existsSync(ITEMS_TXN_FILE)) return; // already migrated (or fresh install with nothing to migrate)
    if (!fs.existsSync(DATA_FILE)) return; // fresh install — nothing to migrate either
    const raw = await fs.promises.readFile(DATA_FILE, 'utf8');
    const old = JSON.parse(raw || '{}');
    if (Array.isArray(old.items) || Array.isArray(old.transactions)) {
      await writeItemsTxnData({ items: old.items || [], transactions: old.transactions || [] });
      console.log('Migrated items/transactions (' + (old.items || []).length + ' items, ' + (old.transactions || []).length + ' transactions) to their own file.');
    }
  } catch (e) {
    console.error('items/transactions migration check failed (non-fatal):', e.message);
  }
}

// ===== SERVER-SIDE BACKUPS =====
// Separate from both the live data file AND from any browser's local backups
// (which only ever lived in that one browser's storage). These sit on the
// server's own persistent disk, so they exist independent of which device is
// open, and survive even if a browser's storage is cleared or the live data
// file itself gets overwritten/corrupted.
const BACKUP_FILENAME_RE = /^backup-[0-9\-T]+Z-(auto|manual|pre-restore)\.json$/;
const AUTO_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // at most one automatic backup per hour
const BACKUP_KEEP_MAX = 5; // rotating cap so the disk doesn't grow unbounded
let _lastAutoBackupAt = 0;

async function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
}

function backupTimestamp() {
  // e.g. 2026-07-19T16-12-45-123Z -- sortable by filename, filesystem-safe
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Writes a full, UNSANITIZED snapshot (includes pinHash, unlike /api/data,
// which strips it before sending to browsers) so a restore can put every
// user's PIN back exactly as it was, not force everyone to reset it.
async function takeServerBackup(kind) {
  await ensureBackupDir();
  // Both stores, merged into one payload — a backup should be a complete
  // snapshot regardless of which file each part actually lives in day-to-day.
  const [data, itemsTxn] = await Promise.all([readSharedData(), readItemsTxnData()]);
  const filename = `backup-${backupTimestamp()}-${kind}.json`;
  const payload = {
    _backupType: 'plant-console-server-backup',
    _version: 1,
    takenAt: new Date().toISOString(),
    kind: kind,
    data: Object.assign({}, data, itemsTxn)
  };
  await fs.promises.writeFile(path.join(BACKUP_DIR, filename), JSON.stringify(payload, null, 2));
  pruneOldBackups().catch(e => console.error('Could not prune old backups:', e.message));
  return filename;
}

async function pruneOldBackups() {
  await ensureBackupDir();
  const files = (await fs.promises.readdir(BACKUP_DIR)).filter(f => BACKUP_FILENAME_RE.test(f));
  if (files.length <= BACKUP_KEEP_MAX) return;
  files.sort(); // filenames are chronologically sortable as-is
  const toDelete = files.slice(0, files.length - BACKUP_KEEP_MAX);
  for (const f of toDelete) {
    try { await fs.promises.unlink(path.join(BACKUP_DIR, f)); } catch (e) { /* best-effort cleanup */ }
  }
}

async function listBackups() {
  await ensureBackupDir();
  const files = (await fs.promises.readdir(BACKUP_DIR)).filter(f => BACKUP_FILENAME_RE.test(f));
  const entries = [];
  for (const f of files) {
    try {
      const stat = await fs.promises.stat(path.join(BACKUP_DIR, f));
      const m = f.match(BACKUP_FILENAME_RE);
      entries.push({ filename: f, kind: m[1], size: stat.size, takenAt: stat.mtime.toISOString() });
    } catch (e) { /* skip anything unreadable rather than fail the whole list */ }
  }
  entries.sort((a, b) => b.filename.localeCompare(a.filename)); // newest first
  return entries;
}

// Called after every successful write to the live data file. Throttled to
// at most once an hour so routine syncing (every few seconds, from every
// open device) doesn't flood the disk with near-identical snapshots.
function maybeAutoBackup() {
  const now = Date.now();
  if (now - _lastAutoBackupAt < AUTO_BACKUP_INTERVAL_MS) return;
  _lastAutoBackupAt = now;
  takeServerBackup('auto').catch(e => console.error('Auto-backup failed:', e.message));
}

// ===== SESSIONS =====
// Session store backed by an HttpOnly cookie, persisted to disk (see
// SESSIONS_FILE above) so a server restart doesn't force everyone to log
// back in. Kept in memory as the source of truth during normal operation
// (every lookup is a plain Map.get — no disk I/O on the hot path); the file
// is only written on session create/destroy and read once at startup.
const SESSIONS = new Map(); // token -> { userId, role, name, email, expires }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Best-effort — a failure here means sessions won't survive a restart
// (the old behavior), not that login itself breaks.
function persistSessions() {
  const obj = {};
  for (const [token, s] of SESSIONS.entries()) obj[token] = s;
  fs.writeFile(SESSIONS_FILE, JSON.stringify(obj), (err) => {
    if (err) console.error('Failed to persist sessions:', err.message);
  });
}
async function loadSessionsFromDisk() {
  try {
    const raw = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const token of Object.keys(obj)) {
      const s = obj[token];
      if (s && s.expires > now) SESSIONS.set(token, s); // drop anything already expired
    }
  } catch (e) {
    // No file yet (first run) or unreadable — start with an empty session
    // table, same as the old in-memory-only behavior. Not fatal.
  }
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  SESSIONS.set(token, {
    userId: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    expires: Date.now() + SESSION_TTL_MS
  });
  persistSessions();
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { SESSIONS.delete(token); persistSessions(); return null; }
  return s;
}
function destroySession(token) {
  if (token) { SESSIONS.delete(token); persistSessions(); }
}
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
function sessionCookieHeader(token, maxAgeSeconds) {
  const isProd = process.env.NODE_ENV === 'production';
  let cookie = `pc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  if (isProd) cookie += '; Secure';
  return cookie;
}
// Every route that touches shared data or QuickBooks must call this first.
// Returns the session object, or null after already sending a 401 response.
function requireAuth(req, res) {
  const cookies = parseCookies(req);
  const session = getSession(cookies.pc_session);
  if (!session) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ error: 'Not authenticated', needsLogin: true }));
    return null;
  }
  return session;
}
// Same as requireAuth, but also requires the session's role to be 'admin'.
// Used for backup/restore routes, since a backup file contains everything —
// including every user's pinHash — and a restore can overwrite all shared
// data in one shot.
function requireAdmin(req, res) {
  const session = requireAuth(req, res);
  if (!session) return null; // requireAuth already sent the 401
  if (session.role !== 'admin') {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ error: 'Admin access required.' }));
    return null;
  }
  return session;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) { req.destroy(); reject(new Error('Payload too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
// ===== END SHARED DATA STORE =====

// ===== QUICKBOOKS TOKEN PERSISTENCE =====
// Previously these tokens lived ONLY in memory, which meant every server
// restart or redeploy silently threw away a working QuickBooks connection —
// the next sync would fail with a confusing 400/403 until someone noticed
// and manually reconnected via /connect. They're now saved to the same disk
// as the shared app data (see DATA_DIR above), so a restart just picks up
// where it left off. Env vars (QB_ACCESS_TOKEN/QB_REFRESH_TOKEN) still work
// as a one-time bootstrap, but the token file — which is always kept current
// after a successful connect or refresh — takes priority once it exists.
const QB_TOKEN_FILE = path.join(DATA_DIR, 'qb-tokens.json');

function loadQBTokens() {
  try {
    if (!fs.existsSync(QB_TOKEN_FILE)) return null;
    const raw = fs.readFileSync(QB_TOKEN_FILE, 'utf8');
    const saved = JSON.parse(raw || '{}');
    if (saved && saved.accessToken) return saved;
  } catch (e) {
    console.error('Could not read saved QuickBooks tokens:', e.message);
  }
  return null;
}

function saveQBTokens() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QB_TOKEN_FILE, JSON.stringify({
      accessToken: accessToken,
      refreshToken: refreshToken,
      activeRealm: activeRealm,
      tokenRefreshedAt: tokenRefreshedAt
    }, null, 2));
  } catch (e) {
    console.error('Could not save QuickBooks tokens to disk:', e.message);
  }
}

function clearQBTokens() {
  try {
    if (fs.existsSync(QB_TOKEN_FILE)) fs.unlinkSync(QB_TOKEN_FILE);
  } catch (e) {
    console.error('Could not clear saved QuickBooks tokens:', e.message);
  }
}

// In-memory token store, seeded from (in priority order) the persisted token
// file, then environment variables, then blank.
let accessToken = process.env.QB_ACCESS_TOKEN || '';
let refreshToken = process.env.QB_REFRESH_TOKEN || '';
let activeRealm = QB_REALM;
let tokenRefreshedAt = 0; // ms timestamp of last successful token refresh

(function bootstrapQBTokens() {
  const saved = loadQBTokens();
  if (saved) {
    accessToken = saved.accessToken || accessToken;
    refreshToken = saved.refreshToken || refreshToken;
    activeRealm = saved.activeRealm || activeRealm;
    tokenRefreshedAt = saved.tokenRefreshedAt || 0;
    console.log('QuickBooks: restored saved tokens from disk (realm ' + activeRealm + ')');
  } else if (accessToken) {
    console.log('QuickBooks: using QB_ACCESS_TOKEN/QB_REFRESH_TOKEN from environment variables');
  }
})();

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Plaid (bank balance) ---
// Same persisted-file pattern as QuickBooks above: the access_token Plaid
// gives us after a successful Link flow lives in its own file on the
// persistent disk, not in an env var — env vars only matter as a one-time
// bootstrap if this file doesn't exist yet.
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET = process.env.PLAID_SECRET || '';
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox'; // 'sandbox' | 'production'
const PLAID_HOST = PLAID_ENV === 'production' ? 'production.plaid.com' : 'sandbox.plaid.com';
const PLAID_TOKEN_FILE = path.join(DATA_DIR, 'plaid-tokens.json');

function loadPlaidTokens() {
  try {
    if (!fs.existsSync(PLAID_TOKEN_FILE)) return null;
    const saved = JSON.parse(fs.readFileSync(PLAID_TOKEN_FILE, 'utf8') || '{}');
    if (saved && saved.accessToken) return saved;
  } catch (e) {
    console.error('Could not read saved Plaid tokens:', e.message);
  }
  return null;
}
function savePlaidTokens() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PLAID_TOKEN_FILE, JSON.stringify({
      accessToken: plaidAccessToken,
      itemId: plaidItemId,
      institutionName: plaidInstitutionName,
      connectedAt: plaidConnectedAt
    }, null, 2));
  } catch (e) {
    console.error('Could not save Plaid tokens to disk:', e.message);
  }
}
function clearPlaidTokens() {
  try {
    if (fs.existsSync(PLAID_TOKEN_FILE)) fs.unlinkSync(PLAID_TOKEN_FILE);
  } catch (e) {
    console.error('Could not clear saved Plaid tokens:', e.message);
  }
}
let plaidAccessToken = '';
let plaidItemId = '';
let plaidInstitutionName = '';
let plaidConnectedAt = 0;
(function bootstrapPlaidTokens() {
  const saved = loadPlaidTokens();
  if (saved) {
    plaidAccessToken = saved.accessToken || '';
    plaidItemId = saved.itemId || '';
    plaidInstitutionName = saved.institutionName || '';
    plaidConnectedAt = saved.connectedAt || 0;
    console.log('Plaid: restored saved connection from disk (' + (plaidInstitutionName || 'unknown institution') + ')');
  }
})();

// Every Plaid API call is a POST with client_id+secret in the JSON body
// (not a header) — this just centralizes that boilerplate.
async function plaidRequest(pathName, extraBody) {
  const body = JSON.stringify(Object.assign({
    client_id: PLAID_CLIENT_ID,
    secret: PLAID_SECRET
  }, extraBody || {}));
  const res = await httpsRequest({
    hostname: PLAID_HOST,
    path: pathName,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  let parsed;
  try { parsed = JSON.parse(res.body || '{}'); } catch (e) { parsed = { error_message: 'Non-JSON response from Plaid: ' + res.body }; }
  return { status: res.status, data: parsed };
}

// Exchange an authorization code for fresh access + refresh tokens
async function exchangeCodeForTokens(code) {
  const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const body = querystring.stringify({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: REDIRECT_URI
  });
  const res = await httpsRequest({
    hostname: 'oauth.platform.intuit.com',
    path: '/oauth2/v1/tokens/bearer',
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + creds,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  const data = JSON.parse(res.body);
  if (data.access_token) {
    accessToken = data.access_token;
    refreshToken = data.refresh_token || refreshToken;
    tokenRefreshedAt = Date.now();
    saveQBTokens();
    console.log('OAuth: new tokens obtained via authorization code');
    return true;
  }
  console.error('OAuth code exchange failed:', res.body);
  return false;
}

async function refreshAccessToken() {
  const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const body = querystring.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const res = await httpsRequest({
    hostname: 'oauth.platform.intuit.com',
    path: '/oauth2/v1/tokens/bearer',
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + creds,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  const data = JSON.parse(res.body);
  if (data.access_token) {
    accessToken = data.access_token;
    if (data.refresh_token) refreshToken = data.refresh_token;
    tokenRefreshedAt = Date.now();
    saveQBTokens();
    console.log('Token refreshed successfully');
    return true;
  }
  console.error('Token refresh failed:', res.body);
  return false;
}


// Proactively refresh if the token is older than ~45 min (tokens live 60 min).
// Called before each page during long syncs so the token never expires mid-loop.
async function ensureFreshToken() {
  var ageMs = Date.now() - tokenRefreshedAt;
  if (!tokenRefreshedAt || ageMs > 45 * 60 * 1000) {
    await refreshAccessToken();
  }
}

async function fetchQBItemsPage(startPosition, retry) {
  // QuickBooks Online silently defaults to Active=true when a query has no
  // WHERE clause on Active at all — any item that's since been deactivated
  // or merged in QuickBooks never comes back from a plain "SELECT * FROM
  // Item" and can never be matched again, even though historical invoices
  // and credit memos still reference it. Explicitly requesting both active
  // and inactive items fixes this — without it, thousands of historical
  // line items end up permanently unmatchable ("item not matched") no
  // matter how many times items are re-synced.
  const query = `SELECT * FROM Item WHERE Active IN (true, false) STARTPOSITION ${startPosition} MAXRESULTS 100`;
  const reqPath = `/v3/company/${activeRealm}/query?query=${encodeURIComponent(query)}&minorversion=75`;
  const res = await httpsRequest({
    hostname: 'quickbooks.api.intuit.com',
    path: reqPath,
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Accept': 'application/json'
    }
  });
  if (res.status === 401 && !retry) {
    const ok = await refreshAccessToken();
    if (ok) return fetchQBItemsPage(startPosition, true);
    throw new Error('NEEDS_RECONNECT');
  }
  if (res.status !== 200) throw new Error('QB API error ' + res.status + ': ' + res.body);
  return JSON.parse(res.body);
}

async function fetchQBItems(retry) {
  // Paginate through all items using STARTPOSITION (QB is 1-indexed)
  let allItems = [];
  let start = 1;
  const pageSize = 100;
  while (true) {
    const data = await fetchQBItemsPage(start, retry);
    const items = (data.QueryResponse && data.QueryResponse.Item) || [];
    allItems = allItems.concat(items);
    if (items.length < pageSize) break; // last page
    start += pageSize;
    if (start > 10000) break; // safety cap
  }
  return { QueryResponse: { Item: allItems, maxResults: allItems.length } };
}

async function fetchQBCustomersPage(startPosition, retry) {
  const query = `SELECT * FROM Customer STARTPOSITION ${startPosition} MAXRESULTS 100`;
  const reqPath = `/v3/company/${activeRealm}/query?query=${encodeURIComponent(query)}&minorversion=75`;
  const res = await httpsRequest({
    hostname: 'quickbooks.api.intuit.com',
    path: reqPath,
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Accept': 'application/json'
    }
  });
  if (res.status === 401 && !retry) {
    const ok = await refreshAccessToken();
    if (ok) return fetchQBCustomersPage(startPosition, true);
    throw new Error('NEEDS_RECONNECT');
  }
  if (res.status !== 200) throw new Error('QB API error ' + res.status + ': ' + res.body);
  return JSON.parse(res.body);
}

async function fetchQBCustomers(retry) {
  // Paginate through all customers using STARTPOSITION (QB is 1-indexed)
  let allCustomers = [];
  let start = 1;
  const pageSize = 100;
  while (true) {
    const data = await fetchQBCustomersPage(start, retry);
    const custs = (data.QueryResponse && data.QueryResponse.Customer) || [];
    allCustomers = allCustomers.concat(custs);
    if (custs.length < pageSize) break; // last page
    start += pageSize;
    if (start > 10000) break; // safety cap
  }
  return { QueryResponse: { Customer: allCustomers, maxResults: allCustomers.length } };
}

// Generic paginated query for any QB entity (Bill, Invoice, SalesReceipt, CreditMemo)
// `since`: only records changed at/after this timestamp (incremental).
// `from`:  only records with TxnDate on/after this date (inventory start floor).
// `to`:    only records with TxnDate on/before this date — added for the
//          Purchasing report's per-week Bill pulls (e.g. "5/4/2026 to
//          5/9/2026"), which need a closed range, not just an open-ended
//          floor. Optional and backward-compatible: existing callers that
//          never pass it are unaffected.
async function fetchQBEntityPage(entity, startPosition, retry, since, from, to) {
  if (!retry) await ensureFreshToken(); // keep token alive during long paged syncs
  const clauses = [];
  if (since) clauses.push(`MetaData.LastUpdatedTime >= '${since}'`);
  if (from)  clauses.push(`TxnDate >= '${from}'`);
  if (to)    clauses.push(`TxnDate <= '${to}'`);
  const where = clauses.length ? (' WHERE ' + clauses.join(' AND ')) : '';
  const query = `SELECT * FROM ${entity}${where} STARTPOSITION ${startPosition} MAXRESULTS 100`;
  const reqPath = `/v3/company/${activeRealm}/query?query=${encodeURIComponent(query)}&minorversion=75`;
  const res = await httpsRequest({
    hostname: 'quickbooks.api.intuit.com',
    path: reqPath,
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
  });
  if (res.status === 401 && !retry) {
    const ok = await refreshAccessToken();
    if (ok) return fetchQBEntityPage(entity, startPosition, true, since, from, to);
    throw new Error('NEEDS_RECONNECT');
  }
  if (res.status !== 200) throw new Error('QB API error ' + res.status + ' on ' + entity + ': ' + res.body);
  return JSON.parse(res.body);
}

async function fetchQBEntity(entity, since, from, to) {
  let all = [];
  let start = 1;
  const pageSize = 100;
  while (true) {
    const data = await fetchQBEntityPage(entity, start, false, since, from, to);
    const rows = (data.QueryResponse && data.QueryResponse[entity]) || [];
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    start += pageSize;
    if (start > 20000) break;
  }
  return all;
}

// Fetches exactly ONE record by ID, directly — not a query, a real single-
// entity read (GET /v3/company/{realm}/{entity}/{id}). This is what a
// webhook notification actually needs: it tells us "Customer 42 changed,"
// not what changed about it, so a targeted read of that one record is the
// correct follow-up — not a full re-sync of every customer.
async function fetchQBEntityById(entity, id, retry) {
  if (!retry) await ensureFreshToken();
  const reqPath = `/v3/company/${activeRealm}/${entity.toLowerCase()}/${encodeURIComponent(id)}?minorversion=75`;
  const res = await httpsRequest({
    hostname: 'quickbooks.api.intuit.com',
    path: reqPath,
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
  });
  if (res.status === 401 && !retry) {
    const ok = await refreshAccessToken();
    if (ok) return fetchQBEntityById(entity, id, true);
    throw new Error('NEEDS_RECONNECT');
  }
  if (res.status === 404) return null; // e.g. deleted between the webhook firing and this fetch
  if (res.status !== 200) throw new Error('QB API error ' + res.status + ' fetching ' + entity + ' ' + id + ': ' + res.body);
  const data = JSON.parse(res.body);
  return data[entity] || null; // QB wraps the single record under its entity name, e.g. {"Customer": {...}}
}

// ===== QUICKBOOKS WRITES ===== Everything above this point only ever
// READS from QuickBooks. This is the first function that WRITES to it —
// creating a real Invoice from an Order in Plant Console, once someone has
// reviewed and confirmed exactly what's being billed (see
// /api/qb/create-invoice below). Same auth/retry pattern as every read
// function above, just a POST with a JSON body instead of a GET.
async function createQBInvoice(invoicePayload, retry) {
  if (!retry) await ensureFreshToken();
  const bodyStr = JSON.stringify(invoicePayload);
  const reqPath = `/v3/company/${activeRealm}/invoice?minorversion=75`;
  const res = await httpsRequest({
    hostname: 'quickbooks.api.intuit.com',
    path: reqPath,
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr)
    }
  }, bodyStr);
  if (res.status === 401 && !retry) {
    const ok = await refreshAccessToken();
    if (ok) return createQBInvoice(invoicePayload, true);
    throw new Error('NEEDS_RECONNECT');
  }
  if (res.status !== 200) throw new Error('QB API error ' + res.status + ' creating invoice: ' + res.body);
  const data = JSON.parse(res.body);
  return data.Invoice || null;
}

// Verifies that an incoming webhook payload genuinely came from Intuit.
// Per Intuit's documented scheme: HMAC-SHA256 of the RAW request body
// (bytes, not a re-serialized/re-parsed copy — re-stringifying JSON can
// change whitespace and silently break this comparison), keyed with the
// Verifier Token from the Developer Portal, base64-encoded, compared
// against the incoming "intuit-signature" header.
function verifyIntuitWebhookSignature(rawBodyStr, signatureHeader) {
  if (!QB_WEBHOOK_VERIFIER_TOKEN || !signatureHeader) return false;
  try {
    const computed = crypto.createHmac('sha256', QB_WEBHOOK_VERIFIER_TOKEN)
      .update(Buffer.from(rawBodyStr, 'utf8'))
      .digest('base64');
    // Constant-time comparison — a naive === here would leak timing
    // information about how many leading bytes matched, which is exactly
    // the kind of subtle gap that turns "we verify signatures" into
    // "we verify signatures, sort of."
    const a = Buffer.from(computed);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

// Extracts a flat list of {entity, id, operation} from either webhook
// payload shape Intuit uses — the newer CloudEvents format (required for
// all NEW subscriptions) or the older dataChangeEvent format (still seen
// on subscriptions created before the cutover). Handling both defensively
// costs almost nothing and avoids a "which format is this again?" support
// problem later.
function parseIntuitWebhookEvents(body) {
  const out = [];
  if (Array.isArray(body && body.events)) {
    // CloudEvents format: { events: [{ entity, entityId, operation, ... }] }
    body.events.forEach(e => {
      if (e && e.entity && e.entityId) {
        out.push({ entity: e.entity, id: e.entityId, operation: e.operation || '' });
      }
    });
  }
  if (Array.isArray(body && body.eventNotifications)) {
    // Legacy format: { eventNotifications: [{ dataChangeEvent: { entities: [{ name, id, operation }] } }] }
    body.eventNotifications.forEach(n => {
      const entities = (n && n.dataChangeEvent && n.dataChangeEvent.entities) || [];
      entities.forEach(e => {
        if (e && e.name && e.id) out.push({ entity: e.name, id: e.id, operation: e.operation || '' });
      });
    });
  }
  return out;
}

// Applies ONE changed Customer or Vendor to the shared data store, using
// SyncToken (a version counter QuickBooks includes on every object) to
// reject a stale/out-of-order webhook delivery instead of letting it
// overwrite a newer version with an older one — Intuit's own docs warn
// deliveries can arrive duplicated or out of order, so this isn't a
// theoretical concern.
async function applyWebhookEntityChange(entityName, id) {
  const entity = entityName.toLowerCase() === 'vendor' ? 'Vendor' : (entityName.toLowerCase() === 'customer' ? 'Customer' : null);
  if (!entity) return; // scoped to Customers/Vendors for now — see the discussion this was built from
  const record = await fetchQBEntityById(entity, id);
  await updateSharedData(async (current) => {
    if (entity === 'Customer') {
      const customers = Array.isArray(current.customers) ? current.customers.slice() : [];
      const idx = customers.findIndex(c => c && c.qbId === id);
      if (!record) {
        // Deleted/deactivated between the webhook firing and this fetch —
        // Customer/Vendor can't truly be deleted in QuickBooks (name-list
        // entities only ever get deactivated), so there's nothing to apply.
        return { skipWrite: true };
      }
      const newSyncToken = Number(record.SyncToken || 0);
      const oldSyncToken = idx >= 0 ? Number((customers[idx].qbSyncToken) || -1) : -1;
      if (idx >= 0 && newSyncToken <= oldSyncToken) return { skipWrite: true }; // stale/duplicate delivery
      const mapped = {
        id: idx >= 0 ? customers[idx].id : 'cust_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        qbId: record.Id,
        qbSyncToken: newSyncToken,
        name: record.DisplayName || record.FullyQualifiedName || record.CompanyName || '',
        active: record.Active !== false,
        salesRep: idx >= 0 ? (customers[idx].salesRep || '') : '',
        // Dun# — confirmed (Aug 2026) QuickBooks's API never returns
        // Customer CustomField data at all, so there's no point even
        // attempting to read it here. Managed locally instead (see
        // /api/customers/:id/dunsnumber) — always carry forward whatever
        // is already stored, same as Sales Rep just above.
        dunsNumber: idx >= 0 ? (customers[idx].dunsNumber || '') : '',
        balance: Number(record.Balance || 0)
      };
      if (idx >= 0) customers[idx] = mapped; else customers.push(mapped);
      return { data: Object.assign({}, current, { customers }) };
    } else {
      const vendors = Array.isArray(current.vendors) ? current.vendors.slice() : [];
      const idx = vendors.findIndex(v => v && v.qbId === id);
      if (!record) return { skipWrite: true };
      const newSyncToken = Number(record.SyncToken || 0);
      const oldSyncToken = idx >= 0 ? Number((vendors[idx].qbSyncToken) || -1) : -1;
      if (idx >= 0 && newSyncToken <= oldSyncToken) return { skipWrite: true };
      let purchRep = '';
      (record.CustomField || []).forEach(f => {
        if (!purchRep && f.Name && (f.Name.toLowerCase().includes('purch') || f.Name.toLowerCase().includes('rep')) && f.StringValue) {
          purchRep = f.StringValue.trim();
        }
      });
      const finalPurchRep = purchRep || (idx >= 0 ? (vendors[idx].purchRep || '') : '');
      const mapped = {
        id: idx >= 0 ? vendors[idx].id : 'vend_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        qbId: record.Id,
        qbSyncToken: newSyncToken,
        name: record.DisplayName || record.CompanyName || '',
        active: record.Active !== false,
        purchRep: finalPurchRep
      };
      if (idx >= 0) vendors[idx] = mapped; else vendors.push(mapped);
      return { data: Object.assign({}, current, { vendors }) };
    }
  });
}

// ===== BACKGROUND SYNC =====
// Runs on the server itself, independent of any open browser tab — the
// point is that nobody should ever have to click "Sync from QuickBooks"
// and wait for it. By the time anyone opens the app, Customers and
// Vendors should already be close to current, kept that way by this
// running on a timer whether or not anyone's looking. Client-triggered
// manual syncs (the existing "Sync" buttons) still work exactly as
// before, for anyone who wants to force an immediate refresh rather than
// wait for the next scheduled run — this is additive, not a replacement.
//
// Deliberately limited to Customers and Vendors for now, not the much
// larger/slower Bill/Invoice/Payment/JournalEntry sync used by the
// Customer Payments and Inventory reports — those have real date-range
// and incremental-sync complexity that deserves its own careful pass
// later, not a rushed inclusion here.
const BACKGROUND_SYNC_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
let _backgroundSyncInFlight = false;
let _lastBackgroundSyncAt = 0;
let _lastBackgroundSyncResult = null; // { at, customers: {ok,count,error}, vendors: {ok,count,error} }

async function backgroundSyncCustomers() {
  const data = await fetchQBCustomers(false);
  const qbCustomers = (data.QueryResponse && data.QueryResponse.Customer) || [];
  await updateSharedData(async (current) => {
    const customers = Array.isArray(current.customers) ? current.customers.slice() : [];
    qbCustomers.forEach(qc => {
      const existing = customers.findIndex(x => x && x.qbId === qc.Id);
      const mapped = {
        id: existing >= 0 ? customers[existing].id : 'cust_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        qbId: qc.Id,
        // Tracked so a later webhook delivery (see applyWebhookEntityChange)
        // can tell whether IT has newer information than what's already
        // here — without this being kept current on every write path, that
        // staleness check would only be accurate immediately after a
        // webhook fires, then silently go stale itself the next time this
        // periodic sync runs and overwrites it.
        qbSyncToken: Number(qc.SyncToken || 0),
        name: qc.DisplayName || qc.FullyQualifiedName || qc.CompanyName || '',
        active: qc.Active !== false,
        // Sales Rep and Dun# are both Plant-Console-only, never touched by
        // any QB sync — always carried forward from whatever's already
        // there. (Dun# was attempted via QuickBooks's CustomField data
        // here and in the webhook handler, but confirmed live in Aug 2026
        // that the API never returns it for Customer records at all — see
        // /api/customers/:id/dunsnumber for the manual-entry path instead.)
        salesRep: existing >= 0 ? (customers[existing].salesRep || '') : '',
        dunsNumber: existing >= 0 ? (customers[existing].dunsNumber || '') : '',
        balance: Number(qc.Balance || 0)
      };
      if (existing >= 0) customers[existing] = mapped; else customers.push(mapped);
    });
    return { data: Object.assign({}, current, { customers }) };
  });
  return qbCustomers.length;
}

async function backgroundSyncVendors() {
  const qbVendors = await fetchQBEntity('Vendor');
  await updateSharedData(async (current) => {
    const vendors = Array.isArray(current.vendors) ? current.vendors.slice() : [];
    qbVendors.forEach(qv => {
      const existing = vendors.findIndex(x => x && x.qbId === qv.Id);
      let purchRep = '';
      (qv.CustomField || []).forEach(f => {
        if (!purchRep && f.Name && (f.Name.toLowerCase().includes('purch') || f.Name.toLowerCase().includes('rep')) && f.StringValue) {
          purchRep = f.StringValue.trim();
        }
      });
      // Same fallback as the client-side sync: QuickBooks reliably does NOT
      // expose this custom field, so almost every call here finds nothing —
      // always fall back to whatever's already saved instead of wiping it.
      const finalPurchRep = purchRep || (existing >= 0 ? (vendors[existing].purchRep || '') : '');
      const mapped = {
        id: existing >= 0 ? vendors[existing].id : 'vend_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        qbId: qv.Id,
        qbSyncToken: Number(qv.SyncToken || 0), // see the matching comment in backgroundSyncCustomers
        name: qv.DisplayName || qv.CompanyName || '',
        active: qv.Active !== false,
        purchRep: finalPurchRep
      };
      if (existing >= 0) vendors[existing] = mapped; else vendors.push(mapped);
    });
    return { data: Object.assign({}, current, { vendors }) };
  });
  return qbVendors.length;
}

async function runBackgroundSync() {
  if (_backgroundSyncInFlight) return; // never overlap two runs
  if (!accessToken && !refreshToken) return; // QuickBooks isn't connected yet — nothing to sync
  _backgroundSyncInFlight = true;
  const result = { at: new Date().toISOString(), customers: null, vendors: null };
  try {
    const count = await backgroundSyncCustomers();
    result.customers = { ok: true, count };
  } catch (e) {
    result.customers = { ok: false, error: e.message };
    console.error('Background customer sync failed:', e.message);
  }
  try {
    const count = await backgroundSyncVendors();
    result.vendors = { ok: true, count };
  } catch (e) {
    result.vendors = { ok: false, error: e.message };
    console.error('Background vendor sync failed:', e.message);
  }
  _lastBackgroundSyncAt = Date.now();
  _lastBackgroundSyncResult = result;
  _backgroundSyncInFlight = false;
}

// NOTE: the whole-history, all-5-entity-types, no-date-bound
// fetchQBDocuments() function that used to live here was removed — see the
// long comment at the /api/qb/documents route (search "V8's own
// out-of-memory abort") for why. Every real caller now fetches one entity
// type, one page at a time, via fetchQBEntity/fetchQBEntityPage above.


// Diagnostic: run a minimal query and report exactly what QB says
async function diagnose(retry) {
  // First refresh to guarantee a current access token
  if (!retry) { await refreshAccessToken(); }

  async function runQuery(q) {
    const reqPath = `/v3/company/${activeRealm}/query?query=${encodeURIComponent(q)}&minorversion=75`;
    const res = await httpsRequest({
      hostname: 'quickbooks.api.intuit.com',
      path: reqPath,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
    });
    return { status: res.status, body: res.body.slice(0, 300) };
  }

  const company = await runQuery('SELECT * FROM CompanyInfo');
  const itemCount = await runQuery('SELECT COUNT(*) FROM Item');
  const item1 = await runQuery('SELECT * FROM Item MAXRESULTS 1');
  const item100 = await runQuery('SELECT * FROM Item STARTPOSITION 1 MAXRESULTS 100');
  const item1000 = await runQuery('SELECT * FROM Item STARTPOSITION 1 MAXRESULTS 1000');

  let companyName = null;
  try {
    const parsed = JSON.parse(company.body);
    if (parsed.QueryResponse && parsed.QueryResponse.CompanyInfo) {
      companyName = parsed.QueryResponse.CompanyInfo[0].CompanyName;
    }
  } catch (e) {}

  return {
    realmUsed: activeRealm,
    hasAccessToken: !!accessToken,
    accessTokenPreview: accessToken ? accessToken.slice(0, 12) + '...' : '(none)',
    companyName: companyName,
    tests: {
      'CompanyInfo': company.status,
      'COUNT(*) Item': itemCount.status + ' → ' + itemCount.body,
      'Item MAXRESULTS 1': item1.status,
      'Item MAXRESULTS 100': item100.status,
      'Item MAXRESULTS 1000': item1000.status
    },
    sampleError: (item1000.status !== 200 ? item1000.body : (item100.status !== 200 ? item100.body : ''))
  };
}

// A bug in any single request handler shouldn't be able to take the whole
// process down for everyone else who's mid-session — without this, one
// uncaught exception or rejected promise anywhere (even in code that looks
// unrelated to the request currently being handled) crashes the entire
// server, which is exactly the kind of restart that used to force every
// logged-in person out at once (see the SESSIONS persistence comment
// above). This logs the failure instead of dying, so at minimum everyone
// else's session and in-flight work survives one bad request.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stayed up):', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server stayed up):', err && err.stack || err);
});

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const fullUrl = req.url;
  const url = fullUrl.split('?')[0];
  const queryParams = querystring.parse(fullUrl.split('?')[1] || '');

  // QuickBooks webhook receiver — deliberately has NO requireAuth() call.
  // Intuit itself calls this directly; it has no session cookie for this
  // app and never will. The signature check below IS this endpoint's
  // authentication — that's the whole point of verifying it.
  if (url === '/api/qb-webhook' && req.method === 'POST') {
    let rawBody = '';
    try {
      rawBody = await readRequestBody(req);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not read request body.' }));
      return;
    }
    const signature = req.headers['intuit-signature'];
    if (!verifyIntuitWebhookSignature(rawBody, signature)) {
      // Deliberately vague response — don't give an attacker probing this
      // endpoint any hint about WHY verification failed (missing header,
      // wrong token, bad payload, etc).
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Signature verification failed.' }));
      return;
    }
    // Respond 200 immediately, before doing any of our own downstream
    // QuickBooks API calls — Intuit expects a fast acknowledgment and can
    // disable an endpoint that's slow or unreliable to respond. The actual
    // fetch-and-apply work happens after responding, not before.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true }));
    try {
      const body = JSON.parse(rawBody || '{}');
      const events = parseIntuitWebhookEvents(body);
      for (const ev of events) {
        try {
          await applyWebhookEntityChange(ev.entity, ev.id);
        } catch (e) {
          console.error('Webhook: failed to apply', ev.entity, ev.id, '-', e.message);
          // One bad event shouldn't stop the rest of the batch from applying.
        }
      }
    } catch (e) {
      console.error('Webhook: failed to parse/process payload:', e.message);
    }
    return;
  }

  // ===== Auth =====
  if (url === '/api/login' && req.method === 'POST') {
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const email = String(body.email || '').trim().toLowerCase();
      const pin = String(body.pin || '').trim();
      const { user, ok } = await updateSharedData(async (data) => {
        const u = data.users.find(x => String(x.email || '').trim().toLowerCase() === email);
        let matched = false;
        let needsMigration = false;
        if (u) {
          if (u.pinHash) {
            matched = verifyPin(pin, u.pinHash);
          } else if (typeof u.pin === 'string') {
            // Legacy plaintext record — verify directly, then migrate to a hash.
            matched = u.pin === pin;
            needsMigration = matched;
          }
        }
        return { data, user: u, ok: matched, skipWrite: !needsMigration };
      });
      if (!ok) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Incorrect email or PIN.' }));
        return;
      }
      const token = createSession(user);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Set-Cookie': sessionCookieHeader(token, SESSION_TTL_MS / 1000)
      });
      res.end(JSON.stringify({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role, perms: user.perms || {} } }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === '/api/logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    destroySession(cookies.pc_session);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Set-Cookie': sessionCookieHeader('', 0) });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  if (url === '/api/session' && req.method === 'GET') {
    const cookies = parseCookies(req);
    const session = getSession(cookies.pc_session);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }
    const data = await readSharedData();
    const user = data.users.find(u => u.id === session.userId);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: 'User no longer exists' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ user: { id: user.id, name: user.name, email: user.email, role: user.role, perms: user.perms || {} } }));
    return;
  }

  // ===== Shared data API — lets every browser/device read & write the same
  // items/transactions/storages/users instead of each keeping its own local copy =====
  if (url === '/api/data' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const [data, itemsTxn] = await Promise.all([readSharedData(), readItemsTxnData()]);
    const safe = Object.assign({}, data, itemsTxn, {
      users: data.users.map(u => { const c = Object.assign({}, u); delete c.pin; delete c.pinHash; return c; })
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify(safe));
    return;
  }
  // Lightweight read of the SMALL shared collections only (users, scale logs,
  // label-allowed list, saved reports, customer-allowed list) — used by the
  // browser to check for anything added/edited on OTHER devices right before
  // it pushes its own data, so an unrelated save (e.g. editing an item)
  // never overwrites one of these lists with a stale local copy that's
  // missing an entry another device just added. Deliberately excludes
  // items/transactions/storages/customers, which can run into the
  // multiple-MB range and shouldn't be re-fetched on every single push.
  if (url === '/api/data/small' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const data = await readSharedData();
    const users = data.users.map(u => { const c = Object.assign({}, u); delete c.pin; delete c.pinHash; return c; });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({
      users: users,
      scaleLogs: data.scaleLogs,
      labelAllowed: data.labelAllowed,
      savedReports: data.savedReports,
      customerAllowed: data.customerAllowed,
      cfScheduledDates: data.cfScheduledDates,
      customers: data.customers,
      orders: data.orders,
      deletedOrderIds: data.deletedOrderIds,
      drivers: data.drivers,
      deletedDrivers: data.deletedDrivers
    }));
    return;
  }
  // Targeted, single-field write — the first piece of a broader move
  // toward "dumb terminal" architecture: instead of every device loading
  // the full customer list into memory, mutating its own copy, and pushing
  // an entire snapshot back (the pattern that caused the Sales Rep data-
  // loss bug), this updates ONLY the one field, for the one customer, that
  // was actually changed. There's nothing to merge and nothing that can
  // race against another device's edit to a DIFFERENT customer, because
  // this never touches anything but the single record it names.
  if (url.startsWith('/api/customers/') && url.endsWith('/salesrep') && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const custId = decodeURIComponent(url.slice('/api/customers/'.length, -'/salesrep'.length));
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const salesRep = typeof body.salesRep === 'string' ? body.salesRep.trim() : '';
      let found = false;
      await updateSharedData(async (current) => {
        const customers = Array.isArray(current.customers) ? current.customers : [];
        const idx = customers.findIndex(c => c && c.id === custId);
        if (idx >= 0) {
          found = true;
          customers[idx] = Object.assign({}, customers[idx], { salesRep });
        }
        return { data: Object.assign({}, current, { customers }), skipWrite: !found };
      });
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Customer not found.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, id: custId, salesRep }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Dun# — confirmed (Aug 2026, live diagnostics) that QuickBooks's REST
  // API does not expose Customer CustomField data at all, via bulk query
  // OR per-record fetch. Managed locally instead, same reasoning and same
  // single-field "dumb terminal" write pattern as salesrep just above.
  if (url.startsWith('/api/customers/') && url.endsWith('/dunsnumber') && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const custId = decodeURIComponent(url.slice('/api/customers/'.length, -'/dunsnumber'.length));
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const dunsNumber = typeof body.dunsNumber === 'string' ? body.dunsNumber.trim() : '';
      let found = false;
      await updateSharedData(async (current) => {
        const customers = Array.isArray(current.customers) ? current.customers : [];
        const idx = customers.findIndex(c => c && c.id === custId);
        if (idx >= 0) {
          found = true;
          customers[idx] = Object.assign({}, customers[idx], { dunsNumber });
        }
        return { data: Object.assign({}, current, { customers }), skipWrite: !found };
      });
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Customer not found.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, id: custId, dunsNumber }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Same "dumb terminal" reasoning as above, for the per-department
  // customer allow-list: this touches ONLY that one department's key
  // inside customerAllowed, never the whole object, so a save for
  // "Resale Box" can never race against or clobber a concurrent save for
  // a different department on another device.
  if (url.startsWith('/api/customer-allowed/') && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const dept = decodeURIComponent(url.slice('/api/customer-allowed/'.length));
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const allowed = Array.isArray(body.allowed) ? body.allowed : [];
      await updateSharedData(async (current) => {
        const customerAllowed = Object.assign({}, current.customerAllowed || {});
        customerAllowed[dept] = allowed;
        return { data: Object.assign({}, current, { customerAllowed }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, dept: dept, count: allowed.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Read-only, on-demand fetch of just the customer list + allow-lists —
  // pairs with the two endpoints above. A "dumb terminal" should re-read
  // this fresh whenever the Customers settings panel opens, rather than
  // trusting whatever copy is already sitting in memory from page load.
  // ===== All-staff chat =====
  // Deliberately its own tiny, dedicated read/write pair rather than part
  // of the main /api/data snapshot: chat needs to be polled frequently
  // (every few seconds) for it to feel "live," and bundling that into the
  // full app snapshot would mean either polling the ENTIRE business's data
  // every few seconds (wasteful, and re-triggers every quota/size concern
  // already documented around that endpoint elsewhere in this file) or
  // throttling chat down to match how often that heavier sync runs (not
  // live at all). A plain cursor-based poll (?afterId=) keeps each request
  // tiny regardless of how much chat history exists.
  //
  // The message's author is taken from the AUTHENTICATED SESSION
  // (session.name), never from anything the client sends — otherwise
  // anyone could type messages under someone else's name.
  // In-memory only (deliberately not persisted) — presence is inherently
  // "right now" information; it should reset to nothing on every server
  // restart, not carry stale "online" users forward from before a deploy.
  if (!global.__chatPresence) global.__chatPresence = new Map(); // name -> last-seen ms
  if (url === '/api/chat/messages' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    try {
      global.__chatPresence.set(session.name, Date.now());
      const cutoff = Date.now() - 20000; // active within the last ~2 poll cycles
      const online = Array.from(global.__chatPresence.entries()).filter(([, t]) => t >= cutoff).map(([name]) => name).sort();
      const data = await readSharedData();
      const all = Array.isArray(data.chatMessages) ? data.chatMessages : [];
      const afterId = Number(queryParams.afterId || 0);
      const messages = afterId ? all.filter(m => m.id > afterId) : all.slice(-200);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ messages, lastId: all.length ? all[all.length - 1].id : 0, online }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === '/api/chat/send' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Empty message' }));
        return;
      }
      let saved = null;
      await updateSharedData(async (current) => {
        const chatMessages = Array.isArray(current.chatMessages) ? current.chatMessages.slice() : [];
        const nextId = (chatMessages.length ? chatMessages[chatMessages.length - 1].id : 0) + 1;
        saved = { id: nextId, user: session.name, text, at: new Date().toISOString() };
        chatMessages.push(saved);
        // Cap history — this is live chatter, not a permanent record;
        // nothing else in the app depends on old chat messages surviving
        // forever, so an unbounded array here would just be a slow,
        // silent memory/storage leak.
        const capped = chatMessages.length > 500 ? chatMessages.slice(chatMessages.length - 500) : chatMessages;
        return { data: Object.assign({}, current, { chatMessages: capped }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, message: saved }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url === '/api/customers' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const data = await readSharedData();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ customers: data.customers || [], customerAllowed: data.customerAllowed || {} }));
    return;
  }
  // Customer Payments report cache — NOT part of the main /api/data
  // snapshot (kept in its own dedicated file, given its size: this can
  // bundle thousands of invoices/payments). Whoever clicks "Pull from
  // QuickBooks" still does that full multi-entity fetch themselves (this
  // deliberately doesn't touch that fetch/compute logic at all — see the
  // comments in index.html's runCollectionReport for why that's stayed
  // hands-off for now), but the RESULT gets saved here afterward so every
  // other terminal can load the same data instantly instead of repeating
  // the same slow pull. A blind replace is correct here (unlike
  // per-field customer data) — the latest successful pull is always
  // meant to fully supersede whatever was cached before it.
  if (url === '/api/collection-report-cache' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    try {
      const raw = await fs.promises.readFile(COLLECTION_CACHE_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(raw);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ cache: null }));
    }
    return;
  }
  if (url === '/api/collection-report-cache' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      // Just validate it parses as JSON before writing — the actual shape
      // is whatever the client's own (already-correct) compute logic
      // produced, this endpoint doesn't need to understand it.
      JSON.parse(bodyStr || '{}');
      await fs.promises.writeFile(COLLECTION_CACHE_FILE, bodyStr, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Scheduled Payments (Cash Flow) report cache — same "pull once, everyone
  // else loads it instantly" pattern as /api/collection-report-cache above,
  // in its own file for the same reason (this can hold a business's entire
  // open-Bills/open-Invoices history and shouldn't bloat the main data file).
  if (url === '/api/cashflow-report-cache' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    try {
      const raw = await fs.promises.readFile(CASHFLOW_CACHE_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(raw);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ cache: null }));
    }
    return;
  }
  if (url === '/api/cashflow-report-cache' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      JSON.parse(bodyStr || '{}');
      await fs.promises.writeFile(CASHFLOW_CACHE_FILE, bodyStr, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Checks tab report cache — same "pull once, everyone else loads it
  // instantly" pattern as Customer Payments and Scheduled Payments above.
  // This one was missing entirely until now: every "Pull from QuickBooks"
  // click on the Checks tab did a full ~90-day Payment fetch (plus an
  // open-Invoices fetch for auto-paid-detection) completely from scratch,
  // on every device, every time — this cache is what lets a second device
  // load a recent pull's results instantly instead of repeating that.
  if (url === '/api/checks-report-cache' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    try {
      const raw = await fs.promises.readFile(CHECKS_CACHE_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(raw);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ cache: null }));
    }
    return;
  }
  if (url === '/api/checks-report-cache' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      JSON.parse(bodyStr || '{}');
      await fs.promises.writeFile(CHECKS_CACHE_FILE, bodyStr, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Purchasing report cache — same "pull once, everyone else loads it
  // instantly" pattern as Customer Payments/Scheduled Payments/Checks above.
  // The client pulls that week's Bills from QuickBooks and does the
  // product/vendor matching itself (see runPurchaseReport() client-side),
  // then POSTs the finished grid here so the next person to open that same
  // week doesn't have to repeat the pull. Keyed by weekId so multiple
  // weeks' cached results can coexist — see the shape built in
  // _purchBuildSharedCacheBundle() client-side.
  if (url === '/api/purchase-report-cache' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    try {
      const raw = await fs.promises.readFile(PURCHASE_CACHE_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(raw);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ weeks: {} }));
    }
    return;
  }
  if (url === '/api/purchase-report-cache' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const incoming = JSON.parse(bodyStr || '{}');
      // Merge by weekId rather than blindly overwriting the whole file, so
      // one terminal caching THIS week's pull can't wipe out another
      // terminal's still-fresh cached result for a DIFFERENT week.
      let merged;
      try {
        const raw = await fs.promises.readFile(PURCHASE_CACHE_FILE, 'utf8');
        const current = JSON.parse(raw);
        merged = { weeks: Object.assign({}, (current && current.weeks) || {}, incoming.weeks || {}) };
      } catch (e) {
        merged = { weeks: incoming.weeks || {} };
      }
      await fs.promises.writeFile(PURCHASE_CACHE_FILE, JSON.stringify(merged), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Same "dumb terminal" pattern as customers/salesrep — updates ONLY this
  // one vendor's Purch Rep field, nothing else touched.
  if (url.startsWith('/api/vendors/') && url.endsWith('/purchrep') && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const vKey = decodeURIComponent(url.slice('/api/vendors/'.length, -'/purchrep'.length));
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const purchRep = typeof body.purchRep === 'string' ? body.purchRep.trim() : '';
      let found = false;
      await updateSharedData(async (current) => {
        const vendors = Array.isArray(current.vendors) ? current.vendors : [];
        const idx = vendors.findIndex(v => v && (v.qbId || v.name) === vKey);
        if (idx >= 0) {
          found = true;
          vendors[idx] = Object.assign({}, vendors[idx], { purchRep });
        }
        return { data: Object.assign({}, current, { vendors }), skipWrite: !found };
      });
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Vendor not found.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, vendorKey: vKey, purchRep }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Single-vendor version of the department endpoint below — used by CSV
  // bulk import, which touches many individual vendors (possibly across
  // several different departments in one file) rather than "replace one
  // department's whole list."
  if (url.startsWith('/api/vendors/') && url.endsWith('/department') && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const vKey = decodeURIComponent(url.slice('/api/vendors/'.length, -'/department'.length));
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const dept = typeof body.dept === 'string' && body.dept ? body.dept : null;
      await updateSharedData(async (current) => {
        const vendorDepartments = Object.assign({}, current.vendorDepartments || {});
        if (dept) vendorDepartments[vKey] = dept;
        else delete vendorDepartments[vKey];
        return { data: Object.assign({}, current, { vendorDepartments }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, vendorKey: vKey, dept: dept }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Targeted write for ONE department's vendor assignments. vendorDepartments
  // is shaped {vendorKey: dept} (one department per vendor, unlike
  // customerAllowed's {dept: [ids]}), so "set this department's vendor
  // list" means: clear this department off anything currently assigned to
  // it but missing from the new list, and assign it to everything IN the
  // new list — without ever touching a vendor that belongs to a DIFFERENT
  // department. Mirrors exactly what the client used to compute locally
  // before pushing an entire snapshot.
  if (url.startsWith('/api/vendor-departments/') && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const dept = decodeURIComponent(url.slice('/api/vendor-departments/'.length));
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const vendorKeys = Array.isArray(body.vendorKeys) ? body.vendorKeys : [];
      const keySet = new Set(vendorKeys);
      await updateSharedData(async (current) => {
        const vendorDepartments = Object.assign({}, current.vendorDepartments || {});
        Object.keys(vendorDepartments).forEach(k => {
          if (vendorDepartments[k] === dept && !keySet.has(k)) delete vendorDepartments[k];
        });
        vendorKeys.forEach(k => { vendorDepartments[k] = dept; });
        return { data: Object.assign({}, current, { vendorDepartments }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, dept: dept, count: vendorKeys.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Read-only fresh fetch, pairs with the two endpoints above.
  if (url === '/api/vendors' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const data = await readSharedData();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ vendors: data.vendors || [], vendorDepartments: data.vendorDepartments || {} }));
    return;
  }
  if (url === '/api/data' && req.method === 'POST') {
    const _dataPostSession = requireAuth(req, res);
    if (!_dataPostSession) return;
    try {
      const bodyStr = await readRequestBody(req);
      const incoming = JSON.parse(bodyStr || '{}');
      // items/transactions are BY FAR the largest, slowest-to-serialize
      // part of a routine full-snapshot push — pulled out and written
      // through their own separate lock/file (see ITEMS_TXN_FILE above)
      // BEFORE the main updateSharedData() call below, so this request's
      // big payload can never make some other, unrelated request (an
      // order save, chat message polling, anything using the main store)
      // sit around waiting on it.
      if (Array.isArray(incoming.items) || Array.isArray(incoming.transactions)) {
        // Only overwrite whichever of the two was actually sent — same
        // "merge: only overwrite the keys actually sent" principle as the
        // main store, so pushing just one of them never wipes the other.
        const existing = (!Array.isArray(incoming.items) || !Array.isArray(incoming.transactions)) ? await readItemsTxnData() : null;
        await writeItemsTxnData({
          items: Array.isArray(incoming.items) ? incoming.items : existing.items,
          transactions: Array.isArray(incoming.transactions) ? incoming.transactions : existing.transactions
        });
        delete incoming.items;
        delete incoming.transactions;
      }
      await updateSharedData(async (current) => {
        // If the incoming users array is missing pin/pinHash for a user (because
        // the browser never received it), keep that user's existing credentials
        // instead of wiping them.
        if (Array.isArray(incoming.users)) {
          incoming.users = incoming.users.map(u => {
            if (u && !u.pin && !u.pinHash) {
              const existing = current.users.find(x => x.id === u.id);
              if (existing) return Object.assign({}, u, { pinHash: existing.pinHash, pin: existing.pin });
            }
            return u;
          });
        }
        // SECURITY: this is a general sync endpoint reachable by any logged-in
        // user (not just admins), because staff devices need to push their own
        // routine local edits here. Without this guard, a non-admin session
        // could hand-craft a `users` payload that promotes itself (or anyone)
        // to role:'admin' with full perms — there's no other check standing
        // between this merge and the permissions matrix. A session may change
        // a user's role or perms through this route if it's role:'admin' OR
        // if the acting user has been individually granted the "Manage
        // users" permission — that second case matters because this app's
        // own permission model explicitly supports a non-admin staff account
        // being granted manageUsers (visible right in the Users list: staff
        // accounts with a full permission set, no admin role) — the first,
        // role-only version of this guard didn't account for that and ended
        // up silently blocking exactly the people it's meant to allow: a
        // staff member with Manage Users trying to grant someone else a
        // permission would look like it saved, then silently revert. For
        // anyone who is neither, every incoming user record's role/perms are
        // forced back to whatever the server currently has on file (or safe
        // defaults for a brand-new user id the server doesn't know yet).
        const actingUser = current.users.find(u => u.id === _dataPostSession.userId);
        const actingUserCanManageUsers = _dataPostSession.role === 'admin' || !!(actingUser && actingUser.perms && actingUser.perms.manageUsers);
        if (Array.isArray(incoming.users) && !actingUserCanManageUsers) {
          incoming.users = incoming.users.map(u => {
            if (!u) return u;
            const existing = current.users.find(x => x.id === u.id);
            return Object.assign({}, u, {
              role: existing ? existing.role : 'staff',
              perms: existing ? (existing.perms || {}) : {}
            });
          });
        }
        // scaleLogs uses UNION semantics server-side, not a blind replace.
        // Deletions are already handled correctly via tombstones (see
        // /api/data/delete-scalelog below) — but a PLAIN REPLACE here had a
        // mirror-image bug for ADDITIONS: if device A adds a new scale log
        // entry and device B (which simply hasn't pulled that addition yet)
        // pushes its own routine full snapshot shortly after, a blind
        // replace would silently overwrite the server's copy with B's
        // stale list — erasing A's brand-new entry even though nothing
        // was ever deleted. Unioning (current server records + incoming
        // records, by id, minus anything tombstoned) means a device that's
        // simply behind can never erase what it doesn't yet know about;
        // the ONLY way a record disappears is through an explicit,
        // deliberate delete.
        if (Array.isArray(incoming.scaleLogs)) {
          const tombstoned = new Set(Array.isArray(current.deletedScaleLogIds) ? current.deletedScaleLogIds : []);
          const merged = new Map((current.scaleLogs || []).map(l => [l && l.id, l]));
          for (const l of incoming.scaleLogs) {
            if (l && !tombstoned.has(l.id)) merged.set(l.id, l);
          }
          for (const id of tombstoned) merged.delete(id);
          incoming.scaleLogs = Array.from(merged.values());
        }
        // Orders — similar shape to scaleLogs, but NOT the same reasoning:
        // scaleLogs are effectively append-only (added or deleted, never
        // edited in place), so for any given id both sides always hold
        // identical content and a blind overwrite is harmless. Orders ARE
        // edited in place (date, driver, products all change on the same
        // id) — confirmed live (Aug 2026) that a blind "incoming always
        // wins" merge here meant ANY device with a stale local copy of an
        // order, doing a routine full-snapshot save for something
        // completely unrelated, would silently overwrite a newer edit
        // someone else just made through the dedicated save-order
        // endpoint. Compare each record's own "at" timestamp and keep
        // whichever is actually newer, instead of whichever merge call
        // happened to run last.
        if (Array.isArray(incoming.orders)) {
          const orderTombstoned = new Set(Array.isArray(current.deletedOrderIds) ? current.deletedOrderIds : []);
          const mergedOrders = new Map((current.orders || []).map(o => [o && o.id, o]));
          for (const o of incoming.orders) {
            if (!o || orderTombstoned.has(o.id)) continue;
            const existing = mergedOrders.get(o.id);
            // Keep the existing record whenever it's the newer one — OR when
            // it has a timestamp and the incoming side doesn't. That second
            // case is the actual bug behind orders "bouncing back" from
            // Shipped to Received days later: requiring BOTH sides to have
            // an .at before comparing meant a device holding a stale,
            // .at-less cached copy (from before this field existed, or any
            // code path that built an order object without it) would
            // unconditionally win over a properly-timestamped, genuinely
            // newer server record — silently reverting shipped status (and
            // anything else about the order) back to whatever that old
            // snapshot had. Only let a timestamp-less incoming record win
            // when the existing one ALSO has no timestamp to compare against.
            if (existing && existing.at && (!o.at || existing.at > o.at)) continue;
            mergedOrders.set(o.id, o);
          }
          for (const id of orderTombstoned) mergedOrders.delete(id);
          incoming.orders = Array.from(mergedOrders.values());
          // Same reasoning as deletedCfBillIds elsewhere in this file: never
          // let a client's own (possibly stale) copy of the tombstone list
          // overwrite the server's — only the dedicated delete-order
          // endpoint below should ever add to it.
          incoming.deletedOrderIds = Array.from(orderTombstoned);
        }
        // Drivers — a simple string list (not objects with ids), same
        // union-plus-tombstone reasoning as orders/scaleLogs above: never
        // let one device's routine save silently erase a driver another
        // device just added.
        if (Array.isArray(incoming.drivers)) {
          const driverTombstoned = new Set(Array.isArray(current.deletedDrivers) ? current.deletedDrivers : []);
          const mergedDrivers = new Set(Array.isArray(current.drivers) ? current.drivers : []);
          for (const d of incoming.drivers) {
            if (typeof d === 'string' && d && !driverTombstoned.has(d)) mergedDrivers.add(d);
          }
          for (const d of driverTombstoned) mergedDrivers.delete(d);
          incoming.drivers = Array.from(mergedDrivers).sort();
          incoming.deletedDrivers = Array.from(driverTombstoned);
        }
        // labelTemplates is a plain object keyed by department, e.g.
        // { "Carcass Process/Retail": {...}, "Slaughter": {...} }. A blind
        // top-level replace here has the exact same problem scaleLogs did:
        // if someone edits department A's layout on one device, and
        // another device (which hasn't pulled that edit yet) pushes its own
        // routine snapshot shortly after, a plain replace would silently
        // discard the edit to A the moment it lands — that device's copy
        // of A is just older, not deliberately reverted. Merging per
        // department key means each device's edits to its own department(s)
        // survive regardless of what order pushes happen to land in.
        if (incoming.labelTemplates && typeof incoming.labelTemplates === 'object') {
          incoming.labelTemplates = Object.assign({}, current.labelTemplates || {}, incoming.labelTemplates);
        }
        // purchaseConfig (Reports → Purchasing row/column definitions) — same
        // merge-not-replace reasoning as labelTemplates, one level deeper:
        // each of products/vendorCols/weeks is itself keyed by id, so two
        // people editing different rows (e.g. one adding a product while
        // another renames a vendor column) on different devices can't
        // silently erase each other.
        if (incoming.purchaseConfig && typeof incoming.purchaseConfig === 'object') {
          const curPC = (current.purchaseConfig && typeof current.purchaseConfig === 'object') ? current.purchaseConfig : { products: {}, vendorCols: {}, weeks: {} };
          const incPC = incoming.purchaseConfig;
          incoming.purchaseConfig = {
            products: Object.assign({}, curPC.products || {}, incPC.products || {}),
            vendorCols: Object.assign({}, curPC.vendorCols || {}, incPC.vendorCols || {}),
            weeks: Object.assign({}, curPC.weeks || {}, incPC.weeks || {})
          };
        }
        // purchaseEstimates is keyed [weekId][productId] -> {vendorColId:
        // amount}. Merged at the productId level within each week (not a
        // blind per-week replace) so one device saving one product's EST.
        // numbers for a week can't wipe out another product's numbers for
        // that same week that a different device just saved.
        if (incoming.purchaseEstimates && typeof incoming.purchaseEstimates === 'object') {
          const curPE = (current.purchaseEstimates && typeof current.purchaseEstimates === 'object') ? current.purchaseEstimates : {};
          const mergedPE = Object.assign({}, curPE);
          for (const weekId of Object.keys(incoming.purchaseEstimates)) {
            mergedPE[weekId] = Object.assign({}, curPE[weekId] || {}, incoming.purchaseEstimates[weekId] || {});
          }
          incoming.purchaseEstimates = mergedPE;
        }
        // customers (holding per-customer fields like salesRep, edited via
        // Settings → Customers) had NO merge protection at all — a blind
        // top-level replace, the exact bug scaleLogs used to have. If one
        // device edits a customer's Sales Rep, and a second device (which
        // simply hasn't pulled that edit yet) pushes its own routine
        // snapshot shortly after, the blind replace would silently erase
        // the first device's edit — not because anyone deleted it, just
        // because the second device's copy was older. Same union-by-id
        // fix as scaleLogs: for any customer present in both, the incoming
        // (freshly-pushed) record wins field-by-field over the old server
        // copy, and anything the current push doesn't know about (added on
        // another device) is preserved rather than dropped.
        if (Array.isArray(incoming.customers)) {
          const merged = new Map((current.customers || []).map(c => [c && c.id, c]));
          for (const c of incoming.customers) {
            if (!c) continue;
            merged.set(c.id, Object.assign({}, merged.get(c.id) || {}, c));
          }
          incoming.customers = Array.from(merged.values());
        }
        // labelAllowed is likewise now a per-department object (each
        // department has its own product allow-list for printing) — same
        // merge-not-replace reasoning as labelTemplates directly above.
        if (incoming.labelAllowed && typeof incoming.labelAllowed === 'object' && !Array.isArray(incoming.labelAllowed)) {
          incoming.labelAllowed = Object.assign({}, (current.labelAllowed && typeof current.labelAllowed === 'object' && !Array.isArray(current.labelAllowed)) ? current.labelAllowed : {}, incoming.labelAllowed);
        }
        // cfScheduledDates (Cash Flow's scheduled/approved payment plan) is
        // keyed by bill id — merged (not blindly replaced) so one device's
        // stale push can't erase another device's schedule/approval change
        // to a DIFFERENT bill made moments earlier. Deletions of a WHOLE
        // bill's record go through the dedicated tombstoned endpoint below
        // instead of this generic merge — a plain merge can only ADD/UPDATE
        // keys, never reliably represent "this key was intentionally
        // removed" (the same reason scaleLogs needed deletedScaleLogIds).
        // Filtering by the tombstone list here means even a stale device's
        // full snapshot — one that still has an already-deleted bill in
        // its local copy — can never bring it back.
        //
        // IMPORTANT — this used to replace a bill's ENTIRE record whenever
        // both sides had one, which caused exactly this bug: Terminal A
        // schedules a payment on a bill via the fast dedicated endpoint
        // (below), and it saves fine. Minutes later, Terminal B — which
        // pulled this bill's record before A's schedule happened, and is
        // just doing its own routine periodic full-snapshot save for
        // something unrelated — pushes ITS stale copy of that same bill's
        // record, which has no idea A's new split exists. Whole-record
        // replace let B's stale version silently wipe A's split back out —
        // "I scheduled it and it bounced back" with no error anywhere,
        // because nothing failed; A's save succeeded, then B's later save
        // overwrote it. Merging at the SPLIT level (by split id) instead
        // means every split either side knows about survives, and a split
        // already marked Paid can never be un-paid by a stale incoming copy
        // that still thinks it's unpaid.
        if (incoming.cfScheduledDates && typeof incoming.cfScheduledDates === 'object' && !Array.isArray(incoming.cfScheduledDates)) {
          const cfTombstoned = new Set(Array.isArray(current.deletedCfBillIds) ? current.deletedCfBillIds : []);
          // Split-level tombstones — confirmed live (Aug 2026) that
          // whole-bill tombstoning alone isn't enough. Deleting ONE
          // duplicate split out of several on a bill that still has other
          // splits left doesn't tombstone the bill at all (correctly —
          // the bill is still legitimately scheduled). But that leaves
          // that one deleted split with NO protection whatsoever: any
          // other device (a second terminal, another open tab, anything)
          // still holding an older copy of this bill's record — one that
          // still includes the split that was just deleted — will
          // resurrect it the moment IT does its own routine full-snapshot
          // save, via the exact same union-merge logic below that's
          // otherwise correct and necessary. Tombstoning "billId::splitId"
          // pairs closes that gap the same way deletedCfBillIds closes it
          // for whole records.
          const cfSplitTombstoned = new Set(Array.isArray(current.deletedCfSplitIds) ? current.deletedCfSplitIds : []);
          const currentCf = (current.cfScheduledDates && typeof current.cfScheduledDates === 'object' && !Array.isArray(current.cfScheduledDates)) ? current.cfScheduledDates : {};
          const mergedCf = Object.assign({}, currentCf);
          for (const billId of Object.keys(incoming.cfScheduledDates)) {
            const incRec = incoming.cfScheduledDates[billId];
            const curRec = currentCf[billId];
            if (!curRec || !Array.isArray(curRec.splits)) { mergedCf[billId] = incRec; continue; }
            const splitsById = new Map();
            curRec.splits.forEach(sp => { if (sp && sp.id != null) splitsById.set(sp.id, sp); });
            (Array.isArray(incRec.splits) ? incRec.splits : []).forEach(sp => {
              if (!sp || sp.id == null) return;
              const existing = splitsById.get(sp.id);
              if (existing && existing.paid && !sp.paid) return; // Paid is one-way; never let a stale copy revert it
              splitsById.set(sp.id, sp);
            });
            for (const splitId of Array.from(splitsById.keys())) {
              if (cfSplitTombstoned.has(billId + '::' + splitId)) splitsById.delete(splitId);
            }
            mergedCf[billId] = Object.assign({}, curRec, incRec, { splits: Array.from(splitsById.values()) });
          }
          for (const id of cfTombstoned) delete mergedCf[id];
          incoming.cfScheduledDates = mergedCf;
          // CRITICAL — confirmed live (Aug 2026) this was the actual cause
          // of a schedule reverting minutes after successfully saving, with
          // no error anywhere: deletedCfBillIds is meant to be written ONLY
          // by the two dedicated endpoints below (delete-cf-schedule adds a
          // tombstone; save-cf-schedule removes its own billId's tombstone
          // when it's rescheduled). But this general endpoint used to fall
          // through to `Object.assign({}, current, incoming)` further down
          // with incoming.deletedCfBillIds left as whatever the PUSHING
          // DEVICE happened to have locally — so if that device's own
          // client-side copy still listed a bill as deleted (e.g. it hadn't
          // refreshed since that bill was legitimately rescheduled
          // elsewhere), its next routine full-snapshot save — even for
          // something completely unrelated — would silently reinstate that
          // stale tombstone here. The very next sync from ANY device would
          // then see the bill in deletedCfBillIds and delete its
          // cfScheduledDates entry all over again in the loop just above —
          // "I scheduled it and it came back later" with no failed request
          // anywhere, because nothing failed; a stale tombstone just got
          // resurrected by an unrelated save. Always keep the SERVER's own
          // current tombstone list here — never adopt a client's copy of it
          // through this generic merge. Same reasoning for the new
          // split-level tombstone list.
          incoming.deletedCfBillIds = Array.from(cfTombstoned);
          incoming.deletedCfSplitIds = Array.from(cfSplitTombstoned);
        }
        // Merge: only overwrite the keys actually sent, so saving e.g. just
        // "users" never wipes out items/transactions/storages.
        const merged = Object.assign({}, current, incoming);
        return { data: merged };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Dedicated, atomic scale-log deletion — separate from the general full-
  // snapshot POST above specifically so a deletion can never lose a race
  // against another device's stale push. This both removes the entry AND
  // permanently tombstones its ID in one locked read-modify-write, so no
  // subsequent push (from any device, however stale) can ever bring it back.
  if (url === '/api/data/delete-scalelog' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      if (!body || !body.id) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Missing id' }));
        return;
      }
      await updateSharedData(async (current) => {
        const scaleLogs = (current.scaleLogs || []).filter(l => !(l && l.id === body.id));
        const tombstones = Array.isArray(current.deletedScaleLogIds) ? current.deletedScaleLogIds.slice() : [];
        if (!tombstones.includes(body.id)) tombstones.push(body.id);
        // Cap the tombstone list so it can't grow unbounded forever — old
        // deletions this far back are extremely unlikely to still be racing
        // against some ancient stale push.
        const cappedTombstones = tombstones.length > 5000 ? tombstones.slice(tombstones.length - 5000) : tombstones;
        return { data: Object.assign({}, current, { scaleLogs, deletedScaleLogIds: cappedTombstones }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ===== Orders tab ===== Same "dumb terminal" reasoning as scaleLogs
  // throughout this file: a dedicated, fast, single-record save endpoint
  // (rather than folding every add/edit into the whole-app snapshot POST,
  // which can take up to a minute on a slow connection and let a
  // background pull land in that gap and revert the edit) plus a dedicated
  // delete endpoint that tombstones the id so no other device's stale push
  // can ever resurrect a deleted order.
  if (url === '/api/data/add-driver' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Missing name' }));
        return;
      }
      let finalDrivers = [];
      await updateSharedData(async (current) => {
        const drivers = new Set(Array.isArray(current.drivers) ? current.drivers : []);
        drivers.add(name);
        finalDrivers = Array.from(drivers).sort();
        // A fresh add always wins over a stale "this was just removed"
        // tombstone, same reasoning as save-order/save-cf-schedule.
        const deletedDrivers = (Array.isArray(current.deletedDrivers) ? current.deletedDrivers : []).filter(d => d !== name);
        return { data: Object.assign({}, current, { drivers: finalDrivers, deletedDrivers }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, drivers: finalDrivers }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === '/api/data/delete-driver' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Missing name' }));
        return;
      }
      await updateSharedData(async (current) => {
        const drivers = (Array.isArray(current.drivers) ? current.drivers : []).filter(d => d !== name);
        const deletedDrivers = Array.isArray(current.deletedDrivers) ? current.deletedDrivers.slice() : [];
        if (!deletedDrivers.includes(name)) deletedDrivers.push(name);
        const capped = deletedDrivers.length > 2000 ? deletedDrivers.slice(deletedDrivers.length - 2000) : deletedDrivers;
        return { data: Object.assign({}, current, { drivers, deletedDrivers: capped }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === '/api/data/save-order' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const order = body && body.order;
      if (!order || typeof order !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Missing order' }));
        return;
      }
      let saved = null;
      await updateSharedData(async (current) => {
        const orders = Array.isArray(current.orders) ? current.orders.slice() : [];
        const id = order.id || ('order_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
        // Multiple product lines per order — each order can now cover
        // several products (e.g. one delivery carrying 3 different items
        // for the same customer, same date, same driver) instead of being
        // limited to exactly one product per order record. Falls back to
        // wrapping legacy single product/description/quantity fields into
        // a one-line array, so older orders saved before this change still
        // read and re-save correctly without a separate migration step.
        const rawLines = Array.isArray(order.lines) && order.lines.length
          ? order.lines
          : (order.product || order.description || order.quantity ? [{ product: order.product, description: order.description, quantity: order.quantity }] : []);
        const lines = rawLines.map(l => ({
          product: String((l && l.product) || '').trim().slice(0, 200),
          description: String((l && l.description) || '').trim().slice(0, 1000),
          quantity: String((l && l.quantity !== undefined && l.quantity !== null) ? l.quantity : '').trim().slice(0, 50),
          // Final physical count — entered per-product directly in the
          // Received Orders row while loading, not part of what the
          // customer ordered. Kept alongside product/description/quantity
          // on each line rather than as one order-level field, since a
          // multi-product order needs a separate count per product.
          finalCount: String((l && l.finalCount) || '').trim().slice(0, 50),
          // Whether this specific product needs to go through the
          // processing department before it can ship — a per-product flag,
          // same reasoning as finalCount: one order can easily mix
          // products that need processing with ones that don't.
          needsProcessing: !!(l && l.needsProcessing)
        })).filter(l => l.product || l.description || l.quantity);
        saved = {
          id: id,
          date: String(order.date || '').slice(0, 10),
          customer: String(order.customer || '').trim().slice(0, 200),
          driver: String(order.driver || '').trim().slice(0, 200),
          lines: lines,
          at: new Date().toISOString()
        };
        const idx = orders.findIndex(o => o && o.id === id);
        // Preserve the original creator/creation time across edits — only
        // set them fresh when this is genuinely a brand-new order.
        if (idx >= 0) {
          saved.createdBy = orders[idx].createdBy || order.createdBy || '';
          saved.createdAt = orders[idx].createdAt || new Date().toISOString();
          // Shipped status set by "Match with QuickBooks" — preserved
          // across ordinary edits (date/driver/products), which never
          // include a shipped field at all in their payload, unless THIS
          // save explicitly provides one. Without this check, editing any
          // detail on an already-shipped order would silently un-ship it,
          // since order.shipped would just be undefined on that request.
          if (order.shipped === undefined) {
            saved.shipped = orders[idx].shipped === true;
            saved.invoiceDocNumber = orders[idx].invoiceDocNumber || '';
            saved.invoiceDate = orders[idx].invoiceDate || '';
          } else {
            saved.shipped = order.shipped === true;
            saved.invoiceDocNumber = String(order.invoiceDocNumber || '').trim().slice(0, 100);
            saved.invoiceDate = String(order.invoiceDate || '').slice(0, 10);
          }
          orders[idx] = saved;
        } else {
          saved.createdBy = order.createdBy || '';
          saved.createdAt = new Date().toISOString();
          saved.shipped = order.shipped === true;
          saved.invoiceDocNumber = String(order.invoiceDocNumber || '').trim().slice(0, 100);
          saved.invoiceDate = String(order.invoiceDate || '').slice(0, 10);
          orders.push(saved);
        }
        // A fresh save always wins over a stale "this was just deleted"
        // tombstone — same reasoning as save-cf-schedule elsewhere in this
        // file: without this, re-adding an order within moments of deleting
        // a mistaken one for the same id would be silently dropped again.
        const tombstones = (Array.isArray(current.deletedOrderIds) ? current.deletedOrderIds : []).filter(tid => tid !== id);
        return { data: Object.assign({}, current, { orders, deletedOrderIds: tombstones }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, order: saved }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === '/api/data/delete-order' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      if (!body || !body.id) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Missing id' }));
        return;
      }
      await updateSharedData(async (current) => {
        const orders = (current.orders || []).filter(o => !(o && o.id === body.id));
        const tombstones = Array.isArray(current.deletedOrderIds) ? current.deletedOrderIds.slice() : [];
        if (!tombstones.includes(body.id)) tombstones.push(body.id);
        const cappedTombstones = tombstones.length > 5000 ? tombstones.slice(tombstones.length - 5000) : tombstones;
        return { data: Object.assign({}, current, { orders, deletedOrderIds: cappedTombstones }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }


  // Dedicated, atomic delete for one Cash Flow bill's ENTIRE scheduled/
  // approved payment record — same reasoning as delete-scalelog above:
  // going through the generic full-snapshot POST can't reliably represent
  // "this was intentionally deleted" (a stale device's snapshot would just
  // look like it never had this bill scheduled, not like it WAS scheduled
  // and got removed), so this atomically removes it AND tombstones the id
  // so no later merge can bring it back.
  if (url === '/api/data/delete-cf-schedule' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      if (!body || !body.billId) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Missing billId' }));
        return;
      }
      await updateSharedData(async (current) => {
        const cfScheduledDates = Object.assign({}, current.cfScheduledDates || {});
        delete cfScheduledDates[body.billId];
        const tombstones = Array.isArray(current.deletedCfBillIds) ? current.deletedCfBillIds.slice() : [];
        if (!tombstones.includes(body.billId)) tombstones.push(body.billId);
        const cappedTombstones = tombstones.length > 5000 ? tombstones.slice(tombstones.length - 5000) : tombstones;
        return { data: Object.assign({}, current, { cfScheduledDates, deletedCfBillIds: cappedTombstones }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Dedicated delete for ONE split within a bill's record — separate from
  // whole-bill delete-cf-schedule above, and for a related but distinct
  // reason. CRITICAL FIX (confirmed live, Aug 2026): deleting a split by
  // re-saving the bill's record via save-cf-schedule (below) with that
  // split simply left out of the array NEVER actually worked, with zero
  // races or multiple devices required. save-cf-schedule's merge unions
  // splits from the server's current copy with whatever the client sent —
  // which is correct and necessary for its actual purpose (another
  // terminal adding a split this client doesn't know about yet), but it
  // has no way to tell "this split is absent because it was deleted" apart
  // from "this split is absent because this client's local copy is just
  // incomplete/stale." Both look identical: a split present on the server
  // but missing from what was sent. Every single delete — from any device,
  // one at a time, with no race whatsoever — was silently undone by that
  // same merge on the very save call that was trying to perform it. Only
  // an explicit tombstone can disambiguate "deleted" from "unknown," which
  // is exactly what this endpoint records.
  if (url === '/api/data/delete-cf-split' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      if (!body || !body.billId || !body.splitId) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Missing billId or splitId' }));
        return;
      }
      let wholeRecordDeleted = false;
      await updateSharedData(async (current) => {
        const cfScheduledDates = Object.assign({}, current.cfScheduledDates || {});
        const rec = cfScheduledDates[body.billId];
        const splitTombstones = Array.isArray(current.deletedCfSplitIds) ? current.deletedCfSplitIds.slice() : [];
        const splitKey = body.billId + '::' + body.splitId;
        if (!splitTombstones.includes(splitKey)) splitTombstones.push(splitKey);
        const cappedSplitTombstones = splitTombstones.length > 20000 ? splitTombstones.slice(splitTombstones.length - 20000) : splitTombstones;
        let billTombstones = Array.isArray(current.deletedCfBillIds) ? current.deletedCfBillIds.slice() : [];
        if (rec && Array.isArray(rec.splits)) {
          const remaining = rec.splits.filter(sp => !sp || sp.id !== body.splitId);
          if (remaining.length) {
            cfScheduledDates[body.billId] = Object.assign({}, rec, { splits: remaining });
          } else {
            delete cfScheduledDates[body.billId];
            wholeRecordDeleted = true;
            if (!billTombstones.includes(body.billId)) billTombstones.push(body.billId);
            billTombstones = billTombstones.length > 5000 ? billTombstones.slice(billTombstones.length - 5000) : billTombstones;
          }
        }
        return { data: Object.assign({}, current, { cfScheduledDates, deletedCfSplitIds: cappedSplitTombstones, deletedCfBillIds: billTombstones }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, wholeRecordDeleted }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Dedicated, atomic SAVE for one Cash Flow bill's scheduled/approved
  // payment record — separate from the general full-snapshot POST for the
  // same reason the delete endpoint above is separate: that generic POST
  // bundles this tiny record together with the ENTIRE app snapshot (items,
  // transactions, everything), which can legitimately take up to a minute
  // to transfer on a slow connection. A background pull landing in that
  // gap would fetch the server's still-outdated copy and silently revert
  // the edit before the slow push ever finished — exactly the "shows up
  // then disappears" bug this fixes. This endpoint sends just the one
  // record that changed, so it completes almost immediately regardless of
  // how much other data this business has accumulated. Also clears this
  // bill's id from the tombstone list, since actively saving a record for
  // it means it's no longer deleted.
  //
  // This endpoint is for ADDING or UPDATING splits only (scheduling,
  // approving, marking paid) — NOT for deleting one. Deletion goes through
  // delete-cf-split above instead, which can express "this split is gone"
  // as an explicit tombstone; this endpoint's union-merge fundamentally
  // cannot represent that (see the long comment on delete-cf-split).
  if (url === '/api/data/save-cf-schedule' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      if (!body || !body.billId || !body.record) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Missing billId or record' }));
        return;
      }
      await updateSharedData(async (current) => {
        const currentCf = current.cfScheduledDates || {};
        const cfScheduledDates = Object.assign({}, currentCf);
        const curRec = currentCf[body.billId];
        const incRec = body.record;
        const splitTombstones = new Set(Array.isArray(current.deletedCfSplitIds) ? current.deletedCfSplitIds : []);
        // Same split-level merge as the general endpoint above, and for the
        // same reason: this device's local record was built from whatever
        // it last pulled, which may already be stale by the time this
        // request lands if another terminal scheduled or paid a split on
        // this exact bill in between. A plain overwrite here would silently
        // drop that other terminal's split.
        if (curRec && Array.isArray(curRec.splits) && incRec && typeof incRec === 'object') {
          const splitsById = new Map();
          curRec.splits.forEach(sp => { if (sp && sp.id != null) splitsById.set(sp.id, sp); });
          (Array.isArray(incRec.splits) ? incRec.splits : []).forEach(sp => {
            if (!sp || sp.id == null) return;
            const existing = splitsById.get(sp.id);
            if (existing && existing.paid && !sp.paid) return; // Paid is one-way
            splitsById.set(sp.id, sp);
          });
          for (const splitId of Array.from(splitsById.keys())) {
            if (splitTombstones.has(body.billId + '::' + splitId)) splitsById.delete(splitId);
          }
          cfScheduledDates[body.billId] = Object.assign({}, curRec, incRec, { splits: Array.from(splitsById.values()) });
        } else {
          cfScheduledDates[body.billId] = incRec;
        }
        const tombstones = (Array.isArray(current.deletedCfBillIds) ? current.deletedCfBillIds : []).filter(id => id !== body.billId);
        return { data: Object.assign({}, current, { cfScheduledDates, deletedCfBillIds: tombstones }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ===== Server-side backups (admin only — these expose everything,
  // including hashed PINs, and a restore can overwrite all shared data) =====
  if (url === '/api/backups' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    try {
      const list = await listBackups();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ backups: list }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === '/api/backups' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const filename = await takeServerBackup('manual');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, filename: filename }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === '/api/backups/restore-upload' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const payload = JSON.parse(bodyStr || '{}');
      if (!payload || payload._backupType !== 'plant-console-server-backup' || !payload.data) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'That file is not a valid Plant Console server backup.' }));
        return;
      }
      await takeServerBackup('pre-restore');
      await writeSharedData(payload.data);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.startsWith('/api/backups/') && url.endsWith('/restore') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const filename = decodeURIComponent(url.slice('/api/backups/'.length, -'/restore'.length));
    if (!BACKUP_FILENAME_RE.test(filename)) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: 'Invalid backup filename.' }));
      return;
    }
    try {
      const raw = await fs.promises.readFile(path.join(BACKUP_DIR, filename), 'utf8');
      const payload = JSON.parse(raw);
      if (!payload || payload._backupType !== 'plant-console-server-backup' || !payload.data) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'That file is not a valid server backup.' }));
        return;
      }
      // Snapshot whatever's live RIGHT NOW before overwriting it, so a bad
      // restore itself has an undo path.
      await takeServerBackup('pre-restore');
      await writeSharedData(payload.data);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.startsWith('/api/backups/') && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const filename = decodeURIComponent(url.slice('/api/backups/'.length));
    if (!BACKUP_FILENAME_RE.test(filename)) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: 'Invalid backup filename.' }));
      return;
    }
    try {
      const raw = await fs.promises.readFile(path.join(BACKUP_DIR, filename), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Content-Disposition': 'attachment; filename="' + filename + '"'
      });
      res.end(raw);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: 'Backup not found.' }));
    }
    return;
  }

  // Serve index.html
  if (url === '/' || url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      // No-cache: without this, some browsers/Android "Add to Home Screen"
      // installs can keep serving a stale cached copy of the whole app
      // (old JS and all) indefinitely, so a device can look "stuck" even
      // after new code has been deployed and other devices already show it.
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // Serve the label preview/editor pages directly (static reference tools,
  // not part of the main app — no auth required, plain HTML files only).
  if (url === '/label-preview.html' || url === '/label-preview-editable.html') {
    const filePath = path.join(__dirname, url.slice(1));
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // Start OAuth flow — redirect user to Intuit's authorization page
  if (url === '/connect') {
    if (!requireAuth(req, res)) return;
    const authUrl = 'https://appcenter.intuit.com/connect/oauth2?' + querystring.stringify({
      client_id: CLIENT_ID,
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: REDIRECT_URI,
      state: 'plantconsole'
    });
    res.writeHead(302, { 'Location': authUrl });
    res.end();
    return;
  }

  // Check connection status
  if (url === '/api/qb/status') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ connected: !!accessToken, realm: activeRealm }));
    return;
  }

  // --- Plaid (bank balance) ---
  if (url === '/api/plaid/status') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({
      connected: !!plaidAccessToken,
      institutionName: plaidInstitutionName || null,
      connectedAt: plaidConnectedAt || null,
      env: PLAID_ENV
    }));
    return;
  }

  // Step 1 of Plaid Link: get a short-lived link_token that the CLIENT
  // uses to open the Link widget. Never expose PLAID_CLIENT_ID/SECRET to
  // the browser directly — this is why it has to be a server round-trip
  // rather than the client calling Plaid itself.
  if (url === '/api/plaid/create-link-token' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'PLAID_CLIENT_ID / PLAID_SECRET not configured on the server yet.' }));
      return;
    }
    try {
      const result = await plaidRequest('/link/token/create', {
        client_name: 'Plant Console',
        language: 'en',
        country_codes: ['US'],
        user: { client_user_id: 'plant-console-' + (session.userId || session.name || 'admin') },
        products: ['balance']
      });
      if (result.status !== 200) {
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.data.error_message || 'Plaid error creating link token', plaid: result.data }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ link_token: result.data.link_token }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Step 2: the Link widget hands the client a public_token once the
  // person finishes logging into their bank inside Plaid's UI. This
  // exchanges it server-side for a permanent access_token, which is what
  // actually gets stored and reused for every future balance check.
  if (url === '/api/plaid/exchange-token' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const body = JSON.parse(await readRequestBody(req) || '{}');
      if (!body.public_token) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing public_token' }));
        return;
      }
      const result = await plaidRequest('/item/public_token/exchange', { public_token: body.public_token });
      if (result.status !== 200) {
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.data.error_message || 'Plaid error exchanging token', plaid: result.data }));
        return;
      }
      plaidAccessToken = result.data.access_token;
      plaidItemId = result.data.item_id;
      plaidInstitutionName = body.institutionName || plaidInstitutionName || '';
      plaidConnectedAt = Date.now();
      savePlaidTokens();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // The actual balance pull — call this any time the UI wants a fresh
  // number, same click-to-refresh model as "Pull from QuickBooks" rather
  // than a background poll (balance checks count against Plaid's usage-
  // based billing, so this should only run when someone actually asks).
  if (url === '/api/plaid/balance' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    if (!plaidAccessToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No bank account connected yet.' }));
      return;
    }
    try {
      const result = await plaidRequest('/accounts/balance/get', { access_token: plaidAccessToken });
      if (result.status !== 200) {
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.data.error_message || 'Plaid error fetching balance', plaid: result.data }));
        return;
      }
      const accounts = (result.data.accounts || []).map(function (a) {
        const current = a.balances.current;
        const available = a.balances.available;
        // Plaid's Balance product doesn't have a direct "pending amount"
        // field — "available" already has pending holds subtracted out of
        // "current" in most cases. current - available is the closest
        // direct equivalent to "how much is tied up pending" without
        // pulling in the separate (billed) Transactions product just for
        // this one number.
        const pending = (current !== null && available !== null) ? Math.round((current - available) * 100) / 100 : null;
        return {
          name: a.name,
          mask: a.mask,
          type: a.subtype || a.type,
          balance: current,
          availableBalance: available,
          pendingAmount: pending,
          currency: a.balances.iso_currency_code || 'USD'
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ institutionName: plaidInstitutionName, accounts: accounts, fetchedAt: Date.now() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url === '/api/plaid/disconnect' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    plaidAccessToken = '';
    plaidItemId = '';
    plaidInstitutionName = '';
    plaidConnectedAt = 0;
    clearPlaidTokens();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Lets the UI show "last automatic sync: N minutes ago" instead of the
  // background job being a completely invisible black box — also useful
  // for confirming it's actually running at all if something looks stale.
  if (url === '/api/background-sync-status') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({
      inFlight: _backgroundSyncInFlight,
      lastSyncAt: _lastBackgroundSyncAt || null,
      lastResult: _lastBackgroundSyncResult
    }));
    return;
  }

  // Diagnostic endpoint — visit this URL directly in the browser
  if (url === '/api/qb/test') {
    if (!requireAuth(req, res)) return;
    try {
      const result = await diagnose(false);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // QuickBooks documents endpoint — bills, invoices, sales receipts, credit memos
  // ?entity=Invoice                  -> fetch ALL pages of that type (may be slow)
  // ?entity=Invoice&startposition=1  -> fetch ONE page (100 rows) starting at N
  //                                     (client drives pagination = no timeouts)
  // &since=ISO                       -> only records changed since that time
  // &to=YYYY-MM-DD                   -> only records with TxnDate on/before that date
  //                                     (used by the Purchasing report to pull one week at a time)
  if (url === '/api/qb/documents') {
    if (!requireAuth(req, res)) return;
    try {
      const ent = queryParams.entity;
      const since = queryParams.since || null;
      const from = queryParams.from || null;
      const to = queryParams.to || null;
      const startPos = queryParams.startposition ? parseInt(queryParams.startposition, 10) : null;
      if (ent && ['Bill','Invoice','SalesReceipt','CreditMemo','VendorCredit','Payment','Vendor','JournalEntry','Account','Deposit'].indexOf(ent) >= 0) {
        if (!accessToken) await refreshAccessToken();
        // Single-page mode: return just one page so each HTTP request is fast.
        if (startPos !== null && !isNaN(startPos)) {
          const data = await fetchQBEntityPage(ent, startPos, false, since, from, to);
          const rows = (data.QueryResponse && data.QueryResponse[ent]) || [];
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
          const out = {}; out[ent] = rows; out.pageSize = 100; out.startPosition = startPos;
          res.end(JSON.stringify(out));
          return;
        }
        // Fetch-all mode (kept for small types)
        const rows = await fetchQBEntity(ent, since, from, to);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        const out = {}; out[ent] = rows;
        res.end(JSON.stringify(out));
        return;
      }
      // A request with NO entity param (or an unrecognized one) used to fall
      // through to fetchQBDocuments(), which pulled Bill+Invoice+
      // SalesReceipt+CreditMemo+VendorCredit's ENTIRE history — every record
      // that has ever existed in QuickBooks, no date bound at all — into one
      // in-memory object, then JSON.stringified the whole thing into a
      // single HTTP response. On a company file with any real transaction
      // history, that is enough to exhaust this instance's 512MB and abort
      // the whole Node process (exit code 134 — V8's own out-of-memory
      // abort). No current frontend code calls this endpoint without an
      // entity param (every real caller specifies one and pages through
      // results 100 at a time instead) — so this path is unreachable by
      // anything in the app today and only ever fires from a stray/stale
      // request. Rather than leave a whole-history-in-one-response bomb
      // sitting there for whatever hits it next, this now just rejects the
      // request outright.
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: 'entity parameter required' }));
    } catch (err) {
      const needsReconnect = err.message === 'NEEDS_RECONNECT';
      res.writeHead(needsReconnect ? 401 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: err.message, needsReconnect: needsReconnect }));
    }
    return;
  }

  // QuickBooks items proxy endpoint
  if (url === '/api/qb/items') {
    if (!requireAuth(req, res)) return;
    try {
      const data = await fetchQBItems(false);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('QB fetch error:', err.message);
      const needsReconnect = err.message === 'NEEDS_RECONNECT';
      res.writeHead(needsReconnect ? 401 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({
        error: needsReconnect ? 'QuickBooks connection expired. Please reconnect.' : err.message,
        needsReconnect: needsReconnect
      }));
    }
    return;
  }

  // QuickBooks customers proxy endpoint (feeds the Scale Log Customer allow-list)
  if (url === '/api/qb/customers') {
    if (!requireAuth(req, res)) return;
    try {
      const data = await fetchQBCustomers(false);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('QB fetch error:', err.message);
      const needsReconnect = err.message === 'NEEDS_RECONNECT';
      res.writeHead(needsReconnect ? 401 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({
        error: needsReconnect ? 'QuickBooks connection expired. Please reconnect.' : err.message,
        needsReconnect: needsReconnect
      }));
    }
    return;
  }

  // Creates a REAL invoice in QuickBooks from an Order in Plant Console.
  // The client builds the actual invoice payload (it already has the
  // customer/item QuickBooks-id matching data loaded locally, and shows the
  // person a review screen before this ever fires) — this endpoint's job is
  // just to authenticate the write and do basic sanity checks, not to
  // reconstruct or second-guess what was already reviewed and confirmed.
  if (url === '/api/qb/create-invoice' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const invoice = body && body.invoice;
      if (!invoice || !invoice.CustomerRef || !invoice.CustomerRef.value) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Missing invoice or CustomerRef' }));
        return;
      }
      if (!Array.isArray(invoice.Line) || !invoice.Line.length) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Invoice has no line items' }));
        return;
      }
      console.log('Creating QuickBooks invoice — requested by ' + session.name + ', customer ref ' + invoice.CustomerRef.value + ', ' + invoice.Line.length + ' line(s)');
      const created = await createQBInvoice(invoice);
      console.log('QuickBooks invoice created: #' + (created && created.DocNumber) + ' (Id ' + (created && created.Id) + ')');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, invoice: created }));
    } catch (err) {
      console.error('QB invoice creation error:', err.message);
      const needsReconnect = err.message === 'NEEDS_RECONNECT';
      res.writeHead(needsReconnect ? 401 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({
        error: needsReconnect ? 'QuickBooks connection expired. Please reconnect.' : err.message,
        needsReconnect: needsReconnect
      }));
    }
    return;
  }


  // QuickBooks token refresh endpoint
  if (url === '/api/qb/refresh') {
    if (!requireAuth(req, res)) return;
    try {
      const ok = await refreshAccessToken();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: ok }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // OAuth callback — exchange the code for tokens
  if (url.startsWith('/callback')) {
    const cookies = parseCookies(req);
    if (!getSession(cookies.pc_session)) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end('<html><body><h2>Your session expired before QuickBooks finished connecting.</h2><p><a href="/">Log back in</a> and try connecting again.</p></body></html>');
      return;
    }
    const code = queryParams.code;
    const realmId = queryParams.realmId;
    if (code) {
      try {
        const ok = await exchangeCodeForTokens(code);
        if (realmId) { activeRealm = realmId; saveQBTokens(); }
        const msg = ok
          ? '<h2 style="color:#0f6e40">✓ Connected to QuickBooks successfully!</h2><p>You can close this window and return to Plant Console. Click <b>Sync from QuickBooks</b> to load your items.</p>'
          : '<h2 style="color:#c23b33">Connection failed</h2><p>Please try connecting again.</p>';
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QuickBooks Connection</title>
        <style>body{font-family:Arial,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;text-align:center;line-height:1.7;color:#222}</style></head>
        <body>${msg}<p style="margin-top:30px"><a href="/" style="background:#1a5f7a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Return to Plant Console</a></p></body></html>`);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end('<h2>Error connecting: ' + err.message + '</h2>');
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end('<html><body><h2>No authorization code received.</h2><p><a href="/connect">Try again</a></p></body></html>');
    }
    return;
  }

  // EULA page
  if (url === '/eula') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>End User License Agreement - Plant Console</title>
    <style>body{font-family:Arial,sans-serif;max-width:800px;margin:60px auto;padding:0 24px;line-height:1.7;color:#222}h1{font-size:26px;margin-bottom:8px}h2{font-size:16px;margin-top:32px}p{margin:10px 0}footer{margin-top:60px;color:#888;font-size:12px}</style></head>
    <body><h1>End User License Agreement</h1><p><strong>Plant Console</strong> — Leader Meat Co.<br>Last updated: June 2026</p>
    <h2>1. Acceptance</h2><p>By using Plant Console you agree to these terms.</p>
    <h2>2. Use of Service</h2><p>Plant Console is an internal inventory and operations management tool for authorized facility staff only. Unauthorized use is prohibited.</p>
    <h2>3. Data</h2><p>All data entered into Plant Console is owned by Leader Meat Co. We do not sell or share your data with third parties.</p>
    <h2>4. QuickBooks Integration</h2><p>Plant Console connects to QuickBooks Online via Intuit's official API to sync inventory data. This connection is used solely for internal business operations.</p>
    <h2>5. Limitation of Liability</h2><p>Plant Console is provided as-is for internal use. Leader Meat Co. is not liable for any data loss or service interruption.</p>
    <h2>6. Contact</h2><p>For questions contact your system administrator.</p>
    <footer>© 2026 Leader Meat Co. All rights reserved.</footer></body></html>`);
    return;
  }

  // Privacy Policy page
  if (url === '/privacy') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Privacy Policy - Plant Console</title>
    <style>body{font-family:Arial,sans-serif;max-width:800px;margin:60px auto;padding:0 24px;line-height:1.7;color:#222}h1{font-size:26px;margin-bottom:8px}h2{font-size:16px;margin-top:32px}p{margin:10px 0}footer{margin-top:60px;color:#888;font-size:12px}</style></head>
    <body><h1>Privacy Policy</h1><p><strong>Plant Console</strong> — Leader Meat Co.<br>Last updated: June 2026</p>
    <h2>1. Information We Collect</h2><p>Plant Console collects inventory and transaction data entered by authorized users for internal business operations.</p>
    <h2>2. How We Use Information</h2><p>Data is used solely to manage facility inventory and operations. We do not sell, trade, or share your data with third parties.</p>
    <h2>3. QuickBooks Data</h2><p>We access QuickBooks Online data (items, inventory) only to display and sync inventory within Plant Console. No QuickBooks data is stored on external servers.</p>
    <h2>4. Data Security</h2><p>All data is transmitted over HTTPS. Access is restricted to authorized personnel only.</p>
    <h2>5. Contact</h2><p>For privacy concerns contact your system administrator.</p>
    <footer>© 2026 Leader Meat Co. All rights reserved.</footer></body></html>`);
    return;
  }

  // Disconnect handler
  if (url === '/disconnect') {
    if (!requireAuth(req, res)) return;
    accessToken = '';
    refreshToken = '';
    clearQBTokens();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

(async () => {
  await loadSessionsFromDisk(); // restore sessions BEFORE accepting any requests, so nobody gets a spurious 401 right after a restart
  await migrateItemsTxnIfNeeded(); // one-time: move any existing items/transactions out of the old combined file before anything tries to read either store
  server.listen(PORT, () => {
    console.log('Plant Console running on port ' + PORT);
    // Apply the (possibly just-lowered) BACKUP_KEEP_MAX to whatever's already
    // on disk right away, instead of waiting for the next backup to be taken
    // (which could be up to an hour away) to trim down existing excess files.
    pruneOldBackups().catch(e => console.error('Could not prune old backups on startup:', e.message));
    // First background Customers/Vendors sync shortly after boot (not
    // immediately — give the server a moment to finish settling first),
    // then on the regular interval after that.
    setTimeout(() => { runBackgroundSync().catch(e => console.error('Background sync error:', e.message)); }, 15000);
    setInterval(() => { runBackgroundSync().catch(e => console.error('Background sync error:', e.message)); }, BACKGROUND_SYNC_INTERVAL_MS);
  });
})();
