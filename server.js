/**
 * Волна — маленький мессенджер без зависимостей.
 * Node.js 22+ (используется встроенный node:sqlite).
 *
 *   node server.js          → http://127.0.0.1:8787  (сам поднимает фото-сервер на 8788)
 *   PORT=9000 node server.js
 *   MEDIA_EXTERNAL=1 node server.js   — не запускать media.js, использовать внешний
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, MEDIA_DIR, openDb } from './db.js';

const PUBLIC = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MEDIA_HOST = process.env.MEDIA_HOST || '127.0.0.1';
const MEDIA_PORT = Number(process.env.MEDIA_PORT || 8788);
const MAX_BODY = 256 * 1024;
const MAX_TEXT = 4000;

/** Если задан — зарегистрироваться можно только с этим кодом. */
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();

/* ─────────────────────────── база ─────────────────────────── */

const db = openDb();

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE name = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (name, pass_hash, salt, hue, created_at) VALUES (?, ?, ?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  setAvatar: db.prepare('UPDATE users SET avatar_media_id = ? WHERE id = ?'),
  mediaOwner: db.prepare('SELECT owner_id FROM media WHERE id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (sender_id, recipient_id, body, kind, media_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  markRead: db.prepare('UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL'),
  maxFromPair: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE sender_id = ? AND recipient_id = ?'),
  contacts: db.prepare(`
    SELECT u.id, u.name, u.hue, u.avatar_media_id,
      lm.body     AS last_body,
      lm.kind     AS last_kind,
      lm.created_at AS last_at,
      lm.sender_id  AS last_from,
      (SELECT COUNT(*) FROM messages m
        WHERE m.sender_id = u.id AND m.recipient_id = ? AND m.read_at IS NULL) AS unread
    FROM users u
    LEFT JOIN (
      SELECT m.* FROM messages m
      JOIN (
        SELECT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id,
               MAX(id) AS id
        FROM messages
        WHERE sender_id = ? OR recipient_id = ?
        GROUP BY peer_id
      ) t ON t.id = m.id
    ) lm ON lm.sender_id = u.id OR lm.recipient_id = u.id
    WHERE u.id != ?
    ORDER BY (last_at IS NULL) ASC, last_at DESC, u.name COLLATE NOCASE ASC
  `),
};

/* ─────────────────────── утилиты ─────────────────────── */

const hashPass = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
const randomToken = () => crypto.randomBytes(24).toString('base64url');
const now = () => Date.now();

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function publicUser(row) {
  return { id: row.id, name: row.name, hue: row.hue, avatarId: row.avatar_media_id || null };
}

function publicMessage(row) {
  return {
    id: row.id,
    from: row.sender_id,
    to: row.recipient_id,
    body: row.body,
    kind: row.kind || 'text',
    mediaId: row.media_id || null,
    at: row.created_at,
    readAt: row.read_at,
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Подмешивает к сообщениям размеры фотографии, чтобы клиент не «прыгал» при загрузке. */
function withMedia(messages) {
  const ids = [...new Set(messages.filter((m) => m.mediaId).map((m) => m.mediaId))];
  if (!ids.length) return messages;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, mime, width, height FROM media WHERE id IN (${placeholders})`).all(...ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const message of messages) {
    const row = message.mediaId ? byId.get(message.mediaId) : null;
    if (row) message.media = { mime: row.mime, width: row.width, height: row.height };
  }
  return messages;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function tokenFrom(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return url.searchParams.get('token') || '';
}

function requireUser(req, url) {
  const token = tokenFrom(req, url);
  if (!token) throw new HttpError(401, 'Нужен вход');
  const row = q.session.get(token);
  if (!row) throw new HttpError(401, 'Сессия истекла');
  touchPresence(row.id);
  return { token, user: publicUser(row) };
}

/* ─────────────────────── онлайн / SSE ─────────────────────── */

/** userId → Set<ServerResponse> (несколько вкладок — нормально) */
const streams = new Map();
/** userId → время последнего запроса; работает, когда SSE заблокирован прокси */
const presence = new Map();
const PRESENCE_TTL = 45000;

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastTo(userId, event, data) {
  const set = streams.get(userId);
  if (!set) return;
  for (const res of set) {
    try {
      sseSend(res, event, data);
    } catch {
      /* оборванный поток уберётся по close */
    }
  }
}

function broadcastAll(event, data) {
  for (const set of streams.values()) {
    for (const res of set) {
      try {
        sseSend(res, event, data);
      } catch {
        /* ignore */
      }
    }
  }
}

const onlineIds = () => {
  const nowTs = Date.now();
  const ids = new Set(streams.keys());
  for (const [id, ts] of presence) {
    if (nowTs - ts <= PRESENCE_TTL) ids.add(id);
    else presence.delete(id);
  }
  return [...ids];
};

/** Клиент без SSE (прокси держит поток) всё равно «онлайн», пока ходит запросами. */
function touchPresence(userId) {
  presence.set(Number(userId), Date.now());
}

function setOnline(userId, res) {
  let set = streams.get(userId);
  if (!set) {
    set = new Set();
    streams.set(userId, set);
  }
  set.add(res);
}

function setOffline(userId, res) {
  const set = streams.get(userId);
  if (!set) return false;
  set.delete(res);
  if (set.size === 0) {
    streams.delete(userId);
    return true; // последняя вкладка закрылась
  }
  return false;
}

/* ─────────────────────── демо-данные ─────────────────────── */

function seedIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count > 0) return;
  const demo = [
    ['anya', '1234', 268],
    ['mark', '1234', 205],
    ['lena', '1234', 330],
  ];
  const ids = {};
  for (const [name, pass, hue] of demo) {
    const salt = crypto.randomBytes(16).toString('hex');
    const info = q.insertUser.run(name, hashPass(pass, salt), salt, hue, now());
    ids[name] = Number(info.lastInsertRowid);
  }

  // демонстрационное фото, чтобы галерея в переписке была не пустой
  let photoId = null;
  const sample = path.join(ROOT, 'assets', 'demo-photo.jpg');
  if (fs.existsSync(sample)) {
    const buf = fs.readFileSync(sample);
    photoId = crypto.randomBytes(12).toString('base64url');
    fs.writeFileSync(path.join(MEDIA_DIR, photoId), buf);
    db.prepare(
      'INSERT INTO media (id, owner_id, mime, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(photoId, ids.anya, 'image/jpeg', buf.length, 1200, 800, now());
    // у anya фото профиля — тот же кадр, просто обрезается аватаром
    q.setAvatar.run(photoId, ids.anya);
  }

  const script = [
    ['anya', 'mark', 'Привет! Ты уже видел новый интерфейс?', 52, null],
    ['mark', 'anya', 'Да, стало заметно чище. Особенно тёмная тема 👌', 49, null],
    ['anya', 'mark', 'Я добавила индикатор «печатает…» — попробуй', 45, null],
    ['mark', 'anya', 'Работает. Слушай, а история правда сохраняется?', 41, null],
    ['anya', 'mark', 'Правда. Перезапусти сервер — всё останется на месте.', 39, null],
    ['mark', 'anya', 'Тогда это уже не игрушка 🙂', 12, null],
    ['lena', 'anya', 'Аня, привет! Скинь потом ссылку на мессенджер', 300, null],
    ['anya', 'mark', 'А ещё теперь можно отправлять фото. Вот, поймала закат с балкона 🌇', 33, photoId],
  ];
  for (const [from, to, body, minutesAgo, media] of script) {
    q.insertMessage.run(
      ids[from],
      ids[to],
      body,
      media ? 'photo' : 'text',
      media,
      now() - minutesAgo * 60 * 1000,
    );
  }
  console.log('  Демо-аккаунты: anya / mark / lena, пароль 1234');
}

seedIfEmpty();

/* ─────────────────────── бэкап базы ─────────────────────── */

/**
 * Снимок базы при каждом старте: VACUUM INTO даёт целостную копию
 * вместе с данными из WAL. Держим последние 10 снимков.
 * Копии лежат в backups/ — отдельно от data/, чтобы не пропасть вместе с ней.
 */
function backupDatabase() {
  try {
    const dir = path.join(ROOT, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `volna-${stamp}.db`);
    if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const snapshots = fs.readdirSync(dir).filter((name) => name.endsWith('.db')).sort();
    while (snapshots.length > 10) fs.unlinkSync(path.join(dir, snapshots.shift()));
    return path.relative(ROOT, file);
  } catch (err) {
    console.error('  бэкап не сделался:', err.message);
    return null;
  }
}

const lastBackup = backupDatabase();

/* ─────────────────────── API ─────────────────────── */

function register({ name, password, invite }) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  const pass = String(password || '');
  if (INVITE_CODE && String(invite || '').trim() !== INVITE_CODE) {
    throw new HttpError(403, 'Неверный код приглашения');
  }
  if (clean.length < 2 || clean.length > 20) throw new HttpError(400, 'Имя: от 2 до 20 символов');
  if (!/^[\p{L}\p{N} ._-]+$/u.test(clean)) throw new HttpError(400, 'В имени только буквы, цифры, пробел, . _ -');
  if (pass.length < 4) throw new HttpError(400, 'Пароль: минимум 4 символа');
  if (q.userByName.get(clean)) throw new HttpError(409, 'Такое имя уже занято');

  const salt = crypto.randomBytes(16).toString('hex');
  const hue = Math.floor(Math.random() * 360);
  const info = q.insertUser.run(clean, hashPass(pass, salt), salt, hue, now());
  const user = publicUser(q.userById.get(Number(info.lastInsertRowid)));
  const token = randomToken();
  q.insertSession.run(token, user.id, now());
  return { token, user };
}

function login({ name, password }) {
  const clean = String(name || '').trim();
  const row = q.userByName.get(clean);
  const salt = row ? row.salt : 'no-such-user-salt';
  const expected = row ? row.pass_hash : hashPass('invalid', salt);
  const actual = hashPass(String(password || ''), salt);
  if (!row || !safeEqual(expected, actual)) throw new HttpError(401, 'Неверное имя или пароль');
  const user = publicUser(row);
  const token = randomToken();
  q.insertSession.run(token, user.id, now());
  return { token, user };
}

function contacts(userId) {
  const rows = q.contacts.all(userId, userId, userId, userId, userId);
  const online = new Set(onlineIds());
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    hue: r.hue,
    avatarId: r.avatar_media_id || null,
    lastBody: r.last_body,
    lastKind: r.last_kind || null,
    lastAt: r.last_at,
    lastFrom: r.last_from,
    unread: r.unread,
    online: online.has(r.id),
  }));
}

function history(userId, otherId, before, limit) {
  const other = q.userById.get(otherId);
  if (!other) throw new HttpError(404, 'Нет такого пользователя');
  const lim = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const rows = before
    ? db
        .prepare(
          `SELECT * FROM messages
           WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) AND id < ?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(userId, otherId, otherId, userId, before, lim)
    : db
        .prepare(
          `SELECT * FROM messages
           WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
           ORDER BY id DESC LIMIT ?`,
        )
        .all(userId, otherId, otherId, userId, lim);

  const messages = withMedia(rows.map(publicMessage).reverse());
  const hasMore = rows.length === lim;
  return { peer: publicUser(other), messages, hasMore };
}

function sendMessage(user, payload) {
  const to = Number(payload.to);
  const body = String(payload.body || '').replace(/\r\n/g, '\n').trim();
  const mediaId = payload.mediaId ? String(payload.mediaId) : null;

  if (!Number.isInteger(to) || to <= 0) throw new HttpError(400, 'Не указан получатель');
  if (!body && !mediaId) throw new HttpError(400, 'Пустое сообщение');
  if (body.length > MAX_TEXT) throw new HttpError(400, `Максимум ${MAX_TEXT} символов`);
  if (!q.userById.get(to)) throw new HttpError(404, 'Нет такого пользователя');
  if (to === user.id) throw new HttpError(400, 'Нельзя писать самому себе');

  let kind = 'text';
  if (mediaId) {
    const media = q.mediaOwner.get(mediaId);
    if (!media) throw new HttpError(400, 'Фотография не найдена');
    if (media.owner_id !== user.id) throw new HttpError(403, 'Это чужое фото');
    kind = 'photo';
  }

  const info = q.insertMessage.run(user.id, to, body, kind, mediaId, now());
  const message = withMedia([publicMessage(q.messageById.get(Number(info.lastInsertRowid)))])[0];
  broadcastTo(to, 'message', message);
  broadcastTo(user.id, 'message', message);
  return message;
}

function setAvatar(user, payload) {
  const mediaId = payload.avatarMediaId ? String(payload.avatarMediaId) : null;
  if (mediaId) {
    const media = q.mediaOwner.get(mediaId);
    if (!media) throw new HttpError(400, 'Фотография не найдена');
    if (media.owner_id !== user.id) throw new HttpError(403, 'Это чужое фото');
  }
  q.setAvatar.run(mediaId, user.id);
  const fresh = publicUser(q.userById.get(user.id));
  broadcastAll('profile', { userId: fresh.id, avatarId: fresh.avatarId });
  return fresh;
}

function markRead(user, payload) {
  const peer = Number(payload.userId);
  if (!Number.isInteger(peer) || peer <= 0) throw new HttpError(400, 'Не указан собеседник');
  const at = now();
  const { changes } = q.markRead.run(at, peer, user.id);
  if (changes > 0) {
    const { id } = q.maxFromPair.get(peer, user.id);
    broadcastTo(peer, 'read', { by: user.id, upTo: id, at });
  }
  return { changed: changes, upTo: q.maxFromPair.get(peer, user.id).id };
}

/* ─────────────────────── статика ─────────────────────── */

/**
 * Проксирует запрос фото-сервису. Нужен, чтобы фото и чат жили на одном адресе:
 * иначе через туннель/HTTPS браузер блокирует картинки с другого порта.
 */
function proxyMedia(req, res) {
  const upstream = http.request(
    {
      host: MEDIA_HOST,
      port: MEDIA_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${MEDIA_HOST}:${MEDIA_PORT}` },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    console.error('[фото-прокси]', err.message);
    if (!res.headersSent) sendJson(res, 502, { error: 'Фото-сервер недоступен' });
    else res.end();
  });

  req.pipe(upstream);
}


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Не найдено');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

/* ─────────────────────── сервер ─────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    /* интерфейс может жить на другом домене (GitHub Pages) — разрешаем кросс-доменные запросы */
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PATCH, OPTIONS');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    /* фото-сервис живёт на том же адресе, что и чат: так работает и через туннель */
    if (pathname.startsWith('/f/') || pathname.startsWith('/api/media')) {
      return proxyMedia(req, res);
    }

    if (pathname.startsWith('/api/')) {
      /* ── поток событий ── */
      if (pathname === '/api/events' && req.method === 'GET') {
        const { user } = requireUser(req, url);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        // Cloudflare и другие прокси копят ответ, пока буфер мал: отдаём «пустой» блок,
        // чтобы браузер сразу получил поток. Клиент эти строки-комментарии игнорирует.
        res.write(`: ${'·'.repeat(2048)}\n\n`);
        const fresh = !streams.has(user.id);
        setOnline(user.id, res);
        touchPresence(user.id);
        sseSend(res, 'ready', { me: user, online: onlineIds() });
        if (fresh) broadcastAll('presence', { userId: user.id, online: true });

        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* ignore */
          }
        }, 10000);

        req.on('close', () => {
          clearInterval(ping);
          const wasLast = setOffline(user.id, res);
          if (wasLast) {
            presence.delete(user.id);
            broadcastAll('presence', { userId: user.id, online: false });
          }
        });
        return;
      }

      /* ── авторизация ── */
      if (pathname === '/api/auth/register' && req.method === 'POST') {
        return sendJson(res, 201, register(await readJson(req)));
      }
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        return sendJson(res, 200, login(await readJson(req)));
      }
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const { token } = requireUser(req, url);
        q.deleteSession.run(token);
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/me' && req.method === 'GET') {
        const { user } = requireUser(req, url);
        return sendJson(res, 200, { user, online: onlineIds() });
      }
      if (pathname === '/api/me' && req.method === 'PATCH') {
        const { user } = requireUser(req, url);
        return sendJson(res, 200, { user: setAvatar(user, await readJson(req)) });
      }

      /* ── чаты ── */
      if (pathname === '/api/users' && req.method === 'GET') {
        const { user } = requireUser(req, url);
        return sendJson(res, 200, { users: contacts(user.id), online: onlineIds() });
      }
      if (pathname === '/api/messages' && req.method === 'GET') {
        const { user } = requireUser(req, url);
        const peer = Number(url.searchParams.get('userId'));
        if (!Number.isInteger(peer) || peer <= 0) throw new HttpError(400, 'Нужен userId');
        const before = Number(url.searchParams.get('before')) || 0;
        const limit = Number(url.searchParams.get('limit')) || 40;
        return sendJson(res, 200, history(user.id, peer, before, limit));
      }
      if (pathname === '/api/messages' && req.method === 'POST') {
        const { user } = requireUser(req, url);
        return sendJson(res, 201, { message: sendMessage(user, await readJson(req)) });
      }
      if (pathname === '/api/read' && req.method === 'POST') {
        const { user } = requireUser(req, url);
        return sendJson(res, 200, markRead(user, await readJson(req)));
      }
      if (pathname === '/api/typing' && req.method === 'POST') {
        const { user } = requireUser(req, url);
        const payload = await readJson(req);
        const to = Number(payload.to);
        if (Number.isInteger(to) && to > 0) {
          broadcastTo(to, 'typing', { from: user.id, name: user.name, at: now() });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/health' && req.method === 'GET') {
        const { users } = db.prepare('SELECT COUNT(*) AS users FROM users').get();
        return sendJson(res, 200, {
          ok: true,
          online: onlineIds().length,
          users,
          uptime: process.uptime(),
        });
      }

      throw new HttpError(404, 'Неизвестный метод API');
    }

    /* настройки клиента: фото идут через этот же сервер (/f/...), поэтому mediaUrl пустой */
    if (pathname === '/config.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      const mediaUrl = process.env.MEDIA_PUBLIC_URL ?? '';
      const body = `window.VOLNA_CONFIG = ${JSON.stringify({
        mediaUrl,
        inviteRequired: Boolean(INVITE_CODE),
      })};\n`;
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    /* фото-сервис на том же адресе */
    if (pathname.startsWith('/f/') || pathname.startsWith('/api/media')) {
      return proxyMedia(req, res);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'Только GET');
    }
    serveStatic(res, pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[волна]', err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Ошибка сервера' });
    else res.end();
  }
});

/* ─────────────────────── фото-сервер рядом ─────────────────────── */

let mediaChild = null;

if (process.env.MEDIA_EXTERNAL !== '1') {
  mediaChild = spawn(process.execPath, [path.join(ROOT, 'media.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, MEDIA_PORT: String(MEDIA_PORT) },
  });
  mediaChild.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') console.error(`  фото-сервер остановился (code ${code})`);
    mediaChild = null;
  });
}

function shutdown() {
  // переносим WAL в основной файл, чтобы копия базы была целой даже без бэкапа
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* уже закрыта */
  }
  mediaChild?.kill();
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => mediaChild?.kill());

server.listen(PORT, HOST, () => {
  const { users } = db.prepare('SELECT COUNT(*) AS users FROM users').get();
  console.log(`\n  Волна запущена → http://${HOST}:${PORT}`);
  console.log(`  Фотографии     → http://${HOST}:${PORT}/f/<id>`);
  console.log(`  Аккаунтов в базе: ${users} (${path.relative(ROOT, path.join(DATA_DIR, 'volna.db'))})`);
  if (lastBackup) console.log(`  Копия базы:      ${lastBackup}\n`);
  else console.log('');
});
