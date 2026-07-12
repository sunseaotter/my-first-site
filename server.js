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

// 舊版留言板沒有 email 欄位，補上（改版後留言含聯絡方式，僅後台可讀）
if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'email')) {
  db.exec('ALTER TABLE messages ADD COLUMN email TEXT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    service TEXT NOT NULL,
    preferred_time TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const listStmt = db.prepare(
  'SELECT id, name, email, message, created_at FROM messages ORDER BY id DESC LIMIT 100'
);
const insertStmt = db.prepare(
  'INSERT INTO messages (name, email, message) VALUES (?, ?, ?)'
);

const insertBookingStmt = db.prepare(
  'INSERT INTO bookings (name, email, phone, service, preferred_time, note) VALUES (?, ?, ?, ?, ?, ?)'
);
const listBookingsStmt = db.prepare(
  'SELECT id, name, email, phone, service, preferred_time, note, status, created_at FROM bookings ORDER BY id DESC LIMIT 200'
);
const updateBookingStmt = db.prepare(
  "UPDATE bookings SET status = ? WHERE id = ?"
);

// 後台管理金鑰：正式環境務必設定 ADMIN_KEY 環境變數
const ADMIN_KEY = process.env.ADMIN_KEY;
function isAdmin(req) {
  return ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY;
}

const SERVICES = ['工作坊設計與引導', '領導力教練', '職場導師', 'Podcast & 演講邀約'];

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

  // 留言含聯絡方式，改版後僅後台可讀
  if (url.pathname === '/api/admin/messages' && req.method === 'GET') {
    if (!isAdmin(req)) {
      sendJSON(res, ADMIN_KEY ? 401 : 503, { error: ADMIN_KEY ? '金鑰錯誤' : '尚未設定 ADMIN_KEY 環境變數' });
      return;
    }
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
      const email = String(data.email || '').trim().slice(0, 100);
      const message = String(data.message || '').trim().slice(0, 500);
      if (!name || !email || !message) {
        sendJSON(res, 400, { error: '姓名、Email 和訊息都要填喔' });
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJSON(res, 400, { error: 'Email 格式看起來不太對' });
        return;
      }
      if (rateLimited(ip)) {
        sendJSON(res, 429, { error: '送出太頻繁了，休息一下再來吧' });
        return;
      }
      insertStmt.run(name, email, message);
      sendJSON(res, 201, { ok: true });
    });
    return;
  }

  if (url.pathname === '/api/bookings' && req.method === 'POST') {
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
      const email = String(data.email || '').trim().slice(0, 100);
      const phone = String(data.phone || '').trim().slice(0, 30);
      const service = String(data.service || '').trim();
      const preferredTime = String(data.preferred_time || '').trim().slice(0, 50);
      const note = String(data.note || '').trim().slice(0, 500);
      if (!name || !email) {
        sendJSON(res, 400, { error: '名字和 Email 都要填喔' });
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJSON(res, 400, { error: 'Email 格式看起來不太對' });
        return;
      }
      if (!SERVICES.includes(service)) {
        sendJSON(res, 400, { error: '請選擇服務項目' });
        return;
      }
      if (rateLimited(ip)) {
        sendJSON(res, 429, { error: '送出太頻繁了，休息一下再來吧' });
        return;
      }
      insertBookingStmt.run(name, email, phone || null, service, preferredTime || null, note || null);
      sendJSON(res, 201, { ok: true });
    });
    return;
  }

  if (url.pathname === '/api/admin/bookings' && req.method === 'GET') {
    if (!isAdmin(req)) {
      sendJSON(res, ADMIN_KEY ? 401 : 503, { error: ADMIN_KEY ? '金鑰錯誤' : '尚未設定 ADMIN_KEY 環境變數' });
      return;
    }
    sendJSON(res, 200, listBookingsStmt.all());
    return;
  }

  const bookingStatusMatch = url.pathname.match(/^\/api\/admin\/bookings\/(\d+)$/);
  if (bookingStatusMatch && req.method === 'PATCH') {
    if (!isAdmin(req)) {
      sendJSON(res, ADMIN_KEY ? 401 : 503, { error: ADMIN_KEY ? '金鑰錯誤' : '尚未設定 ADMIN_KEY 環境變數' });
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000) req.destroy();
    });
    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        sendJSON(res, 400, { error: '格式錯誤' });
        return;
      }
      const status = String(data.status || '');
      if (!['pending', 'confirmed', 'declined'].includes(status)) {
        sendJSON(res, 400, { error: '狀態不正確' });
        return;
      }
      updateBookingStmt.run(status, Number(bookingStatusMatch[1]));
      sendJSON(res, 200, { ok: true });
    });
    return;
  }

  if (url.pathname === '/admin' && req.method === 'GET') {
    serveFile(res, path.join(__dirname, 'admin.html'));
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
