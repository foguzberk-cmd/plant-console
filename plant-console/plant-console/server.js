const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;
const QB_REALM = '9341455286904784';
const CLIENT_ID = 'ABWEkzwkl0wAchmXBFwVmvRGiiYCXihwdcEo8wsyhIWnZW1lKh';
const CLIENT_SECRET = 'rstNRy7lvgmVE0FRdRYzDNXSo5IXV1B8hpubV54s';

// In-memory token store (persists while server is running)
let accessToken = process.env.QB_ACCESS_TOKEN || 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2IiwieC5vcmciOiJIMCJ9..zBDlB5CfSoKxeUJLP7GU5Q.jdQicG2GWCElowlU_0m6lboB93Xojn99i2wv7Byd5z8BhBRbgW-cdLdFRW-r56CuAmaqOI_5gpt_nEBuOQMeZpg-Lqk4MjVflKGfd-1-PBMfoMEquAUEwB-96nkbH4I4I3Z126SY2kIPspcZs4iKvO4w3KpprbhouYJcOP2Rj3P4bQVZ_zxTGICdb1krNVDnGQfmhMakg4KXB3AsEXzDNkANpiZwvp9QMhxWCFxgI1BvvLicW1UDIK7rHpEkywr5k0dWIFhMDUIAi0ydAd15BzK3ugSeHUs62S9vMBZIrXVOWeAZ0u5_JHybipLYUl9OUdNpgcD4bLKtEQNuCfYRmgCkmUGJ8quMhMHewjWHlBzS-pkNCetaHzXrYSX1qnsxMpcxX9v5yiSW81-wwHdIb1f4FdveBrbU8BzpAKzi1dsyIh43kWdIo-Ks9Iyc2YAJM803I0sjC5JFFvaDw4JLmBFnCmjjiBLXystv-MHy-4k.wUtPUSC-s--tWL-bbzOIfQ';
let refreshToken = process.env.QB_REFRESH_TOKEN || 'RT1-99-H0-1791043472ito2ow47kjunqymdqf7w';

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

async function fetchQBItems(retry) {
  const query = 'SELECT * FROM Item MAXRESULTS 1000';
  const path = `/v3/company/${QB_REALM}/query?query=${encodeURIComponent(query)}&minorversion=65`;
  const res = await httpsRequest({
    hostname: 'quickbooks.api.intuit.com',
    path: path,
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Accept': 'application/json'
    }
  });
  if (res.status === 401 && !retry) {
    const ok = await refreshAccessToken();
    if (ok) return fetchQBItems(true);
    throw new Error('Auth failed after token refresh');
  }
  if (res.status !== 200) throw new Error('QB API error ' + res.status + ': ' + res.body);
  return JSON.parse(res.body);
}

const server = http.createServer(async (req, res) => {
  // CORS headers for browser requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

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

  // QuickBooks items proxy endpoint
  if (url === '/api/qb/items') {
    try {
      const data = await fetchQBItems(false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('QB fetch error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // QuickBooks token refresh endpoint
  if (url === '/api/qb/refresh') {
    try {
      const ok = await refreshAccessToken();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: ok, access_token: accessToken }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Callback handler
  if (url.startsWith('/callback')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Connected successfully. You may close this window.</h2></body></html>');
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('Plant Console running on port ' + PORT));
