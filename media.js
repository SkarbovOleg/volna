/**
 * Волна · фото-сервер.
 * Маленький отдельный сервис: принимает картинки, кладёт их в data/media
 * и отдаёт обратно по ссылке /f/<id>. Авторизация — тот же токен сессии,
 * что и у основного сервера (общая база data/volna.db).
 *
 *   node media.js            → http://127.0.0.1:8788
 *   MEDIA_PORT=9000 node media.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MEDIA_DIR, openDb } from './db.js';

const PORT = Number(process.env.MEDIA_PORT || 8788);
const HOST = process.env.MEDIA_HOST || '127.0.0.1';
const MAX_BYTES = 8 * 1024 * 1024;
const ID_BYTES = 12;

const db = openDb();

const q = {
  session: db.prepare('SELECT user_id FROM sessions WHERE token = ?'),
  insert: db.prepare(
    'INSERT INTO media (id, owner_id, mime, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ),
  get: db.prepare('SELECT * FROM media WHERE id = ?'),
  count: db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM media'),
};

/* ───────────────────────── утилиты ───────────────────────── */

/** Тип картинки определяем по содержимому, а не по заголовку клиента. */
function sniffMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  const head4 = buf.subarray(0, 4).toString('latin1');
  const head8 = buf.subarray(8, 12).toString('latin1');
  if (head4 === 'RIFF' && head8 === 'WEBP') return 'image/webp';
  const gif = buf.subarray(0, 6).toString('latin1');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  return null;
}

function number(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 20000) return fallback;
  return Math.round(n);
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'authorization, content-type, x-image-width, x-image-height',
  );
  res.setHeader('access-control-max-age', '600');
  res.setHeader('access-control-expose-headers', 'content-type, content-length');
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

function userByToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  return q.session.get(token) || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error('Файл больше 8 МБ'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ───────────────────────── обработчики ───────────────────────── */

async function upload(req, res) {
  const session = userByToken(req);
  if (!session) return sendJson(res, 401, { error: 'Нужен вход' });

  const buf = await readBody(req);
  if (!buf.length) return sendJson(res, 400, { error: 'Пустой файл' });

  const mime = sniffMime(buf);
  if (!mime) return sendJson(res, 415, { error: 'Это не JPEG, PNG, WebP или GIF' });

  const id = crypto.randomBytes(ID_BYTES).toString('base64url');
  const width = number(req.headers['x-image-width']);
  const height = number(req.headers['x-image-height']);

  fs.writeFileSync(path.join(MEDIA_DIR, id), buf);
  q.insert.run(id, session.user_id, mime, buf.length, width, height, Date.now());

  console.log(`  фото +${(buf.length / 1024).toFixed(0)} КБ ${id} (${mime})`);
  return sendJson(res, 201, { id, url: `/f/${id}`, mime, bytes: buf.length, width, height });
}

function serveFile(req, res, id) {
  const row = q.get.get(id);
  if (!row) return sendJson(res, 404, { error: 'Файл не найден' });

  const file = path.join(MEDIA_DIR, id);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: 'Файл потерян' });
  }

  res.setHeader('content-type', row.mime);
  res.setHeader('content-length', stat.size);
  res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  res.setHeader('etag', `"${stat.size}-${Math.round(stat.mtimeMs)}"`);
  res.setHeader('last-modified', new Date(stat.mtimeMs).toUTCString());

  const etag = req.headers['if-none-match'];
  if (etag && etag === res.getHeader('etag')) {
    res.writeHead(304).end();
    return;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200).end();
    return;
  }

  res.writeHead(200);
  fs.createReadStream(file).pipe(res);
}

/* ───────────────────────── сервер ───────────────────────── */

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/health') {
      const stats = q.count.get();
      return sendJson(res, 200, { ok: true, service: 'media', files: stats.files, bytes: stats.bytes });
    }

    if (pathname === '/api/media' && req.method === 'POST') {
      return await upload(req, res);
    }

    const fileMatch = pathname.match(/^\/f\/([A-Za-z0-9_-]{8,64})$/);
    if (fileMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveFile(req, res, fileMatch[1]);
    }

    const metaMatch = pathname.match(/^\/api\/media\/([A-Za-z0-9_-]{8,64})$/);
    if (metaMatch && req.method === 'GET') {
      const row = q.get.get(metaMatch[1]);
      if (!row) return sendJson(res, 404, { error: 'Нет такого файла' });
      return sendJson(res, 200, {
        id: row.id,
        mime: row.mime,
        bytes: row.bytes,
        width: row.width,
        height: row.height,
        createdAt: row.created_at,
        url: `/f/${row.id}`,
      });
    }

    return sendJson(res, 404, { error: 'Неизвестный метод фото-сервера' });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[фото]', err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Ошибка фото-сервера' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`  Фото-сервер → http://${HOST}:${PORT} (${MEDIA_DIR})`);
});
