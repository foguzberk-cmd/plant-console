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
// Customer portal app icons (Nov 2026): the Leader Meat bull, for the
// installable portal app (home-screen icon on Android and iPhone).
const PORTAL_ICONS = {"icon-192.png": "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", "icon-512.png": "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", "icon-maskable-512.png": "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w4ePHz8+KiqqadOmzj/CZDLFxcVt3rx527ZtycnJjpba7vwqlap///6TJ08eN25ceHh4pX/CjRs39uzZs3Xr1piYGF6N6kRpVCqVxWJZv379lClTSPwwDAAEADREKD6zffv28ePHy60/ZVnl/jhjLDw8fNSoUQ888MDgwYN5cx6aDfDJASkKudVkf3m9TVFR0cGDBzds2PD777+np6dzc8znE926dRs/fvzEiRMjIyPpFZvNZrPZSCFIrvj57f6LMZaWlrZ3715SgtzcXK40giBYrVb+V6jVarPZ/Mgjj6xZs4Z2vsQwABAA0EAFQKVSzZw584cfflCr1aQHgiCYzWauBN27dx81atS4ceN69+7NY/12dp877zysJLfapATc187Ly9u5c+fGjRv37dtXUFAQGho6bty4CRMmREVFaTQaJWewWCykT9zNl8f0s7Ky9u/fHx0dvXfv3lu3bsnnBPSsWa3WZs2aXbp0SR62AgACABpc/OfWrVtdu3bNyclRqVS0zRaZy8jIyDFjxjzwwAMRERFywXBi93NyctLS0rp3716R/253fHJycmJi4r333iufT8hNueMcIiUlpXPnzvwAOp6gxAPlkLkSxMTEbN++fe/evZmZmfxPU6vVRqPxxx9/nD59OqJAAAIAGiJk+37++efp06fTKxqNpl+/fuPGjbv//vt79eql3O7v379/y5YtMTExWVlZvXv3njhx4vjx4zt16iS34/R2rgRyQy8/P1cOub8fFxe3bt26nTt3pqWldevWbdy4cWPHjo2MjOTX4HiF8vPn5eXt379/8+bN+/fvv3HjBr34wAMPbN26lSQKgwFAAECDmwFIkjR48OCEhISoqKgxY8aMHj26ffv2coUgk1qu3c/Ly4uJiYmOjt6zZ09GRobdyT08PIYMGTJx4sQxY8a0bduWm2lu5R2FgZU1peC/Hj58ePPmzTt27OB1RHK6du06duzY8ePH9+3bl8eOnGtVXl7en3/+GR0dvXv37vT09AsXLnTs2BEaACAAoCHGf/Ly8qKjo4cOHdquXTv+OjfT5XrTt27diomJ2bJly/79+3kul+daWVkCmZeTent7jxgx4uGHHx4xYkTz5s2VXNu5c+e2b9++cePGY8eO0SuiKFKOmof75VVJXbt2HTVq1MSJE/v166dQCQoKCn777bd77rknMjISAgAgAKCh6wHZfTKFjpnVmzdv7tu3Lzo6et++fXaZ1XKrLfl7uRK0aNEiKipq6dKl7dq1c7S5JDNbt2795JNPjhw5wtu9qdVqigg5XrNjfWrnzp3HjBkzduzYAQMG8LyCPGPsqAQAQABAw0Wedy23ombfvn2bN2/+888/s7KyuL/PnK63clQCtVptMBhGjhy5YcMGHx8f+fSCbDEJwIkTJ4YNG1ZcXOzh4UGrfJX8CY5KcM8994wdO3bs2LGDBw+mDeXLnRPIo08AQABAQ8Sxpv769et79+6Njo6Oi4vLzs52w+7LodL7wYMH79u3T6PR8M28eMqXy48oiqdPnx42bFhBQQG1mnDpg+hPsNlsfG1BaGjo6NGjJ02aNGjQoHLXLuDbBxAAABhj7MaNG7t27dqyZUtsbCxfVeu23Sdo5W379u1jY2MDAgLIytO/qampa9eunT9/Pl+QRYVJO3fu/Mc//kGNidz70HJXL48ePXrcuHGDBw+u3t3KAIAAgDsSSZKMRmN2dvaOHTu2bNly6NChwsLCarH73BBbrdbg4OCYmJj27duToSezbjKZ/vGPf+zbt++zzz574YUXeD0+/bBq1apZs2ZRAqCKF2A3J2jTps3w4cMnTpw4aNCgJk2aIP0L6v4hBKD2oTYPu3bt0mq18nANde4UqgyliH19fY8cOcI/jnp8SpI0efJkxhi1+Vy9erUkSbTTL/9h0aJFrGxfgWq5GI1GI8/9du/ePTc3l8JfGAygrlAtXLgQKghqH3KN27VrZzab//zzT51Ox61hNUxsy9K8mzdvHjp0KHfwrVarWq1+/vnnf/zxR2o+Korili1bevfu3bFjR77ywGq1DhkypLS0NDY2VqPRVL13v7yfhEql0ul0q1ev7ty5My1EwGAAmAGAhgg1SnvuuecYY1qttlrcbSr7YYytWrVK7tqbTCZJkpYsWSJ37Wmi4OPjc+rUKceJwrRp06pxHsAvbM2aNfxvB6AOgQCAuoRMrcViGT9+fHWZWlqNtXjxYsfAzldffUWBJnmUiYxyq1atrly5ItcAq9VqMBiGDx9eXRdGH/TFF1/ILwwACABo0Bpgs9kKCwsHDx7Mypb1VtH6v/rqq47Wf9OmTbSm1zHHQKa5Y8eO2dnZ3Denf/Py8nr37l1dF7Zw4UJYf1B/QBUQqHuoLjM7O3vIkCHnz5+n1tBunIdK/qdMmbJ+/XreUoISAHFxccOHD6dG0+WOeSoYHTBgQExMDOWlKRmgUqmuX78+cODAtLQ0ty9Mo9GYTKbnn39++fLlFovF1c2EAaghIACgXkCmlvozZ2VluWFqyYKPGDFix44dPGLDTzts2LD09PRyNx2z049p06atW7eO6wed4cSJE/fdd19+fr4bC8TotBMnTty4caN0e/s5AOq4FgO3ANQHaHOu8PDwbdu2+fj4kP111fpHRkZu3LiRijupTZBKpUpPT3/ggQfS09Oprt/JSSwWi0aj+fXXX5977jm6HkmS6My9e/feuHEjzQxcujCy/kOHDl2zZg0PB+HrBhAAAMox4n369Pn1118pKK/QVtIbQ0JCNm/e3LhxY77clzYcnjBhQmJiokajUTKlIA346quv3nrrLT4LUavVFotl2LBhq1ev5pvAKLwws9ncpUuXDRs2NGrUCEWfoN49dFgHAOqRPyKKFoslPDw8PDx8/fr1Srpmkq1v3Ljxrl27OnTowJf7kn5MnTp1//79VPKv8BpsNptGo4mJiQkICOjXrx/fHtJisXTv3t3T03P37t2VTiZY2Trkli1b7tq1KyQkBDsAAwgAAIo0QG5qnaSpeIHNli1bBg4cSPleqazN59NPP7127VqXrD9BkZ/t27f36NGjc+fOcg2IiooyGAx//vmn8wViJEs+Pj67d+/u2rUrrD+op6AQCtTDwlAqlJw/fz6ruAafr6v69ddfHYs+X331VVaFxWVULarT6fbt28fPyReIPfXUU04uTKVSqVQqrVa7e/duFH0CrAMAwE0NmDlzZkWmlirrP/jgA6lslS+3tp9//jm9qypthahYs1mzZmfPnrVbICZJ0siRI8u9sIpkCQAIAAAuaADtynL//fc7mlqy/q+99hoZWeq0Q9Z248aNtLar6k3lyJSHh4dnZGTIF4jZbLb8/Pw+ffqw2xeIiaIolyVYfwABAMBNyNTm5eVFRkbKTS0Z2SeffJIcc7L+5KHv2bNHp9NRyL5aGviQBvTu3TsvL0+6fZFwWlpaWFiY44W98sorsP7gjgALwUC9hmo609LShg8fnpiYSKbWbDYPHz589+7drGxrLflyrby8POcLvlyFavlHjRq1ZcsWxyVmUVFRN2/epJyB2WyePXv2t99+i+W+4I4AAgDqO2RqL126NGTIENoZuE+fPnv27PHx8ZEkie/wlZGRMXDgwGvXrlH9PhlfOxNckUWu6Cmg1yVJIg146KGH1q5dSysMeJOJmJiYMWPGWK1Wi8UyevTonTt3Yr9fgCogAKoNCqccPHhQo9Hcc8896enpPA5D8Z9bt2716tWLlW0lVhNQeOfll1+WZJ2ceZs5xli/fv3y8vJ4lhgAhIAAqM55wPr16++5555evXrJ93fU6/VTp0797bffNBqN2WzWarW+vr6enp46nc7T09PLy0sURdqTXaPReHt7O/pAhYWF/EEwGAxWq1Wv1xuNRr1er9frDQZDSUmJyWSiecCnn346d+5cvps8zQN+/vnnvn37hoeH89cBQAgIAABAPQWuCgAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAABAA3AIAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAAAgAAAAACAAAAAAIAAAAADc5/8DSoEA3CkmW8kAAAAASUVORK5CYII=", "apple-touch-icon.png": "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"};
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
      background_color: '#ffffff', theme_color: '#9E2B25',
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
        const [open, recent] = await Promise.all([
          _qbQueryAll(`SELECT * FROM Invoice WHERE CustomerRef = '${qbId}' AND Balance > '0'`),
          _qbQueryAll(`SELECT * FROM Invoice WHERE CustomerRef = '${qbId}' AND TxnDate >= '${since}'`)
        ]);
        const openS = open.map(i => _invSummary(i, today)).sort((a, b) => a.due.localeCompare(b.due));
        const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
        openS.forEach(i => { const d = i.daysOverdue; if (d <= 0) aging.current += i.balance; else if (d <= 30) aging.d1_30 += i.balance; else if (d <= 60) aging.d31_60 += i.balance; else if (d <= 90) aging.d61_90 += i.balance; else aging.d90 += i.balance; });
        const balance = openS.reduce((t, i) => t + i.balance, 0);
        return sendJ(200, { customer: { id: cust.id, name: cust.name }, asOf: new Date().toISOString(), balance, overdue: balance - aging.current, aging, open: openS,
          recent: recent.map(i => _invSummary(i, today)).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number)) });
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
