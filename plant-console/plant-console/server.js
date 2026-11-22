const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const crypto = require('crypto');
const zlib = require('zlib');

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

// Used for driver route-mileage estimates (see fetchDrivingRouteMiles and
// /api/data/driver-route-miles below) — a free Geoapify API key (no credit
// card required, 3,000 credits/day). Switched from Google Maps (Sep 2026):
// Google's Directions/Routes API only offers a blunt "avoid all highways"
// toggle, not "avoid parkways specifically" — and these are commercial
// trucks that can't legally use NJ parkways but CAN and should use the
// Turnpike/interstates, so that toggle made estimates worse, not better.
// Geoapify's truck travel modes route using real truck road-restriction
// data instead of a blanket highway avoidance. Entirely optional: nothing
// else in the app depends on this being set, so a missing key only
// disables this one feature (the endpoint below returns a clear NO_API_KEY
// error the client can show, rather than the whole app failing to start).
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY || '';
// Optional second key used ONLY to show a "regular route" comparison
// number next to the truck-route mileage above — a normal car/passenger
// route (free to use parkways/highways) so it's easy to see how many
// extra miles the truck route costs by having to avoid them. Requires a
// Google Cloud project with billing enabled and the Directions API turned
// on (unlike Geoapify, Google's free tier isn't card-free) — entirely
// optional: missing this only disables the "regular route" number, the
// truck-route estimate above still works with just GEOAPIFY_API_KEY.
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
// Leader Meat's own address — the fixed origin AND destination for every
// driver's estimated route, since every route is a real round trip back to
// the plant. Update this if the plant ever moves.
const LEADER_MEAT_ADDRESS = '254 Sykesville Road, Chesterfield, NJ 08515';

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
const DATA_DEFAULT = { storages: [], users: [], scaleLogs: [], labelAllowed: {}, savedReports: [], customers: [], customerAllowed: {}, labelTemplates: {}, deletedScaleLogIds: [], cfScheduledDates: {}, deletedCfBillIds: [], deletedCfSplitIds: [], chatMessages: [], orders: [], deletedOrderIds: [], drivers: [], deletedDrivers: [],
  // Weekly Purchase Report (Reports → Purchasing): purchaseConfig holds the
  // admin-configured row/column definitions (which products, which vendor
  // columns, which weeks exist) — small, rarely-changed, keyed by id so it
  // merges the same way labelTemplates does. purchaseEstimates holds the
  // manually-typed EST. numbers, keyed [weekId][productId][vendorColId] —
  // REALIZED numbers are never stored here; they're computed fresh from
  // QuickBooks Bills on demand and only cached separately (see
  // PURCHASE_CACHE_FILE) since they're derived data, not source-of-truth.
  purchaseConfig: { products: {}, vendorCols: {}, weeks: {} },
  purchaseEstimates: {},
  // Per-user UI preferences that should follow a person to any browser or
  // device (not just this one) — keyed by user id. CONFIRMED live (Sep
  // 2026): the Items page's filter dropdowns were only remembered via
  // localStorage, which is why they "got wiped" after signing back in —
  // localStorage is per-browser, so a different browser, an incognito
  // window, or a cleared cache all naturally start empty. Small object,
  // same push/pull merge as labelAllowed/customerAllowed above.
  itemFilterPrefs: {}
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

const WEAK_PINS = new Set(['1234','12345','123456','0000','1111','2222','4321','1212','0123','9876','2580','1122','6969','1004','2000','2026','2025']);
// Boot-time warning if the well-known default admin login still works.
setTimeout(async () => {
  try {
    await updateSharedData(async (data) => {
      const u = (data.users || []).find(x => x && String(x.email || '').toLowerCase() === 'admin@facility.com');
      if (u && ((u.pinHash && verifyPin('1234', u.pinHash)) || u.pin === '1234')) {
        console.warn('[security] WARNING: the default admin login (admin@facility.com / PIN 1234) still works. Change that PIN in Settings > Users.');
      }
      return { data, skipWrite: true };
    });
  } catch (e) {}
}, 10000);
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

// In-memory cache of the parsed data file — updated on every write, served
// directly (no disk read/JSON.parse) on every read as long as it's valid.
// Added specifically because reads vastly outnumber writes here: every
// open browser tab polls this data every 1.5 SECONDS (see index.html,
// setInterval(pullFromServer,1500)), while writes only happen when someone
// actually changes something. Confirmed live (Sep 2026) via request
// logging that several tabs' 1.5s polls landing close together were
// driving repeated, full re-parses of tens of MB of JSON multiple times
// per second — bursts of that easily outpacing what garbage collection
// could reclaim in between, which is what was actually causing the sudden
// (not gradual) multi-hundred-MB memory spikes leading to repeated OOM
// crashes, not a leak in the traditional sense. Caching means a read only
// costs a disk hit the FIRST time (or right after a restart); every read
// after that until the next write is just returning what's already in
// memory — no parsing, most of the allocation pressure gone. null means
// "not loaded yet, or invalidated" and forces exactly one fresh disk read.
let _sharedDataCache = null;

// Internal, lock-free implementations. Only call these from inside
// withDataLock() — calling them directly risks the exact race described above.
async function _readSharedDataUnlocked() {
  if (_sharedDataCache) return Object.assign({}, _sharedDataCache); // shallow clone — cheap, and protects the cache from a caller mutating what it gets back
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
    // Same migration reasoning as labelAllowed just above — customerAllowed
    // is likewise a per-department object; DATA_DEFAULT itself used to
    // declare this as [] (fixed above, but old data files on disk can
    // still have it as an array from before that fix), so guard it the
    // same way rather than let a stale array shape flow into the merge
    // logic downstream, which assumes an object.
    if (Array.isArray(data.customerAllowed)) data.customerAllowed = {};
    // Defensive: never let the app get into a state where no user can log in.
    if (!Array.isArray(data.users) || data.users.length === 0) {
      data.users = [defaultAdmin()];
      await _writeSharedDataRawUnlocked(data);
      console.log('Users list was empty — re-seeded default admin (admin@facility.com / PIN 1234).');
    }
    _sharedDataCache = data;
    return Object.assign({}, data);
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
  _sharedDataCache = data; // the write just landed — this IS the current truth now, no need to re-read it back from disk next time
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
// Server-side mirror of _driverGroupKey() in index.html: same
// trim+uppercase normalization, used anywhere a driver name gets COMPARED
// (rename/merge matching, in-use checks) rather than just displayed. The
// Orders page has always used the client-side version to visually group
// case/whitespace variants of the same driver together, but the
// rename/delete endpoints below used to compare driver names with plain
// === — meaning a driver record could genuinely have orders attached
// under a slightly different-cased string that an exact match would never
// find, so a rename/merge into it could look like it did nothing (the
// merged-into driver still showing 0 orders) even though the data really
// did move. Using the same normalization here as the display does closes
// that gap.
function driverGroupKey(name) {
  const t = typeof name === 'string' ? name.trim() : '';
  return t ? t.toUpperCase() : '';
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
// Same in-memory caching as _sharedDataCache above, same reason: this file
// is bigger than the main one and gets read on every single 1.5s poll from
// every open tab — caching it means that only costs a disk read once, not
// continuously.
let _itemsTxnCache = null;
// Cached STRINGIFIED /api/data response body — see the GET handler below.
// Separate from _sharedDataCache/_itemsTxnCache above (those cache the
// parsed objects); this caches the expensive JSON.stringify of the merged
// payload itself, since that response is what's actually rebuilt on every
// single poll from every open tab. null means "not built yet, or the refs
// below no longer match the current caches" and forces exactly one fresh
// stringify.
let _apiDataJsonCache = null; // { sharedRef, itemsTxnRef, json, etag }
const _API_DATA_BOOT_ID = crypto.randomBytes(4).toString('hex');
let _apiDataVersion = 0;
// Rebuilds the cached /api/data response body from the current caches and
// gives it a fresh version tag. Read the caches directly rather than through
// readSharedData()/readItemsTxnData() (which shallow-clone defensively) — we
// only read from them here before handing them to JSON.stringify.
function _rebuildApiDataJsonCache() {
  const data = _sharedDataCache;
  const itemsTxn = _itemsTxnCache;
  const safe = Object.assign({}, data, itemsTxn, {
    users: data.users.map(u => { const c = Object.assign({}, u); delete c.pin; delete c.pinHash; return c; })
  });
  const json = JSON.stringify(safe);
  _apiDataVersion++;
  _apiDataJsonCache = { sharedRef: _sharedDataCache, itemsTxnRef: _itemsTxnCache, json, etag: '"' + _API_DATA_BOOT_ID + '-' + _apiDataVersion + '"' };
}
async function _readItemsTxnUnlocked() {
  if (_itemsTxnCache) return Object.assign({}, _itemsTxnCache);
  try {
    const raw = await fs.promises.readFile(ITEMS_TXN_FILE, 'utf8');
    const data = Object.assign({}, ITEMS_TXN_DEFAULT, JSON.parse(raw || '{}'));
    _itemsTxnCache = data;
    return Object.assign({}, data);
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
  _itemsTxnCache = data; // the write just landed — this IS the current truth now
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

// ===== LEGAL DOCUMENTS (Oct 2026) =====
// Certificates, inspection records, HACCP plans, licenses. Anyone who can
// see the Legal Documents tab (viewLegal) can list, open and UPLOAD; only
// an admin can DELETE. Files live on the persistent disk under
// DATA_DIR/legal-docs/<id>; the list itself is a small JSON file with its
// own lock (same atomic temp+rename write as everything else). Files are
// also copied to Google Drive by the nightly backup — see
// gdriveSyncLegalDocs.
const LEGAL_DIR = path.join(DATA_DIR, 'legal-docs');
const LEGAL_INDEX_FILE = path.join(DATA_DIR, 'legal-docs.json');
const LEGAL_MAX_BYTES = 25 * 1024 * 1024;
// Only these types are ever shown inline in the browser; anything else is
// served as a plain download so an uploaded HTML/SVG file can never run
// script inside the app.
const LEGAL_INLINE_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain; charset=utf-8' };
const LEGAL_ALLOWED_EXT = /^(pdf|png|jpe?g|gif|webp|heic|txt|docx?|xlsx?|csv|pptx?)$/;
let _legalLock = Promise.resolve();
function withLegalLock(fn) { const run = _legalLock.then(fn, fn); _legalLock = run.then(() => {}, () => {}); return run; }
async function readLegalIndex() {
  try { return JSON.parse(await fs.promises.readFile(LEGAL_INDEX_FILE, 'utf8') || '[]'); } catch (e) { return []; }
}
async function writeLegalIndex(list) {
  if (!fs.existsSync(DATA_DIR)) await fs.promises.mkdir(DATA_DIR, { recursive: true });
  const tmp = LEGAL_INDEX_FILE + '.tmp-' + process.pid + '-' + Date.now();
  await fs.promises.writeFile(tmp, JSON.stringify(list, null, 2));
  await fs.promises.rename(tmp, LEGAL_INDEX_FILE);
}
// One-time (Oct 2026): documents uploaded before multi-file entries existed
// each became their own row. Files the same person uploaded together —
// same note, category, expiry and folder, each within 3 minutes of the
// previous — are joined into one entry, titled by that shared note.
async function migrateLegalGroups() {
  await withLegalLock(async () => {
    const list = await readLegalIndex();
    if (!list.length || list.every(d => d.groupId)) return;
    const legacy = list.filter(d => !d.groupId).sort((a, b) => (a.uploadedAt || '').localeCompare(b.uploadedAt || ''));
    // Bucket by everything that must match, then split each bucket wherever
    // there's a gap of more than 3 minutes between uploads.
    const buckets = {};
    legacy.forEach(d => {
      const key = d.notes ? [d.uploadedBy, d.notes, d.category, d.expires || '', d.folder || ''].join('\u0001') : 'solo:' + d.id;
      (buckets[key] = buckets[key] || []).push(d);
    });
    const assign = run => {
      const gid = 'g_' + run[0].id.slice(3);
      const shared = run.length > 1 && run[0].notes;
      run.forEach(d => { d.groupId = gid; if (shared) { d.title = run[0].notes; d.notes = ''; } });
    };
    Object.values(buckets).forEach(b => {
      let run = [];
      b.forEach(d => {
        const prev = run[run.length - 1];
        if (prev && (new Date(d.uploadedAt) - new Date(prev.uploadedAt)) > 3 * 60 * 1000) { assign(run); run = []; }
        run.push(d);
      });
      if (run.length) assign(run);
    });
    await writeLegalIndex(list);
    console.log('Legal documents: grouped legacy uploads into entries');
  });
}
function legalHeader(req, name) {
  // Text fields travel in headers (URI-encoded) so the body can be the raw file.
  try { return decodeURIComponent(String(req.headers[name] || '')).trim(); } catch (e) { return ''; }
}

// ===== OFF-SITE BACKUPS TO GOOGLE DRIVE (Oct 2026) =====
// The server backups above all live on the SAME Render disk as the live
// data — if that disk is lost, deleted, or the service is recreated, the
// backups go with it. This copies one full snapshot a day (gzipped) into a
// Google Drive folder, completely outside Render.
//
// How it connects: an admin clicks "Connect Google Drive" in Settings →
// Backup & restore, signs in with the Google account that should OWN the
// backups, and the app keeps that account's refresh token on the
// persistent disk (same pattern as qb-tokens.json / plaid-tokens.json).
// Scope is drive.file, the narrowest Drive scope there is: the app can
// only see and touch the files and folder it created itself — never
// anything else in that Drive.
//
// Needs two env vars from a Google Cloud OAuth client (type "Web
// application"): GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.
// Its authorized redirect URI must be exactly <app URL>/gdrive/callback.
// Everything else in the app works fine without them — only this feature
// stays switched off until they're set.
const GDRIVE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GDRIVE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
// Optional override; by default it's derived from QB_REDIRECT_URI's host,
// which is already confirmed to be this service's real public URL.
const GDRIVE_REDIRECT_URI = process.env.GDRIVE_REDIRECT_URI ||
  (function () { try { return new URL(REDIRECT_URI).origin + '/gdrive/callback'; } catch (e) { return ''; } })();
const GDRIVE_FOLDER_NAME = process.env.GDRIVE_FOLDER_NAME || 'Plant Console Backups';
const GDRIVE_KEEP_DAILY = Math.max(3, parseInt(process.env.GDRIVE_KEEP_DAILY || '30', 10) || 30);     // newest N kept no matter what
const GDRIVE_KEEP_MONTHLY = Math.max(0, parseInt(process.env.GDRIVE_KEEP_MONTHLY || '12', 10) || 12); // plus the first backup of each of the last N months
const GDRIVE_BACKUP_HOUR_ET = Math.min(23, Math.max(0, parseInt(process.env.GDRIVE_BACKUP_HOUR_ET || '2', 10) || 2)); // 2am New York time — quiet hours
const GDRIVE_STATE_FILE = path.join(DATA_DIR, 'gdrive-backup.json');
const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';

let gdriveState = { refreshToken: '', email: '', folderId: '', connectedAt: 0,
  lastSuccessAt: 0, lastFileName: '', lastFileSize: 0, lastAttemptAt: 0, lastError: '', lastErrorAt: 0 };
let _gdriveAccessToken = '';
let _gdriveAccessTokenExpires = 0;
let _gdriveRunning = false;
const _gdriveOAuthStates = new Map(); // state nonce -> { userId, expires }

(function loadGDriveState() {
  try {
    if (fs.existsSync(GDRIVE_STATE_FILE)) {
      gdriveState = Object.assign(gdriveState, JSON.parse(fs.readFileSync(GDRIVE_STATE_FILE, 'utf8') || '{}'));
      if (gdriveState.refreshToken) console.log('Google Drive backups: connected as ' + (gdriveState.email || '(unknown account)'));
    }
  } catch (e) { console.error('Could not read Google Drive backup state:', e.message); }
})();

function saveGDriveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = GDRIVE_STATE_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(gdriveState, null, 2));
    fs.renameSync(tmp, GDRIVE_STATE_FILE);
  } catch (e) { console.error('Could not save Google Drive backup state:', e.message); }
}

// Small JSON-over-HTTPS helper for Google's APIs (built on httpsRequest
// below, so it shares the same whole-body UTF-8 decoding).
async function gdriveFetch(method, fullUrl, opts) {
  opts = opts || {};
  const u = new URL(fullUrl);
  const headers = Object.assign({}, opts.headers || {});
  let body = opts.body;
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json; charset=UTF-8';
  }
  if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
  if (opts.auth !== false) headers['Authorization'] = 'Bearer ' + (await gdriveAccessToken());
  // Hard timeout so a stalled connection can never leave a backup "running"
  // forever (which would block every future backup until a restart).
  let timer;
  const r = await Promise.race([
    httpsRequest({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: method, headers: headers }, body),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Google did not respond within 5 minutes.')), 5 * 60 * 1000); })
  ]).finally(() => clearTimeout(timer));
  let data = null;
  try { data = r.body ? JSON.parse(r.body) : null; } catch (e) { data = null; }
  return { status: r.status, data: data, headers: r.headers, raw: r.body };
}

async function gdriveAccessToken() {
  if (_gdriveAccessToken && Date.now() < _gdriveAccessTokenExpires - 60000) return _gdriveAccessToken;
  if (!gdriveState.refreshToken) throw new Error('Google Drive is not connected.');
  const r = await gdriveFetch('POST', 'https://oauth2.googleapis.com/token', {
    auth: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: querystring.stringify({
      client_id: GDRIVE_CLIENT_ID, client_secret: GDRIVE_CLIENT_SECRET,
      refresh_token: gdriveState.refreshToken, grant_type: 'refresh_token'
    })
  });
  if (r.status !== 200 || !r.data || !r.data.access_token) {
    const reason = (r.data && (r.data.error_description || r.data.error)) || ('HTTP ' + r.status);
    if (r.data && r.data.error === 'invalid_grant') {
      throw new Error('Google refused the saved sign-in (' + reason + '). Click "Reconnect Google Drive". If this keeps happening every ~7 days, the Google Cloud OAuth app is still in "Testing" — publish it to "In production" (see setup notes).');
    }
    throw new Error('Could not refresh Google access token: ' + reason);
  }
  _gdriveAccessToken = r.data.access_token;
  _gdriveAccessTokenExpires = Date.now() + (r.data.expires_in || 3600) * 1000;
  return _gdriveAccessToken;
}

// Returns a folder id that's guaranteed to exist and not be in the trash —
// recreates the folder if someone deleted it in Drive.
async function gdriveEnsureFolder() {
  if (gdriveState.folderId) {
    const r = await gdriveFetch('GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(gdriveState.folderId) + '?fields=id,trashed');
    if (r.status === 200 && r.data && !r.data.trashed) return gdriveState.folderId;
  }
  const c = await gdriveFetch('POST', 'https://www.googleapis.com/drive/v3/files?fields=id', {
    body: { name: GDRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { plantConsoleBackupFolder: '1' } }
  });
  if (c.status !== 200 || !c.data || !c.data.id) throw new Error('Could not create the backup folder in Google Drive (HTTP ' + c.status + ').');
  gdriveState.folderId = c.data.id;
  saveGDriveState();
  return gdriveState.folderId;
}

async function gdriveListBackups(folderId) {
  const q = "'" + folderId + "' in parents and trashed = false and appProperties has { key='plantConsoleBackup' and value='1' }";
  const files = [];
  let pageToken = '';
  do {
    const params = { q: q, orderBy: 'createdTime desc', pageSize: 1000, fields: 'nextPageToken,files(id,name,size,createdTime,webViewLink)' };
    if (pageToken) params.pageToken = pageToken;
    const r = await gdriveFetch('GET', 'https://www.googleapis.com/drive/v3/files?' + querystring.stringify(params));
    if (r.status !== 200 || !r.data) throw new Error('Could not list Google Drive backups (HTTP ' + r.status + ').');
    files.push(...(r.data.files || []));
    pageToken = r.data.nextPageToken || '';
  } while (pageToken);
  return files; // newest first
}

// Retention: keep the newest GDRIVE_KEEP_DAILY, plus the earliest backup of
// each of the last GDRIVE_KEEP_MONTHLY calendar months. Everything else is
// moved to Drive's trash (not hard-deleted), so a mistake here is still
// recoverable for 30 days from Drive's own Trash.
async function gdrivePrune(folderId) {
  const files = await gdriveListBackups(folderId);
  const keep = new Set(files.slice(0, GDRIVE_KEEP_DAILY).map(f => f.id));
  const firstOfMonth = new Map(); // 'YYYY-MM' -> oldest file that month
  for (const f of files) firstOfMonth.set(String(f.createdTime).slice(0, 7), f); // files are newest-first, so the last one set per month is the oldest
  const months = Array.from(firstOfMonth.keys()).sort().reverse().slice(0, GDRIVE_KEEP_MONTHLY);
  for (const m of months) keep.add(firstOfMonth.get(m).id);
  let trashed = 0;
  for (const f of files) {
    if (keep.has(f.id)) continue;
    const r = await gdriveFetch('PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id) + '?fields=id', { body: { trashed: true } });
    if (r.status === 200) trashed++;
  }
  return trashed;
}

// Takes a fresh full server backup (same file format the Restore button
// already understands), gzips it, and uploads it to the Drive folder.
async function runGDriveBackup(reason) {
  if (_gdriveRunning) throw new Error('A Google Drive backup is already running.');
  if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET) throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set on the server.');
  if (!gdriveState.refreshToken) throw new Error('Google Drive is not connected.');
  _gdriveRunning = true;
  gdriveState.lastAttemptAt = Date.now();
  try {
    const localName = await takeServerBackup(reason === 'manual' ? 'manual' : 'auto');
    _lastAutoBackupAt = Date.now();
    const raw = await fs.promises.readFile(path.join(BACKUP_DIR, localName));
    const gz = await new Promise((resolve, reject) => zlib.gzip(raw, { level: 9 }, (err, out) => err ? reject(err) : resolve(out)));
    const folderId = await gdriveEnsureFolder();
    const driveName = 'plant-console-' + localName + '.gz';
    // Resumable upload (two steps) — the simple multipart upload is capped
    // at 5 MB, and a compressed snapshot can grow past that.
    const init = await gdriveFetch('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size', {
      headers: { 'X-Upload-Content-Type': 'application/gzip', 'X-Upload-Content-Length': String(gz.length) },
      body: { name: driveName, parents: [folderId], mimeType: 'application/gzip',
        description: 'Plant Console full backup (' + reason + '). Restore: Settings → Backup & restore → Restore from a saved file.',
        appProperties: { plantConsoleBackup: '1' } }
    });
    const sessionUrl = init.headers && init.headers.location;
    if (init.status !== 200 || !sessionUrl) throw new Error('Google Drive refused the upload (HTTP ' + init.status + (init.data && init.data.error ? ': ' + init.data.error.message : '') + ').');
    const up = await gdriveFetch('PUT', sessionUrl, { headers: { 'Content-Type': 'application/gzip' }, body: gz });
    if ((up.status !== 200 && up.status !== 201) || !up.data || !up.data.id) throw new Error('Upload to Google Drive failed (HTTP ' + up.status + ').');
    if (String(up.data.size) !== String(gz.length)) throw new Error('Upload size mismatch — Drive has ' + up.data.size + ' bytes, expected ' + gz.length + '.');
    gdriveState.lastSuccessAt = Date.now();
    gdriveState.lastFileName = driveName;
    gdriveState.lastFileSize = gz.length;
    gdriveState.lastError = '';
    gdriveState.lastErrorAt = 0;
    saveGDriveState();
    console.log('Google Drive backup uploaded: ' + driveName + ' (' + Math.round(gz.length / 1024) + ' KB, from ' + Math.round(raw.length / 1024) + ' KB)');
    gdrivePrune(folderId).then(n => { if (n) console.log('Google Drive backups: moved ' + n + ' old backup(s) to trash'); })
      .catch(e => console.error('Google Drive prune failed:', e.message));
    gdriveSyncLegalDocs(folderId).then(n => { if (n) console.log('Google Drive: copied ' + n + ' legal document(s)'); })
      .catch(e => console.error('Google Drive legal-docs copy failed:', e.message));
    return { fileName: driveName, size: gz.length };
  } catch (e) {
    gdriveState.lastError = e.message;
    gdriveState.lastErrorAt = Date.now();
    saveGDriveState();
    console.error('Google Drive backup failed:', e.message);
    throw e;
  } finally {
    _gdriveRunning = false;
  }
}

function nyHourNow() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }), 10);
}

// Checked every 10 minutes. Runs once a day in the GDRIVE_BACKUP_HOUR_ET
// window; if that window was missed (server down/asleep), catches up as
// soon as it's been over 26h. A failure retries at most once an hour.
function gdriveSchedulerTick() {
  if (!gdriveState.refreshToken || !GDRIVE_CLIENT_ID || _gdriveRunning) return;
  const now = Date.now();
  const sinceSuccess = now - (gdriveState.lastSuccessAt || 0);
  const sinceAttempt = now - (gdriveState.lastAttemptAt || 0);
  if (sinceAttempt < 60 * 60 * 1000) return;
  const h = nyHourNow();
  const inWindow = h >= GDRIVE_BACKUP_HOUR_ET && h < GDRIVE_BACKUP_HOUR_ET + 3;
  // In the nightly window: run unless one already succeeded inside THIS
  // window (the window is 3h wide, so "> 3h ago" means "not tonight yet").
  // This used to require 20h since the last success, which let a daytime
  // manual or catch-up backup push the next nightly run out by a full day
  // and drift the schedule into the afternoon.
  if ((inWindow && sinceSuccess > 3 * 60 * 60 * 1000) || sinceSuccess > 26 * 60 * 60 * 1000) {
    runGDriveBackup('scheduled').catch(() => { /* already logged + saved to state */ });
  }
}

function gdriveStatusPayload() {
  const now = Date.now();
  const configured = !!(GDRIVE_CLIENT_ID && GDRIVE_CLIENT_SECRET);
  const connected = !!gdriveState.refreshToken;
  // "healthy" = a good backup within the last 36h. The UI turns red otherwise.
  const healthy = connected && gdriveState.lastSuccessAt > 0 && (now - gdriveState.lastSuccessAt) < 36 * 60 * 60 * 1000;
  return {
    configured: configured, connected: connected, healthy: healthy, running: _gdriveRunning,
    email: gdriveState.email || null, folderName: GDRIVE_FOLDER_NAME,
    folderUrl: gdriveState.folderId ? 'https://drive.google.com/drive/folders/' + gdriveState.folderId : null,
    lastSuccessAt: gdriveState.lastSuccessAt || null, lastFileName: gdriveState.lastFileName || null, lastFileSize: gdriveState.lastFileSize || null,
    lastError: gdriveState.lastError || null, lastErrorAt: gdriveState.lastErrorAt || null,
    scheduleHourET: GDRIVE_BACKUP_HOUR_ET, keepDaily: GDRIVE_KEEP_DAILY, keepMonthly: GDRIVE_KEEP_MONTHLY,
    redirectUri: GDRIVE_REDIRECT_URI
  };
}

// Copies every Legal Document not yet in Drive into a "Legal Documents"
// subfolder of the backup folder. Runs after each successful Drive backup.
// One-way and additive: deleting a document in the app does NOT delete the
// Drive copy (that's the point of an off-site copy).
async function gdriveSyncLegalDocs(parentFolderId) {
  const list = await readLegalIndex();
  if (!list.length) return 0;
  gdriveState.legalUploaded = gdriveState.legalUploaded || {};
  let folderId = gdriveState.legalFolderId;
  if (folderId) {
    const chk = await gdriveFetch('GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) + '?fields=id,trashed');
    if (chk.status !== 200 || !chk.data || chk.data.trashed) folderId = '';
  }
  if (!folderId) {
    const c = await gdriveFetch('POST', 'https://www.googleapis.com/drive/v3/files?fields=id', {
      body: { name: 'Legal Documents', mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] }
    });
    if (c.status !== 200 || !c.data || !c.data.id) throw new Error('Could not create the Legal Documents folder in Drive (HTTP ' + c.status + ').');
    folderId = c.data.id;
    gdriveState.legalFolderId = folderId;
    gdriveState.legalUploaded = {}; // new folder — everything needs copying again
    saveGDriveState();
  }
  let n = 0;
  for (const doc of list) {
    if (gdriveState.legalUploaded[doc.id]) continue;
    let buf;
    try { buf = await fs.promises.readFile(path.join(LEGAL_DIR, doc.id)); } catch (e) { continue; }
    const mime = (LEGAL_INLINE_TYPES[doc.ext] || 'application/octet-stream').split(';')[0];
    const init = await gdriveFetch('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
      headers: { 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(buf.length) },
      body: { name: (doc.folder ? doc.folder + ' - ' : '') + (doc.category ? doc.category + ' - ' : '') + doc.title + '.' + doc.ext, parents: [folderId], mimeType: mime,
        description: 'Uploaded to Plant Console by ' + doc.uploadedBy + ' on ' + doc.uploadedAt.slice(0, 10) + (doc.expires ? ' · expires ' + doc.expires : ''),
        appProperties: { plantConsoleLegalDoc: doc.id } }
    });
    const loc = init.headers && init.headers.location;
    if (init.status !== 200 || !loc) continue;
    const up = await gdriveFetch('PUT', loc, { headers: { 'Content-Type': mime }, body: buf });
    if ((up.status === 200 || up.status === 201) && up.data && up.data.id) { gdriveState.legalUploaded[doc.id] = up.data.id; n++; }
  }
  if (n) saveGDriveState();
  return n;
}

function gdriveHtmlPage(title, message, ok) {
  const safe = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    (ok ? '<meta http-equiv="refresh" content="3;url=/">' : '') + '<title>' + safe(title) + '</title></head>' +
    '<body style="font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 16px;line-height:1.5">' +
    '<h2 style="color:' + (ok ? '#1a7f37' : '#b42318') + '">' + safe(title) + '</h2><p>' + safe(message) + '</p>' +
    '<p><a href="/">Back to Plant Console</a></p></body></html>';
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
// Atomic write-then-rename, same as DATA_FILE/ITEMS_TXN_FILE above and for
// the same reason: a plain writeFile() truncates the file before the new
// bytes land, so a crash/OOM-kill mid-write (exactly what this app has seen
// — see the OOM investigation elsewhere in this file) can leave a
// truncated/corrupt sessions.json. loadSessionsFromDisk() would then fail
// to parse it on the next boot and silently fall back to an EMPTY session
// table — logging out every currently-logged-in user, which is the most
// direct way a memory crash turns into "kicked out". rename() on the same
// filesystem is atomic: the file on disk is always either the old complete
// version or the new complete version, never a partial one.
function persistSessions() {
  const obj = {};
  for (const [token, s] of SESSIONS.entries()) obj[token] = s;
  const tmpFile = SESSIONS_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFile(tmpFile, JSON.stringify(obj), (err) => {
    if (err) { console.error('Failed to persist sessions:', err.message); return; }
    fs.rename(tmpFile, SESSIONS_FILE, (err2) => {
      if (err2) console.error('Failed to persist sessions (rename):', err2.message);
    });
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
// Logged in AND (admin OR the user currently has permission `permId`).
// Permissions are read from the stored user record (not the session), so
// unticking a permission in Settings takes effect immediately. (Oct 2026)
function requirePerm(req, res, permId) {
  const session = requireAuth(req, res);
  if (!session) return null;
  if (session.role === 'admin') return session;
  const users = (_sharedDataCache && Array.isArray(_sharedDataCache.users)) ? _sharedDataCache.users : [];
  const u = users.find(x => x && x.id === session.userId);
  if (u && u.role === 'admin') return session;
  if (u && u.perms && u.perms[permId] === true) return session;
  res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
  res.end(JSON.stringify({ error: 'You do not have permission for this.' }));
  return null;
}
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

// ===== LOGIN RATE LIMITING =====
// In-memory only (deliberately not persisted — a restart clearing everyone's
// attempt history is an acceptable trade for staying simple, same reasoning
// as _recentlyDeletedCustomerIds elsewhere in this file). Keyed by the
// normalized email from the request body, not by IP: this app can be
// reached over the open internet (Render), so an attacker with multiple
// IPs would trivially defeat a per-IP limit, while a genuine user only
// ever needs a handful of attempts even after a mistyped PIN.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000; // failed attempts older than this don't count toward the limit
const LOGIN_LOCKOUT_MS = 10 * 60 * 1000;
const _loginAttempts = new Map(); // email -> { count, windowStart, lockedUntil }
function checkLoginRateLimit(email) {
  const rec = _loginAttempts.get(email);
  if (!rec) return { locked: false };
  const now = Date.now();
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { locked: true, retryAfterSeconds: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  return { locked: false };
}
function recordFailedLogin(email) {
  if (!email) return;
  const now = Date.now();
  const rec = _loginAttempts.get(email);
  if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) {
    _loginAttempts.set(email, { count: 1, windowStart: now, lockedUntil: 0 });
    return;
  }
  rec.count++;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
    rec.count = 0;
    rec.windowStart = now;
  }
}
function clearLoginRateLimit(email) {
  _loginAttempts.delete(email);
}
// Proactive sweep, same reasoning/cadence as the _recentlyDeletedCustomerIds
// sweep below — an entry that's never touched again after its window
// expires would otherwise sit in memory forever.
setInterval(() => {
  const now = Date.now();
  for (const [email, rec] of _loginAttempts.entries()) {
    if ((!rec.lockedUntil || now > rec.lockedUntil) && now - rec.windowStart > LOGIN_WINDOW_MS) {
      _loginAttempts.delete(email);
    }
  }
}, 5 * 60 * 1000);

// Collects the raw bytes and decodes them as UTF-8 ONCE at the end.
// (Sep 2026 fix.) This used to do `body += chunk`, which decodes every
// ~64KB network chunk separately — any multi-byte character (Turkish
// ş ğ ı ö ü ç, accented letters, even the replacement character itself)
// that happened to straddle a chunk boundary was split in half and turned
// into two garbage "\uFFFD" characters. On large saves this corrupted a
// few characters every time, the corruption compounded save after save
// (two customer names grew past 2 MB), and because each save came out
// slightly different, open tabs kept re-saving each other's copies in a
// nonstop loop — the root cause of the browser out-of-memory crashes.
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', chunk => {
      parts.push(chunk);
      size += chunk.length;
      if (size > 50 * 1024 * 1024) { req.destroy(); reject(new Error('Payload too large')); }
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
// ----- Broken-character cleanup (Sep 2026) -----------------------------
// Text damaged by the old chunk-decoding bug (see readRequestBody) holds
// runs of U+FFFD "replacement characters". A run can't be decoded back to
// what it was, but collapsing each run to ONE character stops it growing
// and makes every copy identical, which is what ends the save loop.
const BROKEN_CHAR = '\uFFFD';
function _collapseBrokenRuns(str) {
  return str.indexOf(BROKEN_CHAR) < 0 ? str : str.replace(/\uFFFD{2,}/g, BROKEN_CHAR);
}
// Walks any value in place, collapsing broken runs in every string.
// Returns how many strings it changed.
function _collapseBrokenDeep(v, depth) {
  depth = depth || 0;
  if (!v || typeof v !== 'object' || depth > 40) return 0;
  let changed = 0;
  const keys = Array.isArray(v) ? v.keys() : Object.keys(v);
  for (const k of keys) {
    const x = v[k];
    if (typeof x === 'string') {
      if (x.indexOf(BROKEN_CHAR) >= 0) { const y = _collapseBrokenRuns(x); if (y !== x) { v[k] = y; changed++; } }
    } else if (x && typeof x === 'object') {
      changed += _collapseBrokenDeep(x, depth + 1);
    }
  }
  return changed;
}
// A customer name is "broken" if it holds replacement characters or is far
// longer than any real name (QuickBooks caps display names well under this).
function _isBrokenName(n) {
  return typeof n === 'string' && (n.indexOf(BROKEN_CHAR) >= 0 || n.length > 300);
}

// One-time repair shortly after boot: collapse broken runs everywhere in
// the shared data, and re-check EVERY customer name against QuickBooks
// (their true source — this app never renames customers itself). That
// restores names the old bug damaged, including ones an earlier cleanup
// could only strip (leaving e.g. "zlütaş" instead of "Özlütaş"). Uses the
// same list query as the regular customer sync; the single-record lookup
// was rejected by QuickBooks with error 400.
async function repairBrokenSharedText() {
  try {
    const realNames = {};
    try {
      await ensureFreshToken();
      const all = await fetchQBCustomers();
      ((all && all.QueryResponse && all.QueryResponse.Customer) || []).forEach(rec => {
        const nm = rec && (rec.DisplayName || rec.FullyQualifiedName || rec.CompanyName);
        if (rec && rec.Id && nm && !_isBrokenName(nm)) realNames[String(rec.Id)] = nm;
      });
      console.log('[repair] fetched ' + Object.keys(realNames).length + ' customer names from QuickBooks to check against');
    } catch (e) {
      console.warn('[repair] could not fetch customers from QuickBooks (' + e.message + ') — damaged names will be cleaned, not restored');
    }
    const res = await updateSharedData(async (current) => {
      let restored = 0, cleaned = 0;
      (current.customers || []).forEach(c => {
        if (!c) return;
        const qbName = c.qbId ? realNames[String(c.qbId)] : null;
        if (qbName && c.name !== qbName) {
          console.log('[repair] customer ' + c.id + ' name restored from QuickBooks (' + String(c.name || '').length + ' chars -> ' + qbName.length + ' chars)');
          c.name = qbName; restored++;
        } else if (_isBrokenName(c.name)) {
          const before = c.name.length;
          c.name = c.name.replace(/\uFFFD+/g, '').trim().slice(0, 200) || '(unreadable name - rename in QuickBooks)';
          console.log('[repair] customer ' + c.id + ' name cleaned (' + before + ' chars -> ' + c.name.length + ' chars) — no QuickBooks match');
          cleaned++;
        }
      });
      const other = _collapseBrokenDeep(current);
      if (!restored && !cleaned && !other) return { skipWrite: true, restored, cleaned, other };
      return { data: current, restored, cleaned, other };
    });
    console.log('[repair] done: ' + (res.restored || 0) + ' name(s) restored from QuickBooks, ' + (res.cleaned || 0) + ' cleaned, ' + (res.other || 0) + ' other text field(s) cleaned');
  } catch (e) {
    console.error('[repair] failed:', e.message);
  }
}
setTimeout(repairBrokenSharedText, 20000);
// ----- Installable phone app assets (Oct 2026) -----------------------------
const APP_ICONS = {
  '/icon-192.png': Buffer.from('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', 'base64'),
  '/icon-512.png': Buffer.from('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', 'base64'),
  '/icon-maskable-512.png': Buffer.from('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ABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAIABMAQAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAAAWAKAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAABAAAIAABAAAAAA8j/BQo94svo+Rv0AAAAAElFTkSuQmCC', 'base64'),
  '/apple-touch-icon.png': Buffer.from('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', 'base64')
};
const SERVICE_WORKER_JS = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return; // everything else: normal network
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">' +
    '<body style="margin:0;font-family:system-ui,sans-serif;background:#EFEDEA;color:#2a2422;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">' +
    '<div><div style="width:64px;height:64px;border-radius:14px;background:#9E2B25;color:#fff;font-weight:800;font-size:24px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">PC</div>' +
    '<h2 style="margin:0 0 8px">No connection</h2><p style="margin:0 0 18px;color:#7a706b">Plant Console needs the internet.<br>Check Wi-Fi or mobile data.</p>' +
    '<button onclick="location.reload()" style="padding:12px 22px;border:0;border-radius:10px;background:#2E7C8B;color:#fff;font-size:16px;font-weight:700">Try again</button></div>',
    { headers: { 'Content-Type': 'text/html' } })));
});
`;
// ----- P.O. numbers (Oct 2026) ---------------------------------------------
// Every order gets a permanent, unique P.O. number: PO-10001, PO-10002, ...
// Assigned ONLY here on the server, from one counter stored with the shared
// data (current.poCounter), so two devices creating orders at the same
// moment can never get the same number. A number never changes once given.
const PO_START = 10000;
function _poNum(po) { const m = /^PO-(\d+)$/.exec(String(po || '')); return m ? Number(m[1]) : 0; }
function _nextPoNumber(current) {
  const highest = (current.orders || []).reduce((mx, o) => Math.max(mx, _poNum(o && o.poNumber)), 0);
  const n = Math.max(Number(current.poCounter) || PO_START, highest) + 1;
  current.poCounter = n;
  return 'PO-' + n;
}
// Gives a number to every order that doesn't have one yet, oldest first
// (by order date, then creation time). Returns how many were assigned.
function _ensurePoNumbers(current) {
  const missing = (current.orders || []).filter(o => o && !o.poNumber);
  missing.sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    || String(a.id || '').localeCompare(String(b.id || '')));
  missing.forEach(o => { o.poNumber = _nextPoNumber(current); });
  return missing.length;
}
// One-time numbering of existing orders shortly after the server starts.
setTimeout(async () => {
  try {
    const res = await updateSharedData(async (current) => {
      if (!Array.isArray(current.orders)) return { skipWrite: true, n: 0 };
      const orders = current.orders.map(o => (o && typeof o === 'object') ? Object.assign({}, o) : o);
      const tmp = Object.assign({}, current, { orders });
      const n = _ensurePoNumbers(tmp);
      if (!n) return { skipWrite: true, n: 0 };
      return { data: tmp, n };
    });
    if (res && res.n) console.log('[po] assigned P.O. numbers to ' + res.n + ' existing order(s)');
  } catch (e) { console.error('[po] numbering existing orders failed:', e.message); }
}, 15000);
// ----- Sync response caching + compression (Oct 2026 audit) ----------------
// Sends a cached JSON body: 304 "no change" when the browser already has this
// version (If-None-Match), otherwise the body — gzip-compressed when the
// browser accepts it. The gzip is made once per version (asynchronously, so
// a big payload never freezes the server) and reused for every tab.
function _gzipCached(entry) {
  if (!entry.gzPromise) {
    entry.gzPromise = new Promise((resolve) => {
      zlib.gzip(Buffer.from(entry.json, 'utf8'), { level: 6 }, (err, buf) => resolve(err ? null : buf));
    });
  }
  return entry.gzPromise;
}
async function _sendCachedJson(req, res, entry) {
  const base = { 'Content-Type': 'application/json', 'ETag': entry.etag, 'Vary': 'Accept-Encoding', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' };
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, base); res.end(); return; }
  const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (accepts && entry.json.length > 2048) {
    const gz = await _gzipCached(entry);
    if (gz) { res.writeHead(200, Object.assign({}, base, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length })); res.end(gz); return; }
  }
  res.writeHead(200, base);
  res.end(entry.json);
}
let _indexGz = null; // { len, buf } compressed index.html
let _smallJsonCache = null; // { ref, json, etag, gzPromise }
let _smallJsonVersion = 0;
// ----- Order change summary for edit tracking (Nov 2026) --------------------
// Short, human-readable list of what changed between two versions of an order.
function _orderChangeSummary(prev, next) {
  const out = [];
  const d = v => String(v || '').trim();
  if (d(prev.date) !== d(next.date)) out.push('Date ' + (d(prev.date) || '—') + ' → ' + (d(next.date) || '—'));
  if (d(prev.customer) !== d(next.customer)) out.push('Customer ' + (d(prev.customer) || '—') + ' → ' + (d(next.customer) || '—'));
  if (d(prev.driver) !== d(next.driver)) out.push('Driver ' + (d(prev.driver) || '—') + ' → ' + (d(next.driver) || '—'));
  if (!!prev.shipped !== !!next.shipped) out.push(next.shipped ? 'Marked shipped' : 'Marked not shipped');
  const pl = Array.isArray(prev.lines) ? prev.lines : [], nl = Array.isArray(next.lines) ? next.lines : [];
  const key = l => d(l.product).toUpperCase() + '|' + d(l.description).toUpperCase();
  const used = new Set();
  nl.forEach(n => {
    // match the same product line (first unused one with the same name/description)
    let mi = pl.findIndex((p, i) => !used.has(i) && key(p) === key(n));
    if (mi < 0) { out.push('Added ' + (d(n.product) || 'line') + (d(n.quantity) ? ' (' + d(n.quantity) + ')' : '')); return; }
    used.add(mi);
    const p = pl[mi], name = d(n.product) || 'line';
    if (d(p.quantity) !== d(n.quantity)) out.push(name + ' qty ' + (d(p.quantity) || '—') + ' → ' + (d(n.quantity) || '—'));
    if (d(p.finalCount) !== d(n.finalCount)) out.push(d(n.finalCount) === '' ? (name + ' weight cleared') : ((d(p.finalCount) === '' ? 'Weight entered: ' : 'Weight changed: ') + name + ' ' + (d(p.finalCount) ? d(p.finalCount) + ' → ' : '') + d(n.finalCount)));
    if (!!p.needsProcessing !== !!n.needsProcessing) out.push(name + (n.needsProcessing ? ' marked for processing' : ' unmarked for processing'));
  });
  pl.forEach((p, i) => { if (!used.has(i)) out.push('Removed ' + (d(p.product) || 'line')); });
  return out.slice(0, 12);
}
// ===== Automatic customer emails (Nov 2026) ===================================
// Per-customer settings (customers[].emailInvoices / .weeklyStatement) are set
// on the Customers page. NEW INVOICES: when switched on, every few minutes
// the server asks QuickBooks for invoices created since then and has
// QuickBooks email each one (POST /invoice/{id}/send — the same email and PDF
// as clicking Send in QuickBooks), for ticked customers only. Only invoices
// created AFTER the switch was turned on are ever sent; each at most once;
// every attempt is logged. WEEKLY STATEMENTS: QuickBooks offers no way to
// send statements from another app, so those need a sending mailbox — the
// boxes are stored now, sending is added once the mailbox is set up.
function _qbDateTime(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, '-00:00'); }
let _invoiceEmailRunning = false;
async function runInvoiceEmailJob(trigger) {
  if (_invoiceEmailRunning) return { skipped: 'already running' };
  _invoiceEmailRunning = true;
  const summary = { sent: 0, skipped: 0, failed: 0, checked: 0 };
  try {
    const data = await readSharedData();
    const cfg = data.emailAutomation || {};
    if (!cfg.invoicesOn) return { off: true };
    if (!accessToken && !process.env.QB_REFRESH_TOKEN) return { error: 'QuickBooks is not connected' };
    const byQbId = {};
    (data.customers || []).forEach(c => { if (c && c.qbId && c.emailInvoices) byQbId[String(c.qbId)] = c; });
    if (!Object.keys(byQbId).length) return Object.assign(summary, { note: 'no customers ticked' });
    const log = Array.isArray(data.invoiceEmailLog) ? data.invoiceEmailLog : [];
    const done = new Set(log.filter(e => e.status === 'sent' || e.status === 'already-emailed' || e.status === 'no-email').map(e => e.invoiceId));
    const since = new Date(Math.max(new Date(cfg.invoicesOnSince || Date.now()).getTime(), Date.now() - 3 * 86400000));
    await ensureFreshToken();
    let invoices = [], start = 1;
    while (start < 5000) {
      const q = `SELECT * FROM Invoice WHERE MetaData.CreateTime >= '${_qbDateTime(since)}' STARTPOSITION ${start} MAXRESULTS 100`;
      const r = await httpsRequest({ hostname: 'quickbooks.api.intuit.com', path: `/v3/company/${activeRealm}/query?query=${encodeURIComponent(q)}&minorversion=75`, method: 'GET',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
      if (r.status !== 200) throw new Error('QuickBooks invoice query failed (' + r.status + ')');
      const rows = (JSON.parse(r.body).QueryResponse || {}).Invoice || [];
      invoices = invoices.concat(rows);
      if (rows.length < 100) break;
      start += 100;
    }
    const entries = [];
    for (const inv of invoices) {
      summary.checked++;
      const cust = byQbId[String(inv.CustomerRef && inv.CustomerRef.value)];
      if (!cust || done.has(inv.Id)) { summary.skipped++; continue; }
      const base = { invoiceId: inv.Id, docNumber: inv.DocNumber || '', customer: cust.name || (inv.CustomerRef && inv.CustomerRef.name) || '', amount: Number(inv.TotalAmt || 0), at: new Date().toISOString(), trigger: trigger || 'auto' };
      if (inv.EmailStatus === 'EmailSent') { entries.push(Object.assign(base, { status: 'already-emailed', note: 'Already emailed from QuickBooks' })); summary.skipped++; continue; }
      const to = (inv.BillEmail && inv.BillEmail.Address) || cust.email || '';
      if (!to) { entries.push(Object.assign(base, { status: 'no-email', note: 'No email address on this customer in QuickBooks' })); summary.skipped++; continue; }
      try {
        const sr = await httpsRequest({ hostname: 'quickbooks.api.intuit.com', path: `/v3/company/${activeRealm}/invoice/${encodeURIComponent(inv.Id)}/send?sendTo=${encodeURIComponent(to)}&minorversion=75`, method: 'POST',
          headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json', 'Content-Type': 'application/octet-stream' } }, '');
        if (sr.status === 200) { entries.push(Object.assign(base, { status: 'sent', to })); summary.sent++; }
        else { entries.push(Object.assign(base, { status: 'failed', to, note: 'QuickBooks answered ' + sr.status })); summary.failed++; }
      } catch (e) { entries.push(Object.assign(base, { status: 'failed', to, note: e.message })); summary.failed++; }
    }
    await updateSharedData(async (current) => {
      const l = (Array.isArray(current.invoiceEmailLog) ? current.invoiceEmailLog : []).concat(entries).slice(-500);
      const c = Object.assign({}, current.emailAutomation || {}, { lastRunAt: new Date().toISOString(), lastError: '', lastSummary: summary });
      return { data: Object.assign({}, current, { invoiceEmailLog: l, emailAutomation: c }) };
    });
    if (summary.sent || summary.failed) console.log('[invoice-email] sent ' + summary.sent + ', failed ' + summary.failed + ', checked ' + summary.checked);
    return summary;
  } catch (e) {
    console.warn('[invoice-email] run failed:', e.message);
    try { await updateSharedData(async (current) => ({ data: Object.assign({}, current, { emailAutomation: Object.assign({}, current.emailAutomation || {}, { lastRunAt: new Date().toISOString(), lastError: e.message }) }) })); } catch (e2) {}
    return { error: e.message };
  } finally { _invoiceEmailRunning = false; }
}
setInterval(() => { runInvoiceEmailJob('auto').catch(() => {}); }, 5 * 60 * 1000);
// Customer portal app icons (Nov 2026): the colourful Leader Meat bull on dark charcoal, for the
// installable portal app (home-screen icon on Android and iPhone).
const PORTAL_ICONS = {"icon-192.png": "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", "icon-512.png": "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", "icon-maskable-512.png": "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CCGEAkAIIYQCQAghhAJACCGEAkAIIYQCQAghhAJACCGEAkAIIYQCQAghhAJACCGEAkAIIYQCQAghhAJACCGEAkAIIYQCQAghhAJACCGEAkAIIYQCQAghhAJACCGEAkAIIYQCQAghFABCCCEUAEIIIRQAQgghFABCCCEUAEIIIRQAQgghFABCCCEUAEIIIRQAQgghFABCCCEUAEIIIRQAQgghFABCCCEUAEIIIRQAQgghFABCCCEUAEIIIRQAQgghFABCCCEUAEIIIRQAQgghFABCCCEUAEIIoQAQQgihABBCCKEAEEIIoQAQQgihABBCCKEAEEIIoQAQQgihABBCCKEAEEIIoQAQQgihABBCCKEAEEIIoQAQQgihABBCCKEAEEIIoQAQQgihABBCCKEAEEIIoQAQQgihABBCCKEAEEIIoQAQQgihABBCCKEAEEIIBYAQQggFgBBCCAWAEEIIBYAQQggFgBBCCAWAEEIIBYAQQggFgBBCCAWAEEIIBYAQQggFgBBCCAWAEEIIBYAQQggFgBBCCAWAEEIIBYAQQggFgBBCCAWAEEIIBYAQQggFgBBCCAWAEEIIBYAQQggFgBBCKACEEEIoAIQQQigAhBBCKACEEEIoAIQQQigAhBBCKACEEEIoAIQQQigAhBBCKACEEEIoAIQQQigAhBBCKACEEEIoAIQQQigAhBBCKACEEEIoAIQQQigAhBBCrpj/F599QKFtjaXeAAAAAElFTkSuQmCC", "apple-touch-icon.png": "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAmEElEQVR42u2deXBd93Xfv+f87vJ2vAdi5QKQ4CJKoihasmxZsmU7tuNdsbwlaZomceykcbd0pjPt1DPNZKZplk6Tus0kaSd2IjtRbNlZXO+y5bWydksitVDcV+zLW+/++53+cQEQgBhS8nRA8PGeecMBH0ACuPdzz37Oj0bG9iKTTC4mnF2CTDI4MsngyCSDI5MMjkwyODLJ4MgkgyOTDI5MMjgyyeDIJJMMjkwyODLJ4MgkgyOTDI5MMjgyyeDIJIMjkwyOTDI4MskkgyOTDI5MMjgyyeDIJIMjk2sWDiIAyFXgFrIbcAnJ5aRUvHDBrhnNwYzB3YhDi+EoyTh4yeOjiDiKaHQEiq8dzUEMEWzZT5YNo7f3JAVLAFBGxApR7OQLm4yBUrRnD0TAfE1oDgGx7LxTJl4AcH0t8mICkGmPlaJNlMsPAzhxSm65mZgh0vVwsIKI7HgNFMNr9BfMlmIUGeJMb6yyKSSiHbvHzVXabTDhwP5UeVBXwyEGAPa9Q517BqD9fZHNAoAzxbHqKhEAJi4WNgM4fITuuhMAZN21xzrCkXobg7vRO0LnDwLymkG/HasMhotYXiAxUam0HcCLRzE4QGPbr4DyWE84AEBueLs0p3S7DuBAfzAfcuZwXFSSuF0obQXQbJmZGbzhzi72OYhgDHJlGnsNjz8PoJKj7ZW4HvKVDOQ3qtMBIIk7bm6T4xYAHD2B/fu4XIIxsp6XitdVb4zcqsr9PH0EwK6eqK9AfsLIVMdFAxaJXaeUyw0AOH2aenqsfTcAAHcjHAAgO24zQYsa4wB2V0PLQmIynfGPiBFmK5/rBzA1K+2W3r+PABjpPjjEoFDD4B7dmEJnHsDOnghAGq1kKbCL2RYGxM33AWg0MDund4yiWl3XhMf6aQ4Z2qN6Bqg9a0IPwNZiAkHeMmmUltGw9sYoWyCOUwUQBFioU61mj412ayg7uJfYgrcgIoqpr6BF0OOaTHG85DESAJbKiYhtFVkpQOoNsMLYjq4MZYnRNyomYb8OoOSgx9ZG0JfTGQwXdd4tuwQRVnlLuQDaHehEtgyva5Flvb5VcZOU+0XHCNsASrbJ25IYDBeTLFh5qeoA4Dg9IkaxpVI42hQnUqtJb2/XwSG9W9ktwWhEHQA5yzgskZZt5QSAyQzLS6J+N1czJiG2mW0AQQijkc/z8FD3aY7qFigbYiiOALhKbIVIY0s5yVkiktGx0uUQIstxasbEzExsAYhiGBGlaLCfug6OnmFAIIDR6bPBhDDGQE5vLSXIcqQXIlgC4LhV2y4bk4A4fcfo1PZKf590GxxS2gSjQbRYYQEAaFAlRzf0hsgKs6v8DRSKg45TMMZAZGUxVmtUq11nVihXFmMAklRJakqWHI3bBkMAkqmOJdUBoFwaxWJjhxGTALAsMJMxUip2n1lxihANIrFzAPyEI02KxYvlQH+QU6Izp3TR4TBEqljaqnVExMYk2sQAXAcEGIO823VmBbazmAbNlQC0YvYS2Iwgxvaq2d8XEq5Mm+QG0xoMoFgczuf7l+CIjA4A5PMAQQSW3X2ag22AIAb5KoB2SAuBZTEMyGG8ZaSTeRyp3gDQU9vLygaEWSWJnyQBgJ5K6nuIWsfuqHXLkAKAGC2lPgBGzLinbEUEtCN58za/5BhtrvGYhQTC7FR79ugkAIjIiqOmMQKg2gOtZZ0rDesFhzEggU6kuEnZDoBjC67FABAkGK3IW7d5ANQ1HLOkt71a3ZMv9msdA2BmP5gBYNtcqyJJhKgrq7JGg5ToiAo1KfcDeHbeTQwIwoRQy4d2txRd26lSAhH19d9ijF52Tv3OBIBaFZUKxbEwp/qjy/IcsU/EIprdoundDuC5OXfWg60AoB3ilsHk9Vs8I1B0LSoPIhaRcmWs3LM9jnwiYlZh2Pb8cQBbhqVUVMYIM4Vh92mO0AMvGg0Zvh7AjEfPzzkFmwQgQmzkozc2FOEazqTT4NAdIoYIIqKUG/hTUdgEMDa2aHWY4fldBwf5C2AmkMQBhvZYlg3g++MFW0GEiNAKcdtw8s7tnWtQeRCxiKnWru/pGUtiPw1omVWzcUwEtk1j2yWKDABmarW6T3O0pokUiCUJqbpFD+wC6PvnirMeLCUQMMGL5OM310u2yGKF4RryRBU7mze/Ueso/SsRR2G70TwCYNsWDA6oMBQiMGN+ofvyHPXJxRqBCCnLjN4GyHibHx13Sw4ZISL4CXbVzG/sXzByDYUtBBIxg8N3FkuDWodpytyy863WqcBfALB/n9g2iQhAIpia6b4M6cI5SUIQQCyhj9FblVsA8MUTleVKnGLMefKLN3RePRgkQuoaSJgSscCUSluHhu+IojbRhQzX3NwzAHI5uvF6CgJDRESIY5mc6jrNQfVx+A1iGwRJQq4O6+2vAfDIROHpKVV0L4TvWuS3b5+vOEYE3T5gTYAo5Y6MvgcQY9J8kFhWrt0612oeB7DvRhkYUFFkiGBZ1G6bqenu8zmCpjQmyHYgAJEkkex9ExNrYz57uOoqSscxiOBF2FnT/+m1c0bA6UxxNxsU2TbyjkJxKEmCdA6WyLCyZ6YfN8Yw0etuQ5IIiFLPdGaGOp3uMysATx+DsiAGRBJ5PLTXjBwA8K0zpaemVGlJeSjGnIe7dwW/flM9EeKujVxYYAYGb+8fuCWKWqlBMcZYVr7VPFNfeB7A3j0ytkN5vmaCiFiKTp9d16uxjoZ94gXRyVL5hETHZv97mCgx5k8P1WymZcuiWOY8/OYtrXfv6Gghqwv5YMBUazdsG3lbGLbT2DVVnMzW5MQPjdHE9KY3ktZY7I8i0kaOn0CXwjF9QhqTZKWWBRL5avONZsftAH5wLv/Nk24tT9osfbFIK5T//Lq512/xE6HuynwwYErl7TvG7o7jkJZ+NRHjOMX5+ecb9aMA9t+I63apINDp0+TYNDtrTp/rSjhYIQkw/jzZucUVLiCJA7n1/WTniPiPnupthLDVonEhRmKQGPzRXbO3DwW6e/hgwJRKozt3f1hERPRSxU0AFcfB+XMPEsG18fa3IoxM+lkj4rp89ISE4bqu6Fi3WVkBgBOPiSwV5tOwZdOo3v8eEXOmZX3yqZ5ajsySD8qMRACS//nmmbs2+11hXxgw5crYrj0/S8RaJ7zU4CQirlscP//dMJgXwZveSFu3qDA0y8lAETl4aMWVXBdRPbW+9aEDIPLmzcgtXOyF1os5jyTi4b04+wy8+rNz7p5qeGO/9qLFIDZd6sGEd495Ex31woKr6CodniQiBkzvphvHdr4fwGoyjOOU5hdeOH/uWwA2D+PnP8RBYFIlIYKcyxNT8rVvwph1TQ6u52Yfgo7p+I9WWBaBaLAld36ElEXEv/1o3/km5e0LjwcRYo0owe+9YeHj++taIIKrKz+WzsuLmKHh1+8Ye78xRmu9TIYxRiknDBbOnv4aQZTCB+8hyyIRLKWUxXX56WeQJOv9i6+b5lh84qk1IzvvgGUvNuETQUfcu9WwhXMHvYQOzTrv29kxggv2hyCCUOOnRqMdlejRybyfkEVXxyQUgQVGWbnt2987tPmOOPKIZEXpSIiYWB07en/gzwB499tx261Wu62X0h5QijxPvvgPsp7F+nWHI3VLIw+FGm/dL5G/fPMlDnjbflk4SwvnJz1rvKPeuzMIksWrk/5JhHZENw8kb9rqnWjYZ9o2AKaNW4NZIkBKpdGduz7UU90ZLUatF8gQIcctnjr5pWb9SBqhvP99apmMNGFaLlk/ekyeOQReEe13IxxpybE+IbvuhLJWTFCTGE2jt+LsQfj1IwtOJ6a3bw870QU+UhTaEfXmzbt2dArKPDPrxmbDlm8JEFb28Oa7to2+w7IKceTzqv56EYHrls+c/ubs9JMANg/hI7/EKxtFiaCYwgif/6IEwRX4HdYZDgErhG04JR65WSIPaf6HADFkudh2QE49TpH/9IwbaXnb9siLF/+lEYLAVlCEvE13jUV3DXvPzjrTgbXx9AcBKBQ379z9c8ObbxcxIjp1PFMHM1UArls+e+bbU5MPAeip4Nd/lYoFiuILD4MxUq5YP3jIPH3wCqiN9Ydj6YmYOy1jt8PJwyy1jRJBJ1SoYvMNdPIxJNGT07lOTG8dDUWQt1HOUc4iL6aTDft75/N/caj898cr5zzLjzdogCukO+1z9YVjcdwmkGXlHKeoLJeJmMl28mdPfzMlo5DHx36FhwbZ983KNIZlcatl7rtf4vgKMT4ytnfdo30Fo+W6N/NPfdy058ArJjHEcK5ipo/RN/4AQQvA+3a2/80t9ZN1+/l559Cce3jBPd9SiXkZ/K180P7/dm2v+N8IYGItl/mBiMnJ9Rbyg8Xi5nx+cy7fO372u2lRvlDAR3+Zd4zSSlcjVRs9Pdbf3J88/NjiIOS1AUeaAQXMO/8Db90nQXvVvIrRnO8xsyfpgT9EexZA0TadeFUMZykMD+VHR0s339T7wIPjR4+1Lnv5iIjSTPXicJC8Ihpo6U9ZMdlMF107QwQRtbni3r4tPjZvJlpmzlusx194OlyjQwDVHnzkl3jblrVkiEihoI4d13/2KQBXhowrZFYWr6ChmROy6y7Q6otMLHHAlQHsuA3Tx9hfiDQByOd4x2jxNbf1vfsdW372QzvuuXvkZ967PY6SL/zdGZFVe8GFKNhUs/1gMcnAZJeLOoxk2dovJqWYCUSc9tEs4rP49+U3eXFzBLA88O5UiibWnOb1gLtLI8ei5prfTrzYefNY8Z3XqRv6nJuHrJEqlV0QITDQRkQT8bat8rFf5qFB6nT0mqQ4M4mRv/xrtFpY51mVDQBH6pn6DURt3n2nhB0Qr7q4UcDlfukdVS9+B6C3v3X4P/77m9/xts1vfMPwrp09lbKltUSR/p0/ODQ7G65x1vy+Wmvf3kSx22iRCJgHDuzZ+ws/XRiosWODyMSJJBqS0rKkC5Zeq98UAFbOyfVXe8a2bHn9TWN3vyFuef7EvBGTY/X7A7f9u6FbXwhmj0YtRbzIEROMmHMN66YhkKiegjVSc/YNWjcP5e4YMX4k420BfuWfYutW1WpppVaRkRqUv/2Sef5w+j9dMbfJumLf2WgQ0wsPmqHr+bq7THseK8dAlTJhW/IVyRXFa1u22rq5NDnVWVgI0svX25v7xgPnjx1fbVCIDHNr85B0OsFgv3ac2rGTnOiJR55lSx34Fx8kIm++kXT8YKEZzLfCZidueYnnJ0FitBZjiJmVsnKWVcg75YJTLedqpVy1YhVzhU09JjFP/fEXJh9/AUCfyv33wde+utA/GzQ+Xr3++53JAGZRBxohJj3RCp86l79ju254EjIEBFF9JbKViOQLVCqR512EjErFevxJ/dAjV5iMKwpHqj+I6KFPmd5tVNsikbfK+RBDbgH5Grz2mbNesx0xL1p/y+JGPfyb+0+uynIQQaQz2CfFAsIQQRBXK3PX764dPWkF4fn/+0x7fPbAv/5wobfMlioO9hIrYlrW2hc8iRV5WTFitE7CyM67rfPTT33y/ubpSQC7nPInB1835lbmYp+Avfnen6+MfapxVIE0llwaQvjgCXvfENmKjIAIAtOJZLINoFJGsYDVrghEJJ9X4+P6C38vtAHi8ytapUgvYeTTg5+U0CNlr7KuAnYK6eD17FwYBnH6kGktlYr7pa+em54JmGCWGwxFtOt4Q/2I47RtBlGkC/n563dH5RKAxonzj//uva2z004+FzbaYavt11v+QtOvt4J6O2x0wkY7bHSC+vL77bDVjpptp5BrnJh47L98JiXjtfn+ezffNWIXF2LfImaieuL/cnXPgMobgBdnxoWIpR5EPzylirnFaEaRCWNpBABqVeRyvPLXNQLb5jA0995nfP9KuhobAw4AYsAK9XE8+EmwWp6KW/6UlAcBLDSiRjNWikUkn+fTZ1tf+spZIlqjdVubB8V1LzyPRIhjY6n568b83ioAb2r+sd/9zMyzx/N9NTHgJSEmSvMPTMS0/LYI8n21qaePPP77n/Fn6wDeU9r2Z0N3Fshq60gRAyBQbMygU/i16h7BhbpJ2pwQPnQmmWiyqyBCzMaLpRMC6O0Vy6KVfjQzmHHvfTI5RUxrlco1Ccey8zH+nHz3T8jJg1auB5MUjsBL5uYj22atTT7v3P+FU56X8PKzRQSRqFQI+jchilbZJiJoDaCxe0dnqB9A1Pae+G/3nfnejwu9FREjxohc7GWMiMnXKqe//fhTf/i52AsA/GrP7v869NpYktBoXuFBK+KF2P9AZft1To8Ww7Q4bkEAwiR48Bi7NowhS5lGaAINoK93bSKmkOf7Pm+OHIXiK+xqXPFo5aXOB9PCWWnO0K7XQScQATEpS/wGHX8YwM37qjvHKkx8+MX6n//FEaJVfiiAxo5tOp+D1mu3fKQKWiTq69XM+WZbjJl+8jCYB27erWxLuY5yXvJybct1j3zxO4fv+6aIENEn+m7+l337FmJfSIjWPlRGpGQ5/cr9Wvsc04WkLTGZyTaP1dSmIlmsT8zHz04DuON2GuineClZXijw33zBPPkUFEMbbBCxNsoPIgbEdPQHIkJv/nXEoehYdCKlTZaldKInpgIiYkV/9bkT2qzobCCCSFDriWrVtWpjJR8AwtDfOmwcu3byDLQ58oUHZw8etYr5i94NUhy1vYUjZwHkyfq9/lvf3TM6HXWYmC7WKsDE9Th4S2nLGwqDP/Sm1Iq0qRgJHzhqffQ2ItJzHgBSVKtCaxGBUnAcvu/z+vEfbywyNhIcy3wc+yFiX97yceKcxCHlq5KroL1wfsIrl90vf+XUMwcXmEmv0LzC3NoydHkrTQTfD/s3zdl27egJpc38i2cuo1eJimz9r8E7bikMTEUdi/iS1TaKxfyr6vUP+zMGkoa1YoSYkuML0cGJ4l27ZLYDoFhAuYQwFNclY3DvX+uDz244MrDhzrIXA2KcfgJf/X0J2uwWYLtSqAGYmY3qdf++NeErABGvr1eXS0iSy6+NIoIIhyEbERFWnC84bs7O5W03t/hKP84XHGbWIqEx57QvL2O8iojaSfSq4sA95REjwksKJqU4/PaJpOmbRgigUhHHQT7PnQ7+96fNxiRjg2mOlfpj6kV8+bfljb9h7X6dLvYBJzxf3/+3p86d99ZmvZTqbB5EHF+eDBHYtt1o1k6ehYjrWr/487fVavkk1umIES1mxBkwlqXm5r2/+twTYZR8YvrJraqwP7+pkQTqkspDEbWS4Nd6rnugc76lEwIJBEbAZGY6/oPHEMYAaj00OGA/cyi+736Zm9+gZGwch/RiyfWwjeM/MvkamGn8ec/Tzz63IC+ptba2DEWbapdXGyJQiuO498hJTjSAD95z874bNhsjuZztulbOtV3Xzrm261quayvFm4er5aLz/OEpDXnUn35XaVuelRa55H4IisVsccuh1o8EMxcS6gIQ9OkG+bFoObAfCwvm05+VTietuGJjysaEA2m0AqPp5KPUmkHkGW1WFSeJIJLk3ObYyEUilIsaFObakZO25wN40xt2veHO3Y1GB4C5mIjA96OxHQNBmJw5u9A08eGofk9lRyxpqxZd4vtEJrkp3/tA53xDRysjFxgRLQAW6njkMRizITJdVyEcy48bEcLOyphjVfg6siUpFSm5zIk+BMB1y6fO5ufrAK7fO3jP3Td3vJCZLiHMiKJk73VD587X5+Y75xKvZaJ3VkZbOlrsPZO1P276RgzpUU4R1ne8CaKL9CIFwWJX7AY/vmwjw7E6EH2JXxnUejo7t0MEloJSUArMix+kH6cvALlcfnyyfH4SwEB/6Rd+7jYxRoy53AIhSouz1103+MLhKd+PD4YL/cq5szQcGeOw5bBylOWycli5bOXYyikrr+yiskF4dXHwSX/mdNxWL+Fj42OxUR3Si5qYi72jXSc3PStJAiYhBgFEQpRqfVn8GGIpq9nuOTMOwHXtD3/gVTnXCoKIX8Y6bSJKEl3Iux/+wIFP/+UjYax/Z+7ggMqPOqVOkhgSLRLDaBEjEkNiaC2SiESiXbZGrBIwJS/jF9qgT+WV6QRbL30jRMQEbSDCzB+65+ab929rt/1XNHFqjJTL+Sd/fPrvvnTQiADIsxWLEUCLdPEpZFeDWfnHb7/UqsQkyiKmRQdl9VNJIsuFilffsu0tb76+2WyrVzg4RkRBEO0cG5ida09NNQEkYgxEXoJFWrazWSniopXTRpurGR3rav3BmWEMXvdavOudWJgXgWhNxiBOxGhKEiQJtEEcsW3Tg98xh49GiYnjhH+iwxmIKIp1khgBRspD797xZm20YqWIFSkmVsyKWBEzsQiqucqTU89+4cg3iFaVXjM41kWMARF941uyezff+ipptciyFm8j0XJLMIzhWs3U6zh89PS5ehBEzIub+V6R16MUe53g3Nk6gL29u+4aeW3drytSstjaszTWCmij83bufHPiKye/p2Hoal5cZeGqFmPoU39pBgeoVhXfB/OyWZELqQUtw5sJaC505ua9ocFKFMWvaFBOBI6jpqZbjXYAYLQ83PAb7dhXawkjQJhUK+z82aHPt2OPiY2Yq/fqXs37HEXAjHab7v3sYuyaZg9WvhSL1hga4J6yMTIx3bLtn+TAEstSE5NNY4yjrM2lAS3awmKD0IoXCVByC5978SsTnRl1lZNxlcORGhdmvHhUvvYNrlTSvp61ojVVKhgaBDA+0fjJliMT0fhEA0BfvrfXrUb6Itl6Y3RPrvzDc48/OnlQvYxJpwyOddIf9JWvm6PHqFC4SA7BGHIc2boVwORUO46Tn+B7hGE8PdUGsK00VHAK5mKpF1e5k+3pLx75JhGZrohvuwIOAElC990PkYsXWURkdATAzGyr2QqUUi8/ghAxlmU1W8HcfAfAttJwOvi29ssgjm1//sjXO4mfLhjN4NhIxuXkSfnu97hSWdv1QyRxbIaHiNnvhPW6/4rcDhFKy/deEAHYUh5KjF5DoDG67JYePv/0odkjCmSufoPSRXCk+oOIvvx1Mz1NjvNSOGjTJlQrACammuqVHKJHBMtS01NNAEU735/vjXW8xnGx2GqG7S+d+DaBTBftXO4qONDp4KvfpMJLpoWShMplDA4CmJpuv1KXVESmplsA+gu1qltOTLIyTWKMLrnFb53+0XzQYKA7DEp3wbGsPB76kTlxknK5tbbBtmV4CMD07Cv1SSWKkpmZDoChwoBruavaSkQcyz3fmvzeuUeJyKCrpNvgQJLggQdp5WjT8uM/PARgbs5rt4N0PupleqPtdjC/0AGwuTiwxqAYMQU79+DZhwMdskC6qwjXXYeapMrjiSf1qdOrlAeRaC2DAwA8L2g0QstSL+//I8tS9Xrg+TGAoUKfXumNijiWe645+cjEM4RuUxvdCQeShH/4EOVya+YiqbeXHUeMzDc6SqmX4xsQQSmer3cEYitrU76WmGS5R9CIFOzcQ+NPhjpasccjg2ODpz0ee0LPzMC2V2oOVCqopVMOHjO9nNKbAEQ0O9sB0OOWqm4pMcmyZbGUNe8tPDr1DADTjQfDdCMcacHlmUO8HLaIQGvKF2RTDcDcfEfk5VVLBcbI3JwHYFOuVrALy13ORqRg5w/OHWmEbSbupiCle+FYtgiPPy4r5xVEyLbQ3w9gfsGPouTldHAxUxTF9boPoD/XayvLXFgIJlr041OH0L3SjXCk2uL4KXP+PLnuqs/0bwLQaPm+H102iS4izOz7UbMVABgo9F5Ib4i4ljPRnj5eP5PGLBkcV9GvxUgSevEouUtuaXoCQ18fAK8Ttb3o5TQLKsXNVuh5YWpWjCxuTDYiruW+OH8iNonq3iO0u/p8zhcOr1yvL0mC3l4iMoluNYPLBiwisBS3WkE65VZ1K3opN0oEI+b5+ePoaulSOEQA0KmzptG4sIdOa5RKlM8BqDd85su0dhCBFTeaAYC87fa4JW10upbFYlUPmqeb490ap3Q/HGjUMTVDjpPmP0RrFAuS7gdrBkR0Wc0BIPVGy1ahYOW0Mem/spUz4803ohZ1VzHlmjErSkEEk5Nk24vL6I2hXA6VCoB6MxCRy2oOEWk2AwAVt5yzckZMOqZiszXemcHyergMjqtSeUxNrY5mbfT0AGi2Qq0vv3kriXWzFQKoumVbWcvnOBLRlDe7SFAGx9Wa7Zibv9C1JQJmqVQAtDthFCV8qVsrRBRGcacTAuhxy8uZLiLSYmb9BXS1Tel+OKTVljULGnoqAHwvCcNkaYbl4nqHmaMo8f0YQNWpLJdOCNAmacedTHNc5RIEWJ0nlXIZQBhGQRhfevpNKQqCJAgTAGWnJEtrW4goMdqPQ3S7dDsccSJmxUmCxqBUBBDH2veTS4xTp5rD8+NEawBlu2DEYGkrR2J0Igm6sRJ7LcGx+uaJMSgU05sf+BEzX8JnYCbPjwAwc9EuaGMItHSubVf7GteKQ2opWp6RTDVHIU+KAXhBfIk8WDpvG/gxAEdZeSuXFlBkaeFQdwex14ZDartY6VgYI7lc2p7uefGlU6RElDaA5ZTjKtuIWV4eabGy2cYll4NlcGxorQEAxTxZ1oXpamPItuE4APwgvoR5SN/3vBiAq1ybbRFJURCBYitnuZnmuMq9jUoZK82KCGxLXHcZjkuYFQBBEANwLcdWlrmwrl4Uq6Kd73rfo9t9jlptlTYwBrYNxwbgB8klUlgiIkbSODanXGvFWR8iUMRVt4ILx05ncFyN2qO/b82MAikF1wEQRcmKkx4vwpURCZfg4KU9LUtKSfry1cysXLWSpjf6+9Y0C6bHFAAIY22M4B83K8aYKNKpQ8rLMezSp/rzmwCYLM9xFZqT1BstSu8mWb35mohgOwCSWBtzqTZjrU0cawC2slfumiVQbJL+fE2RymorVy0cQwNcKSNZPfyYLrIFksQYY/5xh5SMkUQLAJvsVb4nUayTmlvpzfV0t9vRzT6HjI6unYtMV8VZFoBkcZn6RW+tpLbDJAaAzWpNPsOILrrFLeVBACyZ5rgaZecYlgsrK9IfYlkAtBazyM1Fby+JIP2CNN+1JgvCxGPlrUA3F2a7EY40Te66MjoiYXiRm8cMwIjIJc/HMMbo9ERqVi/9DrGOx6rbCDBZm+BV53DIyDbu75MoWh2emgu6xIgx0NpcbIsY0lM1Un+TmbQYA7PsdjBxmESbiwO9+erK40IzOK4SufH6xdbi9G6LkG1TpUKlUmpH0m7hSqXgOLaIkQtiXNeuVArA4pFQ2kjBKVSckq0sEZN+qTa6kivv6dmO7u0kvZp3n1+KeZZ77qZCAVqT63KxSJaFuXl66hn6uy/xweegEx3pY8dmG00/n7d6KoV83iGifN4FMDHZfPTxk9/67pF60wdwtjN5ZOFkkIRlu1jNVXJWTiCJSSxWidE/nnmeiLqysaPrTk1Id6KPjtBvfQKAJIlMTdLho3zoOTp2XHveS/+Fzbxla/X6vUMjI7VTp+dfODx5dryeHqm0RgpOfmfPyP6+666r7hgo9DqWs+A1fuuR/9GOvcXj3DI4NjocIvKhD/Crb5FHH+PnXsCJUyZabOlTrPblam/MDdya6z8Yzj/ojR8M583FutBZcXGk3HNjf2FbpX1sofXiQudccym6Qd5xd/aM7qvtfvXQTf/n+Ld/cP4JBdIZHFeFQ0pDQzwzo5fSX7ay9jm1NxUG78j373Z6CsqOjHZY+Tp+Llh4OJj5q+bxhonT2SeraA+8fktpZ624pcyOZRKjbE6CxJ9stY4uNF+Y75xt6aVVyXknV7YK0958V/ocVhf+TiIyMaEBV1k3ubU35QfvyA/udCp5ZQU68Uzk6ZhBAtEid5a3BJJ82hiztMlDJ7q4vad6Xb8306IwAZB4QsyFzZXyaG3grhF/qtM6Mt98Yb5zrulHgR8F3erTd5vmSO/6Hrf6cz079ju9e9yKy5avE99ERsCg5bBTi6nZ+Uc7Ux+b/FEs2q72D7zzn0x99d6kWWeH93z0QGlHNW6HtNRIZkRIhJiUY7FjmVh7E63OmdbMw+f9yfZVc27bNR/KUmL0T+c335TrbSbRXOT5JiawIl5JRsVyjwT1fzv9WCxa5YuDd/9Kaee+ofd+hHM5E5njn30umPGsvCNLfganB0aC4jCJWkHsReXRam1fn9GmW5Ok3RbKCsBE8zr8jjfxttKWIltahNfuh5SCsucS/9cmH5pKfLbtofd9LL91LKzPuH3DTt+WzpGndRA3j8zXDgxYOUsnq86RTGepLdeKmtGLf/rjcNanblQb3ZnnEECBFkz0jD//3vIIE2mY5cqZiNjMCeSfT/7oaNRk4v53/bPS7v1xu862rQM/v3lUlXo6xw4lXtw53dz0qkFiWm4gBSAQZbEIjn36oD/Z6VIwujcJJoAFOq+943Hr7vJoLEZgCCQwTOyw9ZuTjzwRzALofcv7qwdeH7fqpBQAYtaBXxzdA2X5p1+M6qE32el79bAky6VdISLlWCc+82zrRJ2Yurijo0szpIABFOh43JrR/rvLo75OQAKhHjv3ieknHuiMA6i+7qf77nhX1FqgFSugiEmHfnnnjToMwvGT4YwXNYNNrxrWoSaCCDlF5+Tnn184NAMmmG5u9ulaOJb1x7NhPTbmbZWtbR0POMXfm3n6c82TACo33d7/lg/GrQaYVnZ1EACCDsPS7v1xfSaaGffOt43Wm/YPxn6cq+bPfPnIzMPnu56MLodjmY/Hgtk88Vt6Rv949tCf1A8DKO05MPjeX9JRyJa99LLSFymLlcVKwZjS3lvC6XPx/HT7ZINc7jswfO7rRye+fYquATLQzSdSr9QEABP/YmXnvc3jEHGGtw39zEdFRzoIJIlFa9GasNxszFBMrMiylVsA89Q//Hk4c46YB1+/dfL7Z0DU7RPU1wwcmWRJsEwyODLJ4MgkgyOTDI5MMjgyyeDIJIMjkwyO7BJkksGRSQZHJhkcmWRwZJLBkUkGRyYZHJlkcGSSwZFJBkcmmWRwZJLBkUkGRyYZHJlkcGSSwZFJBkcmGRyZdKv8P1pw8m/JdyV2AAAAAElFTkSuQmCC", "favicon-64.png": "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"};
// ===== Customer portal (Nov 2026) ============================================
// A separate, customer-facing site at /portal. Customers log in with a phone
// number an ADMIN has confirmed on the Customers page (portalPhones) and a
// 6-digit code texted by Twilio Verify. Completely separate from staff
// logins: own cookie (pc_portal), own session table, own /portal/api/*
// routes, and every request re-checks — live — which customers that phone
// may see, so removing a number or switching a customer off takes effect
// immediately. All data is read live from QuickBooks and always filtered to
// the logged-in customer's own QuickBooks id.
function _normPhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) { const digits = d.slice(1).replace(/\D/g, ''); return (digits.length >= 8 && digits.length <= 15) ? '+' + digits : ''; }
  d = d.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return '';
}
function _qbPhonesOf(rec) {
  const out = [];
  [rec && rec.PrimaryPhone, rec && rec.Mobile, rec && rec.AlternatePhone].forEach(p => { const n = _normPhone(p && p.FreeFormNumber); if (n && out.indexOf(n) < 0) out.push(n); });
  return out;
}
const PORTAL_SESSIONS_FILE = path.join(DATA_DIR, 'portal-sessions.json');
const PORTAL_TTL_MS = 30 * 86400000;
const PORTAL_SESSIONS = new Map(); // token -> { phone, expires, createdAt }
try { const raw = JSON.parse(fs.readFileSync(PORTAL_SESSIONS_FILE, 'utf8')); Object.keys(raw || {}).forEach(k => { if (raw[k] && raw[k].expires > Date.now()) PORTAL_SESSIONS.set(k, raw[k]); }); } catch (e) {}
function _persistPortalSessions() {
  try { const o = {}; PORTAL_SESSIONS.forEach((v, k) => { if (v.expires > Date.now()) o[k] = v; });
    const tmp = PORTAL_SESSIONS_FILE + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, PORTAL_SESSIONS_FILE); } catch (e) { console.warn('[portal] could not save sessions:', e.message); }
}
function _portalCookie(token, maxAgeSec) {
  let c = `pc_portal=${token}; Path=/portal; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  if (process.env.NODE_ENV === 'production') c += '; Secure';
  return c;
}
// Customers this phone may see right now (admin-confirmed, not switched off, active).
async function _portalCustomersFor(phone) {
  const data = await readSharedData();
  return (data.customers || []).filter(c => c && c.active !== false && !c.portalOff && c.qbId && Array.isArray(c.portalPhones) && c.portalPhones.indexOf(phone) >= 0);
}
function _portalSession(req) {
  const tok = parseCookies(req).pc_portal;
  const s = tok && PORTAL_SESSIONS.get(tok);
  if (!s) return null;
  if (Date.now() > s.expires) { PORTAL_SESSIONS.delete(tok); _persistPortalSessions(); return null; }
  return Object.assign({ token: tok }, s);
}
// Simple in-memory limits: per phone and per IP address.
const _portalHits = new Map();
function _portalLimited(key, max, windowMs) {
  const now = Date.now(), arr = (_portalHits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { _portalHits.set(key, arr); return true; }
  arr.push(now); _portalHits.set(key, arr); return false;
}
function _clientIp(req) { return String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || ''); }
// Twilio settings, trimmed: a stray space or line break pasted into Render
// along with a value is the most common reason Twilio rejects every request.
function _tw(k) { return String(process.env[k] || '').trim(); }
function _twilioReady() { return !!(_tw('TWILIO_ACCOUNT_SID') && _tw('TWILIO_AUTH_TOKEN') && _tw('TWILIO_VERIFY_SID')); }
async function _twilioVerify(pathSuffix, form) {
  const body = Object.keys(form).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(form[k])).join('&');
  const auth = Buffer.from(_tw('TWILIO_ACCOUNT_SID') + ':' + _tw('TWILIO_AUTH_TOKEN')).toString('base64');
  const r = await _httpsRequestRaw({ hostname: 'verify.twilio.com', path: `/v2/Services/${encodeURIComponent(_tw('TWILIO_VERIFY_SID'))}/${pathSuffix}`, method: 'POST',
    headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
  let j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
  return { status: r.status, json: j };
}
async function _qbQueryAll(sql) {
  await ensureFreshToken();
  let all = [], start = 1;
  while (start < 10000) {
    const q = `${sql} STARTPOSITION ${start} MAXRESULTS 1000`;
    const r = await httpsRequest({ hostname: 'quickbooks.api.intuit.com', path: `/v3/company/${activeRealm}/query?query=${encodeURIComponent(q)}&minorversion=75`, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
    if (r.status !== 200) throw new Error('QuickBooks query failed (' + r.status + ')');
    const qr = JSON.parse(r.body).QueryResponse || {};
    const key = Object.keys(qr).find(k => Array.isArray(qr[k]));
    const rows = key ? qr[key] : [];
    all = all.concat(rows);
    if (rows.length < 1000) break;
    start += 1000;
  }
  return all;
}
let _pmCache = { at: 0, map: {} };
async function _portalPaymentMethods() {
  if (Date.now() - _pmCache.at < 3600000) return _pmCache.map;
  try { const rows = await _qbQueryAll('SELECT * FROM PaymentMethod'); const m = {}; rows.forEach(r => { m[String(r.Id)] = { name: r.Name || '' }; }); _pmCache = { at: Date.now(), map: m }; } catch (e) {}
  return _pmCache.map;
}
function _daysBetween(a, b) { return Math.floor((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function _invSummary(inv, today) {
  const due = (inv.DueDate || inv.TxnDate || '').slice(0, 10);
  const bal = Number(inv.Balance || 0);
  return { id: inv.Id, number: inv.DocNumber || '', date: (inv.TxnDate || '').slice(0, 10), due: due, total: Number(inv.TotalAmt || 0), balance: bal,
    daysOverdue: (bal > 0.004 && due && due < today) ? _daysBetween(due, today) : 0 };
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

// ----- QuickBooks traffic control (Nov 2026) --------------------------------
// QuickBooks allows only ~10 requests in flight per company and answers
// "429 ThrottleExceeded" beyond that. Pages fetched in parallel by the
// browser + the background item/customer syncs + other users can add up,
// so EVERY QuickBooks request goes through one queue here: at most
// QB_MAX_CONCURRENT at a time (the rest wait their turn), and a 429 is
// retried automatically after a short, growing pause instead of failing.
const QB_MAX_CONCURRENT = 4;
let _qbActive = 0;
const _qbWaiting = [];
function _qbAcquire() {
  if (_qbActive < QB_MAX_CONCURRENT) { _qbActive++; return Promise.resolve(); }
  return new Promise(resolve => _qbWaiting.push(resolve));
}
function _qbRelease() {
  const next = _qbWaiting.shift();
  if (next) next(); else _qbActive--;
}
async function httpsRequest(options, body) {
  if (!options || options.hostname !== 'quickbooks.api.intuit.com') return _httpsRequestRaw(options, body);
  const waits = [1000, 2000, 4000, 8000];
  for (let attempt = 0; ; attempt++) {
    await _qbAcquire();
    let res;
    try { res = await _httpsRequestRaw(options, body); }
    finally { _qbRelease(); }
    if (res.status !== 429 || attempt >= waits.length) return res;
    const ra = Number(res.headers && res.headers['retry-after']);
    const pause = (ra > 0 && ra < 60) ? ra * 1000 : waits[attempt] + Math.floor(Math.random() * 300);
    console.warn('[qb] QuickBooks said too many requests (429) — retrying in ' + pause + 'ms (attempt ' + (attempt + 2) + ' of ' + (waits.length + 1) + ')');
    await new Promise(r => setTimeout(r, pause));
  }
}
function _httpsRequestRaw(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      // Same whole-body UTF-8 decoding as readRequestBody — see there.
      // Every QuickBooks response comes through here, so large pulls
      // (customer lists, invoices, bills) could garble Turkish/accented
      // characters the same way.
      const parts = [];
      res.on('data', chunk => parts.push(chunk));
      // options.__binary (Nov 2026): PDFs etc. must stay raw bytes, not text.
      res.on('end', () => resolve({ status: res.statusCode, body: options.__binary ? Buffer.concat(parts) : Buffer.concat(parts).toString('utf8'), headers: res.headers }));
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

async function fetchQBItemsPage(startPosition, retry, activeMode, sinceIso) {
  // QuickBooks Online silently defaults to Active=true when a query has no
  // WHERE clause on Active at all — any item that's since been deactivated
  // or merged in QuickBooks never comes back from a plain "SELECT * FROM
  // Item" and can never be matched again, even though historical invoices
  // and credit memos still reference it. Explicitly requesting both active
  // and inactive items fixes this — without it, thousands of historical
  // line items end up permanently unmatchable ("item not matched") no
  // matter how many times items are re-synced.
  // activeMode: 'both' (default) uses "Active IN (true, false)" — Intuit's
  // own documented pattern, and works fine on most companies. CONFIRMED
  // live (Sep 2026) — one specific company rejects that combined syntax
  // outright with a 400 (errorCode 3202). An EARLIER version of this
  // function "fixed" that by falling back to a plain query with NO active
  // filter at all on that 400 — which silently missed every inactive item
  // for that company (QuickBooks' own default with no Active clause is
  // Active=true only), wrongly flagging ~229 real, legitimately-inactive
  // items as "not found in QuickBooks" the next time anything checked for
  // them. On a 400 with activeMode 'both', this now throws
  // ACTIVE_IN_UNSUPPORTED instead of silently degrading — see
  // fetchAllQBItems below, which is what actually recovers from that by
  // running two separate, always-reliable single-value queries
  // (Active = true, then Active = false) and merging them, rather than
  // dropping the active filter and losing half the catalog.
  // sinceIso: when set, adds "AND MetaData.LastUpdatedTime >= X" so a
  // background sync only fetches items that actually changed instead of
  // the whole catalog every time — see backgroundSyncItems below for why
  // this matters (it's what lets the sync run every few minutes instead
  // of every 30, without hammering QuickBooks for the full item list each
  // time).
  const mode = activeMode || 'both';
  const activeClause = mode === 'both' ? 'Active IN (true, false)' : ('Active = ' + mode);
  const sinceClause = sinceIso ? `MetaData.LastUpdatedTime >= '${sinceIso}'` : '';
  const whereParts = [activeClause, sinceClause].filter(Boolean);
  const whereClause = whereParts.length ? ('WHERE ' + whereParts.join(' AND ') + ' ') : '';
  const query = `SELECT * FROM Item ${whereClause}STARTPOSITION ${startPosition} MAXRESULTS 100`;
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
  if (res.status === 400 && mode === 'both') {
    throw new Error('ACTIVE_IN_UNSUPPORTED');
  }
  // Any 401 here means "this session isn't authorized right now" — whether
  // that's because the access token was simply stale (the refresh+retry
  // below fixes that transparently) or because the QuickBooks connection
  // itself is actually broken (disconnected/revoked in Intuit, or the
  // refresh token itself has expired) — in which case the refresh above
  // either fails outright OR "succeeds" but the retry STILL comes back
  // 401. CONFIRMED live (Sep 2026): that second case used to fall through
  // to the generic error below, surfacing a raw, confusing
  // "QB API error 401: {Fault:...AuthorizationFailure...}" blob instead of
  // the same clear "reconnect QuickBooks" prompt used everywhere else —
  // both paths now land on NEEDS_RECONNECT, which the client already
  // knows how to show a real "Reconnect QuickBooks" link for.
  if (res.status === 401) {
    if (!retry) {
      const ok = await refreshAccessToken();
      if (ok) return fetchQBItemsPage(startPosition, true, activeMode, sinceIso);
    }
    throw new Error('NEEDS_RECONNECT');
  }
  if (res.status !== 200) throw new Error('QB API error ' + res.status + ': ' + res.body);
  return JSON.parse(res.body);
}

// Full pagination for ONE active-mode ('true' or 'false' — never 'both'
// here, callers use fetchAllQBItems for that), collecting every page.
async function _fetchAllQBItemsForMode(activeMode, sinceIso) {
  let allItems = [];
  let start = 1;
  for (;;) {
    const data = await fetchQBItemsPage(start, false, activeMode, sinceIso);
    const batch = (data.QueryResponse && data.QueryResponse.Item) || [];
    allItems = allItems.concat(batch);
    if (batch.length < 100) break;
    start += 100;
    if (start > 20000) break; // safety cap
  }
  return allItems;
}
// The one function anything wanting "every item" (optionally, only ones
// changed since sinceIso) should call. Handles the ACTIVE_IN_UNSUPPORTED
// case (see fetchQBItemsPage) by transparently falling back to two
// separate full passes — Active=true, then Active=false — and merging
// them, rather than ever silently dropping every inactive item the way
// the old "just retry with no active filter at all" fallback used to.
// CONFIRMED live (Sep 2026): that old behavior was live for a while and
// caused ~229 genuinely-inactive-but-real items to wrongly show as "not
// found in QuickBooks" — this is the actual fix, applied once here so
// every caller (the background sync, the orphaned-items finder, the
// /api/qb/items proxy) benefits instead of patching each separately.
async function fetchAllQBItems(sinceIso) {
  try {
    return await _fetchAllQBItemsForMode('both', sinceIso);
  } catch (e) {
    if (e.message !== 'ACTIVE_IN_UNSUPPORTED') throw e;
    const [activeItems, inactiveItems] = await Promise.all([
      _fetchAllQBItemsForMode('true', sinceIso),
      _fetchAllQBItemsForMode('false', sinceIso)
    ]);
    return activeItems.concat(inactiveItems);
  }
}

async function fetchQBItems(retry) {
  const allItems = await fetchAllQBItems();
  return { QueryResponse: { Item: allItems, maxResults: allItems.length } };
}

// sinceIso: same idea as fetchQBItemsPage's sinceIso — when set, adds
// "AND MetaData.LastUpdatedTime >= X" so the background sync only fetches
// customers that actually changed instead of the whole list every time.
// Server-generated only (never taken from a request query param), so it
// doesn't need the same allow-list validation as the user-facing
// since/from/to on /api/qb/documents.
async function fetchQBCustomersPage(startPosition, retry, sinceIso, includeInactive) {
  // QuickBooks queries return ACTIVE customers only unless asked otherwise.
  const conds = [];
  if (sinceIso) conds.push(`MetaData.LastUpdatedTime >= '${sinceIso}'`);
  if (includeInactive) conds.push('Active IN (true, false)');
  const whereClause = conds.length ? (' WHERE ' + conds.join(' AND ')) : '';
  const query = `SELECT * FROM Customer${whereClause} STARTPOSITION ${startPosition} MAXRESULTS 100`;
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
  // See the long comment on the same pattern in fetchQBItemsPage above —
  // a retry that STILL comes back 401 also means NEEDS_RECONNECT, not a
  // raw error blob.
  if (res.status === 401) {
    if (!retry) {
      const ok = await refreshAccessToken();
      if (ok) return fetchQBCustomersPage(startPosition, true, sinceIso, includeInactive);
    }
    throw new Error('NEEDS_RECONNECT');
  }
  if (res.status !== 200) throw new Error('QB API error ' + res.status + ': ' + res.body);
  return JSON.parse(res.body);
}

async function fetchQBCustomers(retry, sinceIso, includeInactive) {
  // Paginate through all customers using STARTPOSITION (QB is 1-indexed)
  let allCustomers = [];
  let start = 1;
  const pageSize = 100;
  while (true) {
    const data = await fetchQBCustomersPage(start, retry, sinceIso, includeInactive);
    const custs = (data.QueryResponse && data.QueryResponse.Customer) || [];
    allCustomers = allCustomers.concat(custs);
    if (custs.length < pageSize) break; // last page
    start += pageSize;
    if (start > 10000) break; // safety cap
  }
  return { QueryResponse: { Customer: allCustomers, maxResults: allCustomers.length } };
}

// since/from/to are meant to always be machine-generated date/datetime
// strings (from new Date().toISOString() or a plain YYYY-MM-DD), but they
// reach fetchQBEntityPage straight from this app's own request query
// params (/api/qb/documents ?since=&from=&to=) with zero validation before
// being concatenated into the QBO query string below. Any authenticated
// user (any role — /api/qb/documents only calls requireAuth, not
// requireAdmin) could pass e.g. ?since=' OR TRUE OR '1'='1 and inject
// arbitrary QBO query syntax. Strict allow-list validation (only digits,
// dashes, colons, dots, T/Z, and a +/- offset — never a literal quote)
// closes that off without needing per-caller escaping.
const QB_DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function isValidQbDateParam(s) {
  return typeof s === 'string' && QB_DATE_PARAM_RE.test(s);
}
// Generic paginated query for any QB entity (Bill, Invoice, SalesReceipt, CreditMemo)
// `since`: only records changed at/after this timestamp (incremental).
// `from`:  only records with TxnDate on/after this date (inventory start floor).
// `to`:    only records with TxnDate on/before this date — added for the
//          Purchasing report's per-week Bill pulls (e.g. "5/4/2026 to
//          5/9/2026"), which need a closed range, not just an open-ended
//          floor. Optional and backward-compatible: existing callers that
//          never pass it are unaffected.
async function fetchQBEntityPage(entity, startPosition, retry, since, from, to, openOnly) {
  if (!retry) await ensureFreshToken(); // keep token alive during long paged syncs
  if (since && !isValidQbDateParam(since)) throw new Error('Invalid since parameter');
  if (from && !isValidQbDateParam(from)) throw new Error('Invalid from parameter');
  if (to && !isValidQbDateParam(to)) throw new Error('Invalid to parameter');
  const clauses = [];
  if (since) clauses.push(`MetaData.LastUpdatedTime >= '${since}'`);
  if (from)  clauses.push(`TxnDate >= '${from}'`);
  if (to)    clauses.push(`TxnDate <= '${to}'`);
  // Open documents only (Oct 2026): asks QuickBooks for bills/invoices that
  // still have a balance, instead of the whole history. The browser falls
  // back to a full fetch if QuickBooks ever rejects this filter.
  if (openOnly && (entity === 'Bill' || entity === 'Invoice')) clauses.push("Balance > '0'");
  const where = clauses.length ? (' WHERE ' + clauses.join(' AND ')) : '';
  const query = `SELECT * FROM ${entity}${where} STARTPOSITION ${startPosition} MAXRESULTS 100`;
  const reqPath = `/v3/company/${activeRealm}/query?query=${encodeURIComponent(query)}&minorversion=75`;
  const res = await httpsRequest({
    hostname: 'quickbooks.api.intuit.com',
    path: reqPath,
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
  });
  // See the long comment on the same pattern in fetchQBItemsPage above —
  // this is the exact case the screenshot bug report showed: a retry that
  // STILL comes back 401 also means NEEDS_RECONNECT, not a raw
  // "QB API error 401 on Payment: {...AuthorizationFailure...}" blob.
  if (res.status === 401) {
    if (!retry) {
      const ok = await refreshAccessToken();
      if (ok) return fetchQBEntityPage(entity, startPosition, true, since, from, to, openOnly);
    }
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
  // See the long comment on the same pattern in fetchQBItemsPage above.
  if (res.status === 401) {
    if (!retry) {
      const ok = await refreshAccessToken();
      if (ok) return fetchQBEntityById(entity, id, true);
    }
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
  // See the long comment on the same pattern in fetchQBItemsPage above.
  if (res.status === 401) {
    if (!retry) {
      const ok = await refreshAccessToken();
      if (ok) return createQBInvoice(invoicePayload, true);
    }
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
        // Automatic emails (Nov 2026): Plant-Console-only settings, carried
        // forward exactly like Sales Rep; email comes from QuickBooks.
        emailInvoices: idx >= 0 ? !!customers[idx].emailInvoices : false,
        weeklyStatement: idx >= 0 ? !!customers[idx].weeklyStatement : false,
        email: (record.PrimaryEmailAddr && record.PrimaryEmailAddr.Address) || (idx >= 0 ? (customers[idx].email || '') : ''),
        // Customer portal (Nov 2026): phones from QuickBooks are only
        // SUGGESTIONS; portalPhones (admin-confirmed) decide who can log in.
        qbPhones: _qbPhonesOf(record).length ? _qbPhonesOf(record) : (idx >= 0 ? (customers[idx].qbPhones || []) : []),
        portalPhones: idx >= 0 ? (customers[idx].portalPhones || []) : [],
        portalOff: idx >= 0 ? !!customers[idx].portalOff : false,
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
// Items get their own, faster cadence — see backgroundSyncItems for why
// this is safe to run more often than the customers/vendors cycle above
// (incremental after the first run, not a full catalog pull every time).
const ITEMS_SYNC_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
let _backgroundSyncInFlight = false;
let _lastBackgroundSyncAt = 0;
// Server-side tombstone for explicitly-deleted customers (see
// /api/data/customers-delete and the merge logic in the main /api/data
// POST handler below) — CONFIRMED live (Sep 2026): the app pushes a full
// customers snapshot every ~1.5s in the background; if one of those
// routine pushes was already in flight (built from the browser's memory
// BEFORE a delete) and its request lands on the server AFTER the delete
// succeeds, the union-by-id merge below had no way to know that customer
// was just deleted — it just saw the id present in the incoming push and
// added it right back in. A client-side-only fix (an in-browser grace
// window) can't close this, since the stale push is a SEPARATE request,
// possibly from the same tab's own earlier-queued ambient sync. This set
// is checked by the merge regardless of what any incoming push still
// contains.
const _recentlyDeletedCustomerIds = new Map(); // id -> expiry timestamp (ms)
function markCustomerIdsDeleted(ids) {
  const expiresAt = Date.now() + 30000; // 30s — comfortably longer than any realistic in-flight request
  ids.forEach(id => _recentlyDeletedCustomerIds.set(id, expiresAt));
}
function isRecentlyDeletedCustomerId(id) {
  const exp = _recentlyDeletedCustomerIds.get(id);
  if (exp === undefined) return false;
  if (Date.now() > exp) { _recentlyDeletedCustomerIds.delete(id); return false; }
  return true;
}
let _lastBackgroundSyncResult = null; // { at, customers: {ok,count,error}, vendors: {ok,count,error} }

// Builds one printable/geocodable address line out of a QuickBooks address
// sub-object (BillAddr/ShipAddr) — used to feed the driver route-mileage
// estimate (see fetchDrivingRouteMiles below), which needs a single string
// per stop, not QB's structured fields.
function formatQBAddress(addr) {
  if (!addr) return '';
  const parts = [addr.Line1, addr.Line2, addr.City, addr.CountrySubDivisionCode, addr.PostalCode].filter(Boolean);
  return parts.join(', ');
}
// Geoapify's Routing API needs lat/lon waypoints, not plain address
// strings, so every stop has to be geocoded first. Geocoded coordinates
// for a fixed address essentially never change, so results are cached
// in-memory per server process — this is what keeps repeated route
// estimates (same customers, different days) from re-geocoding the same
// address over and over. Cleared on a server restart/redeploy, which just
// means the next route estimate after that re-geocodes once; well within
// the free 3,000 credits/day either way.
var _geoapifyGeocodeCache = new Map(); // address string -> {lat, lon}, insertion-ordered for FIFO eviction below
var GEOCODE_CACHE_MAX = 2000; // generous cap so this can't grow unbounded for the life of the process
async function geoapifyGeocode(address, biasCoords) {
  if (_geoapifyGeocodeCache.has(address)) return _geoapifyGeocodeCache.get(address);
  // Biasing toward Leader Meat's own location (when we have it) is what
  // keeps an ambiguous/incomplete address in QuickBooks — missing a city
  // or state, say — from silently matching a same-named street somewhere
  // else in the country instead of the actual regional customer.
  // CONFIRMED live (Sep 2026): this was missing and produced a ~300 mile
  // "round trip" for what should have been a short local delivery.
  var biasParam = biasCoords ? ('&bias=proximity:' + biasCoords.lon + ',' + biasCoords.lat) : '';
  const path = '/v1/geocode/search?text=' + encodeURIComponent(address) + '&filter=countrycode:us' + biasParam + '&limit=1&format=json&apiKey=' + GEOAPIFY_API_KEY;
  const res = await httpsRequest({ hostname: 'api.geoapify.com', path, method: 'GET' });
  const data = JSON.parse(res.body || '{}');
  if (res.status !== 200) throw new Error('Geoapify geocoding error ' + res.status + ': ' + (data.message || res.body));
  const first = data.results && data.results[0];
  if (!first) throw new Error('Could not find coordinates for address: ' + address);
  const coords = { lat: first.lat, lon: first.lon };
  if (_geoapifyGeocodeCache.size >= GEOCODE_CACHE_MAX) {
    _geoapifyGeocodeCache.delete(_geoapifyGeocodeCache.keys().next().value); // evict oldest (Map preserves insertion order)
  }
  _geoapifyGeocodeCache.set(address, coords);
  return coords;
}
// Straight-line (great-circle) distance in miles — used only as a sanity
// check on geocoded stops below, not for the actual route mileage (which
// comes from Geoapify's real driving route).
function _haversineMiles(a, b) {
  var R = 3958.8;
  var toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(b.lat - a.lat);
  var dLon = toRad(b.lon - a.lon);
  var h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}
// Decides the order to visit a driver's stops in — nearest-neighbor
// starting from Leader Meat: repeatedly jump to whichever remaining stop
// is straight-line closest to wherever the route currently is. This is a
// heuristic, not a guaranteed-optimal solve (true optimal ordering for
// more than a handful of stops is combinatorially expensive), but it's a
// reasonable, fast, free-to-compute stand-in — and CRITICALLY, deciding
// the order ourselves (rather than letting Geoapify's optimize_stops
// silently pick one) is what lets the app actually tell the driver "stop
// 1, stop 2, stop 3…" instead of only reporting a total mileage number
// with no visible sequence.
function _nearestNeighborOrder(origin, stops) {
  var remaining = stops.slice();
  var order = [];
  var current = origin;
  while (remaining.length) {
    var bestIdx = 0, bestDist = Infinity;
    remaining.forEach(function (s, i) {
      var d = _haversineMiles(current, s);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    var next = remaining.splice(bestIdx, 1)[0];
    order.push(next);
    current = next;
  }
  return order;
}
// Nearest-neighbor's classic weakness: it decides greedily, one hop at a
// time, with no look-ahead — so it can easily strand one stop far off to
// the side (visited last, or visited early then backtracked past later)
// in a way that's obviously wrong to a human glancing at a map, even
// though each individual hop it made really was the closest one at that
// moment. CONFIRMED live (Sep 2026) — a driver's actual printed stop
// order looked illogical for exactly this reason. This is the standard
// fix: 2-opt local search. It repeatedly tries reversing every possible
// stretch of the route and keeps the reversal if it shortens the total
// round-trip distance (origin -> stop 1 -> ... -> stop N -> origin),
// until no single reversal helps anymore. This is what actually untangles
// the kind of zigzag/straggler pattern nearest-neighbor alone produces —
// still a heuristic (not a proven-optimal solve), but a much better one,
// and still effectively instant for the realistic stop counts here (low
// double digits at most).
function _twoOptImprove(origin, order) {
  var route = order.slice();
  var n = route.length;
  if (n < 3) return route;
  function routeMiles(r) {
    var total = _haversineMiles(origin, r[0]);
    for (var i = 0; i < r.length - 1; i++) total += _haversineMiles(r[i], r[i + 1]);
    total += _haversineMiles(r[r.length - 1], origin);
    return total;
  }
  var improved = true;
  var guard = 0;
  while (improved && guard < 200) {
    improved = false;
    guard++;
    for (var i = 0; i < n - 1; i++) {
      for (var j = i + 1; j < n; j++) {
        var candidate = route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1));
        if (routeMiles(candidate) < routeMiles(route) - 0.01) {
          route = candidate;
          improved = true;
        }
      }
    }
  }
  return route;
}
// Calls Geoapify's truck-mode Routing API for one driver's whole day:
// origin AND destination are both Leader Meat (a real round trip), with
// every stop as a waypoint in between. Stop order is decided ourselves
// (see _nearestNeighborOrder/_twoOptImprove and the waypointsRaw comment
// further down for why — NOT via Geoapify's own optimize_stops, despite
// what an earlier version of this comment said); this is meant as a
// planning ESTIMATE of total miles/time for the day, not a turn-by-turn assignment
// of stop order. mode=medium_truck (see below) routes using real truck
// road-restriction data (including roads legally closed to trucks, like NJ
// parkways) sized for an actual box truck, rather than Google's
// all-or-nothing "avoid every highway" toggle that this replaced.
async function fetchDrivingRouteMiles(stopAddresses) {
  if (!GEOAPIFY_API_KEY) throw new Error('NO_API_KEY');
  const originCoords = await geoapifyGeocode(LEADER_MEAT_ADDRESS);
  // Addresses that fail to geocode (malformed/incomplete data in
  // QuickBooks) are skipped rather than failing the whole estimate — same
  // leniency the client already applies to customers with no address on
  // file at all. A stop that DOES geocode but lands implausibly far from
  // Leader Meat (see _haversineMiles below) is treated the same way: it's
  // almost certainly a wrong match for an ambiguous address, not a real
  // delivery — this is a sanity ceiling for catching things like a typo'd
  // ZIP that geocodes three states away, not a hard business rule. 350 mi
  // (raised from 100 — CONFIRMED live Sep 2026 that regular deliveries go
  // as far as the Boston, MA area, ~250 mi straight-line from the plant,
  // which the original 100 mi ceiling was wrongly excluding as a bad
  // match) comfortably covers that real route while still catching a
  // geocode landing genuinely far off.
  //
  // stopDetails carries every address's geocode result (used or excluded)
  // back to the client for troubleshooting — CONFIRMED live (Sep 2026)
  // that biasing toward Leader Meat alone didn't fix every bad match, so
  // being able to actually SEE which address resolved where (rather than
  // guessing from a final mileage number) is what's needed to pin down
  // which specific customer has a bad address in QuickBooks.
  const stopCoords = [];
  const failedToGeocode = [];
  const stopDetails = [];
  for (const addr of stopAddresses) {
    try {
      const coords = await geoapifyGeocode(addr, originCoords);
      const straightLineMiles = Math.round(_haversineMiles(originCoords, coords) * 10) / 10;
      const excluded = straightLineMiles > 350;
      stopDetails.push({ address: addr, lat: coords.lat, lon: coords.lon, straightLineMiles, excluded });
      if (excluded) { failedToGeocode.push(addr + ' (matched ~' + Math.round(straightLineMiles) + ' mi away — likely a wrong address match)'); continue; }
      stopCoords.push({ address: addr, lat: coords.lat, lon: coords.lon });
    } catch (e) {
      stopDetails.push({ address: addr, error: e.message, excluded: true });
      failedToGeocode.push(addr);
    }
  }
  if (!stopCoords.length) throw new Error('None of the stop addresses could be located: ' + failedToGeocode.join('; '));
  // Decide the actual visiting order ourselves (see _nearestNeighborOrder)
  // rather than leaving it to Geoapify's own optimize_stops — this is what
  // lets the response hand back a real "stop 1, stop 2, stop 3…" sequence
  // for the client to sort the driver's order list by, not just a total
  // mileage number. The waypoints below are sent in THIS decided order,
  // fixed (no optimize_stops), so the distance/time Geoapify returns is
  // for the exact sequence being reported as visitOrder — the two can't
  // drift apart. Bonus: dropping optimize_stops also avoids its per-call
  // credit surcharge on Geoapify's pricing (calcMatrixCost(n-2,n-2)).
  const orderedStops = _twoOptImprove(originCoords, _nearestNeighborOrder(originCoords, stopCoords));
  const visitOrder = orderedStops.map(function (s) { return s.address; });
  const waypointsRaw = [originCoords].concat(orderedStops, [originCoords]).map(c => c.lat + ',' + c.lon).join('|');
  // mode=medium_truck (not the plain "truck" mode) — Geoapify's "truck"
  // profile is actually their heaviest non-hazmat class (up to 22 tonnes,
  // ~21.6 m long: a full semi/tractor-trailer), which was routing AROUND
  // low bridges/tunnels a regular box truck can clear just fine, on top of
  // the parkway-ban restriction that's actually wanted. CONFIRMED live
  // (Sep 2026) that these are regular box trucks, not semis, and only
  // need to avoid parkways — medium_truck (< 7.5 t, < ~4.1 m / 13.5 ft
  // height) matches a typical box truck's real legal restrictions much
  // more closely without over-restricting the route.
  // mode=light_truck — TRYING this instead of medium_truck (Sep 2026):
  // CONFIRMED live that medium_truck was sending a real NJ->Brooklyn route
  // up to the Tappan Zee Bridge (I-287/I-87), ~40 mi north, and back down
  // again, rather than the George Washington Bridge — a huge, clearly-
  // wrong detour for a regular box truck. Since going from truck to
  // medium_truck didn't change this, the George Washington Bridge crossing
  // itself looks to be flagged truck-restricted in Geoapify's road data
  // for ALL truck size classes here, not a weight/height limit that
  // shrinking the vehicle class would get around — light_truck is the
  // next (and smallest) class left to rule that theory out with. If this
  // still detours the same way, the fix isn't a size-class change at all;
  // see the comment further down where majorRoads is computed for how to
  // confirm that from the actual road list next.
  const path = '/v1/routing?waypoints=' + encodeURIComponent(waypointsRaw) + '&mode=light_truck&units=imperial&format=json&details=instruction_details&apiKey=' + GEOAPIFY_API_KEY;
  const res = await httpsRequest({ hostname: 'api.geoapify.com', path, method: 'GET' });
  const data = JSON.parse(res.body || '{}');
  if (res.status !== 200) throw new Error('Geoapify Routing API error ' + res.status + ': ' + (data.message || res.body));
  const route = data.results && data.results[0];
  if (!route) throw new Error('No route returned.');
  // Which actual roads it drove, by total distance on each — this is what
  // finally answers "is this mileage really right?" instead of trusting a
  // single number: CONFIRMED live (Sep 2026) that a huge NJ->Brooklyn
  // detour looked wrong at a glance, and it turned out to be real (the
  // direct bridge/parkway route is barred to ALL trucks regardless of
  // size, not just heavy ones) — but that took pulling turn-by-turn data
  // to actually confirm rather than assume. Aggregated by street name
  // (steps on the same street, even non-consecutively, are summed) since
  // a single street can span several steps around turns/intersections.
  const roadTotals = {};
  (route.legs || []).forEach(function (leg) {
    (leg.steps || []).forEach(function (step) {
      const streets = (step.instruction && step.instruction.streets) || [];
      const name = streets.length ? streets.join('/') : ((step.instruction && step.instruction.text) || '(unnamed road)');
      roadTotals[name] = (roadTotals[name] || 0) + (step.distance || 0);
    });
  });
  // NOTE: the request above passes units=imperial, so Geoapify returns
  // step.distance already in MILES here — NOT meters. (Confirmed live
  // Sep 2026: an earlier version of this code divided by 1609.34 again,
  // as if converting meters to miles, which silently shrank every road's
  // total by ~1600x and meant it always failed the >= 0.3 mi filter below
  // — "Roads driven" never actually appeared in the breakdown popup.)
  const majorRoads = Object.keys(roadTotals)
    .map(function (name) { return { name: name, miles: Math.round(roadTotals[name] * 10) / 10 }; })
    .filter(function (r) { return r.miles >= 0.3; }) // drop tiny local turns/intersections, keep anything that's an actual stretch of driving
    .sort(function (a, b) { return b.miles - a.miles; })
    .slice(0, 12);
  return {
    stopDetails,
    majorRoads,
    visitOrder,
    miles: Math.round(route.distance * 10) / 10,
    minutes: Math.round(route.time / 60)
  };
}
// Companion to fetchDrivingRouteMiles above, but for a NORMAL car/passenger
// route via Google's Directions API — free to use parkways/highways a
// commercial truck legally can't, so the gap between this number and the
// truck-mode one is exactly the extra distance the truck-route restriction
// costs. Uses Google's own waypoint optimization (optimize:true) rather
// than Geoapify's geocode-then-route flow, so there's no separate
// straight-line sanity check here — a stop Google's own geocoder can't
// resolve simply comes back as a leg-level error from the API itself.
async function fetchGoogleDrivingRouteMiles(stopAddresses) {
  if (!GOOGLE_MAPS_API_KEY) throw new Error('NO_GOOGLE_KEY');
  const waypoints = 'optimize:true|' + stopAddresses.map(a => encodeURIComponent(a)).join('|');
  const originDest = encodeURIComponent(LEADER_MEAT_ADDRESS);
  const qs = 'origin=' + originDest + '&destination=' + originDest + '&waypoints=' + waypoints + '&mode=driving&key=' + GOOGLE_MAPS_API_KEY;
  const res = await httpsRequest({ hostname: 'maps.googleapis.com', path: '/maps/api/directions/json?' + qs, method: 'GET' });
  const data = JSON.parse(res.body || '{}');
  if (res.status !== 200) throw new Error('Google Directions API error ' + res.status + ': ' + (data.error_message || res.body));
  if (data.status !== 'OK') throw new Error('Google Directions API: ' + data.status + (data.error_message ? ' — ' + data.error_message : ''));
  const route = data.routes && data.routes[0];
  if (!route || !Array.isArray(route.legs) || !route.legs.length) throw new Error('No route returned.');
  var totalMeters = 0, totalSeconds = 0;
  const stopDetails = route.legs.map(function (leg) {
    totalMeters += (leg.distance && leg.distance.value) || 0;
    totalSeconds += (leg.duration && leg.duration.value) || 0;
    return { address: leg.end_address, distanceMiles: Math.round(((leg.distance && leg.distance.value) || 0) / 1609.34 * 10) / 10 };
  });
  return {
    stopDetails,
    miles: Math.round(totalMeters / 1609.34 * 10) / 10,
    minutes: Math.round(totalSeconds / 60)
  };
}
// Incremental after the first run — same pattern as backgroundSyncItems:
// _lastCustomerSyncAt tracks when the last successful sync STARTED, and
// every run after the first only asks QuickBooks for customers with
// MetaData.LastUpdatedTime at or after that point, instead of the whole
// list every time. This is what makes it safe to run on the SAME
// frequent cadence as items (see runCustomersBackgroundSync below) rather
// than the slower 30-min cycle vendors are still on.
let _lastCustomerSyncAt = null; // ISO string, or null until the first successful run
async function backgroundSyncCustomers() {
  const syncStartedAt = new Date().toISOString();
  const sinceIso = _lastCustomerSyncAt; // capture before this run, so a slow run doesn't miss anything that changes mid-sync
  // includeInactive=true (Oct 2026): without it QuickBooks returns ACTIVE
  // customers only, so when a customer is merged or made inactive in QB its
  // LastUpdatedTime bumps but it's filtered OUT of the incremental pull — so
  // Plant Console never learned the record went inactive and kept the stale
  // copy as a normal, pickable account (the "Ayat Bay Ridge" / "Ayat
  // Bayridge Meast" duplicate: one live, one merged-away but still showing).
  // Pulling inactive too keeps each customer's `active` flag current AND
  // surfaces the inactive ones so reports stay accurate; the UI paints them
  // red and blocks picking them.
  const data = await fetchQBCustomers(false, sinceIso, true);
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
        // Automatic emails (Nov 2026) — same carry-forward as Sales Rep.
        emailInvoices: existing >= 0 ? !!customers[existing].emailInvoices : false,
        weeklyStatement: existing >= 0 ? !!customers[existing].weeklyStatement : false,
        email: (qc.PrimaryEmailAddr && qc.PrimaryEmailAddr.Address) || (existing >= 0 ? (customers[existing].email || '') : ''),
        qbPhones: _qbPhonesOf(qc).length ? _qbPhonesOf(qc) : (existing >= 0 ? (customers[existing].qbPhones || []) : []),
        portalPhones: existing >= 0 ? (customers[existing].portalPhones || []) : [],
        portalOff: existing >= 0 ? !!customers[existing].portalOff : false,
        // Delivery address for driver route-mileage estimates — ShipAddr is
        // preferred (it's where the truck actually goes) with BillAddr as a
        // fallback for customers who never set one separately. If QB
        // returns neither on a given sync, keep whatever was already saved
        // rather than wiping it out — same reasoning as salesRep/dunsNumber
        // above, both of which use this same existing-value fallback.
        address: formatQBAddress(qc.ShipAddr) || formatQBAddress(qc.BillAddr) || (existing >= 0 ? (customers[existing].address || '') : ''),
        balance: Number(qc.Balance || 0),
        // Same purpose as items' qbSynced — lets the client's lightweight
        // poll (pollCustomersFromServer) tell "did anything actually
        // change" from just the newest timestamp, without a deep compare.
        qbSynced: new Date().toISOString()
      };
      if (existing >= 0) customers[existing] = mapped; else customers.push(mapped);
    });
    return { data: Object.assign({}, current, { customers }) };
  });
  _lastCustomerSyncAt = syncStartedAt;
  return qbCustomers.length;
}

let _lastCustomersSyncRunAt = 0;
let _lastCustomersSyncResult = null;
// Same promise-lock pattern as _itemsSyncPromise above, same reason: a
// "Sync now" click landing at the exact moment the timer fires awaits
// that SAME in-progress sync rather than no-op'ing or double-running.
let _customersSyncPromise = null;
function runCustomersBackgroundSync() {
  if (_customersSyncPromise) return _customersSyncPromise;
  if (!accessToken && !refreshToken) return Promise.resolve(); // QuickBooks isn't connected yet
  _customersSyncPromise = (async () => {
    try {
      const count = await backgroundSyncCustomers();
      _lastCustomersSyncResult = { ok: true, count, incremental: !!_lastCustomerSyncAt, at: new Date().toISOString() };
    } catch (e) {
      _lastCustomersSyncResult = { ok: false, error: e.message, at: new Date().toISOString() };
      console.error('Background customer sync failed:', e.message);
    }
    _lastCustomersSyncRunAt = Date.now();
  })();
  return _customersSyncPromise.finally(() => { _customersSyncPromise = null; });
}

// Pulls the Item list from QuickBooks and merges it into the server's own
// items store (readItemsTxnData/writeItemsTxnData) — this is what lets
// Items update on their own instead of requiring someone to click "Quick
// sync"/"Full sync" (CONFIRMED live Sep 2026, removed those buttons in
// favor of this). Runs on its OWN independent, more frequent interval —
// see ITEMS_SYNC_INTERVAL_MS below — separate from the 30-min
// customers/vendors cycle, since items specifically needed a shorter
// cadence.
// Incremental after the first run: _lastItemSyncAt (set below) tracks
// when the last successful sync STARTED, and every run after the first
// only asks QuickBooks for items with MetaData.LastUpdatedTime at or
// after that point — a handful of records instead of the whole catalog
// every time. This (not just a shorter interval) is what makes running
// this every few minutes cheap enough to be safe alongside the ongoing,
// unresolved server-OOM investigation (see the memcheck logging at
// startup): a full catalog pull is real work; an incremental one asking
// "what changed in the last few minutes" almost always comes back empty
// or tiny.
let _lastItemSyncAt = null; // ISO string, or null until the first successful run
async function backgroundSyncItems() {
  const syncStartedAt = new Date().toISOString();
  // ALWAYS a full item pull (Oct 2026 fix). This used to be incremental after
  // the first run (only items whose MetaData.LastUpdatedTime moved), but in
  // QuickBooks an item's QtyOnHand changing because of a bill, invoice or
  // inventory adjustment does NOT bump the item's LastUpdatedTime — so stock
  // changes never came through and on-hand went stale (e.g. Gyro Beef Ground
  // 20 LB showing 0 while QuickBooks had 20). The item list is ~1,000 items,
  // ~10 QuickBooks requests per run, so a full pull every 5 minutes is cheap.
  const qbItems = await fetchAllQBItems();
  // Read-merge-write in ONE locked step, AFTER the slow QuickBooks fetch, so a
  // save that lands while QuickBooks is answering can't be overwritten by
  // this run's older copy (it used to read first, fetch, then write back the
  // whole stale items+transactions file).
  await withItemsTxnLock(async () => {
    const itemsTxn = await _readItemsTxnUnlocked();
    const items = Array.isArray(itemsTxn.items) ? itemsTxn.items.slice() : [];
    qbItems.forEach(qi => {
      const existing = items.findIndex(x => x && x.qbId === qi.Id);
      let groupName = '';
      if (qi.FullyQualifiedName && qi.FullyQualifiedName.indexOf(':') >= 0) {
        groupName = qi.FullyQualifiedName.split(':')[0];
      } else if (qi.ParentRef && qi.ParentRef.name) {
        groupName = qi.ParentRef.name;
      }
      const prev = existing >= 0 ? items[existing] : null;
      const mapped = {
        id: prev ? prev.id : 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        qbId: qi.Id,
        name: qi.Name || '',
        type: qi.Type || '',
        description: qi.Description || qi.FullyQualifiedName || '',
        sku: qi.Sku || '',
        price: qi.UnitPrice || 0,
        cost: qi.PurchaseCost || 0,
        qty: qi.QtyOnHand || 0,
        qbQty: qi.QtyOnHand || 0,
        active: qi.Active !== false,
        groupName: groupName,
        qbSynced: new Date().toISOString(),
        locationId: prev ? prev.locationId : undefined,
        locQtys: prev ? prev.locQtys : undefined,
        openingDate: prev ? prev.openingDate : undefined
      };
      if (existing >= 0) items[existing] = mapped; else items.push(mapped);
    });
    await _writeItemsTxnUnlocked({ items, transactions: itemsTxn.transactions || [] });
  });
  _lastItemSyncAt = syncStartedAt;
  return qbItems.length;
}

let _lastItemsSyncRunAt = 0;
let _lastItemsSyncResult = null;
// A promise-based lock rather than a plain boolean — a caller that
// arrives while a sync is ALREADY running (e.g. the "Sync now" button
// gets clicked at the exact moment the 5-min timer fires) awaits that
// SAME in-progress sync and gets its genuinely-fresh result, instead of
// a boolean guard just no-op'ing immediately and handing back
// whatever's leftover from before that overlapping run finishes —
// important specifically for the manual "Sync now" case below, where
// the whole point is a real, current answer, not a stale one.
let _itemsSyncPromise = null;
function runItemsBackgroundSync() {
  if (_itemsSyncPromise) return _itemsSyncPromise;
  if (!accessToken && !refreshToken) return Promise.resolve(); // QuickBooks isn't connected yet
  _itemsSyncPromise = (async () => {
    try {
      const count = await backgroundSyncItems();
      _lastItemsSyncResult = { ok: true, count, incremental: false, at: new Date().toISOString() };
    } catch (e) {
      _lastItemsSyncResult = { ok: false, error: e.message, at: new Date().toISOString() };
      console.error('Background item sync failed:', e.message);
    }
    _lastItemsSyncRunAt = Date.now();
  })();
  return _itemsSyncPromise.finally(() => { _itemsSyncPromise = null; });
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
  // Items and customers are no longer synced here — they each have their
  // own faster, independent, incremental cycle now (see
  // runItemsBackgroundSync/runCustomersBackgroundSync and
  // ITEMS_SYNC_INTERVAL_MS) since they ended up needing a shorter cadence
  // than vendors, which stays on this slower 30-min cycle (vendors have no
  // incremental/since-based sync — every run here is a full pull).
  const result = { at: new Date().toISOString(), vendors: null };
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
    // Truncated to 300 chars for display — fine for the Item probes below
    // (their whole point is just the status code / a short COUNT result),
    // but NOT safe for CompanyInfo (see companyRaw below), whose response
    // is routinely well over 300 characters and would truncate mid-object,
    // making JSON.parse throw and silently leaving companyName null below
    // — CONFIRMED live (Sep 2026): exactly this happened, hiding the one
    // piece of information (the real connected company's name) this
    // endpoint exists to surface in the first place.
    return { status: res.status, body: res.body.slice(0, 300) };
  }
  async function runQueryFull(q) {
    const reqPath = `/v3/company/${activeRealm}/query?query=${encodeURIComponent(q)}&minorversion=75`;
    const res = await httpsRequest({
      hostname: 'quickbooks.api.intuit.com',
      path: reqPath,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
    });
    return { status: res.status, body: res.body };
  }

  const company = await runQueryFull('SELECT * FROM CompanyInfo');
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
  // (Oct 2026 audit) Security headers on every response, and no more
  // "Access-Control-Allow-Origin: *": the app only ever calls its own
  // address, so other websites have no reason to be invited in.
  res.setHeader('X-Content-Type-Options', 'nosniff');           // browsers must not guess file types
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');               // no embedding in other sites' frames (clickjacking)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(self)');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000'); // HTTPS only

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const fullUrl = req.url;
  const url = fullUrl.split('?')[0];
  const queryParams = querystring.parse(fullUrl.split('?')[1] || '');

  // Temporary request logging — added specifically to catch which request
  // is running at the moment memory spikes (confirmed Sep 2026: a sudden
  // ~840MB jump in under a minute, not a gradual leak — meaning it's some
  // specific, large operation, not something to fix generically). Skips
  // the high-frequency lightweight polling endpoints (session checks, the
  // small-collections poll) since those fire every 1-2s per open tab and
  // would just be noise; logs everything else, with memory readings around
  // the heaviest suspects (QuickBooks document/item pulls, the general
  // data sync) specifically. Remove once the actual cause is found.
  var _reqIsNoisyPoll = (url === '/api/data/small' || url === '/api/session');
  if (!_reqIsNoisyPoll) {
    console.log('[reqlog] ' + req.method + ' ' + url + (fullUrl.indexOf('?') >= 0 ? '?' + fullUrl.split('?')[1].slice(0, 80) : '') + ' rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB');
  }
  var _reqIsHeavySuspect = (url === '/api/qb/documents' || url === '/api/qb/items' || url === '/api/data');
  if (_reqIsHeavySuspect) {
    res.on('finish', function () {
      console.log('[reqlog] FINISHED ' + req.method + ' ' + url + ' rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB');
    });
  }

  // ===== Customer portal routes (Nov 2026) — see "Customer portal" above =====
  // ---- Installable portal app (Nov 2026): manifest, icons, service worker ----
  if (url === '/portal') { res.writeHead(301, { 'Location': '/portal/' + (fullUrl.includes('?') ? '?' + fullUrl.split('?')[1] : '') }); res.end(); return; }
  if (url === '/portal/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      name: 'Leader Meat — Customer Portal', short_name: 'Leader Meat', description: 'Your Leader Meat invoices and account balance.',
      id: '/portal/', start_url: '/portal/', scope: '/portal/', display: 'standalone', orientation: 'portrait',
      background_color: '#1E2228', theme_color: '#1E2228',
      icons: [
        { src: '/portal/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/portal/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/portal/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    }));
    return;
  }
  if (url.startsWith('/portal/') && url.endsWith('.png') && PORTAL_ICONS[url.slice('/portal/'.length)]) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(Buffer.from(PORTAL_ICONS[url.slice('/portal/'.length)], 'base64'));
    return;
  }
  if (url === '/portal/sw.js') {
    // Never caches account data: it only shows a friendly offline page when
    // the phone has no connection.
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/portal/' });
    res.end(`self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
  if(e.request.mode!=='navigate') return;
  e.respondWith(fetch(e.request).catch(()=>new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;text-align:center;padding:60px 24px;color:#1a1e23"><h2>No connection</h2><p style="color:#5e6772">Connect to the internet to see your Leader Meat account.</p><button onclick="location.reload()" style="padding:12px 20px;border-radius:9px;border:0;background:#9E2B25;color:#fff;font-size:16px">Try again</button></body>',{headers:{'Content-Type':'text/html'}})));
});`);
    return;
  }
  if (url === '/portal/') {
    fs.readFile(path.join(__dirname, 'portal.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(data);
    });
    return;
  }
  if (url.startsWith('/portal/api/')) {
    const sendJ = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' }); res.end(JSON.stringify(obj)); };
    try {
      if (url === '/portal/api/send-code' && req.method === 'POST') {
        const body = JSON.parse((await readRequestBody(req)) || '{}');
        const phone = _normPhone(body.phone);
        if (!phone) return sendJ(400, { error: 'Please enter a valid phone number.' });
        if (!_twilioReady()) return sendJ(503, { error: 'Sign-in by text message is not set up yet. Please contact Leader Meat.' });
        if (_portalLimited('ip:' + _clientIp(req), 15, 3600000) || _portalLimited('send:' + phone, 4, 900000)) return sendJ(429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
        const allowed = await _portalCustomersFor(phone);
        // Same answer whether or not the number is registered (no way to probe numbers).
        if (allowed.length) {
          const r = await _twilioVerify('Verifications', { To: phone, Channel: 'sms' });
          if (r.status >= 300) {
            // Twilio's own reason (error code + message) — never the secrets.
            // 20003 = wrong Account SID / Auth Token; 20404 = wrong Verify
            // Service SID; 60410/60605 = Geo Permissions blocking the country;
            // 60200 = invalid phone number. Look these up at twilio.com/docs/api/errors.
            const sidHint = 'account ' + _tw('TWILIO_ACCOUNT_SID').slice(0, 4) + '… (' + _tw('TWILIO_ACCOUNT_SID').length + ' chars), service ' + _tw('TWILIO_VERIFY_SID').slice(0, 4) + '… (' + _tw('TWILIO_VERIFY_SID').length + ' chars)';
            console.warn('[portal] Twilio send failed: HTTP ' + r.status + ', Twilio error ' + (r.json.code || '?') + ' — ' + (r.json.message || 'no message') + ' | ' + sidHint + ' | to ' + phone.slice(0, -4) + '****');
            return sendJ(502, { error: 'Could not send the text message right now. Please try again shortly.' });
          }
          console.log('[portal] code sent to ' + phone.slice(0, -4) + '****');
        } else console.log('[portal] code requested for unregistered number ' + phone.slice(0, -4) + '****');
        return sendJ(200, { ok: true, message: 'If this number is registered with us, a 6-digit code is on its way.' });
      }
      if (url === '/portal/api/verify' && req.method === 'POST') {
        const body = JSON.parse((await readRequestBody(req)) || '{}');
        const phone = _normPhone(body.phone), code = String(body.code || '').replace(/\D/g, '');
        if (!phone || code.length < 4) return sendJ(400, { error: 'Enter the code from the text message.' });
        if (_portalLimited('ip:' + _clientIp(req), 15, 3600000) || _portalLimited('verify:' + phone, 8, 900000)) return sendJ(429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
        const allowed = await _portalCustomersFor(phone);
        if (!allowed.length || !_twilioReady()) return sendJ(401, { error: 'That code is not correct or has expired.' });
        const r = await _twilioVerify('VerificationCheck', { To: phone, Code: code });
        if (r.status >= 300 || r.json.status !== 'approved') return sendJ(401, { error: 'That code is not correct or has expired.' });
        const token = crypto.randomBytes(32).toString('hex');
        PORTAL_SESSIONS.set(token, { phone, createdAt: new Date().toISOString(), expires: Date.now() + PORTAL_TTL_MS });
        _persistPortalSessions();
        console.log('[portal] signed in: ' + phone.slice(0, -4) + '**** (' + allowed.map(c => c.name).join(', ') + ')');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store', 'Set-Cookie': _portalCookie(token, PORTAL_TTL_MS / 1000) });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url === '/portal/api/logout' && req.method === 'POST') {
        const s = _portalSession(req);
        if (s) { PORTAL_SESSIONS.delete(s.token); _persistPortalSessions(); }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': _portalCookie('', 0) });
        res.end('{"ok":true}');
        return;
      }
      // ---- everything below needs a signed-in customer ----
      const sess = _portalSession(req);
      if (!sess) return sendJ(401, { error: 'signed-out' });
      const mine = await _portalCustomersFor(sess.phone);
      if (!mine.length) return sendJ(401, { error: 'signed-out' });
      if (url === '/portal/api/me' && req.method === 'GET') {
        return sendJ(200, { phone: sess.phone.slice(0, -4).replace(/\d/g, '•') + sess.phone.slice(-4), customers: mine.map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) });
      }
      const cust = mine.find(c => c.id === String(queryParams.c || ''));
      if (!cust) return sendJ(403, { error: 'Not available.' });
      const qbId = String(cust.qbId).replace(/'/g, '');
      if (url === '/portal/api/summary' && req.method === 'GET') {
        const today = new Date().toISOString().slice(0, 10);
        const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
        const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
        const [open, recent, pays, cmsRecent, cmsOpen, methods] = await Promise.all([
          _qbQueryAll(`SELECT * FROM Invoice WHERE CustomerRef = '${qbId}' AND Balance > '0'`),
          _qbQueryAll(`SELECT * FROM Invoice WHERE CustomerRef = '${qbId}' AND TxnDate >= '${since}'`),
          _qbQueryAll(`SELECT * FROM Payment WHERE CustomerRef = '${qbId}' AND TxnDate >= '${yearAgo}'`),
          _qbQueryAll(`SELECT * FROM CreditMemo WHERE CustomerRef = '${qbId}' AND TxnDate >= '${yearAgo}'`),
          _qbQueryAll(`SELECT * FROM CreditMemo WHERE CustomerRef = '${qbId}' AND Balance > '0'`),
          _portalPaymentMethods()
        ]);
        const openS = open.map(i => _invSummary(i, today)).sort((a, b) => a.due.localeCompare(b.due));
        const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
        openS.forEach(i => { const d = i.daysOverdue; if (d <= 0) aging.current += i.balance; else if (d <= 30) aging.d1_30 += i.balance; else if (d <= 60) aging.d31_60 += i.balance; else if (d <= 90) aging.d61_90 += i.balance; else aging.d90 += i.balance; });
        const balance = openS.reduce((t, i) => t + i.balance, 0);
        // ---- Payments + credit memos (Nov 2026) ----
        // A Payment lists exactly which invoices it paid and which credit
        // memos it used (Line[].LinkedTxn). A CreditMemo doesn't record where
        // it went, so "applied to" comes from the payments that used it.
        const cmMap = {}; cmsRecent.concat(cmsOpen).forEach(c => { cmMap[c.Id] = c; });
        const docNo = {}; open.concat(recent).forEach(i => { docNo['Invoice:' + i.Id] = i.DocNumber || ''; });
        Object.values(cmMap).forEach(c => { docNo['CreditMemo:' + c.Id] = c.DocNumber || ''; });
        const need = { Invoice: new Set(), CreditMemo: new Set() };
        pays.forEach(p => (p.Line || []).forEach(l => (l.LinkedTxn || []).forEach(t => { if (need[t.TxnType] && docNo[t.TxnType + ':' + t.TxnId] === undefined) need[t.TxnType].add(String(t.TxnId).replace(/\D/g, '')); })));
        for (const type of ['Invoice', 'CreditMemo']) {
          const ids = Array.from(need[type]).filter(Boolean);
          for (let k = 0; k < ids.length; k += 100) {
            const rows = await _qbQueryAll(`SELECT * FROM ${type} WHERE CustomerRef = '${qbId}' AND Id IN (${ids.slice(k, k + 100).map(x => "'" + x + "'").join(',')})`);
            rows.forEach(r => { docNo[type + ':' + r.Id] = r.DocNumber || ''; });
          }
        }
        const applied = {}; // credit memo id -> [{date, amount, invoices:[{id,number}]}]
        const payRows = pays.map(p => {
          const invoices = [], credits = [];
          (p.Line || []).forEach(l => (l.LinkedTxn || []).forEach(t => {
            const row = { id: String(t.TxnId), number: docNo[t.TxnType + ':' + t.TxnId] || '', amount: Number(l.Amount || 0) };
            if (t.TxnType === 'Invoice') invoices.push(row); else if (t.TxnType === 'CreditMemo') credits.push(row);
          }));
          credits.forEach(c => { (applied[c.id] = applied[c.id] || []).push({ date: (p.TxnDate || '').slice(0, 10), amount: c.amount, invoices: invoices.map(i => ({ id: i.id, number: i.number })) }); });
          const m = p.PaymentMethodRef && methods[String(p.PaymentMethodRef.value)];
          return { id: p.Id, date: (p.TxnDate || '').slice(0, 10), ref: p.PaymentRefNum || '', method: (m && m.name) || (p.PaymentMethodRef && p.PaymentMethodRef.name) || '',
            amount: Number(p.TotalAmt || 0), unapplied: Number(p.UnappliedAmt || 0), invoices, credits };
        }).filter(p => p.date >= new Date(Date.now() - 183 * 86400000).toISOString().slice(0, 10))
          .sort((a, b) => b.date.localeCompare(a.date));
        const creditMemos = Object.values(cmMap).map(c => ({ id: c.Id, number: c.DocNumber || '', date: (c.TxnDate || '').slice(0, 10), total: Number(c.TotalAmt || 0), remaining: Number(c.Balance || 0),
          applied: (applied[c.Id] || []).sort((a, b) => b.date.localeCompare(a.date)) })).sort((a, b) => b.date.localeCompare(a.date));
        const availableCredit = creditMemos.reduce((t, c) => t + c.remaining, 0) + payRows.reduce((t, p) => t + (p.unapplied > 0 ? p.unapplied : 0), 0);
        return sendJ(200, { customer: { id: cust.id, name: cust.name }, asOf: new Date().toISOString(), balance, overdue: balance - aging.current, aging, open: openS,
          payments: payRows, creditMemos, availableCredit,
          recent: recent.map(i => _invSummary(i, today)).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number)) });
      }
      if ((url === '/portal/api/creditmemo' || url === '/portal/api/creditmemo-pdf') && req.method === 'GET') {
        const cmId = String(queryParams.cm || '').replace(/\D/g, '');
        if (!cmId) return sendJ(400, { error: 'Missing credit memo.' });
        await ensureFreshToken();
        const r = await httpsRequest({ hostname: 'quickbooks.api.intuit.com', path: `/v3/company/${activeRealm}/creditmemo/${cmId}?minorversion=75`, method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
        const cm = r.status === 200 ? (JSON.parse(r.body).CreditMemo || null) : null;
        if (!cm || String(cm.CustomerRef && cm.CustomerRef.value) !== String(cust.qbId)) return sendJ(404, { error: 'Credit memo not found.' });
        if (url === '/portal/api/creditmemo') {
          const lines = (cm.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail' || l.DetailType === 'DescriptionOnly').map(l => {
            const d = l.SalesItemLineDetail || {};
            return { item: (d.ItemRef && d.ItemRef.name) || '', description: l.Description || '', qty: d.Qty != null ? Number(d.Qty) : null, rate: d.UnitPrice != null ? Number(d.UnitPrice) : null, amount: Number(l.Amount || 0) };
          });
          return sendJ(200, { id: cm.Id, number: cm.DocNumber || '', date: (cm.TxnDate || '').slice(0, 10), total: Number(cm.TotalAmt || 0), remaining: Number(cm.Balance || 0), lines, memo: (cm.CustomerMemo && cm.CustomerMemo.value) || '' });
        }
        const pr = await httpsRequest({ hostname: 'quickbooks.api.intuit.com', path: `/v3/company/${activeRealm}/creditmemo/${cmId}/pdf?minorversion=75`, method: 'GET', __binary: true, headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/pdf' } });
        if (pr.status !== 200) return sendJ(502, { error: 'Could not get the PDF right now.' });
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="Credit-Memo-' + String(cm.DocNumber || cmId).replace(/[^\w-]/g, '') + '.pdf"', 'Cache-Control': 'private, no-store' });
        res.end(pr.body);
        return;
      }
      if ((url === '/portal/api/invoice' || url === '/portal/api/invoice-pdf') && req.method === 'GET') {
        const invId = String(queryParams.inv || '').replace(/\D/g, '');
        if (!invId) return sendJ(400, { error: 'Missing invoice.' });
        await ensureFreshToken();
        const r = await httpsRequest({ hostname: 'quickbooks.api.intuit.com', path: `/v3/company/${activeRealm}/invoice/${invId}?minorversion=75`, method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
        const inv = r.status === 200 ? (JSON.parse(r.body).Invoice || null) : null;
        // Only ever this customer's own invoices.
        if (!inv || String(inv.CustomerRef && inv.CustomerRef.value) !== String(cust.qbId)) return sendJ(404, { error: 'Invoice not found.' });
        if (url === '/portal/api/invoice') {
          const lines = (inv.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail' || l.DetailType === 'DescriptionOnly').map(l => {
            const d = l.SalesItemLineDetail || {};
            return { item: (d.ItemRef && d.ItemRef.name) || '', description: l.Description || '', qty: d.Qty != null ? Number(d.Qty) : null, rate: d.UnitPrice != null ? Number(d.UnitPrice) : null, amount: Number(l.Amount || 0) };
          });
          return sendJ(200, Object.assign(_invSummary(inv, new Date().toISOString().slice(0, 10)), { lines, memo: (inv.CustomerMemo && inv.CustomerMemo.value) || '' }));
        }
        const pr = await httpsRequest({ hostname: 'quickbooks.api.intuit.com', path: `/v3/company/${activeRealm}/invoice/${invId}/pdf?minorversion=75`, method: 'GET', __binary: true, headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/pdf' } });
        if (pr.status !== 200) return sendJ(502, { error: 'Could not get the PDF right now.' });
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="Invoice-' + String(inv.DocNumber || invId).replace(/[^\w-]/g, '') + '.pdf"', 'Cache-Control': 'private, no-store' });
        res.end(pr.body);
        return;
      }
      return sendJ(404, { error: 'Not found.' });
    } catch (e) {
      console.warn('[portal] error on ' + url + ':', e.message);
      return sendJ(500, { error: 'Something went wrong. Please try again.' });
    }
  }
  // Admin: which phone numbers may sign in to the portal for a customer.
  if (url.startsWith('/api/customers/') && url.endsWith('/portal') && req.method === 'POST') {
    const session = requireAdmin(req, res); if (!session) return;
    const custId = decodeURIComponent(url.slice('/api/customers/'.length, -'/portal'.length));
    try {
      const body = JSON.parse((await readRequestBody(req)) || '{}');
      const bad = [], phones = [];
      (Array.isArray(body.phones) ? body.phones : []).forEach(p => { const n = _normPhone(p); if (!n) bad.push(String(p)); else if (phones.indexOf(n) < 0) phones.push(n); });
      if (bad.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not a valid phone number: ' + bad.join(', ') })); return; }
      let saved = null;
      await updateSharedData(async (current) => {
        const customers = Array.isArray(current.customers) ? current.customers : [];
        const idx = customers.findIndex(c => c && c.id === custId);
        if (idx < 0) return { skipWrite: true };
        const patch = { portalPhones: phones };
        if (typeof body.off === 'boolean') patch.portalOff = body.off;
        customers[idx] = Object.assign({}, customers[idx], patch);
        saved = customers[idx];
        return { data: Object.assign({}, current, { customers }) };
      });
      if (!saved) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Customer not found.' })); return; }
      console.log('[portal] ' + (session.name || '?') + ' set portal for ' + saved.name + ': ' + phones.length + ' phone(s)' + (saved.portalOff ? ', access OFF' : ''));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
      res.end(JSON.stringify({ success: true, portalPhones: saved.portalPhones, portalOff: !!saved.portalOff }));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
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
      // PINs are short (4 digits by default — 10,000 combinations) with no
      // other login factor, so unthrottled attempts make a working PIN
      // guessable in a realistic number of requests. Locked per-email
      // rather than per-IP: this app can be reached over the open internet
      // (Render), and per-IP alone is trivially defeated by anyone with
      // more than one address, while a real user only ever needs a handful
      // of attempts even after mistyping.
      const lockCheck = checkLoginRateLimit(email);
      if (lockCheck.locked) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Too many failed attempts. Try again in ' + lockCheck.retryAfterSeconds + ' seconds.' }));
        return;
      }
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
        recordFailedLogin(email);
        res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Incorrect email or PIN.' }));
        return;
      }
      clearLoginRateLimit(email);
      const token = createSession(user);
      // (Oct 2026) Flag commonly guessed PINs so the app can ask the user to
      // change it. The default admin account ships with 1234.
      const weakPin = WEAK_PINS.has(pin) || /^(\d)\1+$/.test(pin);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Set-Cookie': sessionCookieHeader(token, SESSION_TTL_MS / 1000)
      });
      res.end(JSON.stringify({ success: true, weakPin, user: { id: user.id, name: user.name, email: user.email, role: user.role, perms: user.perms || {} } }));
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
    // Every open tab polls this endpoint every 1.5s (see index.html's
    // pullFromServer/setInterval), and the response includes the full
    // items+transactions dataset — "years of synced Bills/Invoices",
    // BY FAR the largest, slowest-to-serialize part of the shared data
    // (see the comment on ITEMS_TXN_FILE above). Re-running JSON.stringify
    // over that whole multi-MB payload on every single poll, from every
    // open tab, regardless of whether anything actually changed, is
    // exactly the kind of continuous, ever-growing (the dataset only ever
    // gets bigger — nothing prunes old transactions) allocation churn that
    // matches the OOM investigation elsewhere in this file: not a fixed
    // one-time cost, but something that scales with open tabs * dataset
    // size * polls/sec. Caching the STRINGIFIED body (not just the parsed
    // object — _sharedDataCache/_itemsTxnCache already do that) means a
    // burst of identical polls between writes costs one stringify, not one
    // per poll. Keyed on reference identity of the two underlying caches:
    // both get reassigned to a brand-new object on every write (see
    // _writeSharedDataRawUnlocked/_writeItemsTxnUnlocked), so `===` here
    // is exactly "has anything changed since the last time we stringified".
    await Promise.all([readSharedData(), readItemsTxnData()]); // cheap: populates/refreshes _sharedDataCache & _itemsTxnCache if needed, no disk I/O once cached
    if (!(_apiDataJsonCache && _apiDataJsonCache.sharedRef === _sharedDataCache && _apiDataJsonCache.itemsTxnRef === _itemsTxnCache)) {
      _rebuildApiDataJsonCache();
    }
    // Version check (Sep 2026, browser out-of-memory fix): every open tab
    // pulls this full payload on a timer. When the browser already has the
    // current version (it sends back the ETag it got last time), answer
    // "304 Not Modified" with an empty body instead of re-sending the whole
    // multi-MB dataset for the browser to download, parse and re-cache.
    // The ETag combines a per-boot random id with a counter bumped on every
    // rebuild, so a server restart can never make an old tag look current.
    await _sendCachedJson(req, res, _apiDataJsonCache); // 304 when unchanged, gzip when accepted
    return;
  }
  // Lightweight read of JUST the items list (no transactions, no other
  // shared collections) — used to poll for background-synced item changes
  // (see backgroundSyncItems above) without paying the cost of the full
  // /api/data payload or the multi-MB transactions array on every poll.
  if (url === '/api/data/items-only' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const itemsTxn = await readItemsTxnData();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ items: itemsTxn.items || [] }));
    return;
  }
  // Forces an item sync to run RIGHT NOW instead of waiting for the next
  // 5-minute tick — CONFIRMED live (Sep 2026): the automatic background
  // sync (see runItemsBackgroundSync) is great for "stays current without
  // touching anything", but there are real moments (checking a number
  // that matters right now, right after fixing something in QuickBooks)
  // where waiting even a few minutes isn't good enough. This reuses the
  // exact same runItemsBackgroundSync used by the timer — including its
  // incremental-since-last-sync behavior and its in-flight guard, so
  // mashing this doesn't trigger overlapping full pulls — the request
  // just waits for whatever sync (already running or freshly started)
  // to finish, then returns the current items.
  if (url === '/api/data/items-sync-now' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      await runItemsBackgroundSync();
      const itemsTxn = await readItemsTxnData();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, items: itemsTxn.items || [], result: _lastItemsSyncResult }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Lightweight read of JUST the customers list — same idea as
  // /api/data/items-only, used to poll for background-synced customer
  // changes without paying the cost of the full /api/data payload.
  if (url === '/api/data/customers-only' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const data = await readSharedData();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ customers: data.customers || [] }));
    return;
  }
  // Forces a customer sync to run RIGHT NOW instead of waiting for the
  // next tick — same reasoning and same reused-in-flight-promise behavior
  // as /api/data/items-sync-now above.
  if (url === '/api/data/customers-sync-now' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      await runCustomersBackgroundSync();
      const data = await readSharedData();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, customers: data.customers || [], result: _lastCustomersSyncResult }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Reconciles Plant Console items against the CURRENTLY connected
  // QuickBooks company three ways:
  //  1) qbId matches a live item → already correct, leave it alone.
  //  2) qbId does NOT match anything live, but the item's NAME matches a
  //     live item exactly → this is the real fix for the Legacy-company
  //     mixup (Sep 2026): the item was originally synced while connected
  //     to a DIFFERENT QuickBooks company file, so its stored qbId is
  //     THAT company's internal id for it — a real product can have the
  //     exact same name in two separate company files with two
  //     completely different numeric ids. CONFIRMED live: checking by id
  //     alone (even with the Active-filter bug fixed) kept flagging these
  //     as "not found" forever, because the ids were never going to
  //     match — they're from a different file entirely. A name match
  //     means the real record; auto-relink to it (updating qbId and
  //     refreshing every QB-sourced field, including Active/inactive
  //     status, to the current company's real data) rather than either
  //     leaving it dangling or deleting real inventory history.
  //  3) NEITHER id nor name matches anything live → genuinely orphaned;
  //     offered up for deletion review.
  // usedQbIds guards against a real bug this same relinking caused
  // (CONFIRMED live Sep 2026): if TWO different local records both
  // normalize to the same name (e.g. one still plain "BEEF TOP ROUND
  // FAYMAN", another already renamed "BEEF TOP ROUND FAYMAN (deleted)"
  // from an earlier partial sync), both would get relinked to the SAME
  // live QuickBooks item, creating a genuine duplicate. Once a qbId has
  // been claimed (whether it was already correct, or just relinked to in
  // THIS pass), any further local record that would also match it is
  // routed to duplicates instead of silently creating a second copy.
  if (url === '/api/data/items-find-orphans' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    try {
      const qbItems = await fetchAllQBItems();
      const liveIds = new Set(qbItems.map(it => it.Id));
      // Normalizes a name for matching by stripping QuickBooks' own
      // "(deleted)" suffix (added automatically when an item gets merged/
      // deactivated) along with surrounding whitespace/case differences.
      // CONFIRMED live (Sep 2026): without this, an item synced BEFORE it
      // was merged in QuickBooks (so Plant Console's copy still has the
      // plain pre-merge name) could never match its own live record
      // afterward — "BEEF RIB EYE B/S PUL" (stored) vs "BEEF RIB EYE B/S
      // PUL (deleted)" (live) are different strings even though it's the
      // exact same real item, wrongly landing it in the genuine-orphans
      // list instead of getting relinked.
      const normalizeName = s => String(s || '').trim().replace(/\s*\(deleted\)\s*$/i, '').trim().toLowerCase();
      const liveByName = new Map(qbItems.map(it => [normalizeName(it.Name), it]));
      const itemsTxn = await readItemsTxnData();
      const items = (itemsTxn.items || []).slice();
      // Tracks which qbIds already have exactly one local record claiming
      // them (the one being kept) as the loop below proceeds — a SECOND
      // (or later) local record that would also end up on the same qbId,
      // whether it was already like that before this run or only becomes
      // so via a name-match relink just now, gets flagged as a duplicate
      // to delete rather than silently becoming a second holder of that
      // id. Only ONE copy per qbId is ever kept automatically — the
      // duplicates list below only ever contains the EXTRA copies, never
      // the one being kept, so selecting all of them for deletion can
      // never wipe an item out entirely.
      const keptQbIds = new Set();
      const relinked = [];
      const orphans = [];
      const duplicates = [];
      let changed = false;
      items.forEach((it, idx) => {
        if (!it || !it.qbId) return;
        if (liveIds.has(it.qbId)) {
          if (keptQbIds.has(it.qbId)) {
            duplicates.push({ id: it.id, qbId: it.qbId, name: it.name, qty: it.qty, cost: it.cost });
          } else {
            keptQbIds.add(it.qbId);
          }
          return;
        }
        const match = liveByName.get(normalizeName(it.name));
        if (match && keptQbIds.has(match.Id)) {
          duplicates.push({ id: it.id, qbId: it.qbId, name: it.name, qty: it.qty, cost: it.cost });
          return;
        }
        if (match) {
          let groupName = '';
          if (match.FullyQualifiedName && match.FullyQualifiedName.indexOf(':') >= 0) {
            groupName = match.FullyQualifiedName.split(':')[0];
          } else if (match.ParentRef && match.ParentRef.name) {
            groupName = match.ParentRef.name;
          }
          items[idx] = Object.assign({}, it, {
            qbId: match.Id,
            name: match.Name || it.name,
            type: match.Type || it.type,
            description: match.Description || match.FullyQualifiedName || it.description,
            sku: match.Sku || it.sku,
            price: match.UnitPrice || 0,
            cost: match.PurchaseCost || 0,
            qty: match.QtyOnHand || 0,
            qbQty: match.QtyOnHand || 0,
            active: match.Active !== false,
            groupName: groupName,
            qbSynced: new Date().toISOString()
          });
          keptQbIds.add(match.Id);
          relinked.push({ name: it.name, wasQbId: it.qbId, nowQbId: match.Id, active: match.Active !== false });
          changed = true;
        } else {
          orphans.push({ id: it.id, qbId: it.qbId, name: it.name, qty: it.qty, cost: it.cost });
        }
      });
      if (changed) {
        await writeItemsTxnData({ items, transactions: itemsTxn.transactions || [] });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, checkedAgainst: liveIds.size, relinked, orphans, duplicates }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Deletes specific Plant Console items by id — used only from the
  // orphaned-items finder above (the person reviews the list and picks
  // which ones to actually remove; nothing here deletes automatically).
  // Admin-only, same as backup/restore — this is a real, permanent
  // deletion of inventory records, not something to expose to every role.
  if (url === '/api/data/items-delete' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const idsToDelete = new Set((Array.isArray(body.ids) ? body.ids : []).filter(x => typeof x === 'string'));
      const itemsTxn = await readItemsTxnData();
      const items = (itemsTxn.items || []).filter(it => !it || !idsToDelete.has(it.id));
      await writeItemsTxnData({ items, transactions: itemsTxn.transactions || [] });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, remaining: items.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // One-time migration: patches docId onto every EXISTING synced
  // transaction that's missing it — CONFIRMED live (Sep 2026), this fixes
  // the "every bill/invoice line shows as its own separate row instead of
  // grouping into one expandable row" bug for transactions that were
  // already synced before that fix existed. Deliberately does NOT
  // re-fetch anything from QuickBooks or re-run the client's document
  // sync — a real "Full sync" attempt for this crashed the browser tab
  // with an Out of Memory error on a ~45k-record transaction history,
  // since that whole rebuild happens in the browser's own memory. The
  // docId value needed is already fully recoverable from data already
  // sitting on the server: every synced transaction's own id field is
  // built as "qb_<DocType>_<QuickBooksDocId>_<suffix>" (see where
  // transactions.push({id:...}) happens client-side for the exact
  // format), so this just parses that apart server-side — zero QuickBooks
  // API calls, zero browser memory pressure, one pass over data that's
  // already local to the server.
  if (url === '/api/data/migrate-transaction-docids' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const itemsTxn = await readItemsTxnData();
      const transactions = (itemsTxn.transactions || []).slice();
      const docTypes = ['Bill', 'Invoice', 'SalesReceipt', 'CreditMemo', 'VendorCredit'];
      const idPattern = new RegExp('^qb_(' + docTypes.join('|') + ')_(.+)_(?:acctline\\d+|disc\\d+|\\d+)$');
      let migrated = 0;
      let alreadyOk = 0;
      let unmatched = 0;
      for (let i = 0; i < transactions.length; i++) {
        const t = transactions[i];
        if (!t || !t.qbDoc) continue;
        if (t.docId) { alreadyOk++; continue; }
        const m = typeof t.id === 'string' ? t.id.match(idPattern) : null;
        if (!m) { unmatched++; continue; }
        transactions[i] = Object.assign({}, t, { docId: m[1] + '_' + m[2] });
        migrated++;
      }
      if (migrated > 0) {
        await writeItemsTxnData({ items: itemsTxn.items || [], transactions });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, migrated, alreadyOk, unmatched, total: transactions.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Same idea as items-find-orphans above, for customers — CONFIRMED live
  // (Sep 2026): the exact same Legacy-company mixup produced duplicate
  // customer records too (e.g. "Amherst Halal Market" correctly linked to
  // the current company, plus a leftover "AMHERST HALAL MARKET" from
  // whichever company Plant Console was connected to before, with its own
  // stale qbId that will never match anything in a fresh sync — a normal
  // customer re-sync only ever adds/updates by qbId, it never removes a
  // record that doesn't match, so re-importing alone can't fix this).
  // Same three-way reconciliation as items: qbId match → already correct;
  // no qbId match but name matches something not already claimed → auto-
  // relink (refresh every QB-sourced field, keep Plant-Console-only ones
  // like salesRep/dunsNumber); name matches something ALREADY claimed →
  // duplicate, flagged for review; neither matches → genuinely orphaned,
  // also flagged for review. Nothing is ever deleted here — see
  // customers-delete below for that, only run after the person reviews
  // the list this returns.
  if (url === '/api/data/customers-find-orphans' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    try {
      // Include inactive QuickBooks customers (Sep 2026 fix): an inactive
      // customer still exists in QuickBooks and must not be reported as
      // "NOT FOUND" and offered for deletion.
      const qbData = await fetchQBCustomers(false, null, true);
      const qbCustomers = (qbData.QueryResponse && qbData.QueryResponse.Customer) || [];
      const liveIds = new Set(qbCustomers.map(c => c.Id));
      const normalizeName = s => String(s || '').trim().toLowerCase();
      // A live customer can be found under SEVERAL name variants, not just
      // its exact DisplayName — CONFIRMED live (Sep 2026): "Wildberry
      // Cake" (a Legacy-company leftover, plain name only) didn't match
      // "Wildberry Cake | A & I Cake Corporation" (the real, current
      // record) under exact-string matching, even though it's the same
      // real customer — QuickBooks's own "Contact | Company" DisplayName
      // format isn't a name difference, it's just a different rendering
      // of the same record. Every alias below points at the SAME live
      // customer object; an alias is skipped (not registered) if it would
      // collide with a DIFFERENT live customer, so this never creates an
      // ambiguous/wrong match — it only adds recognizable variants of a
      // name that's otherwise unique.
      const liveByName = new Map();
      function registerAlias(key, cust) {
        if (!key) return;
        if (liveByName.has(key)) {
          const existing = liveByName.get(key);
          // existing can already be null here (a THIRD customer sharing
          // an alias that a prior pair already marked ambiguous) —
          // CONFIRMED live (Sep 2026): reading existing.Id without this
          // null check crashed the whole check with "Cannot read
          // properties of null (reading 'Id')". Null stays null either
          // way — still ambiguous, still correctly refuses to guess.
          if (existing === null || existing.Id !== cust.Id) { liveByName.set(key, null); }
          return;
        }
        liveByName.set(key, cust);
      }
      qbCustomers.forEach(c => {
        const display = c.DisplayName || c.FullyQualifiedName || c.CompanyName || '';
        registerAlias(normalizeName(display), c);
        if (display.indexOf('|') >= 0) {
          display.split('|').forEach(part => registerAlias(normalizeName(part), c));
        }
        if (c.CompanyName) registerAlias(normalizeName(c.CompanyName), c);
      });
      const liveById = new Map(qbCustomers.map(c => [c.Id, c]));
      let relinked = [];
      let orphans = [];
      let duplicates = [];
      await updateSharedData(async (current) => {
        const customers = (current.customers || []).slice();
        const keptQbIds = new Set();
        const keptBy = new Map(); // qbId -> name of the app record kept for it
        const qbNameOf = id => { const q = liveById.get(id); return q ? (q.DisplayName || q.FullyQualifiedName || q.CompanyName || '') : ''; };
        const dup = (c, qbId) => ({ id: c.id, qbId: qbId || c.qbId, name: c.name, qbName: qbNameOf(qbId || c.qbId), keptName: keptBy.get(qbId || c.qbId) || '' });
        let changed = false;
        // Order matters when two app records share one QuickBooks id: the first
        // one seen is kept and later ones become "duplicate". Look at records
        // whose id AND name both match QuickBooks first, so the copy that is
        // already correct is the one kept (Sep 2026).
        const exactFirst = customers.map((c, idx) => idx).sort((a, b) => {
          const ex = c => !!(c && c.qbId && liveById.get(c.qbId) && liveByName.get(normalizeName(c.name)) && liveByName.get(normalizeName(c.name)).Id === c.qbId);
          return (ex(customers[b]) ? 1 : 0) - (ex(customers[a]) ? 1 : 0) || a - b;
        });
        exactFirst.forEach(idx => {
          const c = customers[idx];
          if (!c) return;
          // CONFIRMED live (Sep 2026): a plain "does this qbId exist
          // somewhere live" check isn't actually enough — two separate
          // QuickBooks company files can independently assign the SAME
          // numeric id to two completely different, unrelated customers
          // (plausible especially for low/early ids). A stale qbId from
          // whichever company Plant Console was connected to before can
          // coincidentally also be a valid id in the CURRENT company —
          // just for someone else entirely — which made a real duplicate
          // ("Zirve Turkish Grill" showing twice) look "already correctly
          // linked" and get silently skipped every time, even after
          // fixing the earlier no-qbId-at-all bug. Now the id is only
          // trusted if the name it's SUPPOSED to belong to also matches
          // what's actually live at that id (via the same alias system
          // used for name-matching below) — an id that exists but points
          // to a differently-named customer is treated as untrustworthy,
          // same as having no id at all, and falls through to a proper
          // name-based lookup instead.
          const match = liveByName.get(normalizeName(c.name));
          const liveAtId = c.qbId ? liveById.get(c.qbId) : null;
          const idIsTrustworthy = liveAtId && match && match.Id === liveAtId.Id;
          if (idIsTrustworthy) {
            if (keptQbIds.has(c.qbId)) {
              duplicates.push(dup(c));
            } else {
              keptQbIds.add(c.qbId); keptBy.set(c.qbId, c.name);
            }
            return;
          }
          if (match && keptQbIds.has(match.Id)) {
            duplicates.push(dup(c, match.Id));
            return;
          }
          if (match) {
            customers[idx] = Object.assign({}, c, {
              qbId: match.Id,
              qbSyncToken: Number(match.SyncToken || 0),
              name: match.DisplayName || match.FullyQualifiedName || match.CompanyName || c.name,
              active: match.Active !== false
            });
            keptQbIds.add(match.Id); keptBy.set(match.Id, customers[idx].name);
            relinked.push({ name: c.name, wasQbId: c.qbId, nowQbId: match.Id });
            changed = true;
          } else if (liveAtId) {
            // Sep 2026 fix: the QuickBooks id still points at a real customer
            // whose name was changed in QuickBooks (e.g. "Ayat Bay Ridge" ->
            // "Ayat Bayridge Meast"). This used to be reported as NOT FOUND
            // and offered for deletion. It's the same customer: keep it and
            // take QuickBooks' current name.
            if (keptQbIds.has(c.qbId)) {
              duplicates.push(dup(c));
              return;
            }
            const qbName = liveAtId.DisplayName || liveAtId.FullyQualifiedName || liveAtId.CompanyName || c.name;
            customers[idx] = Object.assign({}, c, {
              qbSyncToken: Number(liveAtId.SyncToken || 0),
              name: qbName,
              active: liveAtId.Active !== false
            });
            keptQbIds.add(c.qbId); keptBy.set(c.qbId, qbName);
            relinked.push({ name: c.name, wasQbId: c.qbId, nowQbId: c.qbId, renamedTo: qbName });
            changed = true;
          } else if (c.qbId) {
            orphans.push({ id: c.id, qbId: c.qbId, name: c.name });
          }
          // A customer with NEITHER a qbId NOR a name match is left alone
          // entirely rather than flagged — it's likely a genuine
          // Plant-Console-only customer that was simply never synced to
          // QuickBooks (not every customer necessarily needs to be),
          // which is a different situation from a confirmed-orphaned
          // record that already claims a stale QuickBooks link.
        });
        if (!changed) return { skipWrite: true };
        return { data: Object.assign({}, current, { customers }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, checkedAgainst: liveIds.size, relinked, orphans, duplicates }));
    } catch (e) {
      const needsReconnect = e.message === 'NEEDS_RECONNECT';
      res.writeHead(needsReconnect ? 401 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message, needsReconnect }));
    }
    return;
  }
  // Deletes specific customer records by id — used only from the
  // orphaned-customers finder above (the person reviews the list and
  // picks which ones to actually remove). Admin-only, same reasoning as
  // items-delete: a real, permanent deletion, not exposed to every role.
  if (url === '/api/data/customers-delete' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const idsToDelete = new Set((Array.isArray(body.ids) ? body.ids : []).filter(x => typeof x === 'string'));
      markCustomerIdsDeleted(Array.from(idsToDelete)); // tombstone FIRST — closes the race window against any push already in flight
      let remaining = 0;
      await updateSharedData(async (current) => {
        const customers = (current.customers || []).filter(c => !c || !idsToDelete.has(c.id));
        remaining = customers.length;
        return { data: Object.assign({}, current, { customers }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, remaining }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
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
    // Built once per data version (the shared cache object is replaced on
    // every write) and answered with 304 "no change" when the tab already
    // has it — every open tab asks every 1.5s, and this payload is several
    // MB with the live customer list, so re-sending it unchanged cost each
    // tab gigabytes per hour (Oct 2026 audit).
    await readSharedData(); // makes sure the cache is loaded
    if (!_smallJsonCache || _smallJsonCache.ref !== _sharedDataCache) {
    const data = _sharedDataCache;
    const users = data.users.map(u => { const c = Object.assign({}, u); delete c.pin; delete c.pinHash; return c; });
    _smallJsonCache = { ref: _sharedDataCache, etag: '"s' + _API_DATA_BOOT_ID + '-' + (++_smallJsonVersion) + '"', json: JSON.stringify({
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
      deletedDrivers: data.deletedDrivers,
      itemFilterPrefs: data.itemFilterPrefs
    }) };
    }
    await _sendCachedJson(req, res, _smallJsonCache);
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
  // ---- Automatic customer emails (Nov 2026) — see runInvoiceEmailJob ----
  if (url.startsWith('/api/customers/') && url.endsWith('/email-prefs') && req.method === 'POST') {
    const session = requireAdmin(req, res); if (!session) return;
    const custId = decodeURIComponent(url.slice('/api/customers/'.length, -'/email-prefs'.length));
    try {
      const body = JSON.parse((await readRequestBody(req)) || '{}');
      let found = null;
      await updateSharedData(async (current) => {
        const customers = Array.isArray(current.customers) ? current.customers : [];
        const idx = customers.findIndex(c => c && c.id === custId);
        if (idx < 0) return { skipWrite: true };
        const patch = {};
        if (typeof body.emailInvoices === 'boolean') patch.emailInvoices = body.emailInvoices;
        if (typeof body.weeklyStatement === 'boolean') patch.weeklyStatement = body.weeklyStatement;
        customers[idx] = Object.assign({}, customers[idx], patch);
        found = customers[idx];
        return { data: Object.assign({}, current, { customers }) };
      });
      if (!found) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Customer not found.' })); return; }
      console.log('[invoice-email] ' + (session.name || '?') + ' set ' + found.name + ': invoices=' + !!found.emailInvoices + ', statements=' + !!found.weeklyStatement);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
      res.end(JSON.stringify({ success: true, id: custId, emailInvoices: !!found.emailInvoices, weeklyStatement: !!found.weeklyStatement }));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (url === '/api/email-automation' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const data = await readSharedData();
    const log = (Array.isArray(data.invoiceEmailLog) ? data.invoiceEmailLog : []).slice(-150).reverse();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
    res.end(JSON.stringify({ config: data.emailAutomation || {}, log }));
    return;
  }
  if (url === '/api/email-automation' && req.method === 'POST') {
    const session = requireAdmin(req, res); if (!session) return;
    try {
      const body = JSON.parse((await readRequestBody(req)) || '{}');
      let cfg = null;
      await updateSharedData(async (current) => {
        const c = Object.assign({}, current.emailAutomation || {});
        if (typeof body.invoicesOn === 'boolean') {
          // Turning ON starts a fresh window: only invoices created from now on.
          if (body.invoicesOn && !c.invoicesOn) c.invoicesOnSince = new Date().toISOString();
          c.invoicesOn = body.invoicesOn;
          c.changedBy = session.name || ''; c.changedAt = new Date().toISOString();
        }
        cfg = c;
        return { data: Object.assign({}, current, { emailAutomation: c }) };
      });
      console.log('[invoice-email] ' + (session.name || '?') + ' turned automatic invoice emails ' + (cfg.invoicesOn ? 'ON' : 'OFF'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
      res.end(JSON.stringify({ success: true, config: cfg }));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (url === '/api/email-automation/run-now' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const result = await runInvoiceEmailJob('manual');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
    res.end(JSON.stringify(result || {}));
    return;
  }
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
  // Browser memory report (Sep 2026, out-of-memory investigation): each open
  // tab posts its own memory use once a minute so tab growth shows up in the
  // Render logs as [tabmem] lines, tagged with user and page, instead of only
  // being visible after Chrome has already crashed the tab.
  if (url === '/api/tabmem' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    try {
      const b = JSON.parse((await readRequestBody(req)) || '{}');
      const n = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v) : '?';
      const str = v => String(v == null ? '?' : v).replace(/[^\w .:/-]/g, '').slice(0, 40);
      if (process.env.DEBUG_SYNC) console.log('[tabmem] user=' + str(session.name) + ' tab=' + str(b.tab) + ' ver=' + str(b.ver) + ' page=' + str(b.page) +
        ' usedMB=' + n(b.usedMB) + ' limitMB=' + n(b.limitMB) + ' openMin=' + n(b.openMin) +
        ' domNodes=' + n(b.domNodes) + ' txns=' + n(b.txns) + ' items=' + n(b.items) + ' customers=' + n(b.customers));
    } catch (e) {}
    res.writeHead(204, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end();
    return;
  }
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
      // Save-loop investigation (Sep 2026): name who is saving, from which
      // tab and code version, and which collections that tab says changed.
      // A tab showing ver=OLD is running an old copy of the page.
      try {
        const clean = v => String(v == null ? '' : v).replace(/[^\w ,.:/-]/g, '').slice(0, 160);
        console.log('[savelog] user=' + clean(_dataPostSession.name) + ' tab=' + (clean(incoming._tab) || '?') +
          ' ver=' + (clean(incoming._ver) || 'OLD') + ' changed=' + (clean(incoming._changed) || '?') + ' bytes=' + bodyStr.length);
      } catch (e) {}
      delete incoming._tab; delete incoming._ver; delete incoming._changed;
      delete incoming.poCounter; // only the server advances the P.O. counter
      // A tab still holding a copy damaged by the old decoding bug must not
      // be able to write it back: collapse broken runs in everything it sent.
      if (bodyStr.indexOf(BROKEN_CHAR) >= 0) {
        const n = _collapseBrokenDeep(incoming);
        if (n) console.log('[repair] incoming save from ' + String(_dataPostSession.name || '?').slice(0, 40) + ': cleaned ' + n + ' damaged text field(s)');
      }
      // Server-side growth check (Sep 2026): works for every tab, old or new
      // code. For each collection in this save, compare its size with what
      // the server currently holds and log the ones that differ, e.g.
      // [savediff] user=Hasan orders:+412B(+1) customers:-3B(0)
      // Off unless DEBUG_SYNC=1 is set in Render (Oct 2026 audit): it compares
      // every collection on every save — only needed while hunting a sync bug.
      if (process.env.DEBUG_SYNC) try {
        const cur = _sharedDataCache || {};
        const diffs = [];
        Object.keys(incoming).forEach(k => {
          if (k === 'items' || k === 'transactions' || k === 'transactionSyncScope') return;
          const a = JSON.stringify(cur[k] === undefined ? null : cur[k]);
          const b = JSON.stringify(incoming[k] === undefined ? null : incoming[k]);
          if (a === b) return;
          const cnt = v => Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0);
          const dB = b.length - a.length, dN = cnt(incoming[k]) - cnt(cur[k]);
          let detail = '';
          // For lists of records, name up to 3 changed records' changed
          // fields with their size before>after (sizes only, no values).
          if (Array.isArray(incoming[k]) && Array.isArray(cur[k]) && k !== 'users') {
            const byId = new Map(cur[k].map(r => [r && r.id, r]));
            const parts = [];
            for (const r of incoming[k]) {
              if (parts.length >= 3) break;
              if (!r || typeof r !== 'object') continue;
              const old = byId.get(r.id);
              if (!old) { parts.push('new#' + String(r.id).slice(0, 12)); continue; }
              if (JSON.stringify(old) === JSON.stringify(r)) continue;
              const f = [];
              new Set([...Object.keys(old), ...Object.keys(r)]).forEach(fk => {
                const x = JSON.stringify(old[fk]), y = JSON.stringify(r[fk]);
                if (x !== y) f.push(fk + '=' + (x ? x.length : 0) + '>' + (y ? y.length : 0));
              });
              parts.push(String(r.id).slice(0, 12) + '{' + f.slice(0, 6).join(',') + '}');
            }
            if (parts.length) detail = '[' + parts.join(' ') + ']';
          }
          diffs.push(k + ':' + (dB >= 0 ? '+' : '') + dB + 'B(' + (dN >= 0 ? '+' : '') + dN + ')' + detail);
        });
        console.log('[savediff] user=' + String(_dataPostSession.name || '?').replace(/[^\w .-]/g, '').slice(0, 40) + ' ' + (diffs.join(' ') || 'no-change'));
      } catch (e) {}
      // items/transactions are BY FAR the largest, slowest-to-serialize
      // part of a routine full-snapshot push — pulled out and written
      // through their own separate lock/file (see ITEMS_TXN_FILE above)
      // BEFORE the main updateSharedData() call below, so this request's
      // big payload can never make some other, unrelated request (an
      // order save, chat message polling, anything using the main store)
      // sit around waiting on it.
      // CONFIRMED live (Sep 2026): this used to be a BLIND OVERWRITE —
      // "items: incoming.items, transactions: incoming.transactions" —
      // with zero merge protection at all, unlike every other shared
      // collection in this app. A tab pushing its own possibly-stale
      // in-memory copy (very plausible: multiple tabs open, or an
      // automatic background sync racing a manual one) could silently
      // wipe out transactions another tab/process had just added,
      // producing exactly the kind of wildly-wrong inventory quantities
      // this was caught from. Fixed with a proper merge:
      //  - items: merge by id (add/update, never remove here — removal is
      //    a deliberate action via the orphaned-items tool, not a side
      //    effect of an ordinary sync push).
      //  - transactions: scope-aware. transactionSyncScope tells us
      //    exactly which documents THIS push is authoritative for —
      //    '__ALL__' for a full rebuild, or a list of docIds for an
      //    incremental one (see finishDocSync/window.__txnSyncScope on
      //    the client for where this comes from). Only transactions
      //    belonging to a document IN that scope are ever replaced/
      //    removed; anything else already on the server (added by another
      //    tab or process since this one's snapshot was taken) is left
      //    completely alone. Without a scope (older client, or a manual
      //    transaction add/edit that isn't a QB sync at all), falls back
      //    to a safe add/update-by-id merge that never removes anything.
      if (Array.isArray(incoming.items) || Array.isArray(incoming.transactions)) {
       // Read-merge-write as ONE locked step (Oct 2026) so the background item
       // sync, or another save, can't slip in between and be overwritten.
       await withItemsTxnLock(async () => {
        const existing = await _readItemsTxnUnlocked();
        let mergedItems = existing.items || [];
        if (Array.isArray(incoming.items)) {
          const itemMap = new Map(mergedItems.filter(it => it).map(it => [it.id, it]));
          for (const it of incoming.items) { if (it) itemMap.set(it.id, it); }
          mergedItems = Array.from(itemMap.values());
        }
        let mergedTransactions = existing.transactions || [];
        if (Array.isArray(incoming.transactions)) {
          const scope = incoming.transactionSyncScope;
          const incomingIds = new Set(incoming.transactions.filter(t => t).map(t => t.id));
          let base;
          if (scope === '__ALL__') {
            // Full rebuild: drop every existing qbDoc transaction (the
            // incoming array is the complete, authoritative replacement
            // for all of them), keep any non-qbDoc (manually-entered)
            // transaction untouched regardless.
            base = mergedTransactions.filter(t => t && !t.qbDoc);
          } else if (Array.isArray(scope) && scope.length) {
            const scopeSet = new Set(scope);
            // Incremental: drop existing transactions belonging to a
            // document THIS push is updating, unless a line with that
            // exact id is still present in the incoming set (in which
            // case the loop below will just update it in place) — keep
            // absolutely everything else (other documents, manual
            // entries, anything another tab added since this snapshot).
            base = mergedTransactions.filter(t => {
              if (!t || !t.qbDoc) return true;
              const m = typeof t.id === 'string' ? t.id.match(/^qb_([A-Za-z]+)_(.+?)_(?:acctline\d+|disc\d+|\d+)$/) : null;
              const docKey = m ? (m[1] + '_' + m[2]) : null;
              return !(docKey && scopeSet.has(docKey)) || incomingIds.has(t.id);
            });
          } else {
            // No scope provided at all (older client, or a plain manual
            // transaction edit) — safest fallback is add/update only,
            // never remove anything.
            base = mergedTransactions;
          }
          const txnMap = new Map(base.filter(t => t).map(t => [t.id, t]));
          for (const t of incoming.transactions) { if (t) txnMap.set(t.id, t); }
          mergedTransactions = Array.from(txnMap.values());
        }
        await _writeItemsTxnUnlocked({ items: mergedItems, transactions: mergedTransactions });
       });
        delete incoming.items;
        delete incoming.transactions;
        delete incoming.transactionSyncScope;
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
        if (Array.isArray(incoming.users)) {
          incoming.users = incoming.users.map(u => {
            if (!u) return u;
            const existing = current.users.find(x => x.id === u.id);
            const out = Object.assign({}, u);
            // SECURITY: `pinHash` must NEVER be accepted from the client — it is
            // only ever produced server-side (see hashPin()/_writeSharedDataUnlocked).
            // Without this, any logged-in session (any role, any perms) could hand-craft
            // a `users` payload carrying an attacker-chosen pinHash for ANY user id —
            // including an admin's — and take over that account outright, since nothing
            // else in this handler ever inspects or rejects an incoming pinHash.
            delete out.pinHash;
            if (existing) out.pinHash = existing.pinHash;
            // A plaintext `pin` (hashed on write, see _writeSharedDataUnlocked) may only
            // be set by someone who can manage users, or by a session changing its OWN
            // pin. Anyone else attempting to set/change another user's pin has it
            // silently reverted to whatever is already on file, same principle as the
            // role/perms guard below.
            const editingSelf = !!(actingUser && u.id === actingUser.id);
            if (!actingUserCanManageUsers && !editingSelf) {
              if (existing) { out.pin = existing.pin; out.pinHash = existing.pinHash; }
              else { delete out.pin; delete out.pinHash; }
            }
            if (!actingUserCanManageUsers) {
              out.role = existing ? existing.role : 'staff';
              out.perms = existing ? (existing.perms || {}) : {};
            }
            return out;
          });
        }
        // Same gap found in vendors above, also closed during the same
        // maintenance review: users had no union protection either, on top
        // of everything above (pin-preservation, the escalation guard) —
        // once past those, it still fell straight through to the blind
        // whole-array replace at the end of this handler. A device with a
        // stale local users list — most simply, one that just hadn't
        // pulled since a new teammate's account was added on someone
        // else's device — could silently erase that brand-new account by
        // pushing for any unrelated reason. Union-by-id, same as
        // customers/vendors: incoming's copy of a user wins field-by-field
        // where both sides have it (this is what actually carries the
        // pin-preservation and escalation-guard results above through),
        // and anyone the current push doesn't know about is preserved.
        if (Array.isArray(incoming.users)) {
          const mergedUsers = new Map((current.users || []).map(u => [u && u.id, u]));
          for (const u of incoming.users) {
            if (!u) continue;
            const existingUser = mergedUsers.get(u.id) || {};
            const merged = Object.assign({}, existingUser, u);
            // Deep-merge perms specifically, rather than letting the
            // shallow Object.assign above treat the whole perms object as
            // one opaque value. CONFIRMED live (Sep 2026): without this,
            // a permission checkbox change would get silently reverted
            // whenever ANY other session — even one that changed a
            // completely different permission, or wasn't editing
            // permissions at all — next pushed its own (by-then-stale)
            // copy of that user's full perms object. That push could
            // land minutes or hours later, well past the 8s same-tab
            // grace window elsewhere in this app, which is why this
            // looked like it "wiped itself out for no reason" rather than
            // an obvious immediate race. Merging key-by-key means each
            // individual permission is only ever overwritten by a push
            // that actually mentions that specific key.
            if (existingUser.perms || u.perms) {
              merged.perms = Object.assign({}, existingUser.perms || {}, u.perms || {});
            }
            mergedUsers.set(u.id, merged);
          }
          incoming.users = Array.from(mergedUsers.values());
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
            // A device's copy may predate its P.O. number — never let that
            // erase (or change) the number the server already gave it.
            mergedOrders.set(o.id, (existing && existing.poNumber) ? Object.assign({}, o, { poNumber: existing.poNumber }) : o);
          }
          for (const id of orderTombstoned) mergedOrders.delete(id);
          incoming.orders = Array.from(mergedOrders.values());
          // Number any order that arrived this way without one.
          {
            const tmp = { orders: incoming.orders.map(o => (o && !o.poNumber) ? Object.assign({}, o) : o), poCounter: current.poCounter };
            if (_ensurePoNumbers(tmp)) { incoming.orders = tmp.orders; incoming.poCounter = tmp.poCounter; }
          }
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
        // Vendors — found during a maintenance review (Sep 2026) to have had
        // NO merge protection at all, unlike customers/drivers right above
        // (which both get a proper union). A push here fell straight through
        // to the generic Object.assign(current, incoming) at the very end of
        // this handler, which is a blind whole-array REPLACE — worse than
        // customers' old bug even, since that one was at least a union, just
        // missing a timestamp. Any device with a stale local vendors list
        // (hadn't synced recently, or synced a partial page) could silently
        // wipe out vendors that only existed in a fresher copy on the
        // server, just by pushing for any unrelated reason. Same union-by-id
        // fix as customers above: incoming's copy of a vendor wins
        // field-by-field where both sides have it, and any vendor the
        // current push doesn't know about (added/synced on another device)
        // is preserved rather than dropped.
        if (Array.isArray(incoming.vendors)) {
          const mergedVendors = new Map((current.vendors || []).map(v => [v && v.id, v]));
          for (const v of incoming.vendors) {
            if (!v) continue;
            mergedVendors.set(v.id, Object.assign({}, mergedVendors.get(v.id) || {}, v));
          }
          incoming.vendors = Array.from(mergedVendors.values());
        }
        // Same gap, same fix, found for two more during the same review:
        // storages (physical locations — coolers, freezers, dry racks) and
        // savedReports both had no merge protection either, for the exact
        // same reason and with the exact same risk — a stale device could
        // silently erase a location or report someone else just added.
        if (Array.isArray(incoming.storages)) {
          const mergedStorages = new Map((current.storages || []).map(s => [s && s.id, s]));
          for (const s of incoming.storages) {
            if (!s) continue;
            mergedStorages.set(s.id, Object.assign({}, mergedStorages.get(s.id) || {}, s));
          }
          incoming.storages = Array.from(mergedStorages.values());
        }
        if (Array.isArray(incoming.savedReports)) {
          const mergedReports = new Map((current.savedReports || []).map(r => [r && r.id, r]));
          for (const r of incoming.savedReports) {
            if (!r) continue;
            mergedReports.set(r.id, Object.assign({}, mergedReports.get(r.id) || {}, r));
          }
          incoming.savedReports = Array.from(mergedReports.values());
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
          for (let c of incoming.customers) {
            if (!c) continue;
            if (isRecentlyDeletedCustomerId(c.id)) continue; // just deleted — a stale in-flight push can't resurrect it
            // Never let a damaged name overwrite a good one already stored
            // (e.g. one the repair just restored from QuickBooks).
            const prev = merged.get(c.id);
            if (prev && _isBrokenName(c.name) && typeof prev.name === 'string' && !_isBrokenName(prev.name)) {
              c = Object.assign({}, c, { name: prev.name });
            }
            merged.set(c.id, Object.assign({}, prev || {}, c));
          }
          for (const id of _recentlyDeletedCustomerIds.keys()) { merged.delete(id); }
          incoming.customers = Array.from(merged.values());
        }
        // labelAllowed is likewise now a per-department object (each
        // department has its own product allow-list for printing) — same
        // merge-not-replace reasoning as labelTemplates directly above.
        if (incoming.labelAllowed && typeof incoming.labelAllowed === 'object' && !Array.isArray(incoming.labelAllowed)) {
          incoming.labelAllowed = Object.assign({}, (current.labelAllowed && typeof current.labelAllowed === 'object' && !Array.isArray(current.labelAllowed)) ? current.labelAllowed : {}, incoming.labelAllowed);
        }
        // customerAllowed is likewise a per-department object (each
        // department has its own customer allow-list for the Scale Log
        // picker) — same shape, same race as labelAllowed directly above,
        // but this one was missing the equivalent merge-not-replace fix.
        // CONFIRMED: every routine full-snapshot push (see snapshotObj in
        // pushToServer, index.html) includes the pushing device's ENTIRE
        // customerAllowed object, and without this merge it fell straight
        // through to the blind `Object.assign({}, current, incoming)`
        // further down — so a stale device (e.g. a tab that's been open
        // since before another admin last edited a DIFFERENT department's
        // allow-list) would silently wipe out every other department's
        // list on its very next routine save, not just its own. This is
        // what was actually behind the permission matrix getting wiped.
        if (incoming.customerAllowed && typeof incoming.customerAllowed === 'object' && !Array.isArray(incoming.customerAllowed)) {
          incoming.customerAllowed = Object.assign({}, (current.customerAllowed && typeof current.customerAllowed === 'object' && !Array.isArray(current.customerAllowed)) ? current.customerAllowed : {}, incoming.customerAllowed);
        }
        // vendorDepartments ({vendorKey: dept}) — same shape, same routine
        // full-snapshot push (see snapshotObj in index.html), same missing
        // merge as customerAllowed above until now: a stale device's push
        // would silently overwrite every OTHER vendor's department
        // assignment along with its own. The dedicated single/bulk
        // endpoints above already read-modify-write safely on their own;
        // this is specifically about the generic ambient push path.
        if (incoming.vendorDepartments && typeof incoming.vendorDepartments === 'object' && !Array.isArray(incoming.vendorDepartments)) {
          incoming.vendorDepartments = Object.assign({}, (current.vendorDepartments && typeof current.vendorDepartments === 'object' && !Array.isArray(current.vendorDepartments)) ? current.vendorDepartments : {}, incoming.vendorDepartments);
        }
        // itemFilterPrefs ({userId: {active,kind}}) — same shape, same
        // routine full-snapshot push, same missing merge. The comment where
        // this field is defined (see DATA_DEFAULT above) already claimed
        // this got "the same push/pull merge as labelAllowed/customerAllowed
        // above" — it didn't; this closes that gap for real. Without it, a
        // stale device would silently reset every OTHER user's saved Items
        // page filter back to whatever this device happened to have (or
        // nothing, for a user it had never seen), not just its own.
        if (incoming.itemFilterPrefs && typeof incoming.itemFilterPrefs === 'object' && !Array.isArray(incoming.itemFilterPrefs)) {
          incoming.itemFilterPrefs = Object.assign({}, (current.itemFilterPrefs && typeof current.itemFilterPrefs === 'object' && !Array.isArray(current.itemFilterPrefs)) ? current.itemFilterPrefs : {}, incoming.itemFilterPrefs);
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
            // The bill-identity fields below (vendor, vendorId, docNum, due)
            // had NO freshness protection at all — Object.assign(curRec,
            // incRec, ...) let incRec's copy win unconditionally, on every
            // single push, forever, with no timestamp check of any kind
            // (unlike the split-level merge just above, which does protect
            // Paid status). These fields describe which bill this even IS —
            // set once, correctly, the moment a bill is first scheduled
            // (see _cfAddSplit), and have no legitimate reason to ever
            // change afterward. Locking them to curRec closes that gap
            // completely: nothing pushed later, stale or not, can ever
            // relabel an existing bill's vendor again. balance and
            // vendorBalanceAtSchedule are deliberately left OUT of that
            // lock — those two are meant to keep tracking QuickBooks' actual
            // current state (e.g. a partial payment recorded elsewhere),
            // not frozen at whatever they were the moment the bill was
            // first scheduled, so incRec's copy of those two still wins.
            const identityFields = { vendor: curRec.vendor, vendorId: curRec.vendorId, docNum: curRec.docNum, due: curRec.due };
            mergedCf[billId] = Object.assign({}, curRec, incRec, identityFields, { splits: Array.from(splitsById.values()) });
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
      // Normalized to uppercase here too (not just client-side in
      // _promptAddDriver) so this endpoint can't reintroduce the exact
      // case-variant duplicates ("Ibrahim Gungor" vs "IBRAHIM GUNGOR") that
      // used to split one driver's orders into two separate groups in the
      // Orders week summary — see _driverGroupKey() in index.html.
      const name = typeof body.name === 'string' ? body.name.trim().toUpperCase().slice(0, 100) : '';
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
      // Refuse to delete a driver still assigned to at least one order — the
      // Manage Drivers UI already checks this and steers the user to rename
      // (merge) instead, but this endpoint is re-checked here too so it's
      // safe against any other caller: deleting an in-use driver would leave
      // orders pointing at a name that's no longer in the picklist at all,
      // rather than just a case/whitespace variant of one that is.
      let blocked = false;
      await updateSharedData(async (current) => {
        const stillInUse = (Array.isArray(current.orders) ? current.orders : []).some(o => o && driverGroupKey(o.driver) === driverGroupKey(name));
        if (stillInUse) { blocked = true; return { data: current }; }
        const drivers = (Array.isArray(current.drivers) ? current.drivers : []).filter(d => d !== name);
        const deletedDrivers = Array.isArray(current.deletedDrivers) ? current.deletedDrivers.slice() : [];
        if (!deletedDrivers.includes(name)) deletedDrivers.push(name);
        const capped = deletedDrivers.length > 2000 ? deletedDrivers.slice(deletedDrivers.length - 2000) : deletedDrivers;
        return { data: Object.assign({}, current, { drivers, deletedDrivers: capped }) };
      });
      if (blocked) {
        res.writeHead(409, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Driver is still assigned to at least one order — rename it to merge into another driver, or reassign those orders first.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Renames a driver everywhere at once: the picklist entry AND every order
  // currently assigned to it. This is also how two case/whitespace-variant
  // duplicates (e.g. "Ibrahim Gungor" and "IBRAHIM GUNGOR") get merged into
  // one real entry — rename one to exactly match the other and their orders
  // combine under a single driver. See _driverGroupKey() in index.html for
  // the display-side half of this same bug.
  if (url === '/api/data/rename-driver' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const oldName = typeof body.oldName === 'string' ? body.oldName.trim() : '';
      const newName = typeof body.newName === 'string' ? body.newName.trim().toUpperCase().slice(0, 100) : '';
      if (!oldName || !newName) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'Missing oldName/newName' }));
        return;
      }
      let finalDrivers = [];
      let ordersUpdated = 0;
      await updateSharedData(async (current) => {
        const driverSet = new Set(Array.isArray(current.drivers) ? current.drivers : []);
        driverSet.delete(oldName);
        driverSet.add(newName);
        finalDrivers = Array.from(driverSet).sort();
        // Tombstone oldName (same as an explicit delete) so a stale device
        // that still has it cached locally can't resurrect it in the
        // picklist on its next routine sync push; un-tombstone newName in
        // case it was previously deleted.
        const deletedDrivers = (Array.isArray(current.deletedDrivers) ? current.deletedDrivers : []).filter(d => d !== newName);
        if (oldName !== newName && !deletedDrivers.includes(oldName)) deletedDrivers.push(oldName);
        const capped = deletedDrivers.length > 2000 ? deletedDrivers.slice(deletedDrivers.length - 2000) : deletedDrivers;
        const orders = (Array.isArray(current.orders) ? current.orders : []).map(o => {
          // Matches by NORMALIZED name (see driverGroupKey above), not an
          // exact string — so one rename sweeps up every case/whitespace
          // variant of oldName in one shot, instead of only the literal
          // string that happened to be typed into the picklist entry.
          if (o && driverGroupKey(o.driver) === driverGroupKey(oldName)) { ordersUpdated++; return Object.assign({}, o, { driver: newName }); }
          return o;
        });
        return { data: Object.assign({}, current, { drivers: finalDrivers, deletedDrivers: capped, orders }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, drivers: finalDrivers, ordersUpdated }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Estimates a driver's total round-trip mileage for one day's route: the
  // client resolves each stop's customer name to an address (from the
  // synced QuickBooks customer records) and sends the plain address list
  // here — this endpoint keeps the routing API key(s) server-side, never
  // exposed to the browser, and returns the total distance/time. Read-only
  // — never touches saved order data.
  // body.mode: 'truck' (default) uses Geoapify's truck-restricted routing
  // (see fetchDrivingRouteMiles); 'regular' uses Google's normal car
  // routing (see fetchGoogleDrivingRouteMiles) as a comparison number —
  // the gap between the two is the extra distance the truck-route
  // restrictions actually cost.
  if (url === '/api/data/driver-route-miles' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const body = JSON.parse(bodyStr || '{}');
      const addresses = Array.isArray(body.addresses) ? body.addresses.filter(a => typeof a === 'string' && a.trim()) : [];
      const mode = body.mode === 'regular' ? 'regular' : 'truck';
      if (!addresses.length) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
        res.end(JSON.stringify({ error: 'No stop addresses provided.' }));
        return;
      }
      const result = mode === 'regular' ? await fetchGoogleDrivingRouteMiles(addresses) : await fetchDrivingRouteMiles(addresses);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify(Object.assign({ success: true, stopCount: addresses.length, mode }, result)));
    } catch (e) {
      const noKey = e.message === 'NO_API_KEY' || e.message === 'NO_GOOGLE_KEY';
      const keyName = e.message === 'NO_GOOGLE_KEY' ? 'GOOGLE_MAPS_API_KEY' : 'GEOAPIFY_API_KEY';
      res.writeHead(noKey ? 501 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: noKey ? ('No ' + (keyName === 'GOOGLE_MAPS_API_KEY' ? 'Google Maps' : 'Geoapify') + ' API key is configured on the server yet (' + keyName + ').') : e.message }));
    }
    return;
  }
  if (url === '/api/data/save-order' && req.method === 'POST') {
    const _orderSession = requireAuth(req, res);
    if (!_orderSession) return;
    const _who = String(_orderSession.name || _orderSession.email || 'Unknown user').slice(0, 80);
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
        const lines = rawLines.map(l => {
          const base = {
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
          };
          // Shortage-tracking fields are added ONLY when they actually carry
          // information, rather than unconditionally on every line. CONFIRMED
          // live (Sep 2026): writing all six of these on every single order
          // line — including the vast majority that were never a shortage —
          // was measurably bloating the full-data payload that every open
          // tab re-downloads and re-parses every 1.5s (the background sync
          // poll), to the point of contributing to browser tabs crashing
          // with Out of Memory after a few minutes open. A normal line now
          // costs nothing extra; only a line actually touched by the
          // shortage/reschedule flow carries the extra keys.
          if (l && l.shortage) base.shortage = true;
          if (l && l.shortageReschedule) base.shortageReschedule = true;
          if (l && l.rescheduledOrderId) base.rescheduledOrderId = String(l.rescheduledOrderId).trim().slice(0, 100);
          if (l && l.rescheduledToDate) base.rescheduledToDate = String(l.rescheduledToDate).slice(0, 10);
          if (l && l.rescheduledFromOrderId) base.rescheduledFromOrderId = String(l.rescheduledFromOrderId).trim().slice(0, 100);
          // Which line index (within the ORIGINAL order) this reschedule came
          // from — needed alongside rescheduledFromOrderId to identify the
          // exact line, since one order can have more than one shortage.
          // Used client-side as an idempotency check before creating another
          // reschedule for the same original line (see _rescheduleShortageLine).
          if (l && Number.isInteger(l.rescheduledFromLineIdx)) base.rescheduledFromLineIdx = l.rescheduledFromLineIdx;
          if (l && l.rescheduledFromDate) base.rescheduledFromDate = String(l.rescheduledFromDate).slice(0, 10);
          return base;
        }).filter(l => l.product || l.description || l.quantity);
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
          // Who added it never changes; legacy orders keep whatever they had.
          saved.createdBy = orders[idx].createdBy || '';
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
          // P.O. number: permanent — carried over (this endpoint rebuilds
          // the order from scratch, so any field not copied here is lost).
          saved.poNumber = orders[idx].poNumber || '';
          // Edit tracking (Nov 2026): who changed what, from the logged-in
          // account on the server — never taken from the browser. A save that
          // changes nothing (repeat/auto save) adds no history entry.
          saved.history = Array.isArray(orders[idx].history) ? orders[idx].history.slice(-29) : [];
          saved.editedBy = orders[idx].editedBy || '';
          saved.editedAt = orders[idx].editedAt || '';
          // Weights are never erased by a stale copy (Nov 2026): a device
          // holding an older copy of this order (e.g. "Match with QuickBooks"
          // on a computer that hadn't yet received the weights a tablet just
          // entered) sends those lines with a blank weight, which used to wipe
          // them. Only the Count box itself may clear a weight — it marks its
          // saves with allowCountClear. Lines are matched by product +
          // description, each stored line used once.
          if (order.allowCountClear !== true && Array.isArray(saved.lines) && Array.isArray(orders[idx].lines)) {
            const k = l => String((l && l.product) || '').trim().toUpperCase() + '|' + String((l && l.description) || '').trim().toUpperCase();
            const usedPrev = new Set();
            saved.lines.forEach(nl => {
              if (!nl || String(nl.finalCount || '').trim() !== '') return;
              const pi = orders[idx].lines.findIndex((pl, i) => !usedPrev.has(i) && pl && k(pl) === k(nl) && String(pl.finalCount || '').trim() !== '');
              if (pi < 0) return;
              usedPrev.add(pi);
              const pl = orders[idx].lines[pi];
              nl.finalCount = pl.finalCount;
              if (pl.shortage) { nl.shortage = true; if (pl.rescheduledOrderId) nl.rescheduledOrderId = pl.rescheduledOrderId; if (pl.rescheduledToDate) nl.rescheduledToDate = pl.rescheduledToDate; }
            });
          }
          const what = _orderChangeSummary(orders[idx], saved);
          if (what.length) {
            saved.editedBy = _who;
            saved.editedAt = new Date().toISOString();
            saved.history.push({ by: _who, at: saved.editedAt, what: what });
          }
          orders[idx] = saved;
        } else {
          saved.createdBy = _who; // the logged-in account, not the browser's claim
          saved.createdAt = new Date().toISOString();
          saved.history = [{ by: _who, at: saved.createdAt, what: ['Order added'] }];
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
        const next = Object.assign({}, current, { orders, deletedOrderIds: tombstones });
        if (!saved.poNumber) saved.poNumber = _nextPoNumber(next); // new order (or one still unnumbered)
        return { data: next };
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

  // ===== Legal Documents =====
  if (url === '/api/legal-docs' && req.method === 'GET') {
    if (!requirePerm(req, res, 'viewLegal')) return;
    const list = await readLegalIndex();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ docs: list }));
    return;
  }
  if (url === '/api/legal-docs' && req.method === 'POST') {
    const session = requirePerm(req, res, 'viewLegal');
    if (!session) return;
    const sendErr = (code, msg) => { if (!res.headersSent) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); } };
    const fileName = legalHeader(req, 'x-file-name').replace(/[\\/\r\n]/g, '_').slice(0, 200);
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    if (!fileName || !LEGAL_ALLOWED_EXT.test(ext)) { req.resume(); return sendErr(400, 'File type not allowed. Use PDF, a photo (JPG/PNG/HEIC), Word, Excel, PowerPoint, CSV or TXT.'); }
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > LEGAL_MAX_BYTES) { req.resume(); return sendErr(413, 'File is larger than 25 MB.'); }
    const id = 'ld_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    try {
      await fs.promises.mkdir(LEGAL_DIR, { recursive: true });
      const dest = path.join(LEGAL_DIR, id);
      const tmp = dest + '.part';
      const size = await new Promise((resolve, reject) => {
        let n = 0, failed = false;
        const out = fs.createWriteStream(tmp);
        req.on('data', chunk => {
          n += chunk.length;
          if (n > LEGAL_MAX_BYTES && !failed) { failed = true; out.destroy(); req.destroy(); reject(new Error('TOO_BIG')); }
        });
        req.on('error', e => { if (!failed) { failed = true; reject(e); } });
        out.on('error', e => { if (!failed) { failed = true; reject(e); } });
        out.on('finish', () => { if (!failed) resolve(n); });
        req.pipe(out);
      }).catch(async e => { try { await fs.promises.unlink(tmp); } catch (x) { /* nothing to clean */ } throw e; });
      if (!size) { await fs.promises.unlink(tmp).catch(() => {}); return sendErr(400, 'The file was empty.'); }
      await fs.promises.rename(tmp, dest);
      const expires = legalHeader(req, 'x-doc-expires');
      const doc = {
        id: id,
        title: legalHeader(req, 'x-doc-title').slice(0, 200) || fileName.replace(/\.[^.]+$/, ''),
        category: legalHeader(req, 'x-doc-category').slice(0, 60) || 'Other',
        folder: legalHeader(req, 'x-doc-folder').replace(/\s+/g, ' ').slice(0, 120),
        // Several files uploaded together share one groupId and show as ONE
        // entry (one subject, many attachments). The browser makes the id.
        groupId: /^g_[a-z0-9]{6,40}$/.test(legalHeader(req, 'x-doc-group')) ? legalHeader(req, 'x-doc-group') : 'g_' + id.slice(3),
        expires: /^\d{4}-\d{2}-\d{2}$/.test(expires) ? expires : '',
        notes: legalHeader(req, 'x-doc-notes').slice(0, 500),
        fileName: fileName, ext: ext, size: size,
        uploadedAt: new Date().toISOString(),
        uploadedBy: session.name || session.email || 'Unknown'
      };
      await withLegalLock(async () => { const list = await readLegalIndex(); list.push(doc); await writeLegalIndex(list); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, doc: doc }));
    } catch (e) {
      if (e.message === 'TOO_BIG') return sendErr(413, 'File is larger than 25 MB.');
      console.error('Legal doc upload failed:', e.message);
      sendErr(500, 'Upload failed: ' + e.message);
    }
    return;
  }
  if (url.startsWith('/api/legal-docs/') && url.endsWith('/file') && req.method === 'GET') {
    if (!requirePerm(req, res, 'viewLegal')) return;
    const id = url.slice('/api/legal-docs/'.length, -'/file'.length);
    const doc = /^ld_[a-z0-9]+$/.test(id) ? (await readLegalIndex()).find(d => d.id === id) : null;
    if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Document not found.' })); return; }
    const inlineType = LEGAL_INLINE_TYPES[doc.ext];
    const wantDownload = queryParams.download === '1' || !inlineType;
    const safeName = doc.fileName.replace(/["\\]/g, '_');
    res.writeHead(200, {
      'Content-Type': inlineType && !wantDownload ? inlineType : 'application/octet-stream',
      'Content-Disposition': (wantDownload ? 'attachment' : 'inline') + '; filename="' + safeName.replace(/[^\x20-\x7e]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(doc.fileName),
      'Cache-Control': 'private, no-store'
    });
    fs.createReadStream(path.join(LEGAL_DIR, doc.id)).on('error', () => res.end()).pipe(res);
    return;
  }
  // Whole-entry edit / delete (every attachment in the group) — admin only.
  if (url.startsWith('/api/legal-docs/group/') && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const session = requireAdmin(req, res);
    if (!session) return;
    const gid = url.slice('/api/legal-docs/group/'.length);
    let body = {};
    if (req.method === 'PATCH') { try { body = JSON.parse(await readRequestBody(req) || '{}'); } catch (e) { /* empty */ } }
    let touched = [];
    await withLegalLock(async () => {
      const list = await readLegalIndex();
      const members = list.filter(d => (d.groupId || ('g_' + d.id.slice(3))) === gid);
      if (!members.length) return;
      if (req.method === 'DELETE') {
        touched = members;
        await writeLegalIndex(list.filter(d => members.indexOf(d) < 0));
        return;
      }
      members.forEach(doc => {
        if (typeof body.title === 'string' && body.title.trim()) doc.title = body.title.trim().slice(0, 200);
        if (typeof body.folder === 'string') doc.folder = body.folder.replace(/\s+/g, ' ').trim().slice(0, 120);
        if (typeof body.category === 'string' && body.category.trim()) doc.category = body.category.trim().slice(0, 60);
        if (typeof body.expires === 'string') doc.expires = /^\d{4}-\d{2}-\d{2}$/.test(body.expires) ? body.expires : '';
        if (typeof body.notes === 'string') doc.notes = body.notes.trim().slice(0, 500);
      });
      touched = members;
      await writeLegalIndex(list);
    });
    if (!touched.length) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Entry not found.' })); return; }
    if (req.method === 'DELETE') {
      for (const d of touched) { try { await fs.promises.unlink(path.join(LEGAL_DIR, d.id)); } catch (e) { /* already gone */ } }
      console.log('Legal entry deleted by ' + (session.name || session.email) + ': ' + touched[0].title + ' (' + touched.length + ' file(s))');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, docs: req.method === 'PATCH' ? touched : [] }));
    return;
  }
  // Edit a document's details / move it to another folder — admin only,
  // same as delete (uploading stays open to everyone with the tab).
  if (url.startsWith('/api/legal-docs/') && req.method === 'PATCH') {
    if (!requireAdmin(req, res)) return;
    const id = url.slice('/api/legal-docs/'.length);
    let body = {};
    try { body = JSON.parse(await readRequestBody(req) || '{}'); } catch (e) { /* treated as empty */ }
    let updated = null;
    await withLegalLock(async () => {
      const list = await readLegalIndex();
      const doc = list.find(d => d.id === id);
      if (!doc) return;
      if (typeof body.title === 'string' && body.title.trim()) doc.title = body.title.trim().slice(0, 200);
      if (typeof body.folder === 'string') doc.folder = body.folder.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (typeof body.category === 'string' && body.category.trim()) doc.category = body.category.trim().slice(0, 60);
      if (typeof body.expires === 'string') doc.expires = /^\d{4}-\d{2}-\d{2}$/.test(body.expires) ? body.expires : '';
      if (typeof body.notes === 'string') doc.notes = body.notes.trim().slice(0, 500);
      await writeLegalIndex(list);
      updated = doc;
    });
    if (!updated) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Document not found.' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, doc: updated }));
    return;
  }
  if (url.startsWith('/api/legal-docs/') && req.method === 'DELETE') {
    const session = requireAdmin(req, res); // uploading is open to everyone with the tab; deleting is admin-only
    if (!session) return;
    const id = url.slice('/api/legal-docs/'.length);
    let removed = null;
    await withLegalLock(async () => {
      const list = await readLegalIndex();
      const ix = list.findIndex(d => d.id === id);
      if (ix < 0) return;
      removed = list.splice(ix, 1)[0];
      await writeLegalIndex(list);
    });
    if (!removed) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Document not found.' })); return; }
    try { await fs.promises.unlink(path.join(LEGAL_DIR, removed.id)); } catch (e) { /* already gone */ }
    console.log('Legal document deleted by ' + (session.name || session.email) + ': ' + removed.title + ' (' + removed.fileName + ')');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ===== Off-site backups to Google Drive (admin only) =====
  if (url === '/api/gdrive/status' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const payload = gdriveStatusPayload();
    if (payload.connected && queryParams.list === '1') {
      try {
        const folderId = gdriveState.folderId;
        payload.recent = folderId ? (await gdriveListBackups(folderId)).slice(0, 10) : [];
      } catch (e) { payload.listError = e.message; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify(payload));
    return;
  }
  if (url === '/api/gdrive/backup-now' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const result = await runGDriveBackup('manual');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ success: true, fileName: result.fileName, size: result.size }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === '/api/gdrive/disconnect' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const tokenToRevoke = gdriveState.refreshToken;
    gdriveState.refreshToken = '';
    gdriveState.email = '';
    gdriveState.folderId = ''; // reconnecting creates a fresh folder — drive.file can't see the old one from a new grant anyway
    _gdriveAccessToken = '';
    _gdriveAccessTokenExpires = 0;
    saveGDriveState();
    if (tokenToRevoke) {
      gdriveFetch('POST', 'https://oauth2.googleapis.com/revoke', { auth: false, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: querystring.stringify({ token: tokenToRevoke }) })
        .catch(() => { /* best-effort */ });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  // Step 1 of connecting: send the admin to Google's sign-in/consent page.
  if (url === '/gdrive/connect' && req.method === 'GET') {
    const session = requireAdmin(req, res);
    if (!session) return;
    if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET || !GDRIVE_REDIRECT_URI) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(gdriveHtmlPage('Google Drive not set up yet', 'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET need to be added to the Render environment first.', false));
      return;
    }
    const state = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    for (const [k, v] of _gdriveOAuthStates.entries()) if (v.expires < now) _gdriveOAuthStates.delete(k);
    _gdriveOAuthStates.set(state, { userId: session.userId, expires: now + 10 * 60 * 1000 });
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + querystring.stringify({
      client_id: GDRIVE_CLIENT_ID, redirect_uri: GDRIVE_REDIRECT_URI, response_type: 'code',
      scope: GDRIVE_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: state
    });
    res.writeHead(302, { 'Location': authUrl });
    res.end();
    return;
  }
  // Step 2: Google sends the admin back here with a one-time code.
  if (url === '/gdrive/callback' && req.method === 'GET') {
    const session = requireAdmin(req, res);
    if (!session) return;
    const sendPage = (status, title, msg, ok) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(gdriveHtmlPage(title, msg, ok)); };
    const st = _gdriveOAuthStates.get(String(queryParams.state || ''));
    _gdriveOAuthStates.delete(String(queryParams.state || ''));
    if (!st || st.expires < Date.now() || st.userId !== session.userId) return sendPage(400, 'Connection expired', 'That sign-in link expired or did not start here. Go back to Settings and click Connect Google Drive again.', false);
    if (queryParams.error) return sendPage(400, 'Google Drive not connected', 'Google said: ' + queryParams.error, false);
    try {
      const r = await gdriveFetch('POST', 'https://oauth2.googleapis.com/token', {
        auth: false, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: querystring.stringify({ code: String(queryParams.code || ''), client_id: GDRIVE_CLIENT_ID, client_secret: GDRIVE_CLIENT_SECRET, redirect_uri: GDRIVE_REDIRECT_URI, grant_type: 'authorization_code' })
      });
      if (r.status !== 200 || !r.data || !r.data.access_token) throw new Error((r.data && (r.data.error_description || r.data.error)) || ('HTTP ' + r.status));
      if (!r.data.refresh_token) throw new Error('Google did not return a long-lived token. Remove "Plant Console" from your Google account\'s third-party access page and connect again.');
      let email = '';
      try { email = JSON.parse(Buffer.from(String(r.data.id_token || '').split('.')[1] || '', 'base64url').toString('utf8')).email || ''; } catch (e) { /* email is display-only */ }
      gdriveState.refreshToken = r.data.refresh_token;
      gdriveState.email = email;
      gdriveState.connectedAt = Date.now();
      gdriveState.folderId = '';
      gdriveState.lastError = '';
      _gdriveAccessToken = r.data.access_token;
      _gdriveAccessTokenExpires = Date.now() + (r.data.expires_in || 3600) * 1000;
      saveGDriveState();
      // First backup right away, so there's proof it works before tonight.
      runGDriveBackup('first').catch(() => { /* surfaced in the Settings panel */ });
      return sendPage(200, 'Google Drive connected', 'Backups will go to the "' + GDRIVE_FOLDER_NAME + '" folder in ' + (email || 'that Google account') + '\'s Drive. The first one is uploading now. Taking you back…', true);
    } catch (e) {
      return sendPage(500, 'Google Drive not connected', e.message, false);
    }
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

  // ----- Installable phone app (Oct 2026) ---------------------------------
  // Android installs a web app as a real home-screen app (own icon, full
  // screen, no browser bars) when the site offers a manifest FILE, proper
  // PNG icons and a service worker. The old manifest was embedded in the
  // HTML as a data: URL, which Chrome on Android won't install from.
  // Icons are embedded here so deploying stays two files.
  if (url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      id: '/',
      name: 'Plant Console',
      short_name: 'Plant Console',
      description: 'Leader Meat Packing — inventory, orders and operations',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: '#EFEDEA',
      theme_color: '#9E2B25',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    }));
    return;
  }
  if (APP_ICONS[url]) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(APP_ICONS[url]);
    return;
  }
  // Service worker: required for the install. It deliberately caches
  // NOTHING — every launch loads the latest deploy straight from the server
  // (stale copies were a real problem before; see the no-cache note on
  // index.html below). Its only extra job: a clear "No connection" screen
  // instead of a blank page when the phone is offline.
  if (url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.end(SERVICE_WORKER_JS);
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
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Vary': 'Accept-Encoding' };
      // Compressed when the browser accepts it (Oct 2026 audit) — the page is
      // mostly text and shrinks to a fraction for phones on mobile data. The
      // compressed copy is reused until the file changes (i.e. a redeploy).
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
        if (!_indexGz || _indexGz.len !== data.length) {
          _indexGz = { len: data.length, buf: zlib.gzipSync(data, { level: 9 }) };
        }
        res.writeHead(200, Object.assign(headers, { 'Content-Encoding': 'gzip', 'Content-Length': _indexGz.buf.length }));
        res.end(_indexGz.buf);
        return;
      }
      res.writeHead(200, headers);
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
    const session = requireAdmin(req, res); // connecting the company bank: admins only
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
    if (!requireAdmin(req, res)) return; // admins only
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
    // Live company bank balance: admins, or users given "View bank balance".
    if (!requirePerm(req, res, 'viewBankBalance')) return;
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
    if (!requireAdmin(req, res)) return; // admins only
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
      lastResult: _lastBackgroundSyncResult,
      items: {
        inFlight: !!_itemsSyncPromise,
        lastSyncAt: _lastItemsSyncRunAt || null,
        lastResult: _lastItemsSyncResult,
        incrementalSinceAt: _lastItemSyncAt || null
      },
      customers: {
        inFlight: !!_customersSyncPromise,
        lastSyncAt: _lastCustomersSyncRunAt || null,
        lastResult: _lastCustomersSyncResult,
        incrementalSinceAt: _lastCustomerSyncAt || null
      }
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

  // Diagnostic: look up ANY document type by its DocNumber and return the
  // raw QuickBooks JSON, unprocessed — visit directly in the browser, e.g.
  // /api/qb/inspect?entity=Bill&docNumber=2026-1013 . Built specifically to
  // let a non-technical person pull the exact raw line-item structure for
  // one troublesome document (rather than needing Intuit's own API
  // Explorer), when a dollar amount looks wrong in Plant Console and it's
  // not obvious why from the processed/transformed data alone.
  if (url.startsWith('/api/qb/inspect') && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    try {
      const entity = queryParams.entity || 'Bill';
      const docNumber = queryParams.docNumber;
      if (!docNumber) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Pass ?docNumber=X (and optionally &entity=Bill|Invoice|SalesReceipt|CreditMemo|VendorCredit)' })); return; }
      // Same fixed allow-list as /api/qb/documents — entity was previously
      // concatenated straight into `FROM ${entity}` with no validation at
      // all, unlike its sibling endpoint. A GET request from any
      // authenticated user (any role) could set entity to arbitrary QBO
      // query syntax.
      const QB_INSPECT_ENTITIES = ['Bill', 'Invoice', 'SalesReceipt', 'CreditMemo', 'VendorCredit', 'Payment', 'Vendor', 'JournalEntry', 'Account', 'Deposit'];
      if (QB_INSPECT_ENTITIES.indexOf(entity) < 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported entity. Use one of: ' + QB_INSPECT_ENTITIES.join(', ') }));
        return;
      }
      await ensureFreshToken();
      // QBO's query grammar escapes a literal single quote inside a string
      // literal by DOUBLING it (standard SQL-92 string escaping), not by
      // backslash-escaping — the previous `.replace(/'/g, "\\'")` left a
      // literal backslash followed by an UNESCAPED quote, which still
      // terminates the string literal early in QBO's parser. Doubling is
      // the actual fix, not just cosmetic: a docNumber containing a quote
      // could otherwise inject arbitrary query syntax.
      const query = `SELECT * FROM ${entity} WHERE DocNumber = '${docNumber.replace(/'/g, "''")}'`;
      const reqPath = `/v3/company/${activeRealm}/query?query=${encodeURIComponent(query)}&minorversion=75`;
      const qres = await httpsRequest({
        hostname: 'quickbooks.api.intuit.com',
        path: reqPath,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
      });
      if (qres.status !== 200) { res.writeHead(qres.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'QB API error ' + qres.status, body: qres.body })); return; }
      const parsed = JSON.parse(qres.body);
      const rows = (parsed.QueryResponse && parsed.QueryResponse[entity]) || [];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ found: rows.length, results: rows }, null, 2));
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
  // ----- Checks tab: bank "cleared" status (Oct 2026) -----------------------
  // The Deposit / Payment entities themselves don't say whether the bank has
  // actually cleared them — that flag (the "C" / "R" you see in a QuickBooks
  // register, set by a bank-feed match or a reconciliation) is only exposed
  // through the TransactionList report's `cleared` filter. This asks that
  // report three times per transaction type (Cleared, Reconciled, Uncleared)
  // and returns just the transaction ids in each bucket.
  //
  // `reliable` is a sanity check: if QuickBooks ever ignored the filter, the
  // same id would come back in both the Cleared and Uncleared lists — in
  // that case the frontend falls back to a days-since-deposit estimate and
  // labels it as an estimate, instead of trusting bad data.
  if (url === '/api/qb/cleared-status' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const from = String(queryParams.from || '');
    if (!isValidQbDateParam(from)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'from=YYYY-MM-DD required' }));
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const collectIds = (rows, typeLabel, out) => {
      (rows || []).forEach(r => {
        if (r.Rows && r.Rows.Row) collectIds(r.Rows.Row, typeLabel, out);
        (r.ColData || []).forEach(c => { if (c && c.id && c.value === typeLabel) out.add(String(c.id)); });
      });
    };
    const runReport = async (txnType, cleared, retry) => {
      if (!retry) await ensureFreshToken();
      const qs = querystring.stringify({ start_date: from, end_date: today, transaction_type: txnType, cleared: cleared, minorversion: 75 });
      const r = await httpsRequest({
        hostname: 'quickbooks.api.intuit.com',
        path: `/v3/company/${activeRealm}/reports/TransactionList?${qs}`,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
      });
      if (r.status === 401) {
        if (!retry && await refreshAccessToken()) return runReport(txnType, cleared, true);
        throw new Error('NEEDS_RECONNECT');
      }
      if (r.status !== 200) throw new Error('QB report error ' + r.status + ': ' + r.body.slice(0, 300));
      const data = JSON.parse(r.body);
      // In the report, a Deposit row's type cell reads "Deposit", a Payment
      // row's reads "Payment" — that cell's `id` is the transaction id.
      const label = txnType === 'ReceivePayment' ? 'Payment' : txnType;
      const ids = new Set();
      collectIds((data.Rows && data.Rows.Row) || [], label, ids);
      return ids;
    };
    try {
      if (!accessToken) await refreshAccessToken();
      const out = { from: from, reliable: true, deposits: {}, payments: {} };
      for (const [txnType, key] of [['Deposit', 'deposits'], ['ReceivePayment', 'payments']]) {
        const cleared = await runReport(txnType, 'Cleared');
        const reconciled = await runReport(txnType, 'Reconciled');
        const uncleared = await runReport(txnType, 'Uncleared');
        for (const id of cleared) { if (uncleared.has(id)) out.reliable = false; out[key][id] = 'Cleared'; }
        for (const id of reconciled) { if (uncleared.has(id)) out.reliable = false; out[key][id] = 'Reconciled'; }
        out[key + 'UnclearedCount'] = uncleared.size;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify(out));
    } catch (err) {
      const needsReconnect = err.message === 'NEEDS_RECONNECT';
      res.writeHead(needsReconnect ? 401 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({ error: err.message, needsReconnect: needsReconnect }));
    }
    return;
  }

  if (url === '/api/qb/documents') {
    if (!requireAuth(req, res)) return;
    try {
      const ent = queryParams.entity;
      const since = queryParams.since || null;
      const from = queryParams.from || null;
      const to = queryParams.to || null;
      const startPos = queryParams.startposition ? parseInt(queryParams.startposition, 10) : null;
      // InventoryAdjustment added Sep 2026: the transaction sync has always asked
      // for it (and knows how to turn its lines into adjustment transactions),
      // but it was missing from this allow-list, so every request was refused
      // and QuickBooks "Inventory Adjust" entries never reached the app.
      if (ent && ['Bill','Invoice','SalesReceipt','CreditMemo','VendorCredit','InventoryAdjustment','Payment','Vendor','JournalEntry','Account','Deposit','PaymentMethod'].indexOf(ent) >= 0) {
        if (!accessToken) await refreshAccessToken();
        // Single-page mode: return just one page so each HTTP request is fast.
        if (startPos !== null && !isNaN(startPos)) {
          const openOnly = queryParams.open === '1';
          const data = await fetchQBEntityPage(ent, startPos, false, since, from, to, openOnly);
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

  // Memory diagnostics — reports what Node's own process is ACTUALLY using
  // right now (not an estimate from the browser side), plus how large the
  // underlying data actually is. Added specifically to find out whether
  // repeated OOM crashes (Sep 2026 — crashed at ~255MB, then ~350MB, then
  // ~460MB, then ~1792MB, each time right against whatever heap ceiling
  // was set) are a genuine, continuously-growing memory problem — the
  // transactions array (every movement record from years of synced
  // QuickBooks history, all held in memory at once, nothing currently
  // archives or prunes it) is the leading suspect — or something else.
  // Lightweight version of the memory diagnostic above — ONLY reads file
  // SIZES from the filesystem (fs.statSync), never loads or parses their
  // actual contents into memory. Added because the full diagnostic above
  // calls readItemsTxnData()/readSharedData(), which DOES parse the whole
  // file — if that file has grown large enough to be the actual problem,
  // the full diagnostic could itself be slow or risky to call while the
  // server is already under memory pressure or mid crash-loop. This one
  // works regardless, since it never touches the file's contents at all.
  if (url === '/api/diagnostics/filesizes') {
    if (!requireAuth(req, res)) return;
    try {
      const mb = (bytes) => Math.round(bytes / 1024 / 1024 * 10) / 10;
      let itemsTxnFileSize = null;
      try { itemsTxnFileSize = fs.statSync(ITEMS_TXN_FILE).size; } catch (e) { /* file may not exist yet */ }
      let mainFileSize = null;
      try { mainFileSize = fs.statSync(DATA_FILE).size; } catch (e) { /* file may not exist yet */ }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({
        processMemoryMB: { rss: mb(process.memoryUsage().rss) },
        uptimeMinutes: Math.round(process.uptime() / 60),
        fileSizesMB: {
          itemsTransactionsFile: itemsTxnFileSize != null ? mb(itemsTxnFileSize) : null,
          mainDataFile: mainFileSize != null ? mb(mainFileSize) : null
        }
      }, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url === '/api/diagnostics/memory') {
    if (!requireAuth(req, res)) return;
    try {
      const mem = process.memoryUsage();
      const itemsTxn = await readItemsTxnData();
      const mainData = await readSharedData();
      const mb = (bytes) => Math.round(bytes / 1024 / 1024 * 10) / 10;
      let itemsTxnFileSize = null;
      try { itemsTxnFileSize = fs.statSync(ITEMS_TXN_FILE).size; } catch (e) { /* file may not exist yet */ }
      let mainFileSize = null;
      try { mainFileSize = fs.statSync(DATA_FILE).size; } catch (e) { /* file may not exist yet */ }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(JSON.stringify({
        processMemoryMB: {
          rss: mb(mem.rss), // total memory the OS has actually allocated to this process — the number that matters for an OOM kill
          heapUsed: mb(mem.heapUsed),
          heapTotal: mb(mem.heapTotal),
          external: mb(mem.external),
          arrayBuffers: mb(mem.arrayBuffers)
        },
        uptimeMinutes: Math.round(process.uptime() / 60),
        dataCounts: {
          items: (itemsTxn.items || []).length,
          transactions: (itemsTxn.transactions || []).length,
          orders: (mainData.orders || []).length,
          scaleLogs: (mainData.scaleLogs || []).length,
          customers: (mainData.customers || []).length,
          vendors: (mainData.vendors || []).length
        },
        fileSizesMB: {
          itemsTransactionsFile: itemsTxnFileSize != null ? mb(itemsTxnFileSize) : null,
          mainDataFile: mainFileSize != null ? mb(mainFileSize) : null
        }
      }, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
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
  await migrateItemsTxnIfNeeded();
  await migrateLegalGroups().catch(e => console.error('Legal group migration failed:', e.message)); // one-time: move any existing items/transactions out of the old combined file before anything tries to read either store
  server.listen(PORT, () => {
    console.log('Plant Console running on port ' + PORT);
    // Apply the (possibly just-lowered) BACKUP_KEEP_MAX to whatever's already
    // on disk right away, instead of waiting for the next backup to be taken
    // (which could be up to an hour away) to trim down existing excess files.
    pruneOldBackups().catch(e => console.error('Could not prune old backups on startup:', e.message));
    // Off-site Google Drive backups — see runGDriveBackup(). First check 1 min
    // after boot (lets startup work settle), then every 10 minutes.
    setTimeout(gdriveSchedulerTick, 60 * 1000);
    setInterval(gdriveSchedulerTick, 10 * 60 * 1000);
    // Repeated OOM crashes (Sep 2026) at wildly varying times-since-restart
    // (2.5 min once, 7 min another) but always right at whatever the heap
    // ceiling happened to be set to — and confirmed NOT caused by the data
    // files themselves being too large (16MB + 23MB on disk, nowhere near
    // enough to explain a multi-GB crash on their own). That pattern points
    // to something accumulating continuously during normal operation rather
    // than a one-time startup cost — but reading through the request
    // handlers and the periodic background sync hasn't turned up an
    // obvious culprit. This logs actual RSS every 60s so the NEXT crash's
    // logs show the full memory timeline leading up to it (smooth climb?
    // a sudden jump? does it correlate with the 30-min background sync
    // firing?) instead of just the single final number V8 reports right
    // as it dies.
    setInterval(() => {
      var mem = process.memoryUsage();
      console.log('[memcheck] uptime=' + Math.round(process.uptime()) + 's rss=' + Math.round(mem.rss / 1024 / 1024) + 'MB heapUsed=' + Math.round(mem.heapUsed / 1024 / 1024) + 'MB external=' + Math.round(mem.external / 1024 / 1024) + 'MB');
    }, 60000);
    // First background Vendors sync shortly after boot (not immediately —
    // give the server a moment to finish settling first), then on the
    // regular (slower) interval after that. Customers used to share this
    // cycle too — see runCustomersBackgroundSync below for why it moved to
    // its own faster, incremental one.
    setTimeout(() => {
      console.log('[memcheck] background sync starting, rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB');
      runBackgroundSync()
        .then(() => console.log('[memcheck] background sync finished, rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB'))
        .catch(e => console.error('Background sync error:', e.message));
    }, 15000);
    setInterval(() => { runBackgroundSync().catch(e => console.error('Background sync error:', e.message)); }, BACKGROUND_SYNC_INTERVAL_MS);
    // Proactive sweep for _recentlyDeletedCustomerIds — isRecentlyDeletedCustomerId
    // already expires entries lazily when checked, but an id that's never
    // referenced again after its 30s window would otherwise sit in memory
    // forever. Cheap, infrequent sweep instead.
    setInterval(() => {
      const now = Date.now();
      for (const [id, exp] of _recentlyDeletedCustomerIds) { if (now > exp) _recentlyDeletedCustomerIds.delete(id); }
    }, 5 * 60 * 1000);
    // Items: first run shortly after boot (staggered a bit later than the
    // customers/vendors one above, so they don't both fire in the same
    // instant), then every ITEMS_SYNC_INTERVAL_MS after that — the FIRST
    // run is always a full catalog pull (no _lastItemSyncAt yet), every
    // run after that is incremental (see backgroundSyncItems).
    setTimeout(() => {
      console.log('[memcheck] items sync starting, rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB');
      runItemsBackgroundSync()
        .then(() => console.log('[memcheck] items sync finished, rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB'))
        .catch(e => console.error('Items background sync error:', e.message));
    }, 20000);
    setInterval(() => { runItemsBackgroundSync().catch(e => console.error('Items background sync error:', e.message)); }, ITEMS_SYNC_INTERVAL_MS);
    // Customers: same treatment as Items just above (own independent,
    // incremental cycle on the same ITEMS_SYNC_INTERVAL_MS cadence) —
    // staggered a bit later still so the three startup syncs (vendors,
    // items, customers) don't all fire in the same instant. The FIRST run
    // is always a full catalog pull (no _lastCustomerSyncAt yet), every
    // run after that is incremental (see backgroundSyncCustomers).
    setTimeout(() => {
      console.log('[memcheck] customers sync starting, rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB');
      runCustomersBackgroundSync()
        .then(() => console.log('[memcheck] customers sync finished, rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB'))
        .catch(e => console.error('Customers background sync error:', e.message));
    }, 25000);
    setInterval(() => { runCustomersBackgroundSync().catch(e => console.error('Customers background sync error:', e.message)); }, ITEMS_SYNC_INTERVAL_MS);
  });
})();
