// Server kecil untuk menjalankan dashboard (tanpa dependensi, cukup Node.js 18+).
//  - Menyajikan file statis dari folder public/
//  - Meneruskan (proxy) semua request /api/* ke backend, termasuk stream realtime (SSE)
// Dengan proxy ini, browser hanya bicara ke server ini sendiri -> tidak ada masalah CORS.
//
// Jalankan:  node server.js
// Opsi env:  PORT=5173  BACKEND_URL=https://backend-wokwi.kitimaru.my.id
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 5173;
const TARGET = new URL(process.env.BACKEND_URL || 'https://backend-wokwi.kitimaru.my.id');
const ROOT = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function proxy(req, res) {
  const lib = TARGET.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: TARGET.host };
  delete headers.origin;   // request datang dari server, bukan browser -> CORS tidak berlaku
  delete headers.referer;

  const upstream = lib.request(
    {
      protocol: TARGET.protocol,
      hostname: TARGET.hostname,
      port: TARGET.port || undefined,
      path: req.url,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode, { ...up.headers, 'x-accel-buffering': 'no' });
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { code: 'BAD_GATEWAY', message: `Backend tidak dapat dihubungi (${e.message})` } }));
  });
  res.on('close', () => upstream.destroy());   // browser menutup koneksi (mis. SSE) -> tutup juga ke backend
  req.pipe(upstream);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Tidak ditemukan');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

http
  .createServer((req, res) => (req.url.startsWith('/api/') ? proxy(req, res) : serveStatic(req, res)))
  .on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nPort ${PORT} sudah dipakai program lain (mungkin dashboard ini sudah jalan di terminal lain).`);
      console.error(`- Buka saja http://localhost:${PORT}, atau`);
      console.error(`- Tutup program itu, atau`);
      console.error(`- Pakai port lain:  PowerShell: $env:PORT=5180; npm start   |   Bash: PORT=5180 npm start\n`);
      process.exit(1);
    }
    throw e;
  })
  .listen(PORT, () => {
    console.log(`Dashboard siap: http://localhost:${PORT}`);
    console.log(`API diteruskan ke: ${TARGET.origin}`);
  });
