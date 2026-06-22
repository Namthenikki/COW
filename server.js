/* ═══════════════════════════════════════════════════════
   CoWatch — Server + YouTube Proxy API
   Ad-free streams via Piped · Google OAuth for library
   ═══════════════════════════════════════════════════════ */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
  'https://piped-api.lunar.icu',
  'https://pipedapi.leptons.xyz'
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

async function pipedFetch(apiPath) {
  let lastErr;
  for (const base of PIPED_INSTANCES) {
    try {
      const res = await fetchRemote(base + apiPath);
      if (res.status >= 200 && res.status < 300) {
        return JSON.parse(res.body.toString('utf8'));
      }
      lastErr = new Error(`HTTP ${res.status} from ${base}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Piped instances failed');
}

/** JSON fetch for Piped API metadata */
function fetchRemote(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'CoWatch/1.0',
        'Accept': 'application/json',
        ...options.headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Pipe video bytes through — supports Range requests for smooth seeking */
function pipeRemoteStream(clientReq, clientRes, targetUrl) {
  const parsed = new URL(targetUrl);
  const lib = parsed.protocol === 'https:' ? https : http;

  const headers = {
    'User-Agent': 'CoWatch/1.0',
    'Accept': '*/*'
  };
  if (clientReq.headers.range) {
    headers['Range'] = clientReq.headers.range;
  }

  const proxyReq = lib.request(targetUrl, { method: 'GET', headers }, (proxyRes) => {
    const outHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    };
    ['content-type', 'content-length', 'content-range', 'cache-control'].forEach((h) => {
      if (proxyRes.headers[h]) outHeaders[h] = proxyRes.headers[h];
    });
    if (!outHeaders['content-type']) outHeaders['Content-Type'] = 'video/mp4';

    clientRes.writeHead(proxyRes.statusCode, outHeaders);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', () => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Stream proxy failed' }));
    }
  });

  clientReq.on('close', () => proxyReq.destroy());
  proxyReq.end();
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

async function handleAPI(req, res, urlPath, query) {
  try {
    // ── Auth config ──
    if (urlPath === '/api/auth/config' && req.method === 'GET') {
      const host = req.headers.host || `localhost:${PORT}`;
      const proto = req.headers['x-forwarded-proto'] || 'http';
      return sendJSON(res, 200, {
        clientId: GOOGLE_CLIENT_ID || null,
        authEnabled: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
        redirectUri: `${proto}://${host}/auth/callback`
      });
    }

    // ── OAuth token exchange ──
    if (urlPath === '/api/auth/token' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return sendJSON(res, 503, { error: 'Google OAuth not configured on server' });
      }
      const params = new URLSearchParams({
        code: body.code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: body.redirectUri,
        grant_type: 'authorization_code'
      });
      const tokenRes = await fetchRemote('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = JSON.parse(tokenRes.body.toString('utf8'));
      if (tokenRes.status !== 200) {
        return sendJSON(res, tokenRes.status, data);
      }
      return sendJSON(res, 200, data);
    }

    // ── YouTube Data API proxy (library) ──
    if (urlPath === '/api/youtube/data' && req.method === 'GET') {
      const accessToken = req.headers.authorization?.replace('Bearer ', '');
      if (!accessToken) return sendJSON(res, 401, { error: 'No token' });

      const endpoint = query.get('endpoint');
      if (!endpoint) return sendJSON(res, 400, { error: 'Missing endpoint' });

      const allowed = ['subscriptions', 'playlists', 'playlistItems', 'videos', 'channels', 'search'];
      const resource = endpoint.split('?')[0].split('/').pop();
      if (!allowed.includes(resource)) {
        return sendJSON(res, 403, { error: 'Endpoint not allowed' });
      }

      const ytUrl = `https://www.googleapis.com/youtube/v3/${endpoint}`;
      const ytRes = await fetchRemote(ytUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      res.writeHead(ytRes.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(ytRes.body);
    }

    // ── Piped proxy routes ──
    if (urlPath.startsWith('/api/yt/')) {
      const sub = urlPath.replace('/api/yt/', '');

      if (sub.startsWith('search')) {
        const q = encodeURIComponent(query.get('q') || '');
        const filter = query.get('filter') || 'all';
        const data = await pipedFetch(`/search?q=${q}&filter=${filter}`);
        return sendJSON(res, 200, data);
      }

      if (sub.startsWith('trending')) {
        const region = query.get('region') || 'US';
        const data = await pipedFetch(`/trending?region=${region}`);
        return sendJSON(res, 200, data);
      }

      if (sub.startsWith('streams/')) {
        const videoId = sub.replace('streams/', '').split('/')[0];
        if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
          return sendJSON(res, 400, { error: 'Invalid video ID' });
        }
        const data = await pipedFetch(`/streams/${videoId}`);
        return sendJSON(res, 200, data);
      }

      if (sub.startsWith('channel/')) {
        const channelId = sub.replace('channel/', '');
        const data = await pipedFetch(`/channel/${channelId}`);
        return sendJSON(res, 200, data);
      }

      if (sub.startsWith('playlist/')) {
        const playlistId = sub.replace('playlist/', '');
        const data = await pipedFetch(`/playlists/${playlistId}`);
        return sendJSON(res, 200, data);
      }

      if (sub.startsWith('nextpage/channel/')) {
        const rest = sub.replace('nextpage/channel/', '');
        const data = await pipedFetch(`/nextpage/channel/${rest}?${query.toString()}`);
        return sendJSON(res, 200, data);
      }

      // Stream URL proxy — true streaming with Range support (fallback only)
      if (sub === 'proxy') {
        const target = query.get('url');
        if (!target || (!target.includes('piped') && !target.includes('googlevideo') && !target.includes('youtube') && !target.includes('ytimg'))) {
          return sendJSON(res, 403, { error: 'URL not allowed' });
        }
        return pipeRemoteStream(req, res, target);
      }
    }

    return false;
  } catch (err) {
    console.error('API error:', err.message);
    sendJSON(res, 502, { error: err.message || 'Upstream error' });
    return true;
  }
}

function serveStatic(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/auth/callback') urlPath = '/auth-callback.html';

  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(filePath + '.html', (err2, data2) => {
          if (err2) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>404 — Not Found</h1>');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data2);
          }
        });
        return;
      }
      res.writeHead(500);
      return res.end('Internal Server Error');
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const urlPath = parsed.pathname;
  const query = parsed.searchParams;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  if (urlPath.startsWith('/api/')) {
    const handled = await handleAPI(req, res, urlPath, query);
    if (handled !== false) return;
  }

  serveStatic(req, res, urlPath);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   🎬  CoWatch is LIVE!                   ║');
  console.log(`  ║   🌐  http://localhost:${PORT}                ║`);
  console.log('  ║   🚫  Ad-free YouTube via Piped          ║');
  console.log('  ║   🔐  Set GOOGLE_CLIENT_ID for login     ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
