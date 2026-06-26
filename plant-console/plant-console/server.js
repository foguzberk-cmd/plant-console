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

// In-memory token store (persists while server is running)
let accessToken = process.env.QB_ACCESS_TOKEN || '';
let refreshToken = process.env.QB_REFRESH_TOKEN || 'RT1-99-H0-1791043472ito2ow47kjunqymdqf7w';
let activeRealm = QB_REALM;

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
    console.log('Token refreshed successfully');
    return true;
  }
  console.error('Token refresh failed:', res.body);
  return false;
}

async function fetchQBItemsPage(startPosition, retry) {
  const query = `SELECT * FROM Item STARTPOSITION ${startPosition} MAXRESULTS 1000`;
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
  const pageSize = 1000;
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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const fullUrl = req.url;
  const url = fullUrl.split('?')[0];
  const queryParams = querystring.parse(fullUrl.split('?')[1] || '');

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
