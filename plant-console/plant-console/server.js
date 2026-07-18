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
const DATA_DEFAULT = { items: [], transactions: [], storages: [], users: [], scaleLogs: [], labelAllowed: [], savedReports: [], customers: [], customerAllowed: [], labelTemplates: {} };

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
  await fs.promises.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
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
  return withDataLock(() => _writeSharedDataUnlocked(data));
}
// Atomic "read, modify, write" as ONE queued step — use this whenever the
// write depends on first reading the current data (e.g. merging incoming
// sync data), so no other request's read/write can slip in between.
// The mutator returns { data, skipWrite, ...anything else the caller needs }.
// Set skipWrite:true when nothing actually changed (e.g. an ordinary login
// with no legacy PIN to migrate) to avoid a pointless disk write on every call.
function updateSharedData(mutator) {
  return withDataLock(async () => {
    const current = await _readSharedDataUnlocked();
    const result = await mutator(current);
    if (!result.skipWrite) {
      await _writeSharedDataUnlocked(result.data !== undefined ? result.data : current);
    }
    return result;
  });
}

// ===== SESSIONS =====
// Minimal in-memory session store backed by an HttpOnly cookie. Sessions are
// lost on server restart (acceptable for this app's scale) — that's a plain
// re-login, not data loss, since real data lives in the shared data file.
const SESSIONS = new Map(); // token -> { userId, role, name, email, expires }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  SESSIONS.set(token, {
    userId: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    expires: Date.now() + SESSION_TTL_MS
  });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { SESSIONS.delete(token); return null; }
  return s;
}
function destroySession(token) {
  if (token) SESSIONS.delete(token);
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
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not authenticated', needsLogin: true }));
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
  const query = `SELECT * FROM Item STARTPOSITION ${startPosition} MAXRESULTS 100`;
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
async function fetchQBEntityPage(entity, startPosition, retry, since, from) {
  if (!retry) await ensureFreshToken(); // keep token alive during long paged syncs
  const clauses = [];
  if (since) clauses.push(`MetaData.LastUpdatedTime >= '${since}'`);
  if (from)  clauses.push(`TxnDate >= '${from}'`);
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
    if (ok) return fetchQBEntityPage(entity, startPosition, true, since, from);
    throw new Error('NEEDS_RECONNECT');
  }
  if (res.status !== 200) throw new Error('QB API error ' + res.status + ' on ' + entity + ': ' + res.body);
  return JSON.parse(res.body);
}

async function fetchQBEntity(entity, since, from) {
  let all = [];
  let start = 1;
  const pageSize = 100;
  while (true) {
    const data = await fetchQBEntityPage(entity, start, false, since, from);
    const rows = (data.QueryResponse && data.QueryResponse[entity]) || [];
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    start += pageSize;
    if (start > 20000) break;
  }
  return all;
}

// Fetch all purchase/sales documents that move inventory
async function fetchQBDocuments() {
  // Refresh once up front
  if (!accessToken) await refreshAccessToken();
  const result = { Bill: [], Invoice: [], SalesReceipt: [], CreditMemo: [], errors: {} };
  const entities = ['Bill', 'Invoice', 'SalesReceipt', 'CreditMemo'];
  for (const entity of entities) {
    try {
      result[entity] = await fetchQBEntity(entity);
    } catch (e) {
      result.errors[entity] = e.message;
    }
  }
  return result;
}


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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const fullUrl = req.url;
  const url = fullUrl.split('?')[0];
  const queryParams = querystring.parse(fullUrl.split('?')[1] || '');

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
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Incorrect email or PIN.' }));
        return;
      }
      const token = createSession(user);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookieHeader(token, SESSION_TTL_MS / 1000)
      });
      res.end(JSON.stringify({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role, perms: user.perms || {} } }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === '/api/logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    destroySession(cookies.pc_session);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookieHeader('', 0) });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  if (url === '/api/session' && req.method === 'GET') {
    const cookies = parseCookies(req);
    const session = getSession(cookies.pc_session);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }
    const data = await readSharedData();
    const user = data.users.find(u => u.id === session.userId);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'User no longer exists' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: { id: user.id, name: user.name, email: user.email, role: user.role, perms: user.perms || {} } }));
    return;
  }

  // ===== Shared data API — lets every browser/device read & write the same
  // items/transactions/storages/users instead of each keeping its own local copy =====
  if (url === '/api/data' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const data = await readSharedData();
    const safe = Object.assign({}, data, {
      users: data.users.map(u => { const c = Object.assign({}, u); delete c.pin; delete c.pinHash; return c; })
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      users: users,
      scaleLogs: data.scaleLogs,
      labelAllowed: data.labelAllowed,
      savedReports: data.savedReports,
      customerAllowed: data.customerAllowed
    }));
    return;
  }
  if (url === '/api/data' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const bodyStr = await readRequestBody(req);
      const incoming = JSON.parse(bodyStr || '{}');
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
        // Merge: only overwrite the keys actually sent, so saving e.g. just
        // "users" never wipes out items/transactions/storages.
        const merged = Object.assign({}, current, incoming);
        return { data: merged };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve index.html
  if (url === '/' || url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ connected: !!accessToken, realm: activeRealm }));
    return;
  }

  // Diagnostic endpoint — visit this URL directly in the browser
  if (url === '/api/qb/test') {
    if (!requireAuth(req, res)) return;
    try {
      const result = await diagnose(false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // QuickBooks documents endpoint — bills, invoices, sales receipts, credit memos
  // ?entity=Invoice                  -> fetch ALL pages of that type (may be slow)
  // ?entity=Invoice&startposition=1  -> fetch ONE page (100 rows) starting at N
  //                                     (client drives pagination = no timeouts)
  // &since=ISO                       -> only records changed since that time
  if (url === '/api/qb/documents') {
    if (!requireAuth(req, res)) return;
    try {
      const ent = queryParams.entity;
      const since = queryParams.since || null;
      const from = queryParams.from || null;
      const startPos = queryParams.startposition ? parseInt(queryParams.startposition, 10) : null;
      if (ent && ['Bill','Invoice','SalesReceipt','CreditMemo'].indexOf(ent) >= 0) {
        if (!accessToken) await refreshAccessToken();
        // Single-page mode: return just one page so each HTTP request is fast.
        if (startPos !== null && !isNaN(startPos)) {
          const data = await fetchQBEntityPage(ent, startPos, false, since, from);
          const rows = (data.QueryResponse && data.QueryResponse[ent]) || [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const out = {}; out[ent] = rows; out.pageSize = 100; out.startPosition = startPos;
          res.end(JSON.stringify(out));
          return;
        }
        // Fetch-all mode (kept for small types)
        const rows = await fetchQBEntity(ent, since, from);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const out = {}; out[ent] = rows;
        res.end(JSON.stringify(out));
        return;
      }
      const data = await fetchQBDocuments();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      const needsReconnect = err.message === 'NEEDS_RECONNECT';
      res.writeHead(needsReconnect ? 401 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, needsReconnect: needsReconnect }));
    }
    return;
  }

  // QuickBooks items proxy endpoint
  if (url === '/api/qb/items') {
    if (!requireAuth(req, res)) return;
    try {
      const data = await fetchQBItems(false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('QB fetch error:', err.message);
      const needsReconnect = err.message === 'NEEDS_RECONNECT';
      res.writeHead(needsReconnect ? 401 : 500, { 'Content-Type': 'application/json' });
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('QB fetch error:', err.message);
      const needsReconnect = err.message === 'NEEDS_RECONNECT';
      res.writeHead(needsReconnect ? 401 : 500, { 'Content-Type': 'application/json' });
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: ok }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // OAuth callback — exchange the code for tokens
  if (url.startsWith('/callback')) {
    const cookies = parseCookies(req);
    if (!getSession(cookies.pc_session)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
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
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QuickBooks Connection</title>
        <style>body{font-family:Arial,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;text-align:center;line-height:1.7;color:#222}</style></head>
        <body>${msg}<p style="margin-top:30px"><a href="/" style="background:#1a5f7a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Return to Plant Console</a></p></body></html>`);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h2>Error connecting: ' + err.message + '</h2>');
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>No authorization code received.</h2><p><a href="/connect">Try again</a></p></body></html>');
    }
    return;
  }

  // EULA page
  if (url === '/eula') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
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
    res.writeHead(200, { 'Content-Type': 'text/html' });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('Plant Console running on port ' + PORT));
