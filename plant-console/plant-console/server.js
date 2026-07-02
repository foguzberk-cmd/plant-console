const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;
const QB_REALM = process.env.QB_REALM || '9341455286904784';
const CLIENT_ID = process.env.QB_CLIENT_ID || 'ABWEkzwkl0wAchmXBFwVmvRGiiYCXihwdcEo8wsyhIWnZW1lKh';
const CLIENT_SECRET = process.env.QB_CLIENT_SECRET || 'rstNRy7lvgmVE0FRdRYzDNXSo5IXV1B8hpubV54s';
const REDIRECT_URI = process.env.QB_REDIRECT_URI || 'https://plant-console-app.onrender.com/callback';

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
const DATA_DEFAULT = { items: [], transactions: [], storages: [], users: [], scaleLogs: [], labelAllowed: [] };

function ensureDataFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify(DATA_DEFAULT, null, 2));
  } catch (e) {
    console.error('Could not prepare shared data file:', e.message);
  }
}

function readSharedData() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return Object.assign({}, DATA_DEFAULT, JSON.parse(raw || '{}'));
  } catch (e) {
    console.error('Could not read shared data file:', e.message);
    return Object.assign({}, DATA_DEFAULT);
  }
}

function writeSharedData(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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

// In-memory token store (persists while server is running)
let accessToken = process.env.QB_ACCESS_TOKEN || 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2IiwieC5vcmciOiJIMCJ9..5HeNoqIq2dNH_ywSUn07BA.2UqmIwUlqtSLpWe25ejJCjnOdu99Sgb0P1JQ0nS76Yj_OqrhBmaBUKjbh92pTZFbtVxx5TyBnZ-07qdHAcqEmwYcQjckZ4nZieXUTiQrK6vtMVNViIVOLtNIXEO6faCFYgk61U0MkOjLCrRoAKZ-2wg4UAIwIMJ2sLEPR4pLA--JoxLq7grYVRJqnUGL2i9i392di9L4_lxF8mXleS1KC4UEwDTJL-TluC-TscxJIMhaAEh9G9n-smzRbszx2DHdJ3e_dITU9X1KIICyCsdAsBXKxlzrUR7MwPMnkCgjm9ydLse2yPvHVSKnEswuE1pD7CnxfL6Ir4MLvEqdeo2W1m66e-12RdAUIoAqB_N-l0K1-YqYJacAhmkRO0FatsTj-Wl1D8fRm43uPrPudlFZQKMY_YnF_ENJHJ-JuMCYme1MzRHpX0vupS7Z05uecpbKxAaU0D9o8Cxraa74E51llEd60dGzsBHD4VPQV8O2bFo.H4Nx-fR1jI0UGwn95uqh6g';
let refreshToken = process.env.QB_REFRESH_TOKEN || 'RT1-76-H0-1791468215k2xxhdx8wq5jcuwo5cqq';
let activeRealm = QB_REALM;
let tokenRefreshedAt = 0; // ms timestamp of last successful token refresh

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

  // ===== Shared data API — lets every browser/device read & write the same
  // items/transactions/storages/users instead of each keeping its own local copy =====
  if (url === '/api/data' && req.method === 'GET') {
    const data = readSharedData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }
  if (url === '/api/data' && req.method === 'POST') {
    try {
      const bodyStr = await readRequestBody(req);
      const incoming = JSON.parse(bodyStr || '{}');
      const current = readSharedData();
      // Merge: only overwrite the keys actually sent, so saving e.g. just
      // "users" never wipes out items/transactions/storages.
      const merged = Object.assign({}, current, incoming);
      writeSharedData(merged);
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ connected: !!accessToken, realm: activeRealm }));
    return;
  }

  // Diagnostic endpoint — visit this URL directly in the browser
  if (url === '/api/qb/test') {
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

  // QuickBooks token refresh endpoint
  if (url === '/api/qb/refresh') {
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
    const code = queryParams.code;
    const realmId = queryParams.realmId;
    if (code) {
      try {
        const ok = await exchangeCodeForTokens(code);
        if (realmId) activeRealm = realmId;
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
    accessToken = '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('Plant Console running on port ' + PORT));
