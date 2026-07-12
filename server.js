const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 8080;

// 資料庫放在 DATA_DIR（正式環境掛載持久化硬碟），本機預設 ./data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'guestbook.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const listStmt = db.prepare(
  'SELECT id, name, message, created_at FROM messages ORDER BY id DESC LIMIT 100'
);
const insertStmt = db.prepare(
  'INSERT INTO messages (name, message) VALUES (?, ?)'
);

// 每個 IP 一分鐘最多 5 則，防灌水
const postLog = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (postLog.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 5) return true;
  recent.push(now);
  postLog.set(ip, recent);
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/messages' && req.method === 'GET') {
    sendJSON(res, 200, listStmt.all());
    return;
  }

  if (url.pathname === '/api/messages' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        sendJSON(res, 400, { error: '格式錯誤' });
        return;
      }
      const name = String(data.name || '').trim().slice(0, 30);
      const message = String(data.message || '').trim().slice(0, 200);
      if (!name || !message) {
        sendJSON(res, 400, { error: '名字和留言都要填喔' });
        return;
      }
      if (rateLimited(ip)) {
        sendJSON(res, 429, { error: '留言太頻繁了，休息一下再來吧' });
        return;
      }
      insertStmt.run(name, message);
      sendJSON(res, 201, { ok: true });
    });
    return;
  }

  // 靜態檔案：只允許根目錄下的已知檔案
  if (req.method === 'GET') {
    const safeName = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    if (MIME[path.extname(safeName).toLowerCase()]) {
      serveFile(res, path.join(__dirname, safeName));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}, data dir: ${DATA_DIR}`);
});
