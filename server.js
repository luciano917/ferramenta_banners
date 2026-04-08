// server.js — serve o gerador de banners + proxy de imagens para resolver CORS no canvas
// Uso: node server.js
// Depois abrir: http://localhost:3333

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = 3333;
const DIR  = __dirname;

// Encontra o arquivo HTML principal mais recente (gerador-banners-dot-v*.html, excluindo checkpoints)
function getLatestHtml() {
  const files = fs.readdirSync(DIR)
    .filter(f => /^gerador-banners-dot-v[\d\w]+\.html$/.test(f))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].name : 'gerador-banners-dot-v20.html';
}

// ── PROXY API FIGMA: /figma-api/... ──────────────────────────────────────
// Repassa chamadas para api.figma.com com o token do header X-Figma-Token
function figmaApi(pathname, req, res) {
  const apiPath = '/v1' + pathname.replace('/figma-api', '');
  const token   = req.headers['x-figma-token'] || '';

  const options = {
    hostname: 'api.figma.com',
    path: apiPath,
    method: 'GET',
    headers: { 'X-Figma-Token': token, 'User-Agent': 'Mozilla/5.0' }
  };

  const apiReq = https.request(options, function(apiRes) {
    res.writeHead(apiRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    apiRes.pipe(res);
  });
  apiReq.on('error', function(e) {
    res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ err: e.message }));
  });
  apiReq.end();
}

// ── PROXY DE IMAGEM: /figma-img?url=https://... ───────────────────────────
// Garante que todas as imagens externas sejam servidas com CORS headers,
// evitando canvas "tainted" e permitindo canvas.toDataURL()
function figmaImg(query, res) {
  const imgUrl = decodeURIComponent(query.url || '');
  if (!imgUrl) {
    res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
    res.end('parametro url obrigatorio'); return;
  }

  try {
    const parsed = new URL(imgUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    };

    const req = https.request(options, function(imgRes) {
      const ct = imgRes.headers['content-type'] || 'image/png';
      res.writeHead(200, {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      });
      imgRes.pipe(res);
    });
    req.on('error', function(e) {
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
      res.end('Erro ao buscar imagem: ' + e.message);
    });
    req.end();
  } catch(e) {
    res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
    res.end('URL invalida: ' + e.message);
  }
}

// ── SERVE ARQUIVOS ESTÁTICOS ──────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
};

function serveFile(filePath, res) {
  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end('Arquivo não encontrado'); return; }
    const ext  = path.extname(filePath);
    const mime  = MIME[ext] || 'text/plain';
    const cache = ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache });
    res.end(data);
  });
}

// ── TOKEN FIGMA: compartilhado entre todos os dispositivos na rede ────────
let _figmaToken = '';

function handleToken(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ token: _figmaToken }));
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { const p = JSON.parse(body); if (p.token !== undefined) _figmaToken = p.token; } catch(e) {}
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); res.end();
    });
    return;
  }
  res.writeHead(405, { 'Access-Control-Allow-Origin': '*' }); res.end();
}

// ── LOG REMOTO: armazena mensagens de debug do browser ────────────────────
const logBuffer = [];
const MAX_LOG = 200;

function handleLog(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(logBuffer));
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        if (msg.clear) { logBuffer.length = 0; }
        else { logBuffer.push({ t: new Date().toISOString(), msg: msg.msg || String(msg) }); }
        if (logBuffer.length > MAX_LOG) logBuffer.splice(0, logBuffer.length - MAX_LOG);
      } catch(e) {}
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); res.end();
    });
    return;
  }
  res.writeHead(405, { 'Access-Control-Allow-Origin': '*' }); res.end();
}

// ── SERVIDOR ─────────────────────────────────────────────────────────────
http.createServer(function(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return;
  }

  if (pathname === '/token') { handleToken(req, res); return; }
  if (pathname === '/log') { handleLog(req, res); return; }
  if (pathname.startsWith('/figma-api/')) { figmaApi(pathname + (parsed.search || ''), req, res); return; }
  if (pathname === '/figma-img') { figmaImg(parsed.query, res); return; }

  // ── SERVE FONTES LOCAIS: /fonts/{familia}/{arquivo} ───────────────────────
  if (pathname.startsWith('/fonts/')) {
    const parts    = pathname.split('/').filter(Boolean); // ['fonts','Familia','400.woff2']
    const fontPath = path.join(DIR, 'fonts', ...parts.slice(1));
    if (!fs.existsSync(fontPath)) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Fonte não encontrada'); return; }
    const ext  = path.extname(fontPath).toLowerCase();
    const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : 'font/ttf';
    res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(fontPath).pipe(res);
    return;
  }

  const filePath = path.join(DIR, pathname === '/' ? getLatestHtml() : pathname);
  serveFile(filePath, res);

}).listen(PORT, function() {
  console.log('\n✓ Servidor rodando em http://localhost:' + PORT);
  console.log('  Abrir no browser: http://localhost:' + PORT + '\n');
});
